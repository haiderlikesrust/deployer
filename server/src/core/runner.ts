import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { containerName, docker, inspectContainer, removeContainer } from './docker.js';
import { traefikLabels } from './proxy.js';
import { appendLog } from './buildlogs.js';
import { isCanceled } from './children.js';
import type { AppRow, ResolvedConfig } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a worker must survive before we call the deployment good. */
const WORKER_SETTLE_MS = 10_000;

export async function runContainer(app: AppRow, deploymentId: number, cfg: ResolvedConfig, image: string): Promise<string> {
  const name = containerName(app.name, deploymentId);
  await removeContainer(name); // stale leftover from a crashed attempt, if any

  // env delivered via --env-file (client-side read; never a bind mount)
  fs.mkdirSync(paths.tmp(), { recursive: true });
  const envFile = path.join(paths.tmp(), `env-${deploymentId}`);
  const lines = Object.entries(cfg.env).map(([k, v]) => {
    if (/[\n\r]/.test(v)) throw new Error(`env var ${k} contains a newline — not supported`);
    return `${k}=${v}`;
  });
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });

  try {
    const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--network', config.dockerNetwork, '--env-file', envFile];
    for (const label of traefikLabels(app.name, deploymentId, cfg)) args.push('--label', label);
    if (app.memory_limit) args.push('--memory', app.memory_limit);
    args.push(image);

    const res = await docker(args, { deploymentId });
    if (res.code !== 0) throw new Error(`docker run failed: ${res.stderr.trim()}`);
    return name;
  } finally {
    fs.rmSync(envFile, { force: true });
  }
}

/**
 * Deploy gate: the new container must prove itself before the old one is
 * removed. Workers just need to stay alive; web/static must answer HTTP.
 */
export async function healthGate(deploymentId: number, cfg: ResolvedConfig, container: string): Promise<void> {
  if (cfg.type === 'worker') {
    appendLog(deploymentId, `Worker app — checking the process stays up for ${WORKER_SETTLE_MS / 1000}s...`);
    await sleep(WORKER_SETTLE_MS);
    const state = await inspectContainer(container);
    if (!state?.running) {
      throw new Error(`worker exited right after start (status: ${state?.status ?? 'unknown'}, exit code ${state?.exitCode})\n${await logsTail(container)}`);
    }
    // --restart unless-stopped hides a crash loop behind a "running" container
    if (state.status === 'restarting' || state.restartCount > 0) {
      throw new Error(
        `worker is crash-looping (restarted ${state.restartCount} time(s), last exit code ${state.exitCode})\n${await logsTail(container)}`
      );
    }
    appendLog(deploymentId, `Worker is running (no restarts in the first ${WORKER_SETTLE_MS / 1000}s)`);
    return;
  }

  const probePath = cfg.healthPath ?? '/';
  const url = `http://${container}:${cfg.containerPort}${probePath}`;
  appendLog(deploymentId, `Waiting for the app to answer on ${url} ...`);
  const deadline = Date.now() + 60_000;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    if (isCanceled(deploymentId)) throw new Error('canceled');
    const state = await inspectContainer(container);
    if (!state) throw new Error('container disappeared during health check');
    if (!state.running) {
      throw new Error(`container exited during health check (exit code ${state.exitCode})\n${await logsTail(container)}`);
    }
    const ok = await probe(url, deploymentId);
    if (ok.pass) {
      appendLog(deploymentId, `Health check passed (${ok.detail})`);
      return;
    }
    lastError = ok.detail;
    await sleep(2000);
  }
  throw new Error(
    `app did not answer on port ${cfg.containerPort} within 60s (${lastError}). ` +
      `Make sure it listens on 0.0.0.0:$PORT (PORT=${cfg.containerPort} is injected), or set the correct port in settings/deploy.yml.\n${await logsTail(container)}`
  );
}

async function probe(url: string, deploymentId: number): Promise<{ pass: boolean; detail: string }> {
  if (config.probeMode === 'direct') {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      return res.status < 500
        ? { pass: true, detail: `HTTP ${res.status}` }
        : { pass: false, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { pass: false, detail: (e as Error).message.slice(0, 120) };
    }
  }
  // probeMode 'docker': reach the app network via a disposable busybox container
  const res = await docker(
    ['run', '--rm', '--network', config.dockerNetwork, 'busybox:1.36', 'wget', '-q', '-T', '3', '-O', '-', '--spider', url],
    { deploymentId, timeoutMs: 30_000 }
  );
  return res.code === 0 ? { pass: true, detail: 'HTTP 2xx/3xx' } : { pass: false, detail: res.stderr.trim().slice(0, 120) || 'no response' };
}

async function logsTail(container: string, n = 25): Promise<string> {
  const res = await docker(['logs', '--tail', String(n), container]);
  const out = (res.stdout + res.stderr).trim();
  return out ? `─ last container logs ─\n${out}` : '';
}
