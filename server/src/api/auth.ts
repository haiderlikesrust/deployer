import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getSetting } from '../db/db.js';

export const SESSION_COOKIE = 'dep_session';
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 64));
  } catch {
    return false;
  }
}

export function isAuthed(req: FastifyRequest): boolean {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  const issuedAt = parseInt(unsigned.value, 10);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < SESSION_MAX_AGE_S * 1000;
}

/** Routes that skip the session gate. */
const PUBLIC_PREFIXES = ['/api/auth/login', '/api/health', '/api/hooks/'];

export async function authGate(req: FastifyRequest, reply: FastifyReply) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/')) return; // SPA assets
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return;
  if (!isAuthed(req)) {
    reply.code(401).send({ error: 'unauthorized' });
  }
}

// naive per-IP limiter — one admin user, this only needs to stop dumb brute force
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export async function authRoutes(f: FastifyInstance) {
  f.post('/auth/login', async (req, reply) => {
    const ip = req.ip;
    const nowMs = Date.now();
    const entry = attempts.get(ip);
    if (entry && entry.resetAt > nowMs && entry.count >= MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'too many attempts — try again later' });
    }

    const body = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'password required' });

    const stored = getSetting('admin_password_hash');
    if (!stored || !verifyPassword(body.data.password, stored)) {
      const e = entry && entry.resetAt > nowMs ? entry : { count: 0, resetAt: nowMs + WINDOW_MS };
      e.count += 1;
      attempts.set(ip, e);
      return reply.code(401).send({ error: 'wrong password' });
    }

    attempts.delete(ip);
    // Derive Secure from how the BROWSER reached us (X-Forwarded-Proto via
    // trustProxy), not from our own TLS mode — behind an external terminator
    // (nginx fallback) the deployer speaks HTTP while the browser speaks HTTPS.
    reply
      .setCookie(SESSION_COOKIE, String(Date.now()), {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        secure: req.protocol === 'https' || config.publicScheme === 'https',
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
      })
      .send({ ok: true });
  });

  f.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  f.get('/auth/me', async (req, reply) => {
    // authGate already ran — reaching here means the session is valid
    reply.send({ authenticated: true });
  });
}
