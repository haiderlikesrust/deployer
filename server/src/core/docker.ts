import { exec, type ExecOptions, type ExecResult } from './exec.js';
import { config } from '../config.js';

export function docker(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return exec('docker', args, opts);
}

/** Run a docker command whose output is NDJSON (via --format '{{json .}}'). */
export async function dockerJson<T = any>(args: string[]): Promise<T[]> {
  const res = await docker(args);
  if (res.code !== 0) throw new Error(`docker ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  const out: T[] = [];
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON noise
    }
  }
  return out;
}

export interface ContainerSummary {
  ID: string;
  Names: string;
  State: string; // running | exited | created ...
  Status: string;
  Image: string;
  Labels: string;
}

export function parseLabels(labelStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of labelStr.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export async function listManagedContainers(): Promise<ContainerSummary[]> {
  return dockerJson<ContainerSummary>(['ps', '-a', '--filter', 'label=deployer.managed=true', '--format', '{{json .}}']);
}

export interface ContainerState {
  running: boolean;
  status: string;
  startedAt: string | null;
  exitCode: number | null;
  ip: string | null;
}

export async function inspectContainer(nameOrId: string): Promise<ContainerState | null> {
  const res = await docker(['inspect', nameOrId]);
  if (res.code !== 0) return null;
  try {
    const [info] = JSON.parse(res.stdout);
    const net = info?.NetworkSettings?.Networks?.[config.dockerNetwork];
    return {
      running: !!info?.State?.Running,
      status: info?.State?.Status ?? 'unknown',
      startedAt: info?.State?.StartedAt ?? null,
      exitCode: info?.State?.ExitCode ?? null,
      ip: net?.IPAddress ?? null,
    };
  } catch {
    return null;
  }
}

export async function removeContainer(nameOrId: string): Promise<void> {
  await docker(['rm', '-f', nameOrId]);
}

export async function stopContainer(nameOrId: string): Promise<ExecResult> {
  return docker(['stop', nameOrId]);
}

export async function startContainer(nameOrId: string): Promise<ExecResult> {
  return docker(['start', nameOrId]);
}

export async function restartContainer(nameOrId: string): Promise<ExecResult> {
  return docker(['restart', nameOrId]);
}

export interface ImageSummary {
  Repository: string;
  Tag: string;
  ID: string;
  Size: string;
}

/** All tags of one app's image repo (dep-<app>). */
export async function listAppImages(appName: string): Promise<ImageSummary[]> {
  return dockerJson<ImageSummary>(['images', imageRepo(appName), '--format', '{{json .}}']);
}

export async function removeImage(ref: string): Promise<void> {
  await docker(['rmi', ref]);
}

export function imageRepo(appName: string): string {
  return `dep-${appName}`;
}

export function imageTag(appName: string, deploymentId: number): string {
  return `${imageRepo(appName)}:${deploymentId}`;
}

export function containerName(appName: string, deploymentId: number): string {
  return `dep-${appName}-${deploymentId}`;
}

/** Make sure the shared app network exists (idempotent). */
export async function ensureNetwork(): Promise<void> {
  const res = await docker(['network', 'inspect', config.dockerNetwork]);
  if (res.code !== 0) {
    const create = await docker(['network', 'create', config.dockerNetwork]);
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new Error(`failed to create docker network '${config.dockerNetwork}': ${create.stderr.trim()}`);
    }
  }
}

export async function dockerInfo(): Promise<{ version: string; ok: boolean; error?: string }> {
  const res = await docker(['version', '--format', '{{.Server.Version}}']);
  if (res.code !== 0) return { version: '', ok: false, error: res.stderr.trim() };
  return { version: res.stdout.trim(), ok: true };
}
