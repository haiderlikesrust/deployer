export type AppType = 'web' | 'worker' | 'static';

export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'resolving'
  | 'building'
  /** Running the release command (migrations) — after build, before the swap. */
  | 'releasing'
  | 'starting'
  | 'checking'
  /** Terminal, and deliberately not a failure: required env vars were missing, so nothing was built. */
  | 'needs_env'
  | 'live'
  | 'superseded'
  | 'failed'
  | 'canceled';

/**
 * Statuses that mean "this deployment is still moving through the pipeline".
 * 'needs_env' is terminal, so it stays out — that alone makes the boot
 * reconciler, the cancel path and the app status computation behave.
 */
export const IN_FLIGHT_STATUSES: DeploymentStatus[] = ['queued', 'cloning', 'resolving', 'building', 'releasing', 'starting', 'checking'];

export interface AppRow {
  id: number;
  name: string;
  repo_url: string;
  branch: string;
  type: AppType | null; // null = auto-detect
  domain: string | null;
  port: number | null;
  build_cmd: string | null;
  start_cmd: string | null;
  healthcheck_path: string | null;
  dockerfile_path: string | null;
  /** Subdirectory of the repo to build from (monorepos). null = repo root. */
  root_dir: string | null;
  memory_limit: string | null;
  git_token: string | null;
  webhook_secret: string | null;
  active_deployment_id: number | null;
  /** Latest parsed .env.example schema (JSON of EnvSchema); null = repo has none. */
  env_schema_json: string | null;
  env_schema_detected_at: string | null;
  /** 1 = user chose "deploy anyway"; the .env.example gate is skipped. */
  skip_env_check: number;
  /** JSON array of {name, path} — named volumes mounted into the container. */
  volumes_json: string | null;
  /** Runs in a one-off container after build, before the swap (migrations). */
  release_cmd: string | null;
  /** 1 = webhook pushes to other branches spawn preview apps. */
  preview_branches: number;
  /** Set on preview apps: the app they were spawned from. */
  parent_app_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface AppVolume {
  name: string;
  path: string;
}

export type ServiceType = 'postgres' | 'redis' | 'mongo';

export interface ServiceRow {
  id: number;
  name: string;
  type: ServiceType;
  version: string;
  password: string;
  created_at: string;
}

export interface ServiceLinkRow {
  id: number;
  service_id: number;
  app_id: number;
  env_key: string;
}

export interface EnvVarRow {
  id: number;
  app_id: number;
  key: string;
  value: string;
}

export interface DeploymentRow {
  id: number;
  app_id: number;
  status: DeploymentStatus;
  failed_stage: string | null;
  error: string | null;
  trigger: 'manual' | 'webhook' | 'rollback';
  commit_sha: string | null;
  commit_msg: string | null;
  config_json: string | null;
  image_tag: string | null;
  container_id: string | null;
  log_file: string | null;
  /** Snapshot of the env-example schema at this commit. */
  env_schema_json: string | null;
  /** JSON string[] of required keys that were unset; only set on 'needs_env'. */
  env_missing_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** One variable declared by a repo's .env.example (or equivalent). */
export interface EnvVarSpec {
  key: string;
  required: boolean;
  description: string | null;
  /** Concrete default from the file; null when the value was a placeholder. */
  example: string | null;
  /** Name heuristic — a UI masking hint, nothing more. */
  secret: boolean;
  group: string | null;
  commentedOut: boolean;
}

export interface EnvSchema {
  /** Path relative to the resolved build root. */
  file: string;
  detectedAt: string;
  commitSha: string | null;
  vars: EnvVarSpec[];
}

export type Builder = 'dockerfile' | 'node' | 'node-static' | 'python' | 'rust' | 'go' | 'static';

export type ConfigSource = 'ui' | 'yml' | 'auto';

/** The fully merged per-deployment config, snapshotted into deployments.config_json. */
export interface ResolvedConfig {
  type: AppType;
  /** Host the app is routed on (null for workers). */
  domainHost: string | null;
  /** Port the app listens on INSIDE the container (never published to the host). */
  containerPort: number;
  buildCmd: string | null;
  startCmd: string | null;
  healthPath: string | null;
  /** Merged env (deploy.yml env <- dashboard env), PORT injected. */
  env: Record<string, string>;
  builder: Builder;
  /** Relative path of the Dockerfile when builder = 'dockerfile'. */
  dockerfilePath: string | null;
  /** Where each decisive key came from, for the "why did it pick X" panel. */
  sources: Record<string, ConfigSource>;
  /** Human-readable detection notes, printed into the build log. */
  notes: string[];
  /** Why this app type was chosen — printed to the build log and shown in the UI. */
  typeReason: string;
  /** The signal that proved this serves HTTP; null for workers and static sites. */
  webEvidence: string | null;
  /** Named volumes mounted at deploy time; volumes force a stop-then-start swap. */
  volumes: AppVolume[];
  /** One-off command run after build, before the swap (migrations). */
  releaseCmd: string | null;
}
