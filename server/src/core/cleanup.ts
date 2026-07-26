import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from '../config.js';
import {
  containerName,
  docker,
  listAppImages,
  listManagedContainers,
  parseLabels,
  removeContainer,
  removeImage,
} from './docker.js';
import { getAppByName, listApps, markInterruptedDeployments } from '../db/repo.js';
import { getSetting } from '../db/db.js';

function imageRetention(): number {
  const fromSetting = parseInt(getSetting('image_retention') ?? '', 10);
  return Number.isFinite(fromSetting) ? fromSetting : config.imageRetention;
}

/**
 * Boot reconciliation: the process may have died mid-build. Mark in-flight
 * deployments failed, then sweep containers/images that no longer correspond
 * to any app's active deployment. Everything we ever create carries
 * deployer.* labels, so this is a label query — nothing else is touched.
 */
export async function bootReconcile(log: (msg: string) => void) {
  const interrupted = markInterruptedDeployments();
  if (interrupted > 0) log(`marked ${interrupted} interrupted deployment(s) as failed`);

  let containers;
  try {
    containers = await listManagedContainers();
  } catch (e) {
    log(`docker not reachable during reconcile: ${(e as Error).message}`);
    return;
  }

  for (const c of containers) {
    const labels = parseLabels(c.Labels);
    const appName = labels['deployer.app'];
    const app = appName ? getAppByName(appName) : null;
    const expected = app?.active_deployment_id ? containerName(app.name, app.active_deployment_id) : null;
    if (!expected || c.Names !== expected) {
      log(`removing orphaned container ${c.Names}`);
      await removeContainer(c.ID);
    }
  }

  for (const app of listApps()) {
    try {
      await retainImages(app.name, app.active_deployment_id);
    } catch {}
  }

  // build workspaces are transient
  await fsp.rm(paths.builds(), { recursive: true, force: true }).catch(() => {});
  fs.mkdirSync(paths.builds(), { recursive: true });
}

/** Keep the active image + the newest N others (rollback fodder); remove the rest. */
export async function retainImages(appName: string, activeDeploymentId: number | null) {
  const images = await listAppImages(appName);
  const numbered = images
    .map((i) => ({ ...i, num: parseInt(i.Tag, 10) }))
    .filter((i) => Number.isFinite(i.num))
    .sort((a, b) => b.num - a.num);
  const keep = new Set<number>();
  if (activeDeploymentId != null) keep.add(activeDeploymentId);
  for (const img of numbered) {
    if (keep.size >= imageRetention() + 1) break;
    keep.add(img.num);
  }
  for (const img of numbered) {
    if (!keep.has(img.num)) {
      await removeImage(`${img.Repository}:${img.Tag}`).catch(() => {}); // in-use images just stay
    }
  }
}

/** Full resource sweep for app deletion. */
export async function sweepAppResources(appName: string) {
  const containers = await listManagedContainers().catch(() => []);
  for (const c of containers) {
    if (parseLabels(c.Labels)['deployer.app'] === appName) await removeContainer(c.ID);
  }
  const images = await listAppImages(appName).catch(() => []);
  for (const img of images) {
    await removeImage(`${img.Repository}:${img.Tag}`).catch(() => {});
  }
  // persistent volumes go with the app (the delete dialog says so)
  const vols = await docker(['volume', 'ls', '--filter', `label=deployer.app=${appName}`, '--format', '{{.Name}}']);
  for (const name of vols.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    await docker(['volume', 'rm', name]);
  }
  await fsp.rm(`${paths.builds()}/${appName}`, { recursive: true, force: true }).catch(() => {});
}

export async function diskFreeBytes(): Promise<number> {
  const s = await fsp.statfs(config.dataDir);
  return s.bavail * s.bsize;
}

export async function checkDiskSpace() {
  try {
    const free = await diskFreeBytes();
    if (free < config.minFreeDiskBytes) {
      const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
      throw new Error(
        `only ${gb(free)}GB disk free (minimum ${gb(config.minFreeDiskBytes)}GB to build) — run a prune from the system page or remove old images`
      );
    }
  } catch (e) {
    if ((e as Error).message.includes('disk free')) throw e;
    // statfs unsupported → skip the guard rather than block deploys
  }
}

/** Manual "prune" button: dangling images + old build cache. */
export async function pruneSystem(): Promise<string> {
  const out: string[] = [];
  const img = await docker(['image', 'prune', '-f']);
  out.push(img.stdout.trim());
  const cache = await docker(['builder', 'prune', '-f', '--keep-storage', '10GB']);
  out.push(cache.stdout.trim().split('\n').slice(-1)[0] ?? '');
  return out.filter(Boolean).join('\n');
}
