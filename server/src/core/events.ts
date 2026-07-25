import { EventEmitter } from 'node:events';

/** Global event bus feeding the dashboard's /api/events SSE stream. */
export const bus = new EventEmitter();
bus.setMaxListeners(500);

export interface DeployerEvent {
  type: 'deployment' | 'app';
  appId: number;
  deploymentId?: number;
  status: string;
  ts: number;
}

export function emitEvent(ev: Omit<DeployerEvent, 'ts'>) {
  bus.emit('event', { ...ev, ts: Date.now() } satisfies DeployerEvent);
}
