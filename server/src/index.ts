import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getDb, getSetting, setSetting } from './db/db.js';
import { listApps } from './db/repo.js';
import { registerSecret } from './core/secrets.js';
import { bootReconcile } from './core/cleanup.js';
import { authGate, authRoutes, hashPassword } from './api/auth.js';
import { appRoutes } from './api/apps.js';
import { deploymentRoutes } from './api/deployments.js';
import { envRoutes } from './api/env.js';
import { settingsRoutes } from './api/settings.js';
import { systemRoutes } from './api/system.js';
import { sseRoutes } from './api/sse.js';
import { healthRoutes } from './api/health.js';
import { webhookRoutes } from './api/webhooks.js';
import { serviceRoutes } from './api/services.js';
import { tokenRoutes } from './api/tokens.js';
import { startCrashWatcher } from './core/notify.js';
import { reconcileServices, startBackupSchedule } from './core/services.js';
import { startObservers } from './core/observe.js';

async function main() {
  getDb(); // opens + migrates + creates data dirs

  // --- first-boot bootstrap ---
  let sessionKey = getSetting('session_key');
  if (!sessionKey) {
    sessionKey = crypto.randomBytes(32).toString('hex');
    setSetting('session_key', sessionKey);
  }
  if (!getSetting('admin_password_hash')) {
    const pw = config.adminPasswordBootstrap ?? crypto.randomBytes(9).toString('base64url');
    setSetting('admin_password_hash', hashPassword(pw));
    if (!config.adminPasswordBootstrap) {
      // eslint-disable-next-line no-console
      console.log(`\n============================================\n  deployer admin password: ${pw}\n  (change it by setting ADMIN_PASSWORD and\n   deleting the admin_password_hash setting)\n============================================\n`);
    }
  }

  // git tokens must never leak into logs
  for (const app of listApps()) registerSecret(app.git_token);

  const f = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true, // behind traefik
    bodyLimit: 1024 * 1024,
  });

  await f.register(fastifyCookie, { secret: sessionKey });
  f.addHook('onRequest', authGate);

  await f.register(authRoutes, { prefix: '/api' });
  await f.register(healthRoutes, { prefix: '/api' });
  await f.register(appRoutes, { prefix: '/api' });
  await f.register(deploymentRoutes, { prefix: '/api' });
  await f.register(envRoutes, { prefix: '/api' });
  await f.register(settingsRoutes, { prefix: '/api' });
  await f.register(systemRoutes, { prefix: '/api' });
  await f.register(sseRoutes, { prefix: '/api' });
  await f.register(webhookRoutes, { prefix: '/api' });
  await f.register(serviceRoutes, { prefix: '/api' });
  await f.register(tokenRoutes, { prefix: '/api' });

  // --- built dashboard (same origin — no CORS, cookie auth just works) ---
  const webDist = process.env.WEB_DIST ?? path.resolve(import.meta.dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await f.register(fastifyStatic, { root: webDist, index: ['index.html'] });
    f.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html'); // SPA fallback
      }
      reply.code(404).send({ error: 'not found' });
    });
    f.log.info(`serving dashboard from ${webDist}`);
  } else {
    f.log.warn(`no dashboard build found at ${webDist} — API only`);
  }

  await f.listen({ port: config.port, host: config.host });

  // reconcile AFTER listen so the health endpoint comes up fast
  bootReconcile((msg) => f.log.info(`reconcile: ${msg}`)).catch((e) => f.log.error(e, 'boot reconcile failed'));
  reconcileServices((msg) => f.log.info(`services: ${msg}`)).catch((e) => f.log.error(e, 'service reconcile failed'));
  startCrashWatcher();
  startBackupSchedule();
  startObservers();

  const shutdown = async () => {
    try {
      await f.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', e);
  process.exit(1);
});
