#!/usr/bin/env node
/**
 * E2E for the deploy-workflow batch: webhook HMAC auth, generic hook, rollback.
 *   node scripts/e2e-deploy-workflow.mjs --password test123 [--base http://localhost:3000]
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

async function waitFor(id, timeoutMs = 5 * 60 * 1000) {
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

// fixture repo
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-wf-'));
const dir = path.join(WORK, 'site');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), '<h1>version-one</h1>');
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'e2e@test.local');
git('config', 'user.name', 'e2e');
git('add', '-A');
git('commit', '-q', '-m', 'v1');
const repoUrl = 'file:///' + dir.replaceAll('\\', '/').replace(/^\//, '');

{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) { console.error('login failed'); process.exit(1); }
  ok('login');
}

console.log('\n[1] deploy v1, then v2');
const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl, name: 'wftest' }) });
const appId = created.body.app.id;
const depA = await waitFor(created.body.deploymentId);
depA.status === 'live' ? ok('v1 live') : fail('v1 live', depA.error ?? depA.status);

fs.writeFileSync(path.join(dir, 'index.html'), '<h1>version-two</h1>');
git('add', '-A');
git('commit', '-q', '-m', 'v2');
const r2 = await api(`/apps/${appId}/deploy`, { method: 'POST' });
const depB = await waitFor(r2.body.deploymentId);
depB.status === 'live' ? ok('v2 live') : fail('v2 live', depB.error ?? depB.status);

console.log('\n[2] rollback to v1');
{
  const already = await api(`/deployments/${depB.id}/rollback`, { method: 'POST' });
  already.status === 409 ? ok('rolling back the live deployment is rejected') : fail('live rollback rejected', String(already.status));

  const rb = await api(`/deployments/${depA.id}/rollback`, { method: 'POST' });
  rb.status === 201 ? ok('rollback accepted') : fail('rollback accepted', JSON.stringify(rb.body));
  const rbDep = await waitFor(rb.body.deploymentId);
  rbDep.status === 'live' ? ok('rollback went live') : fail('rollback went live', rbDep.error ?? rbDep.status);
  rbDep.trigger === 'rollback' ? ok('trigger recorded as rollback') : fail('trigger recorded', rbDep.trigger);
  rbDep.imageTag === depA.imageTag ? ok('runs the ORIGINAL v1 image (no rebuild)') : fail('original image reused', `${rbDep.imageTag} vs ${depA.imageTag}`);
  const logText = await api(`/deployments/${rbDep.id}/log`);
  !String(logText.body).includes('Cloning') ? ok('no clone/build happened') : fail('no clone/build happened');
}

console.log('\n[3] webhooks');
{
  const app = await api(`/apps/${appId}`);
  const wh = app.body.webhook;
  wh?.secret && wh.githubUrl && wh.genericUrl ? ok('webhook info exposed') : fail('webhook info exposed', JSON.stringify(wh));

  const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main' } });
  const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
  const hookPath = `/hooks/github/${appId}`;

  const bad = await fetch(`${BASE}/api${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: payload,
  });
  bad.status === 401 ? ok('bad signature rejected (no session needed to test — route is public)') : fail('bad signature rejected', String(bad.status));

  const ping = await fetch(`${BASE}/api${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sig },
    body: payload,
  });
  (await ping.json()).pong === true ? ok('ping answered') : fail('ping answered');

  const push = await fetch(`${BASE}/api${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig },
    body: payload,
  });
  const pushBody = await push.json();
  pushBody.deploymentId ? ok('valid push triggers a deployment') : fail('valid push triggers deployment', JSON.stringify(pushBody));
  const whDep = await waitFor(pushBody.deploymentId);
  whDep.trigger === 'webhook' && whDep.status === 'live' ? ok('webhook deployment live') : fail('webhook deployment live', whDep.status);

  const otherPayload = JSON.stringify({ ref: 'refs/heads/feature-x', repository: { default_branch: 'main' } });
  const otherSig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(otherPayload).digest('hex');
  const other = await fetch(`${BASE}/api${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': otherSig },
    body: otherPayload,
  });
  const otherBody = await other.json();
  otherBody.ignored ? ok('push to another branch is ignored') : fail('other branch ignored', JSON.stringify(otherBody));

  const generic = await fetch(`${BASE}/api/hooks/deploy/${appId}/${wh.secret}`, { method: 'POST' });
  const genericBody = await generic.json();
  genericBody.deploymentId ? ok('generic hook triggers a deployment') : fail('generic hook works', JSON.stringify(genericBody));
  await waitFor(genericBody.deploymentId);

  const wrongToken = await fetch(`${BASE}/api/hooks/deploy/${appId}/wrong-token-here`, { method: 'POST' });
  wrongToken.status === 401 ? ok('wrong generic token rejected') : fail('wrong token rejected', String(wrongToken.status));
}

// cleanup
await api(`/apps/${appId}`, { method: 'DELETE' });
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { for (const [n, , d] of failed) console.log(`  FAIL: ${n}${d ? ` — ${d}` : ''}`); process.exit(1); }
console.log('deploy workflow verified 🚀');
