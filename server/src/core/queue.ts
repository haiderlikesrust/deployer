import { createDeployment, getDeployment, queuedDeploymentForApp, updateDeployment } from '../db/repo.js';
import { now } from '../db/db.js';
import { IN_FLIGHT_STATUSES, type DeploymentRow } from '../types.js';
import { requestCancel } from './children.js';
import { emitEvent } from './events.js';
import { runDeployment } from './pipeline.js';

/**
 * One build at a time — a small VPS OOMs fast when two webpack builds race.
 * The queue is in-process; state lives in the DB so a restart reconciles.
 */
const q: number[] = [];
let activeId: number | null = null;

export function enqueueDeploy(appId: number, trigger: 'manual' | 'webhook'): DeploymentRow {
  // a newer request replaces one still waiting in the queue
  const waiting = queuedDeploymentForApp(appId);
  if (waiting && q.includes(waiting.id)) {
    q.splice(q.indexOf(waiting.id), 1);
    updateDeployment(waiting.id, { status: 'superseded', finished_at: now() });
    emitEvent({ type: 'deployment', appId, deploymentId: waiting.id, status: 'superseded' });
  }
  const dep = createDeployment(appId, trigger);
  q.push(dep.id);
  emitEvent({ type: 'deployment', appId, deploymentId: dep.id, status: 'queued' });
  void pump();
  return dep;
}

async function pump() {
  if (activeId != null) return;
  const next = q.shift();
  if (next == null) return;
  activeId = next;
  try {
    await runDeployment(next);
  } catch (e) {
    // runDeployment handles its own failures; this is a last-resort guard
    console.error('deployment crashed outside the pipeline error handling:', e);
  } finally {
    activeId = null;
    void pump();
  }
}

export function activeDeploymentId(): number | null {
  return activeId;
}

/** Cancel a queued or in-flight deployment. Returns false if it can't be canceled. */
export function cancelDeployment(deploymentId: number): boolean {
  const dep = getDeployment(deploymentId);
  if (!dep) return false;
  if (dep.status === 'queued') {
    const i = q.indexOf(deploymentId);
    if (i >= 0) q.splice(i, 1);
    updateDeployment(deploymentId, { status: 'canceled', finished_at: now() });
    emitEvent({ type: 'deployment', appId: dep.app_id, deploymentId, status: 'canceled' });
    return true;
  }
  if ((IN_FLIGHT_STATUSES as string[]).includes(dep.status) && activeId === deploymentId) {
    requestCancel(deploymentId); // the pipeline notices and finishes as canceled
    return true;
  }
  return false;
}

/** Used by app deletion: stop anything queued or running for this app. */
export function cancelAllForApp(appId: number) {
  for (const id of [...q]) {
    const dep = getDeployment(id);
    if (dep?.app_id === appId) cancelDeployment(id);
  }
  if (activeId != null) {
    const dep = getDeployment(activeId);
    if (dep?.app_id === appId) requestCancel(activeId);
  }
}
