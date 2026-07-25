import fs from 'node:fs';
import path from 'node:path';
import { paths, config } from '../config.js';
import {
  getApp,
  getDeployment,
  getEnvVars,
  setActiveDeployment,
  updateDeployment,
} from '../db/repo.js';
import { now } from '../db/db.js';
import type { AppRow, DeploymentRow, DeploymentStatus, ResolvedConfig } from '../types.js';
import { appendLog, closeLog, stageLog } from './buildlogs.js';
import { clearCancelFlag, isCanceled } from './children.js';
import { cloneRepo } from './git.js';
import { resolveConfig } from './configResolve.js';
import { buildImage } from './builder.js';
import { runContainer, healthGate } from './runner.js';
import { removeContainer, stopContainer, ensureNetwork } from './docker.js';
import { emitEvent } from './events.js';
import { checkDiskSpace, retainImages } from './cleanup.js';

class CanceledError extends Error {
  constructor() {
    super('canceled');
  }
}

function setStage(dep: DeploymentRow, status: DeploymentStatus) {
  if (isCanceled(dep.id)) throw new CanceledError();
  updateDeployment(dep.id, { status });
  emitEvent({ type: 'deployment', appId: dep.app_id, deploymentId: dep.id, status });
}

/**
 * Runs one deployment through the state machine:
 *   cloning → resolving → building → starting → checking → live
 * Any failure before 'starting' touches nothing at runtime; failures at
 * starting/checking remove the NEW container — the old version keeps serving.
 */
export async function runDeployment(deploymentId: number): Promise<void> {
  const dep = getDeployment(deploymentId);
  if (!dep || dep.status !== 'queued') return;
  const app = getApp(dep.app_id);
  if (!app) {
    updateDeployment(dep.id, { status: 'canceled', error: 'app was deleted', finished_at: now() });
    return;
  }

  updateDeployment(dep.id, { started_at: now(), log_file: `deploy-${dep.id}.log` });
  const buildDir = paths.buildDir(app.name, dep.id);
  const srcDir = path.join(buildDir, 'src');
  let startedContainer: string | null = null;
  let stage: DeploymentStatus = 'cloning';

  try {
    await ensureNetwork();

    // ---- cloning ----
    setStage(dep, (stage = 'cloning'));
    stageLog(dep.id, `Cloning ${app.repo_url}${app.branch ? ` (branch ${app.branch})` : ''}`);
    fs.rmSync(buildDir, { recursive: true, force: true });
    const commit = await cloneRepo({
      url: app.repo_url,
      branch: app.branch,
      dest: srcDir,
      token: app.git_token,
      deploymentId: dep.id,
      log: (l) => appendLog(dep.id, l),
    });
    updateDeployment(dep.id, { commit_sha: commit.sha, commit_msg: commit.message });
    appendLog(dep.id, `Checked out ${commit.sha.slice(0, 10)} — ${commit.message}`);

    // ---- resolving ----
    setStage(dep, (stage = 'resolving'));
    stageLog(dep.id, 'Resolving build configuration');
    const buildRoot = resolveRootDir(srcDir, app.root_dir);
    if (app.root_dir) stageLog(dep.id, `Building from subdirectory '${app.root_dir}'`);
    const { cfg, generatedDockerfile, extraContextFiles } = resolveConfig(app, getEnvVars(app.id), buildRoot);
    updateDeployment(dep.id, { config_json: JSON.stringify(cfg) });
    for (const note of cfg.notes) appendLog(dep.id, `  ${note}`);
    appendLog(
      dep.id,
      `Resolved: type=${cfg.type} builder=${cfg.builder} port=${cfg.containerPort}` +
        (cfg.domainHost ? ` domain=${cfg.domainHost}` : '') +
        (cfg.healthPath ? ` health=${cfg.healthPath}` : '')
    );

    // ---- building ----
    setStage(dep, (stage = 'building'));
    stageLog(dep.id, 'Building image');
    await checkDiskSpace();
    const image = await buildImage({
      appName: app.name,
      deploymentId: dep.id,
      cfg,
      generatedDockerfile,
      extraContextFiles,
      contextDir: buildRoot,
    });
    updateDeployment(dep.id, { image_tag: image });

    // ---- starting ----
    setStage(dep, (stage = 'starting'));
    stageLog(dep.id, 'Starting container');
    startedContainer = await runContainer(app, dep.id, cfg, image);
    updateDeployment(dep.id, { container_id: startedContainer });

    // ---- checking ----
    setStage(dep, (stage = 'checking'));
    stageLog(dep.id, 'Health check');
    await healthGate(dep.id, cfg, startedContainer);

    // ---- promote ----
    await promote(app, dep, cfg);
    stageLog(dep.id, cfg.domainHost ? `✓ Live at ${urlFor(cfg)}` : '✓ Live (worker — no HTTP route)');
    updateDeployment(dep.id, { status: 'live', finished_at: now() });
    emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'live' });

    // post-live housekeeping — never fails the deployment
    try {
      await retainImages(app.name, dep.id);
    } catch (e) {
      appendLog(dep.id, `note: image retention sweep failed: ${(e as Error).message}`);
    }
  } catch (e) {
    const wasCanceled = e instanceof CanceledError || isCanceled(dep.id);
    if (startedContainer) {
      await removeContainer(startedContainer).catch(() => {});
      updateDeployment(dep.id, { container_id: null });
    }
    if (wasCanceled) {
      stageLog(dep.id, '✗ Deployment canceled');
      updateDeployment(dep.id, { status: 'canceled', failed_stage: stage, finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'canceled' });
    } else {
      const msg = (e as Error).message;
      for (const line of msg.split('\n')) appendLog(dep.id, `✗ ${line}`);
      updateDeployment(dep.id, { status: 'failed', failed_stage: stage, error: msg.slice(0, 4000), finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'failed' });
    }
  } finally {
    clearCancelFlag(dep.id);
    closeLog(dep.id);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

function urlFor(cfg: ResolvedConfig): string {
  return `${config.publicScheme}://${cfg.domainHost}`;
}

/**
 * Resolve the build root for monorepos, refusing anything that escapes the
 * clone (a '../' would hand the build context an arbitrary host directory).
 */
function resolveRootDir(srcDir: string, rootDir: string | null): string {
  if (!rootDir || rootDir.trim() === '' || rootDir.trim() === '.') return srcDir;
  const rel = rootDir.trim().replace(/^[/\\]+/, '');
  const resolved = path.resolve(srcDir, rel);
  const within = path.relative(srcDir, resolved);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`root directory '${rootDir}' must stay inside the repository`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`root directory '${rootDir}' does not exist in the repository`);
  }
  return resolved;
}

/** Swap traffic to the new container, then retire the previous deployment. */
async function promote(app: AppRow, dep: DeploymentRow, cfg: ResolvedConfig) {
  const previousId = getApp(app.id)?.active_deployment_id ?? null;
  setActiveDeployment(app.id, dep.id);

  if (previousId && previousId !== dep.id) {
    const prev = getDeployment(previousId);
    if (prev?.container_id) {
      appendLog(dep.id, `Retiring previous deployment #${previousId}`);
      await stopContainer(prev.container_id); // graceful SIGTERM first
      await removeContainer(prev.container_id);
    }
    if (prev) updateDeployment(prev.id, { status: 'superseded' });
  }
}
