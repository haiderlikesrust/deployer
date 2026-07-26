#!/usr/bin/env node
/**
 * E2E for the stacks + power-tools batch: Go build, API tokens, container exec,
 * CLI round-trip, preview branch deploys.
 *   node scripts/e2e-power.mjs --password test123
 *
 * Rust is covered by scripts/detect-fixtures.mjs (a real cargo build is minutes
 * of compile time; the generated Dockerfile is asserted instead).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

async function waitFor(id, timeoutMs = 8 * 60 * 1000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/deployments/${id}`);
    if (body.status !== last) { last = body.status; console.log(`    [dep ${id}] ${body.status}`); }
    if (['live', 'failed', 'canceled', 'superseded', 'needs_env'].includes(body.status)) return body;
    await sleep(2000);
  }
  throw new Error('timeout');
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pow-'));
function repo(name, files) {
  const dir = path.join(WORK, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-q', '-m', 'v1');
  return { url: 'file:///' + dir.replaceAll('\\', '/').replace(/^\//, ''), dir };
}

{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) { console.error('login failed'); process.exit(1); }
  ok('login');
}

// ------------------------------------------------------------- 1: go app
console.log('\n[1] Go repo builds and serves without a Dockerfile');
let goAppId;
{
  const fx = repo('goapp', {
    'go.mod': 'module goapp\n\ngo 1.21\n',
    'main.go': `package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "go-ok") })
	http.ListenAndServe(":"+port, nil)
}
`,
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: fx.url, name: 'goapp' }) });
  goAppId = created.body.app.id;
  const dep = await waitFor(created.body.deploymentId);
  dep.status === 'live' ? ok('go app live') : fail('go app live', dep.error ?? dep.status);
  dep.config?.builder === 'go' ? ok('go builder selected') : fail('go builder', dep.config?.builder);
  dep.config?.type === 'web' ? ok('detected as web (ListenAndServe)') : fail('detected as web', dep.config?.type);
}

// -------------------------------------------------------- 2: exec + tokens
console.log('\n[2] one-off exec and API tokens');
{
  const exec = await api(`/apps/${goAppId}/exec`, { method: 'POST', body: JSON.stringify({ cmd: 'echo hello-from-exec && echo $PORT' }) });
  exec.body.code === 0 && exec.body.output.includes('hello-from-exec') ? ok('exec runs in the container') : fail('exec runs', JSON.stringify(exec.body).slice(0, 120));
  exec.body.output.includes('3000') ? ok('exec sees the app env') : fail('exec sees env', exec.body.output.slice(0, 60));

  const bad = await api(`/apps/${goAppId}/exec`, { method: 'POST', body: JSON.stringify({ cmd: 'exit 3' }) });
  bad.body.code === 3 ? ok('exec propagates the exit code') : fail('exit code', String(bad.body.code));

  const made = await api('/tokens', { method: 'POST', body: JSON.stringify({ name: 'e2e-cli' }) });
  const token = made.body.token;
  token?.startsWith('dpl_') ? ok('token created') : fail('token created', JSON.stringify(made.body));

  // token auth works with NO session cookie
  const viaToken = await fetch(`${BASE}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
  viaToken.status === 200 ? ok('bearer token authenticates') : fail('bearer authenticates', String(viaToken.status));
  const viaBad = await fetch(`${BASE}/api/apps`, { headers: { authorization: 'Bearer dpl_wrong' } });
  viaBad.status === 401 ? ok('bad token rejected') : fail('bad token rejected', String(viaBad.status));
  const noAuth = await fetch(`${BASE}/api/apps`);
  noAuth.status === 401 ? ok('no credentials still rejected') : fail('no credentials rejected', String(noAuth.status));

  const listed = await api('/tokens');
  !JSON.stringify(listed.body).includes(token) ? ok('token list never returns the plaintext') : fail('plaintext leaked in list');

  // CLI round-trip against the real API
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clihome-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const cli = (...a) => execFileSync('node', [path.resolve('cli/deployer.mjs'), ...a], { env, stdio: 'pipe' }).toString();
  cli('login', BASE, token);
  const ls = cli('ls');
  ls.includes('goapp') ? ok('CLI lists apps using the token') : fail('CLI ls', ls.slice(0, 80));
  const execOut = cli('exec', 'goapp', 'echo cli-exec-works');
  execOut.includes('cli-exec-works') ? ok('CLI exec works') : fail('CLI exec', execOut.slice(0, 80));
  fs.rmSync(home, { recursive: true, force: true });

  const tokenId = listed.body[0]?.id;
  await api(`/tokens/${tokenId}`, { method: 'DELETE' });
  const afterDelete = await fetch(`${BASE}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
  afterDelete.status === 401 ? ok('deleted token stops working') : fail('deleted token rejected', String(afterDelete.status));
}

// ------------------------------------------------------ 3: preview branches
console.log('\n[3] preview deploys per branch');
{
  const fx = repo('previewapp', {
    'package.json': JSON.stringify({ name: 'previewapp', scripts: { start: 'node s.js' } }),
    's.js': `require('http').createServer((q,r)=>r.end('prev')).listen(process.env.PORT||3000,'0.0.0.0');`,
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: fx.url, name: 'previewapp' }) });
  const parentId = created.body.app.id;
  await waitFor(created.body.deploymentId);
  await api(`/apps/${parentId}/env`, { method: 'PUT', body: JSON.stringify({ vars: [{ key: 'SHARED', value: 'from-parent' }] }) });
  await api(`/apps/${parentId}`, { method: 'PATCH', body: JSON.stringify({ previewBranches: true }) });

  // a real branch in the fixture repo
  execFileSync('git', ['-C', fx.dir, 'checkout', '-q', '-b', 'feat-x']);
  fs.writeFileSync(path.join(fx.dir, 's.js'), `require('http').createServer((q,r)=>r.end('prev-branch')).listen(process.env.PORT||3000,'0.0.0.0');`);
  execFileSync('git', ['-C', fx.dir, 'add', '-A']);
  execFileSync('git', ['-C', fx.dir, 'commit', '-q', '-m', 'branch work']);

  const app = (await api(`/apps/${parentId}`)).body;
  const push = (branch, extra = {}) => {
    const payload = JSON.stringify({ ref: `refs/heads/${branch}`, repository: { default_branch: 'main' }, ...extra });
    const sig = 'sha256=' + crypto.createHmac('sha256', app.webhook.secret).update(payload).digest('hex');
    return fetch(`${BASE}/api/hooks/github/${parentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig },
      body: payload,
    }).then((r) => r.json());
  };

  const res = await push('feat-x');
  res.preview === 'previewapp-feat-x' ? ok('preview app created for the branch') : fail('preview created', JSON.stringify(res));
  const prevDep = await waitFor(res.deploymentId);
  prevDep.status === 'live' ? ok('preview deploy live') : fail('preview live', prevDep.error ?? prevDep.status);

  const apps = (await api('/apps')).body;
  const preview = apps.find((a) => a.name === 'previewapp-feat-x');
  preview?.parentAppId === parentId ? ok('preview linked to its parent') : fail('preview parent', String(preview?.parentAppId));
  preview?.branch === 'feat-x' ? ok('preview tracks the branch') : fail('preview branch', preview?.branch);
  const prevEnv = (await api(`/apps/${preview.id}/env`)).body;
  prevEnv.some((v) => v.key === 'SHARED' && v.value === 'from-parent') ? ok('env copied from parent') : fail('env copied', JSON.stringify(prevEnv));

  // a second push must reuse the same preview app, not spawn another
  const res2 = await push('feat-x');
  res2.preview === 'previewapp-feat-x' ? ok('second push reuses the preview app') : fail('reuse preview', JSON.stringify(res2));
  await waitFor(res2.deploymentId);
  const appsAfter = (await api('/apps')).body.filter((a) => a.name.startsWith('previewapp'));
  appsAfter.length === 2 ? ok('no duplicate preview apps') : fail('no duplicates', String(appsAfter.length));

  // branch deletion retires the preview
  const delPayload = JSON.stringify({ ref: 'feat-x', ref_type: 'branch' });
  const delSig = 'sha256=' + crypto.createHmac('sha256', app.webhook.secret).update(delPayload).digest('hex');
  const del = await fetch(`${BASE}/api/hooks/github/${parentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'delete', 'x-hub-signature-256': delSig },
    body: delPayload,
  }).then((r) => r.json());
  del.previewRemoved ? ok('branch deletion removes the preview') : fail('preview removed', JSON.stringify(del));
  const remaining = (await api('/apps')).body.filter((a) => a.name.startsWith('previewapp'));
  remaining.length === 1 ? ok('only the parent app remains') : fail('parent remains', String(remaining.length));

  await api(`/apps/${parentId}`, { method: 'DELETE' });
}

// cleanup
{
  const apps = (await api('/apps')).body;
  for (const a of apps.filter((x) => ['goapp'].includes(x.name))) await api(`/apps/${a.id}`, { method: 'DELETE' });
}
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { for (const [n, , d] of failed) console.log(`  FAIL: ${n}${d ? ` — ${d}` : ''}`); process.exit(1); }
console.log('power tools verified 🚀');
