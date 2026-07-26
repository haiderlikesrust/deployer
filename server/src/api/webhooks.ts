import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getApp } from '../db/repo.js';
import { enqueueDeploy } from '../core/queue.js';

/**
 * Push-to-deploy. These routes are unauthenticated by design (authGate skips
 * /api/hooks/) — the GitHub route is guarded by an HMAC over the raw body,
 * the generic route by a secret in the path. GitHub signs the RAW bytes, so
 * this plugin swaps the JSON parser for a buffer parser (parsers are
 * encapsulated per Fastify plugin — the rest of the API is unaffected).
 */
export async function webhookRoutes(f: FastifyInstance) {
  f.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  f.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  f.post('/hooks/github/:appId', async (req, reply) => {
    const app = getApp(Number((req.params as any).appId));
    // identical response whether the app is missing or has no secret — no probing
    if (!app?.webhook_secret) return reply.code(404).send({ error: 'not found' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !verifyGithubSignature(raw, app.webhook_secret, signature)) {
      return reply.code(401).send({ error: 'bad signature' });
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'push') return { ok: true, ignored: `event ${String(event)}` };

    let payload: any;
    try {
      const text = raw.toString('utf8');
      // GitHub's form-encoded delivery wraps the JSON in payload=
      payload = (req.headers['content-type'] ?? '').includes('form-urlencoded')
        ? JSON.parse(new URLSearchParams(text).get('payload') ?? '')
        : JSON.parse(text);
    } catch {
      return reply.code(400).send({ error: 'unparseable payload' });
    }

    const ref: string = payload.ref ?? '';
    if (!ref.startsWith('refs/heads/')) return { ok: true, ignored: 'not a branch push' };
    if (payload.deleted) return { ok: true, ignored: 'branch deletion' };

    const pushedBranch = ref.slice('refs/heads/'.length);
    const targetBranch = app.branch || payload.repository?.default_branch || 'main';
    if (pushedBranch !== targetBranch) {
      return { ok: true, ignored: `push to ${pushedBranch} — this app deploys ${targetBranch}` };
    }

    const dep = enqueueDeploy(app.id, 'webhook');
    return { ok: true, deploymentId: dep.id };
  });

  /** Anything that can send a POST can trigger a deploy: CI, cron, another script. */
  f.post('/hooks/deploy/:appId/:token', async (req, reply) => {
    const app = getApp(Number((req.params as any).appId));
    if (!app?.webhook_secret) return reply.code(404).send({ error: 'not found' });
    const given = String((req.params as any).token ?? '');
    if (!timingSafeEq(given, app.webhook_secret)) return reply.code(401).send({ error: 'bad token' });
    const dep = enqueueDeploy(app.id, 'webhook');
    return { ok: true, deploymentId: dep.id };
  });
}

function verifyGithubSignature(raw: Buffer, secret: string, header: string): boolean {
  if (!header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEq(header.slice('sha256='.length), expected);
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
