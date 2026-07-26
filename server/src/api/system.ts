import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { dockerInfo, listManagedContainers } from '../core/docker.js';
import { diskFreeBytes, pruneSystem } from '../core/cleanup.js';
import { listApps } from '../db/repo.js';

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
      probeMode: config.probeMode,
    };
  });

  f.post('/system/prune', async () => {
    const output = await pruneSystem();
    return { ok: true, output };
  });
}
