import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appHost, appUrl } from '../config.js';
import {
  createApp,
  deleteApp,
  getApp,
  getAppByName,
  inFlightDeploymentForApp,
  latestDeploymentForApp,
  getDeployment,
  listApps,
  listDeployments,
  updateApp,
  type AppPatch,
} from '../db/repo.js';
import type { AppRow, DeploymentRow } from '../types.js';
import { cancelAllForApp, enqueueDeploy } from '../core/queue.js';
import { sweepAppResources } from '../core/cleanup.js';
import { deleteLogFile } from '../core/buildlogs.js';
import { registerSecret, forgetSecret } from '../core/secrets.js';
import {
  inspectContainer,
  listManagedContainers,
  parseLabels,
  restartContainer,
  startContainer,
  stopContainer,
} from '../core/docker.js';
import { emitEvent } from '../core/events.js';

const RESERVED_NAMES = ['deploy', 'deployer', 'traefik', 'www'];
const NAME_RE = /^[a-z][a-z0-9-]{0,30}(?<!-)$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\n\r]/.test(s), 'must be a single line');

const createSchema = z.object({
  repoUrl: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => !/\s/.test(s), 'repo URL must not contain whitespace'),
  name: z.string().regex(NAME_RE, 'name must be a DNS-safe slug (a-z, 0-9, dashes)').optional(),
  branch: singleLine(100).optional(),
  type: z.enum(['web', 'worker', 'static']).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  domain: z.string().regex(DOMAIN_RE, 'invalid domain').nullish(),
  gitToken: singleLine(300).nullish(),
});

const patchSchema = z.object({
  repoUrl: createSchema.shape.repoUrl.optional(),
  branch: singleLine(100).optional(),
  type: z.enum(['web', 'worker', 'static']).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  domain: z.string().regex(DOMAIN_RE, 'invalid domain').nullish(),
  buildCmd: singleLine(500).nullish(),
  startCmd: singleLine(500).nullish(),
  healthPath: z.string().max(200).regex(/^\/[^\s]*$/, 'must be a path starting with /').nullish(),
  dockerfilePath: singleLine(200).nullish(),
  memoryLimit: z.string().regex(/^\d+[bkmg]?$/i, 'e.g. 512m or 1g').nullish(),
  gitToken: singleLine(300).nullish(),
});

function slugFromRepoUrl(url: string): string {
  const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? 'app';
  const slug = last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return slug.match(/^[a-z]/) ? slug : `app-${slug}`.slice(0, 28);
}

function uniqueName(base: string): string {
  let name = base || 'app';
  let i = 2;
  while (getAppByName(name) || RESERVED_NAMES.includes(name)) {
    name = `${base}-${i++}`;
  }
  return name;
}

export type AppStatus = 'deploying' | 'live' | 'stopped' | 'failed' | 'new';

function deploymentSummary(d: DeploymentRow | null) {
  if (!d) return null;
  return {
    id: d.id,
    status: d.status,
    failedStage: d.failed_stage,
    error: d.error,
    commitSha: d.commit_sha?.slice(0, 10) ?? null,
    commitMsg: d.commit_msg,
    createdAt: d.created_at,
    finishedAt: d.finished_at,
  };
}

export function appView(app: AppRow, extra: Record<string, unknown> = {}) {
  const { git_token, ...rest } = app;
  return {
    id: app.id,
    name: app.name,
    repoUrl: app.repo_url,
    branch: app.branch,
    type: app.type,
    domain: app.domain,
    effectiveHost: appHost(app.name, app.domain),
    url: appUrl(app.name, app.domain),
    port: app.port,
    buildCmd: app.build_cmd,
    startCmd: app.start_cmd,
    healthPath: app.healthcheck_path,
    dockerfilePath: app.dockerfile_path,
    memoryLimit: app.memory_limit,
    hasGitToken: !!git_token,
    activeDeploymentId: app.active_deployment_id,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
    ...extra,
  };
}

async function computeStatuses(apps: AppRow[]): Promise<Map<number, AppStatus>> {
  const running = new Set<string>();
  try {
    for (const c of await listManagedContainers()) {
      if (c.State === 'running') running.add(c.Names);
    }
  } catch {
    // docker down — statuses degrade gracefully
  }
  const map = new Map<number, AppStatus>();
  for (const app of apps) {
    if (inFlightDeploymentForApp(app.id)) {
      map.set(app.id, 'deploying');
      continue;
    }
    if (app.active_deployment_id) {
      const name = `dep-${app.name}-${app.active_deployment_id}`;
      map.set(app.id, running.has(name) ? 'live' : 'stopped');
      continue;
    }
    const last = latestDeploymentForApp(app.id);
    map.set(app.id, last?.status === 'failed' ? 'failed' : 'new');
  }
  return map;
}

export async function appRoutes(f: FastifyInstance) {
  f.get('/apps', async () => {
    const apps = listApps();
    const statuses = await computeStatuses(apps);
    return apps.map((a) =>
      appView(a, {
        status: statuses.get(a.id) ?? 'new',
        lastDeployment: deploymentSummary(latestDeploymentForApp(a.id)),
      })
    );
  });

  f.post('/apps', async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    const d = body.data;

    let name: string;
    if (d.name) {
      if (RESERVED_NAMES.includes(d.name)) return reply.code(400).send({ error: `'${d.name}' is reserved` });
      if (getAppByName(d.name)) return reply.code(409).send({ error: `an app named '${d.name}' already exists` });
      name = d.name;
    } else {
      name = uniqueName(slugFromRepoUrl(d.repoUrl));
    }

    const app = createApp({
      name,
      repo_url: d.repoUrl,
      branch: d.branch?.trim() ?? '',
      type: d.type ?? null,
      domain: d.domain?.toLowerCase() ?? null,
      port: d.port ?? null,
      git_token: d.gitToken?.trim() || null,
    });
    registerSecret(app.git_token);
    const dep = enqueueDeploy(app.id, 'manual');
    reply.code(201).send({ app: appView(app, { status: 'deploying' }), deploymentId: dep.id });
  });

  f.get('/apps/:id', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const statuses = await computeStatuses([app]);
    const active = app.active_deployment_id ? getDeployment(app.active_deployment_id) : null;
    const container = active?.container_id ? await inspectContainer(active.container_id) : null;
    return appView(app, {
      status: statuses.get(app.id) ?? 'new',
      activeDeployment: deploymentSummary(active),
      lastDeployment: deploymentSummary(latestDeploymentForApp(app.id)),
      container: container ? { running: container.running, status: container.status, startedAt: container.startedAt } : null,
    });
  });

  f.patch('/apps/:id', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    const d = body.data;

    const patch: AppPatch = {};
    if (d.repoUrl !== undefined) patch.repo_url = d.repoUrl;
    if (d.branch !== undefined) patch.branch = d.branch.trim();
    if (d.type !== undefined) patch.type = d.type;
    if (d.port !== undefined) patch.port = d.port;
    if (d.domain !== undefined) patch.domain = d.domain ? d.domain.toLowerCase() : null;
    if (d.buildCmd !== undefined) patch.build_cmd = d.buildCmd || null;
    if (d.startCmd !== undefined) patch.start_cmd = d.startCmd || null;
    if (d.healthPath !== undefined) patch.healthcheck_path = d.healthPath || null;
    if (d.dockerfilePath !== undefined) patch.dockerfile_path = d.dockerfilePath || null;
    if (d.memoryLimit !== undefined) patch.memory_limit = d.memoryLimit || null;
    if (d.gitToken !== undefined) {
      forgetSecret(app.git_token);
      patch.git_token = d.gitToken?.trim() || null;
      registerSecret(patch.git_token as string | null);
    }

    const updated = updateApp(app.id, patch)!;
    return appView(updated, { redeployRequired: !!updated.active_deployment_id });
  });

  f.delete('/apps/:id', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    cancelAllForApp(app.id);
    const deployments = listDeployments(app.id, 1000);
    await sweepAppResources(app.name);
    for (const d of deployments) deleteLogFile(d.id);
    forgetSecret(app.git_token);
    deleteApp(app.id);
    emitEvent({ type: 'app', appId: app.id, status: 'deleted' });
    reply.code(204).send();
  });

  f.post('/apps/:id/deploy', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const dep = enqueueDeploy(app.id, 'manual');
    reply.code(201).send({ deploymentId: dep.id });
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    f.post(`/apps/:id/${action}`, async (req, reply) => {
      const app = getApp(Number((req.params as any).id));
      if (!app) return reply.code(404).send({ error: 'not found' });
      const active = app.active_deployment_id ? getDeployment(app.active_deployment_id) : null;
      if (!active?.container_id) return reply.code(409).send({ error: 'no active container — deploy first' });
      const fn = action === 'start' ? startContainer : action === 'stop' ? stopContainer : restartContainer;
      const res = await fn(active.container_id);
      if (res.code !== 0) return reply.code(500).send({ error: res.stderr.trim() });
      emitEvent({ type: 'app', appId: app.id, status: action === 'stop' ? 'stopped' : 'live' });
      return { ok: true };
    });
  }
}
