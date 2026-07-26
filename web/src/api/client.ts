export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('deployer:unauthorized'));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

/* ------------------------------------------------------------------ *
 * Shared unions
 * ------------------------------------------------------------------ */

export type AppType = 'web' | 'worker' | 'static';

export type AppStatus = 'deploying' | 'live' | 'stopped' | 'failed' | 'needs_env' | 'new';

export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'resolving'
  | 'building'
  | 'starting'
  | 'checking'
  /** terminal, informational — the repo declares env vars that are not set yet */
  | 'needs_env'
  | 'live'
  | 'superseded'
  | 'failed'
  | 'canceled';

export type ConfigSource = 'ui' | 'yml' | 'auto';

/* ------------------------------------------------------------------ *
 * .env.example schema
 * ------------------------------------------------------------------ */

export interface EnvVarSpec {
  key: string;
  required: boolean;
  description: string | null;
  example: string | null;
  /** name heuristic; a UI masking hint only */
  secret: boolean;
  group: string | null;
  commentedOut: boolean;
}

/** Raw snapshot as parsed at a commit. Returned on deployment endpoints. */
export interface EnvSchema {
  file: string;
  detectedAt: string;
  commitSha: string | null;
  vars: EnvVarSpec[];
}

/** App endpoints add the live comparison against the app's current env vars. */
export interface EnvSchemaFull extends EnvSchema {
  missingKeys: string[];
  satisfied: boolean;
}

/** Compact form for list rows and headers. */
export interface EnvStatus {
  file: string;
  requiredCount: number;
  missingCount: number;
  satisfied: boolean;
}

/* ------------------------------------------------------------------ *
 * Containers and deployments
 * ------------------------------------------------------------------ */

export interface ContainerInfo {
  running: boolean;
  /** docker State.Status: created | running | restarting | paused | exited | dead */
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  oomKilled: boolean;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  uptimeSeconds: number | null;
}

export interface DeploymentSummary {
  id: number;
  status: DeploymentStatus;
  failedStage: string | null;
  error: string | null;
  commitSha: string | null;
  commitMsg: string | null;
  createdAt: string;
  finishedAt: string | null;
  envMissingCount: number | null;
}

export interface ResolvedConfig {
  type: AppType;
  domainHost: string | null;
  containerPort: number;
  buildCmd: string | null;
  startCmd: string | null;
  /** always null when type === 'worker' */
  healthPath: string | null;
  env: Record<string, string>;
  builder: 'dockerfile' | 'node' | 'node-static' | 'python' | 'static' | string;
  dockerfilePath: string | null;
  sources: Record<string, ConfigSource>;
  notes: string[];
  /** absent on deployments created before worker-first detection landed */
  typeReason?: string;
  webEvidence?: string | null;
}

export interface Deployment {
  id: number;
  appId: number;
  status: DeploymentStatus;
  /** stays null for needs_env — it is not a failure */
  failedStage: string | null;
  error: string | null;
  trigger: 'manual' | 'webhook' | 'initial' | string;
  commitSha: string | null;
  commitMsg: string | null;
  imageTag: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  config: ResolvedConfig | null;
  /** non-null only on needs_env deployments */
  envMissing: string[] | null;
  envSchema: EnvSchema | null;
}

/* ------------------------------------------------------------------ *
 * Apps
 * ------------------------------------------------------------------ */

export interface App {
  id: number;
  name: string;
  repoUrl: string;
  branch: string;
  /** the explicit dashboard override only — null means "auto-detect" */
  type: AppType | null;
  /** override, else the last resolved type, else null (never resolved) */
  effectiveType: AppType | null;
  isWorker: boolean;
  domain: string | null;
  /** null when isWorker — workers get no HTTP route */
  effectiveHost: string | null;
  url: string | null;
  port: number | null;
  buildCmd: string | null;
  startCmd: string | null;
  healthPath: string | null;
  dockerfilePath: string | null;
  rootDir: string | null;
  memoryLimit: string | null;
  hasGitToken: boolean;
  activeDeploymentId: number | null;
  skipEnvCheck: boolean;
  /** null when no example file was found (or the app never resolved) */
  envStatus: EnvStatus | null;
  createdAt: string;
  updatedAt: string;
  status: AppStatus;
  lastDeployment: DeploymentSummary | null;
  /** detail endpoint only */
  activeDeployment?: DeploymentSummary | null;
  /** detail endpoint only; null when there is no active container */
  container?: ContainerInfo | null;
  /** detail endpoint only */
  envSchema?: EnvSchemaFull | null;
  webhook?: WebhookInfo | null;
  volumes?: AppVolume[];
  releaseCmd?: string | null;
  services?: LinkedService[];
  /** null = not probed; false = container up but the app is not answering */
  httpUp?: boolean | null;
}

export interface EnvSchemaResponse {
  schema: EnvSchemaFull | null;
  skipEnvCheck: boolean;
  /** null = the app has never been resolved */
  detectedAt: string | null;
}

export interface EnvPutResult {
  ok: true;
  redeployRequired: boolean;
  missingKeys: string[];
  envSatisfied: boolean;
}

/* ------------------------------------------------------------------ *
 * System / settings
 * ------------------------------------------------------------------ */

export interface SystemInfo {
  docker: { version: string; ok: boolean; error?: string };
  diskFreeBytes: number | null;
  apps: number;
  managedContainers: number;
  runningContainers: number;
  baseDomain: string;
  sslMode: string;
  publicScheme?: string;
  docsUrl?: string | null;
  probeMode: string;
}

export interface NotifyEvents {
  deploySuccess: boolean;
  deployFailed: boolean;
  needsEnv: boolean;
  crashLoop: boolean;
  reachability: boolean;
}

export interface Settings {
  baseDomain: string;
  sslMode: string;
  dockerNetwork: string;
  imageRetention: number;
  letsencryptEmail: string | null;
  notifications: {
    telegramConfigured: boolean;
    telegramChat: string | null;
    discordConfigured: boolean;
    events: NotifyEvents;
  };
}

export interface WebhookInfo {
  secret: string;
  githubUrl: string;
  genericUrl: string;
}

export interface AppVolume {
  name: string;
  path: string;
}

export interface LinkedService {
  serviceId: number;
  name: string;
  type: string;
  envKey: string;
}

export interface Service {
  id: number;
  name: string;
  type: 'postgres' | 'redis' | 'mongo';
  version: string;
  createdAt: string;
  host: string;
  running: boolean;
  status: string;
  url: string;
  links: { appId: number; appName: string; envKey: string }[];
  backups?: ServiceBackup[];
}

export interface ServiceBackup {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

export interface CreateAppInput {
  repoUrl: string;
  name?: string;
  branch?: string;
  type?: AppType | string | null;
  port?: number | null;
  domain?: string | null;
  rootDir?: string | null;
  gitToken?: string | null;
}

/** `event: update` payload on /api/events. */
export interface SseUpdate {
  type: 'deployment' | 'app';
  appId: number;
  deploymentId?: number;
  status: string;
  ts: number;
}

export const Api = {
  login: (password: string) => req<{ ok: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => req<{ authenticated: boolean }>('/auth/me'),

  apps: {
    list: () => req<App[]>('/apps'),
    get: (id: number) => req<App>(`/apps/${id}`),
    create: (input: CreateAppInput) => req<{ app: App; deploymentId: number }>('/apps', { method: 'POST', body: JSON.stringify(input) }),
    patch: (id: number, patch: Record<string, unknown>) => req<App & { redeployRequired?: boolean }>(`/apps/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: number) => req<void>(`/apps/${id}`, { method: 'DELETE' }),
    /** `skipEnvCheck: true` persists the "deploy anyway" flag before enqueueing. */
    deploy: (id: number, opts?: { skipEnvCheck?: boolean }) =>
      req<{ deploymentId: number }>(`/apps/${id}/deploy`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
    envSchema: (id: number) => req<EnvSchemaResponse>(`/apps/${id}/env-schema`),
    regenerateWebhook: (id: number) => req<{ webhook: WebhookInfo }>(`/apps/${id}/webhook/regenerate`, { method: 'POST' }),
    metrics: (id: number, range: '1h' | '24h' = '1h') =>
      req<{ range: number; points: { ts: number; cpuPct: number; memBytes: number }[] }>(`/apps/${id}/metrics?range=${range}`),
    logsHistory: (id: number, q: string, limit = 300) =>
      req<{ lines: string[]; scannedBytes: number }>(`/apps/${id}/logs/history?q=${encodeURIComponent(q)}&limit=${limit}`),
    action: (id: number, action: 'start' | 'stop' | 'restart') => req<{ ok: boolean }>(`/apps/${id}/${action}`, { method: 'POST' }),
  },

  deployments: {
    list: (appId: number, limit = 20) => req<Deployment[]>(`/apps/${appId}/deployments?limit=${limit}`),
    get: (id: number) => req<Deployment>(`/deployments/${id}`),
    log: (id: number) => req<string>(`/deployments/${id}/log`),
    cancel: (id: number) => req<{ ok: boolean }>(`/deployments/${id}/cancel`, { method: 'POST' }),
    rollback: (id: number) => req<{ deploymentId: number }>(`/deployments/${id}/rollback`, { method: 'POST' }),
  },

  env: {
    get: (appId: number) => req<{ key: string; value: string }[]>(`/apps/${appId}/env`),
    put: (appId: number, vars: { key: string; value: string }[]) =>
      req<EnvPutResult>(`/apps/${appId}/env`, { method: 'PUT', body: JSON.stringify({ vars }) }),
  },

  settings: {
    get: () => req<Settings>('/settings'),
    put: (patch: {
      imageRetention?: number;
      letsencryptEmail?: string | null;
      telegramToken?: string;
      telegramChat?: string;
      discordWebhook?: string;
      notifyEvents?: Partial<NotifyEvents>;
    }) => req<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    notifyTest: () => req<{ ok: boolean; errors: string[] }>('/settings/notify-test', { method: 'POST' }),
  },

  services: {
    list: () => req<Service[]>('/services'),
    get: (id: number) => req<Service>(`/services/${id}`),
    create: (input: { name: string; type: string; version?: string }) =>
      req<Service>('/services', { method: 'POST', body: JSON.stringify(input) }),
    remove: (id: number, force = false) => req<void>(`/services/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    start: (id: number) => req<{ ok: boolean }>(`/services/${id}/start`, { method: 'POST' }),
    link: (id: number, appId: number, envKey?: string) =>
      req<{ ok: boolean }>(`/services/${id}/link`, { method: 'POST', body: JSON.stringify({ appId, envKey }) }),
    unlink: (id: number, appId: number) =>
      req<{ ok: boolean }>(`/services/${id}/unlink`, { method: 'POST', body: JSON.stringify({ appId }) }),
    backup: (id: number) => req<{ ok: boolean; backup: ServiceBackup }>(`/services/${id}/backup`, { method: 'POST' }),
    backupUrl: (id: number, file: string) => `/api/services/${id}/backups/${encodeURIComponent(file)}`,
  },

  system: {
    get: () => req<SystemInfo>('/system'),
    prune: () => req<{ ok: boolean; output: string }>('/system/prune', { method: 'POST' }),
  },
};
