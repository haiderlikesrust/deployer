import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  backupPath,
  backupService,
  containerName,
  createService,
  defaultEnvKey,
  deleteService,
  getService,
  getServiceByName,
  linkService,
  linksForService,
  listBackups,
  listServices,
  serviceState,
  serviceUrl,
  startServiceContainer,
  unlinkService,
} from '../core/services.js';
import { getApp } from '../db/repo.js';
import type { ServiceRow } from '../types.js';

const NAME_RE = /^[a-z][a-z0-9-]{0,24}(?<!-)$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function view(svc: ServiceRow) {
  const state = await serviceState(svc);
  return {
    id: svc.id,
    name: svc.name,
    type: svc.type,
    version: svc.version,
    createdAt: svc.created_at,
    host: containerName(svc.name),
    running: !!state?.running,
    status: state?.status ?? 'missing',
    // the URL contains the password — the dashboard masks it until revealed
    url: serviceUrl(svc),
    links: linksForService(svc.id).map((l) => {
      const app = getApp(l.app_id);
      return app ? { appId: app.id, appName: app.name, envKey: l.env_key } : null;
    }).filter(Boolean),
  };
}

export async function serviceRoutes(f: FastifyInstance) {
  f.get('/services', async () => Promise.all(listServices().map(view)));

  f.post('/services', async (req, reply) => {
    const body = z
      .object({
        name: z.string().regex(NAME_RE, 'name must be a short dns-safe slug'),
        type: z.enum(['postgres', 'redis', 'mongo']),
        version: z.string().max(20).regex(/^[A-Za-z0-9.-]*$/).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    if (getServiceByName(body.data.name)) return reply.code(409).send({ error: `a service named '${body.data.name}' already exists` });
    const svc = await createService(body.data.name, body.data.type, body.data.version);
    reply.code(201).send(await view(svc));
  });

  f.get('/services/:id', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    return { ...(await view(svc)), backups: listBackups(svc) };
  });

  f.delete('/services/:id', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    const linked = linksForService(svc.id);
    if (linked.length > 0 && (req.query as any)?.force !== 'true') {
      return reply.code(409).send({ error: `still linked to ${linked.length} app(s) — unlink them first, or pass ?force=true` });
    }
    await deleteService(svc);
    reply.code(204).send();
  });

  f.post('/services/:id/start', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    await startServiceContainer(svc);
    return { ok: true };
  });

  f.post('/services/:id/link', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    const body = z
      .object({
        appId: z.number().int(),
        envKey: z.string().regex(ENV_KEY_RE, 'invalid env var name').optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    const app = getApp(body.data.appId);
    if (!app) return reply.code(404).send({ error: 'app not found' });
    linkService(svc.id, app.id, body.data.envKey ?? defaultEnvKey(svc.type));
    return { ok: true, redeployRequired: true };
  });

  f.post('/services/:id/unlink', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    const body = z.object({ appId: z.number().int() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'appId required' });
    unlinkService(svc.id, body.data.appId);
    return { ok: true, redeployRequired: true };
  });

  f.post('/services/:id/backup', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    const backup = await backupService(svc);
    return { ok: true, backup };
  });

  f.get('/services/:id/backups/:file', async (req, reply) => {
    const svc = getService(Number((req.params as any).id));
    if (!svc) return reply.code(404).send({ error: 'not found' });
    const file = String((req.params as any).file);
    // only this service's own backups are downloadable through its route
    if (!file.startsWith(`${svc.name}-`) || file.includes('/') || file.includes('\\')) {
      return reply.code(404).send({ error: 'not found' });
    }
    const full = backupPath(file);
    if (!fs.existsSync(full)) return reply.code(404).send({ error: 'not found' });
    reply.header('content-disposition', `attachment; filename="${file}"`);
    reply.type('application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });
}
