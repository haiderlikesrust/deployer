export type AppType = 'web' | 'worker' | 'static';

export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'resolving'
  | 'building'
  | 'starting'
  | 'checking'
  | 'live'
  | 'superseded'
  | 'failed'
  | 'canceled';

/** Statuses that mean "this deployment is still moving through the pipeline". */
export const IN_FLIGHT_STATUSES: DeploymentStatus[] = ['queued', 'cloning', 'resolving', 'building', 'starting', 'checking'];

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
  created_at: string;
  updated_at: string;
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
  trigger: 'manual' | 'webhook';
  commit_sha: string | null;
  commit_msg: string | null;
  config_json: string | null;
  image_tag: string | null;
  container_id: string | null;
  log_file: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type Builder = 'dockerfile' | 'node' | 'node-static' | 'python' | 'static';

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
}
