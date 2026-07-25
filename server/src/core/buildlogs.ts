import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { paths } from '../config.js';
import { scrub } from './secrets.js';

/**
 * Build logs live on disk (/data/logs/deploy-<id>.log). While a deployment is
 * active we also keep its lines in memory so SSE clients get a lossless
 * replay-then-follow without racing the file writer's buffer.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(500);

interface ActiveLog {
  ws: fs.WriteStream;
  lines: string[];
}

const active = new Map<number, ActiveLog>();

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function appendLog(deploymentId: number, raw: string) {
  // one call may carry multiple lines (or \r progress updates) — normalize
  const lines = raw.replace(ANSI_RE, '').split(/\r\n|\n|\r/);
  let entry = active.get(deploymentId);
  if (!entry) {
    entry = { ws: fs.createWriteStream(paths.deployLog(deploymentId), { flags: 'a' }), lines: [] };
    active.set(deploymentId, entry);
  }
  for (const l of lines) {
    if (l === '' && lines.length > 1) continue; // drop empties created by the split, keep intentional blank lines
    const clean = scrub(l);
    entry.lines.push(clean);
    entry.ws.write(clean + '\n');
    emitter.emit(`log:${deploymentId}`, clean);
  }
}

export function stageLog(deploymentId: number, message: string) {
  appendLog(deploymentId, `==> ${message}`);
}

export function closeLog(deploymentId: number) {
  const entry = active.get(deploymentId);
  if (entry) {
    entry.ws.end();
    active.delete(deploymentId);
  }
  emitter.emit(`end:${deploymentId}`);
}

export function isLogActive(deploymentId: number): boolean {
  return active.has(deploymentId);
}

export function readFullLog(deploymentId: number): string {
  const entry = active.get(deploymentId);
  if (entry) return entry.lines.join('\n');
  try {
    return fs.readFileSync(paths.deployLog(deploymentId), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Subscribe to a deployment's log. Replays everything so far, then follows.
 * Returns an unsubscribe function. onEnd fires when the deployment finishes.
 */
export function subscribeLog(
  deploymentId: number,
  onLine: (line: string) => void,
  onEnd: () => void
): () => void {
  const lineHandler = (l: string) => onLine(l);
  const endHandler = () => onEnd();
  // Synchronous block: subscribe + replay in the same tick so nothing is missed.
  emitter.on(`log:${deploymentId}`, lineHandler);
  emitter.on(`end:${deploymentId}`, endHandler);
  const existing = readFullLog(deploymentId);
  if (existing) for (const l of existing.split('\n')) onLine(l);
  if (!active.has(deploymentId)) {
    // already finished — let the client know right away
    queueMicrotask(onEnd);
  }
  return () => {
    emitter.off(`log:${deploymentId}`, lineHandler);
    emitter.off(`end:${deploymentId}`, endHandler);
  };
}

export function deleteLogFile(deploymentId: number) {
  try {
    fs.unlinkSync(paths.deployLog(deploymentId));
  } catch {}
}
