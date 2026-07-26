import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb, now } from '../db/db.js';
import type { ServiceLinkRow, ServiceRow, ServiceType } from '../types.js';
import { docker, inspectContainer, removeContainer } from './docker.js';
import { registerSecret } from './secrets.js';

/**
 * Managed databases: one container + one named volume per service, reachable
 * only on the private docker network (never a published host port). Linked
 * apps get the connection URL injected as an env var at deploy time.
 */

interface ServiceSpec {
  image: (version: string) => string;
  defaultVersion: string;
  dataDir: string;
  port: number;
  runArgs: (password: string) => string[];
  url: (name: string, password: string) => string;
  defaultEnvKey: string;
  /** Produces a full backup on stdout inside the container; null = special-cased. */
  backupCmd: ((password: string) => string[]) | null;
  backupExt: string;
}

const SPECS: Record<ServiceType, ServiceSpec> = {
  postgres: {
    image: (v) => `postgres:${v}-alpine`,
    defaultVersion: '16',
    dataDir: '/var/lib/postgresql/data',
    port: 5432,
    runArgs: (pw) => ['-e', `POSTGRES_PASSWORD=${pw}`],
    url: (name, pw) => `postgres://postgres:${pw}@${containerName(name)}:5432/postgres`,
    defaultEnvKey: 'DATABASE_URL',
    backupCmd: (pw) => ['env', `PGPASSWORD=${pw}`, 'pg_dump', '-U', 'postgres', '--clean', '--if-exists', 'postgres'],
    backupExt: 'sql',
  },
  redis: {
    image: (v) => `redis:${v}-alpine`,
    defaultVersion: '7',
    dataDir: '/data',
    port: 6379,
    runArgs: () => [],
    url: (name, pw) => `redis://:${pw}@${containerName(name)}:6379`,
    defaultEnvKey: 'REDIS_URL',
    backupCmd: null, // handled specially: SAVE + RDB copy
    backupExt: 'rdb',
  },
  mongo: {
    image: (v) => `mongo:${v}`,
    defaultVersion: '7',
    dataDir: '/data/db',
    port: 27017,
    runArgs: (pw) => ['-e', 'MONGO_INITDB_ROOT_USERNAME=root', '-e', `MONGO_INITDB_ROOT_PASSWORD=${pw}`],
    url: (name, pw) => `mongodb://root:${pw}@${containerName(name)}:27017`,
    defaultEnvKey: 'MONGO_URL',
    backupCmd: (pw) => ['mongodump', '--username', 'root', '--password', pw, '--archive'],
    backupExt: 'archive',
  },
};

export function containerName(serviceName: string): string {
  return `dep-svc-${serviceName}`;
}

export function volumeName(serviceName: string): string {
  return `dep-svc-${serviceName}-data`;
}

export function serviceUrl(svc: ServiceRow): string {
  return SPECS[svc.type].url(svc.name, svc.password);
}

export function defaultEnvKey(type: ServiceType): string {
  return SPECS[type].defaultEnvKey;
}

export function defaultVersion(type: ServiceType): string {
  return SPECS[type].defaultVersion;
}

// ---------------------------------------------------------------- db access

export function listServices(): ServiceRow[] {
  return getDb().prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[];
}

export function getService(id: number): ServiceRow | null {
  return (getDb().prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow) ?? null;
}

export function getServiceByName(name: string): ServiceRow | null {
  return (getDb().prepare('SELECT * FROM services WHERE name = ?').get(name) as ServiceRow) ?? null;
}

export function linksForService(serviceId: number): ServiceLinkRow[] {
  return getDb().prepare('SELECT * FROM service_links WHERE service_id = ?').all(serviceId) as ServiceLinkRow[];
}

export function linksForApp(appId: number): (ServiceLinkRow & { service: ServiceRow })[] {
  const rows = getDb().prepare('SELECT * FROM service_links WHERE app_id = ?').all(appId) as ServiceLinkRow[];
  return rows
    .map((l) => ({ ...l, service: getService(l.service_id)! }))
    .filter((l) => l.service != null);
}

/** Connection-URL env entries injected into a linked app's deploys. */
export function serviceEnvForApp(appId: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const link of linksForApp(appId)) env[link.env_key] = serviceUrl(link.service);
  return env;
}

// ---------------------------------------------------------------- lifecycle

export async function createService(name: string, type: ServiceType, version?: string): Promise<ServiceRow> {
  const spec = SPECS[type];
  const v = version?.trim() || spec.defaultVersion;
  const password = crypto.randomBytes(18).toString('base64url');

  const res = getDb()
    .prepare('INSERT INTO services (name, type, version, password, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, type, v, password, now());
  const svc = getService(Number(res.lastInsertRowid))!;
  registerSecret(password);

  try {
    await startServiceContainer(svc);
  } catch (e) {
    getDb().prepare('DELETE FROM services WHERE id = ?').run(svc.id);
    throw e;
  }
  return svc;
}

export async function startServiceContainer(svc: ServiceRow): Promise<void> {
  const spec = SPECS[svc.type];
  await removeContainer(containerName(svc.name)); // stale leftover, if any
  const args = [
    'run', '-d',
    '--name', containerName(svc.name),
    '--restart', 'unless-stopped',
    '--network', config.dockerNetwork,
    '-v', `${volumeName(svc.name)}:${spec.dataDir}`,
    '--label', 'deployer.managed=true',
    '--label', `deployer.service=${svc.name}`,
    ...spec.runArgs(svc.password),
    spec.image(svc.version),
  ];
  if (svc.type === 'redis') args.push('redis-server', '--requirepass', svc.password, '--appendonly', 'yes');
  const res = await docker(args);
  if (res.code !== 0) throw new Error(`could not start ${svc.type}: ${res.stderr.trim().split('\n').slice(-2).join(' ')}`);
}

export async function serviceState(svc: ServiceRow) {
  return inspectContainer(containerName(svc.name));
}

export async function deleteService(svc: ServiceRow): Promise<void> {
  await removeContainer(containerName(svc.name));
  await docker(['volume', 'rm', volumeName(svc.name)]);
  getDb().prepare('DELETE FROM services WHERE id = ?').run(svc.id); // links cascade
}

export function linkService(serviceId: number, appId: number, envKey: string) {
  getDb()
    .prepare(
      `INSERT INTO service_links (service_id, app_id, env_key) VALUES (?, ?, ?)
       ON CONFLICT(service_id, app_id) DO UPDATE SET env_key = excluded.env_key`
    )
    .run(serviceId, appId, envKey);
}

export function unlinkService(serviceId: number, appId: number) {
  getDb().prepare('DELETE FROM service_links WHERE service_id = ? AND app_id = ?').run(serviceId, appId);
}

// ---------------------------------------------------------------- backups

function backupsDir(): string {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface BackupFile {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

export function listBackups(svc: ServiceRow): BackupFile[] {
  const dir = backupsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${svc.name}-`))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupPath(file: string): string {
  // file names come from listBackups, but never trust a path from a request
  const safe = path.basename(file);
  return path.join(backupsDir(), safe);
}

const KEEP_BACKUPS = 7;

export async function backupService(svc: ServiceRow): Promise<BackupFile> {
  const spec = SPECS[svc.type];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${svc.name}-${stamp}.${spec.backupExt}`;
  const dest = backupPath(file);

  if (svc.type === 'redis') {
    // trigger a synchronous snapshot, then copy the RDB out of the container
    const save = await docker(['exec', containerName(svc.name), 'redis-cli', '-a', svc.password, '--no-auth-warning', 'SAVE']);
    if (save.code !== 0) throw new Error(`redis SAVE failed: ${save.stderr.trim()}`);
    const cp = await docker(['cp', `${containerName(svc.name)}:/data/dump.rdb`, dest]);
    if (cp.code !== 0) throw new Error(`could not copy dump.rdb: ${cp.stderr.trim()}`);
  } else {
    // raw byte stream to disk — dumps exceed any in-memory cap, and mongo's
    // archive format is binary (line-based capture would corrupt it)
    const cmd = spec.backupCmd?.(svc.password);
    if (!cmd) throw new Error(`no backup strategy for ${svc.type}`);
    await execToFile(['exec', containerName(svc.name), ...cmd], dest);
  }

  // retention
  for (const old of listBackups(svc).slice(KEEP_BACKUPS)) {
    fs.rmSync(backupPath(old.file), { force: true });
  }
  const st = fs.statSync(dest);
  return { file, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
}

function execToFile(dockerArgs: string[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(dest);
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (stderr += String(d).slice(0, 2000)));
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      out.close();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.close(() => {
        if (code === 0) resolve();
        else {
          fs.rmSync(dest, { force: true }); // never leave a truncated dump behind
          reject(new Error(`backup failed: ${stderr.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`));
        }
      });
    });
  });
}

/** Daily best-effort backups of every service. */
export function startBackupSchedule() {
  const timer = setInterval(async () => {
    for (const svc of listServices()) {
      try {
        await backupService(svc);
      } catch (e) {
        console.error(`scheduled backup of ${svc.name} failed:`, (e as Error).message);
      }
    }
  }, 24 * 60 * 60 * 1000);
  timer.unref();
}

/** On boot: make sure every service container is running (VPS reboot safety). */
export async function reconcileServices(log: (msg: string) => void) {
  for (const svc of listServices()) {
    registerSecret(svc.password);
    const state = await serviceState(svc);
    if (!state) {
      log(`service ${svc.name} container missing — recreating`);
      await startServiceContainer(svc).catch((e) => log(`could not recreate ${svc.name}: ${(e as Error).message}`));
    }
  }
}
