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

export interface DeploymentSummary {
  id: number;
  status: string;
  failedStage: string | null;
  error: string | null;
  commitSha: string | null;
  commitMsg: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface App {
  id: number;
  name: string;
  repoUrl: string;
  branch: string;
  type: string | null;
  domain: string | null;
  effectiveHost: string;
  url: string;
  port: number | null;
  buildCmd: string | null;
  startCmd: string | null;
  healthPath: string | null;
  dockerfilePath: string | null;
  memoryLimit: string | null;
  hasGitToken: boolean;
  activeDeploymentId: number | null;
  status: 'deploying' | 'live' | 'stopped' | 'failed' | 'new';
  lastDeployment?: DeploymentSummary | null;
  activeDeployment?: DeploymentSummary | null;
  container?: { running: boolean; status: string; startedAt: string | null } | null;
  createdAt: string;
}

export interface Deployment {
  id: number;
  appId: number;
  status: string;
  failedStage: string | null;
  error: string | null;
  trigger: string;
  commitSha: string | null;
  commitMsg: string | null;
  imageTag: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  config: ResolvedConfig | null;
}

export interface ResolvedConfig {
  type: string;
  domainHost: string | null;
  containerPort: number;
  buildCmd: string | null;
  startCmd: string | null;
  healthPath: string | null;
  env: Record<string, string>;
  builder: string;
  dockerfilePath: string | null;
  sources: Record<string, 'ui' | 'yml' | 'auto'>;
  notes: string[];
}

export interface SystemInfo {
  docker: { version: string; ok: boolean; error?: string };
  diskFreeBytes: number | null;
  apps: number;
  managedContainers: number;
  runningContainers: number;
  baseDomain: string;
  sslMode: string;
  probeMode: string;
}

export interface Settings {
  baseDomain: string;
  sslMode: string;
  dockerNetwork: string;
  imageRetention: number;
  letsencryptEmail: string | null;
}

export interface CreateAppInput {
  repoUrl: string;
  name?: string;
  branch?: string;
  type?: string | null;
  port?: number | null;
  domain?: string | null;
  gitToken?: string | null;
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
    deploy: (id: number) => req<{ deploymentId: number }>(`/apps/${id}/deploy`, { method: 'POST' }),
    action: (id: number, action: 'start' | 'stop' | 'restart') => req<{ ok: boolean }>(`/apps/${id}/${action}`, { method: 'POST' }),
  },

  deployments: {
    list: (appId: number, limit = 20) => req<Deployment[]>(`/apps/${appId}/deployments?limit=${limit}`),
    get: (id: number) => req<Deployment>(`/deployments/${id}`),
    log: (id: number) => req<string>(`/deployments/${id}/log`),
    cancel: (id: number) => req<{ ok: boolean }>(`/deployments/${id}/cancel`, { method: 'POST' }),
  },

  env: {
    get: (appId: number) => req<{ key: string; value: string }[]>(`/apps/${appId}/env`),
    put: (appId: number, vars: { key: string; value: string }[]) =>
      req<{ ok: boolean; redeployRequired: boolean }>(`/apps/${appId}/env`, { method: 'PUT', body: JSON.stringify({ vars }) }),
  },

  settings: {
    get: () => req<Settings>('/settings'),
    put: (patch: Partial<Pick<Settings, 'imageRetention' | 'letsencryptEmail'>>) =>
      req<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  },

  system: {
    get: () => req<SystemInfo>('/system'),
    prune: () => req<{ ok: boolean; output: string }>('/system/prune', { method: 'POST' }),
  },
};
