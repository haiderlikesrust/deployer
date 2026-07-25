import type { FastifyInstance } from 'fastify';
import { getApp, getDeployment, listDeployments } from '../db/repo.js';
import { cancelDeployment } from '../core/queue.js';
import { readFullLog } from '../core/buildlogs.js';
import type { DeploymentRow } from '../types.js';

function view(d: DeploymentRow) {
  return {
    id: d.id,
    appId: d.app_id,
    status: d.status,
    failedStage: d.failed_stage,
    error: d.error,
    trigger: d.trigger,
    commitSha: d.commit_sha,
    commitMsg: d.commit_msg,
    imageTag: d.image_tag,
    createdAt: d.created_at,
    startedAt: d.started_at,
    finishedAt: d.finished_at,
    config: d.config_json ? safeParse(d.config_json) : null,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function deploymentRoutes(f: FastifyInstance) {
  f.get('/apps/:id/deployments', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10) || 20));
    const before = q.before ? parseInt(q.before, 10) : undefined;
    return listDeployments(app.id, limit, before).map(view);
  });

  f.get('/deployments/:id', async (req, reply) => {
    const dep = getDeployment(Number((req.params as any).id));
    if (!dep) return reply.code(404).send({ error: 'not found' });
    return view(dep);
  });

  f.get('/deployments/:id/log', async (req, reply) => {
    const dep = getDeployment(Number((req.params as any).id));
    if (!dep) return reply.code(404).send({ error: 'not found' });
    reply.type('text/plain; charset=utf-8').send(readFullLog(dep.id));
  });

  f.post('/deployments/:id/cancel', async (req, reply) => {
    const dep = getDeployment(Number((req.params as any).id));
    if (!dep) return reply.code(404).send({ error: 'not found' });
    const ok = cancelDeployment(dep.id);
    if (!ok) return reply.code(409).send({ error: `deployment is ${dep.status} — nothing to cancel` });
    return { ok: true };
  });
}
