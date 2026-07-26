import type { FastifyInstance } from 'fastify';
import { appHost, config } from '../config.js';
import { dockerInfo, listManagedContainers } from '../core/docker.js';
import { diskFreeBytes, pruneSystem } from '../core/cleanup.js';
import { listApps } from '../db/repo.js';

/**
 * The docs are just another app someone may or may not have deployed, so the
 * link is only offered once something actually answers on that host —
 * otherwise the nav would point at a 404.
 */
function docsUrl(): string | null {
  const host = `docs.${config.baseDomain}`;
  const served = listApps().some((a) => a.active_deployment_id != null && appHost(a.name, a.domain) === host);
  return served ? `${config.publicScheme}://${host}` : null;
}

export async function systemRoutes(f: FastifyInstance) {
  f.get('/system', async () => {
    const [docker, containers, disk] = await Promise.all([
      dockerInfo(),
      listManagedContainers().catch(() => []),
      diskFreeBytes().catch(() => null),
    ]);
    return {
      docker,
      diskFreeBytes: disk,
      apps: listApps().length,
      managedContainers: containers.length,
      runningContainers: containers.filter((c) => c.State === 'running').length,
      baseDomain: config.baseDomain,
      sslMode: config.sslMode,
      publicScheme: config.publicScheme,
      docsUrl: docsUrl(),
      probeMode: config.probeMode,
    };
  });

  f.post('/system/prune', async () => {
    const output = await pruneSystem();
    return { ok: true, output };
  });
}
