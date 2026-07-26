import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { getDb } from '../db/db.js';
import { getDeployment, listApps } from '../db/repo.js';
import { docker, inspectContainer } from './docker.js';
import { scrub } from './secrets.js';
import { notify } from './notify.js';
import type { AppRow, ResolvedConfig } from '../types.js';

/**
 * Observability: persistent runtime logs, metrics samples, reachability alerts.
 * All three reconcile against "which apps have an active container" on a timer,
 * so they self-heal across deploys, restarts and VPS reboots.
 */

// ---------------------------------------------------------------- log history

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATIONS = 3;

interface Collector {
  container: string;
  child: ChildProcess;
}

const collectors = new Map<number, Collector>(); // appId -> collector

function appLogDir(): string {
  const dir = path.join(config.dataDir, 'applogs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appLogPath(appName: string, rotation = 0): string {
  return path.join(appLogDir(), rotation === 0 ? `${appName}.log` : `${appName}.log.${rotation}`);
}

function rotateIfNeeded(appName: string) {
  const current = appLogPath(appName);
  try {
    if (fs.statSync(current).size < MAX_LOG_BYTES) return;
  } catch {
    return;
  }
  for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
    try {
      fs.renameSync(appLogPath(appName, i), appLogPath(appName, i + 1));
    } catch {}
  }
  try {
    fs.renameSync(current, appLogPath(appName, 1));
    fs.rmSync(appLogPath(appName, KEEP_ROTATIONS + 1), { force: true });
  } catch {}
}

function startCollector(app: AppRow, container: string) {
  stopCollector(app.id);
  const child = spawn('docker', ['logs', '-f', '--tail', '0', container], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const write = (line: string) => {
    try {
      rotateIfNeeded(app.name);
      fs.appendFileSync(appLogPath(app.name), `${new Date().toISOString()} ${scrub(line)}\n`);
    } catch {}
  };
  readline.createInterface({ input: child.stdout! }).on('line', write);
  readline.createInterface({ input: child.stderr! }).on('line', write);
  child.on('close', () => {
    if (collectors.get(app.id)?.child === child) collectors.delete(app.id);
  });
  collectors.set(app.id, { container, child });
}

function stopCollector(appId: number) {
  const c = collectors.get(appId);
  if (!c) return;
  try {
    c.child.kill('SIGTERM');
  } catch {}
  collectors.delete(appId);
}

export function deleteAppLogs(appName: string) {
  for (let i = 0; i <= KEEP_ROTATIONS; i++) fs.rmSync(appLogPath(appName, i), { force: true });
}

export interface LogSearchResult {
  lines: string[];
  scannedBytes: number;
}

/** Newest-first search across the current file and rotations. */
export function searchAppLogs(appName: string, query: string, limit = 500): LogSearchResult {
  const needle = query.toLowerCase();
  const lines: string[] = [];
  let scanned = 0;
  for (let i = 0; i <= KEEP_ROTATIONS && lines.length < limit; i++) {
    let content: string;
    try {
      content = fs.readFileSync(appLogPath(appName, i), 'utf8');
    } catch {
      continue;
    }
    scanned += content.length;
    const fileLines = content.split('\n');
    for (let j = fileLines.length - 1; j >= 0 && lines.length < limit; j--) {
      const line = fileLines[j];
      if (line && (!needle || line.toLowerCase().includes(needle))) lines.push(line);
    }
  }
  return { lines, scannedBytes: scanned };
}

// ---------------------------------------------------------------- metrics

interface StatsRow {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
}

function parseMem(usage: string): number {
  // "24.5MiB / 512MiB" -> bytes of the first part
  const m = usage.split('/')[0].trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith('K') ? 1024 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('T') ? 1024 ** 4 : 1;
  return Math.round(n * mult);
}

async function sampleMetrics() {
  let rows: StatsRow[];
  try {
    const res = await docker(['stats', '--no-stream', '--format', '{{json .}}']);
    if (res.code !== 0) return;
    rows = res.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StatsRow);
  } catch {
    return;
  }

  const byContainer = new Map(rows.map((r) => [r.Name, r]));
  const ts = Math.floor(Date.now() / 1000);
  const insert = getDb().prepare('INSERT INTO metrics (app_id, ts, cpu_pct, mem_bytes) VALUES (?, ?, ?, ?)');
  for (const app of listApps()) {
    if (!app.active_deployment_id) continue;
    const dep = getDeployment(app.active_deployment_id);
    const stat = dep?.container_id ? byContainer.get(dep.container_id) : null;
    if (!stat) continue;
    insert.run(app.id, ts, parseFloat(stat.CPUPerc) || 0, parseMem(stat.MemUsage));
  }
}

export interface MetricPoint {
  ts: number;
  cpuPct: number;
  memBytes: number;
}

export function metricsForApp(appId: number, rangeSeconds: number): MetricPoint[] {
  const since = Math.floor(Date.now() / 1000) - rangeSeconds;
  return (
    getDb()
      .prepare('SELECT ts, cpu_pct AS cpuPct, mem_bytes AS memBytes FROM metrics WHERE app_id = ? AND ts >= ? ORDER BY ts')
      .all(appId, since) as MetricPoint[]
  );
}

// ---------------------------------------------------------------- reachability

interface ReachState {
  failures: number;
  up: boolean | null; // null = unknown / not probing
}

const reach = new Map<number, ReachState>();
const DOWN_AFTER = 3;

export function reachabilityFor(appId: number): boolean | null {
  return reach.get(appId)?.up ?? null;
}

async function probeApp(app: AppRow): Promise<boolean | null> {
  if (!app.active_deployment_id) return null;
  const dep = getDeployment(app.active_deployment_id);
  if (!dep?.container_id || !dep.config_json) return null;
  let cfg: ResolvedConfig;
  try {
    cfg = JSON.parse(dep.config_json);
  } catch {
    return null;
  }
  if (cfg.type === 'worker') {
    const state = await inspectContainer(dep.container_id);
    return state ? state.running : null;
  }
  const url = `http://${dep.container_id}:${cfg.containerPort}${cfg.healthPath ?? '/'}`;
  if (config.probeMode === 'direct') {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
      return res.status < 500;
    } catch {
      return false;
    }
  }
  const res = await docker(
    ['run', '--rm', '--network', config.dockerNetwork, 'busybox:1.36', 'wget', '-q', '-T', '4', '-O', '-', '--spider', url],
    { timeoutMs: 30_000 }
  );
  return res.code === 0;
}

async function checkReachability() {
  for (const app of listApps()) {
    const result = await probeApp(app);
    if (result == null) {
      reach.delete(app.id);
      continue;
    }
    const state = reach.get(app.id) ?? { failures: 0, up: null };
    if (result) {
      if (state.up === false) {
        notify('reachability', `✅ ${app.name} is responding again.`);
      }
      reach.set(app.id, { failures: 0, up: true });
    } else {
      const failures = state.failures + 1;
      const nowDown = failures >= DOWN_AFTER;
      if (nowDown && state.up !== false) {
        notify('reachability', `🔴 ${app.name} is not responding (${failures} consecutive failed checks). The container may be up but the app isn't answering.`);
      }
      reach.set(app.id, { failures, up: nowDown ? false : state.up });
    }
  }
}

// ---------------------------------------------------------------- scheduler

async function reconcileCollectors() {
  for (const app of listApps()) {
    const dep = app.active_deployment_id ? getDeployment(app.active_deployment_id) : null;
    const existing = collectors.get(app.id);
    if (!dep?.container_id) {
      if (existing) stopCollector(app.id);
      continue;
    }
    if (existing?.container === dep.container_id) continue;
    const state = await inspectContainer(dep.container_id);
    if (state?.running) startCollector(app, dep.container_id);
    else if (existing) stopCollector(app.id);
  }
}

export function startObservers() {
  const collectorTimer = setInterval(() => void reconcileCollectors().catch(() => {}), 30_000);
  collectorTimer.unref();
  const metricsTimer = setInterval(() => void sampleMetrics().catch(() => {}), 30_000);
  metricsTimer.unref();
  const reachTimer = setInterval(() => void checkReachability().catch(() => {}), 60_000);
  reachTimer.unref();
  const pruneTimer = setInterval(() => {
    try {
      getDb().prepare('DELETE FROM metrics WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 25 * 3600);
    } catch {}
  }, 3600_000);
  pruneTimer.unref();
  void reconcileCollectors().catch(() => {});
}
