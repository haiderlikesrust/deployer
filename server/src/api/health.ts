import type { FastifyInstance } from 'fastify';

export async function healthRoutes(f: FastifyInstance) {
  f.get('/health', async () => ({ ok: true }));
}
