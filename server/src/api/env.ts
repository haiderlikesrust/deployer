import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getApp, getEnvVars, replaceEnvVars } from '../db/repo.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const putSchema = z.object({
  vars: z
    .array(
      z.object({
        key: z.string().regex(ENV_KEY_RE, 'invalid env var name'),
        value: z.string().max(10000).refine((v) => !/[\n\r]/.test(v), 'values must be single-line'),
      })
    )
    .max(200),
});

export async function envRoutes(f: FastifyInstance) {
  f.get('/apps/:id/env', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    return getEnvVars(app.id).map((v) => ({ key: v.key, value: v.value }));
  });

  f.put('/apps/:id/env', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const body = putSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });

    // last occurrence of a duplicated key wins
    const deduped = new Map<string, string>();
    for (const v of body.data.vars) deduped.set(v.key, v.value);
    replaceEnvVars(
      app.id,
      [...deduped.entries()].map(([key, value]) => ({ key, value }))
    );
    return { ok: true, redeployRequired: !!app.active_deployment_id };
  });
}
