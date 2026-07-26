import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp, deleteApp, getApp, getAppByName, getEnvVars, listApps, listDeployments, replaceEnvVars, updateApp } from '../db/repo.js';
import { cancelAllForApp, enqueueDeploy } from '../core/queue.js';
import { sweepAppResources } from '../core/cleanup.js';
import { deleteLogFile } from '../core/buildlogs.js';
import { deleteAppLogs } from '../core/observe.js';
import type { AppRow } from '../types.js';

/**
 * Push-to-deploy. These routes are unauthenticated by design (authGate skips
 * /api/hooks/) — the GitHub route is guarded by an HMAC over the raw body,
 * the generic route by a secret in the path. GitHub signs the RAW bytes, so
 * this plugin swaps the JSON parser for a buffer parser (parsers are
 * encapsulated per Fastify plugin — the rest of the API is unaffected).
 */
export async function webhookRoutes(f: FastifyInstance) {
  f.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  f.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  f.post('/hooks/github/:appId', async (req, reply) => {
    const app = getApp(Number((req.params as any).appId));
    // identical response whether the app is missing or has no secret — no probing
    if (!app?.webhook_secret) return reply.code(404).send({ error: 'not found' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !verifyGithubSignature(raw, app.webhook_secret, signature)) {
      return reply.code(401).send({ error: 'bad signature' });
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'push' && event !== 'delete') return { ok: true, ignored: `event ${String(event)}` };

    let payload: any;
    try {
      const text = raw.toString('utf8');
      // GitHub's form-encoded delivery wraps the JSON in payload=
      payload = (req.headers['content-type'] ?? '').includes('form-urlencoded')
        ? JSON.parse(new URLSearchParams(text).get('payload') ?? '')
        : JSON.parse(text);
    } catch {
      return reply.code(400).send({ error: 'unparseable payload' });
    }

    // branch deletion (as a delete event or a push with deleted:true) retires its preview app
    if (event === 'delete') {
      if (payload.ref_type !== 'branch') return { ok: true, ignored: 'not a branch deletion' };
      await removePreviewApp(app, String(payload.ref ?? ''));
      return { ok: true, previewRemoved: true };
    }

    const ref: string = payload.ref ?? '';
    if (!ref.startsWith('refs/heads/')) return { ok: true, ignored: 'not a branch push' };
    const pushedBranch = ref.slice('refs/heads/'.length);
    if (payload.deleted) {
      await removePreviewApp(app, pushedBranch);
      return { ok: true, ignored: 'branch deletion' };
    }

    const targetBranch = app.branch || payload.repository?.default_branch || 'main';
    if (pushedBranch !== targetBranch) {
      if (app.preview_branches !== 1) {
        return { ok: true, ignored: `push to ${pushedBranch} — this app deploys ${targetBranch}` };
      }
      const preview = ensurePreviewApp(app, pushedBranch);
      if (!preview) return { ok: true, ignored: `could not create a preview app for ${pushedBranch}` };
      const dep = enqueueDeploy(preview.id, 'webhook');
      return { ok: true, preview: preview.name, deploymentId: dep.id };
    }

    const dep = enqueueDeploy(app.id, 'webhook');
    return { ok: true, deploymentId: dep.id };
  });

  /** Anything that can send a POST can trigger a deploy: CI, cron, another script. */
  f.post('/hooks/deploy/:appId/:token', async (req, reply) => {
    const app = getApp(Number((req.params as any).appId));
    if (!app?.webhook_secret) return reply.code(404).send({ error: 'not found' });
    const given = String((req.params as any).token ?? '');
    if (!timingSafeEq(given, app.webhook_secret)) return reply.code(401).send({ error: 'bad token' });
    const dep = enqueueDeploy(app.id, 'webhook');
    return { ok: true, deploymentId: dep.id };
  });
}

function previewName(app: AppRow, branch: string): string | null {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  if (!slug) return null;
  const name = `${app.name}-${slug}`.slice(0, 31).replace(/-+$/, '');
  return name;
}

/**
 * Preview apps: same repo and settings, different branch, own subdomain.
 * Env vars are copied at creation time; volumes and service links deliberately
 * are NOT — previews must never touch production data.
 */
function ensurePreviewApp(parent: AppRow, branch: string): AppRow | null {
  const name = previewName(parent, branch);
  if (!name) return null;
  const existing = getAppByName(name);
  if (existing) return existing.parent_app_id === parent.id ? existing : null;

  const preview = createApp({
    name,
    repo_url: parent.repo_url,
    branch,
    type: parent.type,
    domain: null, // previews always live on <name>.<base-domain>
    port: parent.port,
    root_dir: parent.root_dir,
    git_token: parent.git_token,
  });
  updateApp(preview.id, {
    parent_app_id: parent.id,
    build_cmd: parent.build_cmd,
    start_cmd: parent.start_cmd,
    healthcheck_path: parent.healthcheck_path,
    dockerfile_path: parent.dockerfile_path,
    release_cmd: parent.release_cmd,
    skip_env_check: parent.skip_env_check,
    webhook_secret: crypto.randomBytes(24).toString('hex'),
  });
  replaceEnvVars(preview.id, getEnvVars(parent.id).map((v) => ({ key: v.key, value: v.value })));
  return getAppByName(name);
}

async function removePreviewApp(parent: AppRow, branch: string) {
  const name = previewName(parent, branch);
  if (!name) return;
  const preview = getAppByName(name);
  // only ever delete something this parent created — never a real app that happens to match
  if (!preview || preview.parent_app_id !== parent.id) return;
  cancelAllForApp(preview.id);
  const deployments = listDeployments(preview.id, 1000);
  await sweepAppResources(preview.name);
  for (const d of deployments) deleteLogFile(d.id);
  deleteAppLogs(preview.name);
  deleteApp(preview.id);
}

function verifyGithubSignature(raw: Buffer, secret: string, header: string): boolean {
  if (!header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEq(header.slice('sha256='.length), expected);
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
