#!/usr/bin/env node
/**
 * End-to-end coverage for the two behaviours a bot/worker repo depends on:
 *   1. a repo with no web framework deploys as a WORKER — no domain, no HTTP probe
 *   2. a repo whose .env.example declares required vars stops at needs_env
 *      BEFORE building, and deploys once the values are supplied
 *
 *   node scripts/e2e-worker-env.mjs --password test123 [--base http://localhost:3000]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? ''] : null)).filter(Boolean)
);
const BASE = args.base ?? 'http://localhost:3000';
const PASSWORD = args.password ?? 'test123';

let cookie = '';
const results = [];
const ok = (n) => { results.push([n, true]); console.log(`  ✓ ${n}`); };
const fail = (n, d) => { results.push([n, false, d]); console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, init = {}) {
  const res = await fetch(`${BASE}/api${p}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-we-'));
function repo(name, files) {
  const dir = path.join(WORK, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@test.local');
  git('config', 'user.name', 'e2e');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return 'file:///' + dir.replaceAll('\\', '/').replace(/^\//, '');
}

async function waitFor(id, timeoutMs = 6 * 60 * 1000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/deployments/${id}`);
    if (body.status !== last) { last = body.status; console.log(`    [dep ${id}] ${body.status}`); }
    if (['live', 'failed', 'canceled', 'superseded', 'needs_env'].includes(body.status)) return body;
    await sleep(2000);
  }
  throw new Error(`deployment ${id} timed out`);
}

{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) { console.error('login failed'); process.exit(1); }
  ok('login');
}

// ---------------------------------------------------------------- worker
console.log('\n[1] bot repo with no web framework deploys as a worker');
{
  const url = repo('botapp', {
    'package.json': JSON.stringify({ name: 'botapp', dependencies: {}, scripts: { start: 'node bot.js' } }, null, 2),
    'bot.js': `let n = 0;
setInterval(() => console.log('tick', ++n), 1000);
process.on('SIGTERM', () => process.exit(0));
console.log('bot started');
`,
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: url, name: 'botapp' }) });
  if (created.status !== 201) { fail('create app', JSON.stringify(created.body)); }
  const dep = await waitFor(created.body.deploymentId);

  dep.status === 'live' ? ok('worker deploys to live') : fail('worker deploys to live', dep.error ?? dep.status);
  dep.config?.type === 'worker' ? ok('auto-detected as worker') : fail('auto-detected as worker', dep.config?.type);
  dep.config?.domainHost === null ? ok('no domain allocated') : fail('no domain allocated', String(dep.config?.domainHost));

  const app = await api(`/apps/${created.body.app.id}`);
  app.body.isWorker === true ? ok('API reports isWorker') : fail('API reports isWorker', String(app.body.isWorker));
  app.body.url === null ? ok('API returns no url for a worker') : fail('API returns no url', String(app.body.url));
  app.body.status === 'live' ? ok('worker shows as live') : fail('worker shows as live', app.body.status);

  const logText = await api(`/deployments/${dep.id}/log`);
  String(logText.body).includes('worker') ? ok('build log explains the worker decision') : fail('build log explains the decision');
}

// ------------------------------------------------------------- env gate
console.log('\n[2] .env.example with required vars stops before building');
let envAppId;
{
  const url = repo('envapp', {
    'package.json': JSON.stringify({ name: 'envapp', dependencies: {}, scripts: { start: 'node worker.js' } }, null, 2),
    'worker.js': `if (!process.env.API_KEY) { console.error('missing API_KEY'); process.exit(1); }
console.log('running with key', process.env.API_KEY.slice(0, 3));
setInterval(() => {}, 1000);
`,
    '.env.example': `# API key for the exchange
API_KEY=your-api-key-here

# Optional tuning
INTERVAL_MS=1000
`,
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: url, name: 'envapp' }) });
  envAppId = created.body.app.id;
  const dep = await waitFor(created.body.deploymentId);

  dep.status === 'needs_env' ? ok('stops at needs_env') : fail('stops at needs_env', dep.status);
  dep.imageTag === null ? ok('nothing was built') : fail('nothing was built', dep.imageTag);
  Array.isArray(dep.envMissing) && dep.envMissing.includes('API_KEY')
    ? ok('reports API_KEY as missing')
    : fail('reports API_KEY as missing', JSON.stringify(dep.envMissing));
  !dep.envMissing?.includes('INTERVAL_MS')
    ? ok('key with a real default is not required')
    : fail('key with a real default is not required');

  const schema = await api(`/apps/${envAppId}/env-schema`);
  const apiKey = schema.body?.schema?.vars?.find((v) => v.key === 'API_KEY');
  apiKey?.description === 'API key for the exchange'
    ? ok('description parsed from the comment above the key')
    : fail('description parsed', JSON.stringify(apiKey?.description));

  const app = await api(`/apps/${envAppId}`);
  app.body.status === 'needs_env' ? ok('app status is needs_env') : fail('app status is needs_env', app.body.status);
  app.body.envStatus?.satisfied === false ? ok('envStatus reports unsatisfied') : fail('envStatus reports unsatisfied');
}

console.log('\n[3] filling the value in lets it deploy');
{
  await api(`/apps/${envAppId}/env`, { method: 'PUT', body: JSON.stringify({ vars: [{ key: 'API_KEY', value: 'secret-value-123' }] }) });
  const app = await api(`/apps/${envAppId}`);
  app.body.envStatus?.satisfied === true ? ok('envStatus becomes satisfied') : fail('envStatus becomes satisfied');

  const r = await api(`/apps/${envAppId}/deploy`, { method: 'POST' });
  const dep = await waitFor(r.body.deploymentId);
  dep.status === 'live' ? ok('deploys once filled in') : fail('deploys once filled in', dep.error ?? dep.status);

  const logs = await api(`/deployments/${dep.id}/log`);
  !String(logs.body).includes('secret-value-123') ? ok('env value never appears in the build log') : fail('env value leaked into the log');
}

// cleanup
for (const name of ['botapp', 'envapp']) {
  const apps = await api('/apps');
  const found = apps.body.find?.((a) => a.name === name);
  if (found) await api(`/apps/${found.id}`, { method: 'DELETE' });
}
fs.rmSync(WORK, { recursive: true, force: true });

console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { for (const [n, , d] of failed) console.log(`  FAIL: ${n}${d ? ` — ${d}` : ''}`); process.exit(1); }
console.log('worker + env gate verified 🚀');
