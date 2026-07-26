import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, now } from '../db/db.js';

/**
 * API tokens for the CLI and CI. Only the sha256 of a token is stored; the
 * plaintext is shown exactly once at creation. Tokens authenticate via
 * `Authorization: Bearer dpl_...` and grant the same access as the dashboard
 * session (single-admin tool — there is nothing narrower to grant).
 */

interface TokenRow {
  id: number;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const lastTouched = new Map<number, number>();

export function bearerTokenValid(req: FastifyRequest): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token.startsWith('dpl_')) return false;
  const row = getDb().prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(hash(token)) as { id: number } | undefined;
  if (!row) return false;
  // touch last_used_at at most once a minute per token
  const last = lastTouched.get(row.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastTouched.set(row.id, Date.now());
    getDb().prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  }
  return true;
}

export async function tokenRoutes(f: FastifyInstance) {
  f.get('/tokens', async () => {
    const rows = getDb().prepare('SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY id DESC').all() as Omit<TokenRow, 'token_hash'>[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  });

  f.post('/tokens', async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'name required' });
    const token = `dpl_${crypto.randomBytes(24).toString('base64url')}`;
    getDb().prepare('INSERT INTO api_tokens (name, token_hash, created_at) VALUES (?, ?, ?)').run(body.data.name.trim(), hash(token), now());
    // the only time the plaintext ever leaves the server
    reply.code(201).send({ token, name: body.data.name.trim() });
  });

  f.delete('/tokens/:id', async (req, reply) => {
    const res = getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(Number((req.params as any).id));
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    reply.code(204).send();
  });
}
