import fs from 'node:fs';
import path from 'node:path';
import { paths, config } from '../config.js';
import {
  getApp,
  getDeployment,
  getEnvVars,
  setActiveDeployment,
  setAppEnvSchema,
  updateDeployment,
} from '../db/repo.js';
import { now } from '../db/db.js';
import type { AppRow, AppType, DeploymentRow, DeploymentStatus, EnvSchema, ResolvedConfig } from '../types.js';
import { appendLog, closeLog, stageLog } from './buildlogs.js';
import { clearCancelFlag, isCanceled } from './children.js';
import { cloneRepo } from './git.js';
import { resolveConfig } from './configResolve.js';
import { detectEnvSchema, missingRequiredKeys } from './detect/envexample.js';
import { buildImage } from './builder.js';
import { runContainer, healthGate } from './runner.js';
import { docker, removeContainer, stopContainer, ensureNetwork } from './docker.js';
import { emitEvent } from './events.js';
import { checkDiskSpace, retainImages } from './cleanup.js';
import { notify } from './notify.js';

class CanceledError extends Error {
  constructor() {
    super('canceled');
  }
}

/** Not a failure: the repo declares env vars the user has not filled in yet. */
class NeedsEnvError extends Error {
  constructor(
    readonly missing: string[],
    readonly schema: EnvSchema
  ) {
    super('missing required environment variables');
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
 * 'resolving' has one extra terminal exit: 'needs_env', taken when the repo's
 * .env.example declares required variables that are still unset. Nothing is
 * built and nothing at runtime is touched — it is a prompt, not a failure.
 */
export async function runDeployment(deploymentId: number): Promise<void> {
  const dep = getDeployment(deploymentId);
  if (!dep || dep.status !== 'queued') return;
  const app = getApp(dep.app_id);
  if (!app) {
    updateDeployment(dep.id, { status: 'canceled', error: 'app was deleted', finished_at: now() });
    return;
  }

  if (dep.trigger === 'rollback') {
    await runRollback(dep, app);
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
    const { cfg, generatedDockerfile, extraContextFiles } = resolveConfig(app, getEnvVars(app.id), buildRoot, {
      previousType: activeResolvedType(app),
    });
    updateDeployment(dep.id, { config_json: JSON.stringify(cfg) });
    for (const note of cfg.notes) appendLog(dep.id, `  ${note}`);
    appendLog(
      dep.id,
      `Resolved: type=${cfg.type} builder=${cfg.builder} port=${cfg.containerPort}` +
        (cfg.domainHost ? ` domain=${cfg.domainHost}` : '') +
        (cfg.healthPath ? ` health=${cfg.healthPath}` : '')
    );

    // ---- env example gate ----
    // Nothing has been built or started yet, so bailing out here costs nothing.
    let schema: EnvSchema | null = null;
    try {
      schema = detectEnvSchema(buildRoot, (m) => appendLog(dep.id, m));
      if (schema) schema.commitSha = commit.sha;
    } catch (e) {
      appendLog(dep.id, `note: could not read the env example file: ${(e as Error).message}`);
    }
    // cached on every attempt, including a null result (the repo may have dropped the file)
    setAppEnvSchema(app.id, schema);
    emitEvent({ type: 'app', appId: app.id, status: 'updated' });

    if (schema) {
      updateDeployment(dep.id, { env_schema_json: JSON.stringify(schema) });
      const required = schema.vars.filter((v) => v.required);
      appendLog(dep.id, `  ${schema.file} declares ${schema.vars.length} variable(s), ${required.length} required`);
      if (schema.vars.some((v) => v.key === 'PORT')) appendLog(dep.id, '  note: PORT is injected by deployer — ignoring it from the example file');
      const provided = new Set(
        Object.entries(cfg.env)
          .filter(([, v]) => v !== '')
          .map(([k]) => k)
      );
      const missing = missingRequiredKeys(schema, provided);
      if (missing.length && app.skip_env_check !== 1) throw new NeedsEnvError(missing, schema);
      if (missing.length) {
        appendLog(
          dep.id,
          `note: ${missing.length} required variable(s) still unset (${missing.join(', ')}) — continuing because "deploy anyway" is enabled for this app`
        );
      }
    }

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

    notify(
      'deploySuccess',
      `✅ ${app.name} deployed (#${dep.id})` +
        (commit.message ? ` — ${commit.message}` : '') +
        (cfg.domainHost ? `\n${urlFor(cfg)}` : ' (worker)')
    );

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
    if (e instanceof NeedsEnvError) {
      // no ✗ prefix, no error string — this must not read as a crash
      stageLog(dep.id, 'Waiting for environment variables');
      appendLog(dep.id, `This repo's ${e.schema.file} lists ${e.missing.length} required variable(s) that are not set yet:`);
      for (const k of e.missing) {
        const spec = e.schema.vars.find((v) => v.key === k);
        appendLog(dep.id, `  • ${k}${spec?.description ? ` — ${spec.description}` : ''}`);
      }
      appendLog(dep.id, 'Nothing was built or changed. Fill these in on the Environment tab and deploy again, or choose "Deploy anyway".');
      updateDeployment(dep.id, {
        status: 'needs_env',
        failed_stage: null,
        error: null,
        env_missing_json: JSON.stringify(e.missing),
        env_schema_json: JSON.stringify(e.schema),
        finished_at: now(),
      });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'needs_env' });
      notify('needsEnv', `⏸️ ${app.name} deploy #${dep.id} is waiting for ${e.missing.length} environment variable(s): ${e.missing.join(', ')}`);
    } else if (wasCanceled) {
      stageLog(dep.id, '✗ Deployment canceled');
      updateDeployment(dep.id, { status: 'canceled', failed_stage: stage, finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'canceled' });
    } else {
      const msg = (e as Error).message;
      for (const line of msg.split('\n')) appendLog(dep.id, `✗ ${line}`);
      updateDeployment(dep.id, { status: 'failed', failed_stage: stage, error: msg.slice(0, 4000), finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'failed' });
      notify('deployFailed', `❌ ${app.name} deploy #${dep.id} failed at ${stage}: ${msg.split('\n')[0].slice(0, 300)}`);
    }
  } finally {
    clearCancelFlag(dep.id);
    closeLog(dep.id);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

/**
 * Rollback: re-run a retained image with its snapshotted config. No clone, no
 * build — the same failure guarantees as a deploy apply (health gate before
 * the old container is retired).
 */
async function runRollback(dep: DeploymentRow, app: AppRow) {
  updateDeployment(dep.id, { started_at: now(), log_file: `deploy-${dep.id}.log` });
  let startedContainer: string | null = null;
  let stage: DeploymentStatus = 'starting';

  try {
    await ensureNetwork();
    if (!dep.image_tag || !dep.config_json) throw new Error('rollback source has no retained image or config');
    const cfg = JSON.parse(dep.config_json) as ResolvedConfig;
    stageLog(dep.id, `Rolling back to image ${dep.image_tag}${dep.commit_sha ? ` (${dep.commit_sha.slice(0, 10)} — ${dep.commit_msg ?? ''})` : ''}`);

    const exists = await docker(['image', 'inspect', dep.image_tag]);
    if (exists.code !== 0) {
      throw new Error(`image ${dep.image_tag} no longer exists (pruned by retention) — redeploy that commit instead`);
    }

    setStage(dep, (stage = 'starting'));
    stageLog(dep.id, 'Starting container');
    startedContainer = await runContainer(app, dep.id, cfg, dep.image_tag);
    updateDeployment(dep.id, { container_id: startedContainer });

    setStage(dep, (stage = 'checking'));
    stageLog(dep.id, 'Health check');
    await healthGate(dep.id, cfg, startedContainer);

    await promote(app, dep, cfg);
    stageLog(dep.id, cfg.domainHost ? `✓ Rolled back — live at ${urlFor(cfg)}` : '✓ Rolled back (worker)');
    updateDeployment(dep.id, { status: 'live', finished_at: now() });
    emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'live' });
    notify('deploySuccess', `↩️ ${app.name} rolled back to ${dep.commit_sha?.slice(0, 10) ?? dep.image_tag} (#${dep.id})`);
  } catch (e) {
    const wasCanceled = e instanceof CanceledError || isCanceled(dep.id);
    if (startedContainer) {
      await removeContainer(startedContainer).catch(() => {});
      updateDeployment(dep.id, { container_id: null });
    }
    if (wasCanceled) {
      stageLog(dep.id, '✗ Rollback canceled');
      updateDeployment(dep.id, { status: 'canceled', failed_stage: stage, finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'canceled' });
    } else {
      const msg = (e as Error).message;
      for (const line of msg.split('\n')) appendLog(dep.id, `✗ ${line}`);
      updateDeployment(dep.id, { status: 'failed', failed_stage: stage, error: msg.slice(0, 4000), finished_at: now() });
      emitEvent({ type: 'deployment', appId: app.id, deploymentId: dep.id, status: 'failed' });
      notify('deployFailed', `❌ ${app.name} rollback #${dep.id} failed: ${msg.split('\n')[0].slice(0, 300)}`);
    }
  } finally {
    clearCancelFlag(dep.id);
    closeLog(dep.id);
  }
}

function urlFor(cfg: ResolvedConfig): string {
  return `${config.publicScheme}://${cfg.domainHost}`;
}

/** What the currently-live deployment resolved to, so detection can't demote it. */
function activeResolvedType(app: AppRow): AppType | null {
  if (!app.active_deployment_id) return null;
  const active = getDeployment(app.active_deployment_id);
  if (!active?.config_json) return null;
  try {
    return (JSON.parse(active.config_json) as Partial<ResolvedConfig>).type ?? null;
  } catch {
    return null;
  }
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
