import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/db.js';

export async function settingsRoutes(f: FastifyInstance) {
  f.get('/settings', async () => ({
    // base domain + ssl mode are static config (compose .env) — shown read-only
    baseDomain: config.baseDomain,
    sslMode: config.sslMode,
    dockerNetwork: config.dockerNetwork,
    imageRetention: parseInt(getSetting('image_retention') ?? String(config.imageRetention), 10),
    letsencryptEmail: getSetting('letsencrypt_email') ?? null,
  }));

  f.put('/settings', async (req, reply) => {
    const body = z
      .object({
        imageRetention: z.number().int().min(0).max(20).optional(),
        letsencryptEmail: z.string().email().nullish(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    if (body.data.imageRetention !== undefined) setSetting('image_retention', String(body.data.imageRetention));
    if (body.data.letsencryptEmail !== undefined) setSetting('letsencrypt_email', body.data.letsencryptEmail ?? '');
    return { ok: true };
  });
}
