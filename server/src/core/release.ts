import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { docker } from './docker.js';
import { appendLog } from './buildlogs.js';
import type { AppRow, ResolvedConfig } from '../types.js';

const RELEASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The release command (migrations, seeds) runs in a ONE-OFF container from the
 * freshly built image, with the app's env and volumes, after the build and
 * before any traffic decision. A non-zero exit fails the deployment while the
 * old version keeps serving untouched.
 */
export async function runRelease(app: AppRow, deploymentId: number, cfg: ResolvedConfig, image: string): Promise<void> {
  if (!cfg.releaseCmd) return;

  fs.mkdirSync(paths.tmp(), { recursive: true });
  const envFile = path.join(paths.tmp(), `release-env-${deploymentId}`);
  fs.writeFileSync(envFile, Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });

  try {
    appendLog(deploymentId, `$ ${cfg.releaseCmd}`);
    const args = ['run', '--rm', '--network', config.dockerNetwork, '--env-file', envFile];
    for (const vol of cfg.volumes ?? []) args.push('-v', `dep-${app.name}-${vol.name}:${vol.path}`);
    args.push(image, 'sh', '-c', cfg.releaseCmd);

    const res = await docker(args, {
      deploymentId,
      timeoutMs: RELEASE_TIMEOUT_MS,
      onLine: (l) => appendLog(deploymentId, l),
    });
    if (res.timedOut) throw new Error(`release command timed out after ${RELEASE_TIMEOUT_MS / 60000} minutes`);
    if (res.code !== 0) throw new Error(`release command exited with code ${res.code} — the deploy was stopped and the running version is untouched`);
    appendLog(deploymentId, 'Release command finished');
  } finally {
    fs.rmSync(envFile, { force: true });
  }
}
