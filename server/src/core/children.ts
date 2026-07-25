import type { ChildProcess } from 'node:child_process';

/**
 * Registry of live child processes per deployment, so cancel can SIGTERM
 * everything a deployment spawned (git clone, docker build, probes...).
 */
const registry = new Map<number, Set<ChildProcess>>();

export function registerChild(deploymentId: number, child: ChildProcess) {
  let set = registry.get(deploymentId);
  if (!set) {
    set = new Set();
    registry.set(deploymentId, set);
  }
  set.add(child);
}

export function unregisterChild(deploymentId: number, child: ChildProcess) {
  const set = registry.get(deploymentId);
  if (!set) return;
  set.delete(child);
  if (set.size === 0) registry.delete(deploymentId);
}

export function killChildren(deploymentId: number) {
  const set = registry.get(deploymentId);
  if (!set) return;
  for (const child of set) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
}

// ---- cancellation flags (owned here to avoid queue<->pipeline import cycles) ----

const canceled = new Set<number>();

/** Flag a deployment as canceled and SIGTERM everything it spawned. */
export function requestCancel(deploymentId: number) {
  canceled.add(deploymentId);
  killChildren(deploymentId);
}

export function isCanceled(deploymentId: number): boolean {
  return canceled.has(deploymentId);
}

export function clearCancelFlag(deploymentId: number) {
  canceled.delete(deploymentId);
}
