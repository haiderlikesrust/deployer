import { getDb, now } from './db.js';
import { IN_FLIGHT_STATUSES, type AppRow, type DeploymentRow, type EnvSchema, type EnvVarRow } from '../types.js';

// ---------- apps ----------

export interface CreateAppInput {
  name: string;
  repo_url: string;
  branch: string;
  type: string | null;
  domain: string | null;
  port: number | null;
  root_dir: string | null;
  git_token: string | null;
}

export function createApp(input: CreateAppInput): AppRow {
  const ts = now();
  const res = getDb()
    .prepare(
      `INSERT INTO apps (name, repo_url, branch, type, domain, port, root_dir, git_token, created_at, updated_at)
       VALUES (@name, @repo_url, @branch, @type, @domain, @port, @root_dir, @git_token, @ts, @ts)`
    )
    .run({ ...input, ts });
  return getApp(Number(res.lastInsertRowid))!;
}

export function getApp(id: number): AppRow | null {
  return (getDb().prepare('SELECT * FROM apps WHERE id = ?').get(id) as AppRow) ?? null;
}

export function getAppByName(name: string): AppRow | null {
  return (getDb().prepare('SELECT * FROM apps WHERE name = ?').get(name) as AppRow) ?? null;
}

export function listApps(): AppRow[] {
  return getDb().prepare('SELECT * FROM apps ORDER BY name').all() as AppRow[];
}

const APP_PATCH_COLUMNS = [
  'repo_url',
  'branch',
  'type',
  'domain',
  'port',
  'build_cmd',
  'start_cmd',
  'healthcheck_path',
  'dockerfile_path',
  'root_dir',
  'memory_limit',
  'git_token',
  'webhook_secret',
  'skip_env_check',
  'env_schema_json',
  'env_schema_detected_at',
] as const;

export type AppPatch = Partial<Record<(typeof APP_PATCH_COLUMNS)[number], string | number | null>>;

export function updateApp(id: number, patch: AppPatch): AppRow | null {
  const keys = Object.keys(patch).filter((k) => (APP_PATCH_COLUMNS as readonly string[]).includes(k));
  if (keys.length > 0) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    getDb()
      .prepare(`UPDATE apps SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, updated_at: now(), id });
  }
  return getApp(id);
}

/** Cache the parsed env-example schema so the UI can show it before a successful deploy. */
export function setAppEnvSchema(appId: number, schema: EnvSchema | null) {
  updateApp(appId, { env_schema_json: schema ? JSON.stringify(schema) : null, env_schema_detected_at: now() });
}

export function setActiveDeployment(appId: number, deploymentId: number | null) {
  getDb().prepare('UPDATE apps SET active_deployment_id = ?, updated_at = ? WHERE id = ?').run(deploymentId, now(), appId);
}

export function deleteApp(id: number) {
  getDb().prepare('DELETE FROM apps WHERE id = ?').run(id);
}

// ---------- env vars ----------

export function getEnvVars(appId: number): EnvVarRow[] {
  return getDb().prepare('SELECT * FROM env_vars WHERE app_id = ? ORDER BY key').all(appId) as EnvVarRow[];
}

export function replaceEnvVars(appId: number, vars: { key: string; value: string }[]) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM env_vars WHERE app_id = ?').run(appId);
    const ins = db.prepare('INSERT INTO env_vars (app_id, key, value) VALUES (?, ?, ?)');
    for (const v of vars) ins.run(appId, v.key, v.value);
  })();
}

// ---------- deployments ----------

export function createDeployment(appId: number, trigger: DeploymentRow['trigger']): DeploymentRow {
  const res = getDb()
    .prepare(`INSERT INTO deployments (app_id, status, trigger, created_at) VALUES (?, 'queued', ?, ?)`)
    .run(appId, trigger, now());
  return getDeployment(Number(res.lastInsertRowid))!;
}

/**
 * Rollback rows are born with the source deployment's image and resolved
 * config: the pipeline skips clone/resolve/build entirely and re-runs exactly
 * what shipped before — including its env snapshot.
 */
export function createRollbackDeployment(appId: number, source: DeploymentRow): DeploymentRow {
  const res = getDb()
    .prepare(
      `INSERT INTO deployments (app_id, status, trigger, commit_sha, commit_msg, config_json, image_tag, created_at)
       VALUES (?, 'queued', 'rollback', ?, ?, ?, ?, ?)`
    )
    .run(appId, source.commit_sha, source.commit_msg, source.config_json, source.image_tag, now());
  return getDeployment(Number(res.lastInsertRowid))!;
}

export function getDeployment(id: number): DeploymentRow | null {
  return (getDb().prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow) ?? null;
}

export function listDeployments(appId: number, limit = 20, beforeId?: number): DeploymentRow[] {
  if (beforeId) {
    return getDb()
      .prepare('SELECT * FROM deployments WHERE app_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(appId, beforeId, limit) as DeploymentRow[];
  }
  return getDb().prepare('SELECT * FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT ?').all(appId, limit) as DeploymentRow[];
}

export type DeploymentPatch = Partial<
  Pick<
    DeploymentRow,
    | 'status'
    | 'failed_stage'
    | 'error'
    | 'commit_sha'
    | 'commit_msg'
    | 'config_json'
    | 'image_tag'
    | 'container_id'
    | 'log_file'
    | 'env_schema_json'
    | 'env_missing_json'
    | 'started_at'
    | 'finished_at'
  >
>;

export function updateDeployment(id: number, patch: DeploymentPatch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE deployments SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function queuedDeploymentForApp(appId: number): DeploymentRow | null {
  return (
    (getDb().prepare(`SELECT * FROM deployments WHERE app_id = ? AND status = 'queued' ORDER BY id DESC LIMIT 1`).get(appId) as DeploymentRow) ??
    null
  );
}

export function inFlightDeploymentForApp(appId: number): DeploymentRow | null {
  const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',');
  return (
    (getDb()
      .prepare(`SELECT * FROM deployments WHERE app_id = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1`)
      .get(appId, ...IN_FLIGHT_STATUSES) as DeploymentRow) ?? null
  );
}

export function latestDeploymentForApp(appId: number): DeploymentRow | null {
  return (
    (getDb().prepare('SELECT * FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT 1').get(appId) as DeploymentRow) ?? null
  );
}

/** Boot reconciliation: anything mid-flight when the process died is failed. */
export function markInterruptedDeployments(): number {
  const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',');
  const res = getDb()
    .prepare(
      `UPDATE deployments SET failed_stage = status, status = 'failed', error = 'interrupted by deployer restart', finished_at = ?
       WHERE status IN (${placeholders})`
    )
    .run(now(), ...IN_FLIGHT_STATUSES);
  return res.changes;
}
