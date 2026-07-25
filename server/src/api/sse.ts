import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bus, type DeployerEvent } from '../core/events.js';
import { subscribeLog } from '../core/buildlogs.js';
import { scrub } from '../core/secrets.js';
import { getApp, getDeployment } from '../db/repo.js';

interface SseConn {
  send: (event: string, data: unknown) => void;
  onClose: (cb: () => void) => void;
  close: () => void;
}

function openSse(req: FastifyRequest, reply: FastifyReply): SseConn {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  const hb = setInterval(() => {
    try {
      res.write(':hb\n\n');
    } catch {}
  }, 15000);

  const closers: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    for (const c of closers) c();
    try {
      res.end();
    } catch {}
  };
  req.raw.on('close', close);

  return {
    send: (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    },
    onClose: (cb) => closers.push(cb),
    close,
  };
}

export async function sseRoutes(f: FastifyInstance) {
  /** Global status bus — dashboard reactivity. */
  f.get('/events', async (req, reply) => {
    const conn = openSse(req, reply);
    const handler = (ev: DeployerEvent) => conn.send('update', ev);
    bus.on('event', handler);
    conn.onClose(() => bus.off('event', handler));
  });

  /** Build log: replay everything so far, then follow until the deployment ends. */
  f.get('/deployments/:id/logstream', async (req, reply) => {
    const dep = getDeployment(Number((req.params as any).id));
    if (!dep) return reply.code(404).send({ error: 'not found' });
    const conn = openSse(req, reply);
    const unsubscribe = subscribeLog(
      dep.id,
      (line) => conn.send('log', { text: line }),
      () => {
        const finished = getDeployment(dep.id);
        conn.send('end', { status: finished?.status ?? 'unknown' });
        conn.close();
      }
    );
    conn.onClose(unsubscribe);
  });

  /** Runtime container logs: docker logs -f, piped per client. */
  f.get('/apps/:id/logs/stream', async (req, reply) => {
    const app = getApp(Number((req.params as any).id));
    if (!app) return reply.code(404).send({ error: 'not found' });
    const active = app.active_deployment_id ? getDeployment(app.active_deployment_id) : null;
    if (!active?.container_id) return reply.code(409).send({ error: 'no active container' });

    const conn = openSse(req, reply);
    const child = spawn('docker', ['logs', '-f', '--tail', '200', active.container_id], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pipe = (stream: NodeJS.ReadableStream) => {
      readline.createInterface({ input: stream }).on('line', (l) => conn.send('log', { text: scrub(l) }));
    };
    pipe(child.stdout!);
    pipe(child.stderr!);
    child.on('close', () => {
      conn.send('end', {});
      conn.close();
    });
    conn.onClose(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    });
  });
}
