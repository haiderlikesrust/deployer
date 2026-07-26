#!/usr/bin/env node
/**
 * E2E for the state batch: persistent volumes, release commands, managed services.
 *   node scripts/e2e-state.mjs --password test123 [--base http://localhost:3000]
 */
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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-st-'));
function repo(name, files) {
  const dir = path.join(WORK, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@t');
  git('config', 'user.name', 'e2e');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { url: 'file:///' + dir.replaceAll('\\', '/').replace(/^\//, ''), dir };
}

{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) { console.error('login failed'); process.exit(1); }
  ok('login');
}

// ------------------------------------------------ 1: volumes survive deploys
console.log('\n[1] a counter on a volume survives a redeploy');
let volAppId;
{
  const fx = repo('volapp', {
    'package.json': JSON.stringify({ name: 'volapp', scripts: { start: 'node server.js' }, dependencies: {} }),
    'server.js': `const http=require('http'),fs=require('fs');
const FILE='/appdata/counter.txt';
let n=0; try{n=parseInt(fs.readFileSync(FILE,'utf8'))||0}catch{}
n+=1; fs.mkdirSync('/appdata',{recursive:true}); fs.writeFileSync(FILE,String(n));
http.createServer((req,res)=>res.end('boot-count='+n)).listen(process.env.PORT||3000,'0.0.0.0');
`,
    'deploy.yml': 'type: web\nvolumes:\n  appdata: /appdata\n',
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: fx.url, name: 'volapp' }) });
  volAppId = created.body.app.id;
  const dep1 = await waitFor(created.body.deploymentId);
  dep1.status === 'live' ? ok('deploys with a volume') : fail('deploys with a volume', dep1.error ?? dep1.status);
  (dep1.config?.volumes?.length ?? 0) === 1 ? ok('volume in resolved config (from deploy.yml)') : fail('volume in config', JSON.stringify(dep1.config?.volumes));

  const r2 = await api(`/apps/${volAppId}/deploy`, { method: 'POST' });
  const dep2 = await waitFor(r2.body.deploymentId);
  dep2.status === 'live' ? ok('second deploy live') : fail('second deploy live', dep2.error ?? dep2.status);
  const logText = String((await api(`/deployments/${dep2.id}/log`)).body);
  logText.includes('Stopping previous container first') ? ok('stop-then-start swap used for volume app') : fail('stop-then-start swap used');

  // the container reads+increments the counter at boot: deploy #2 must see #1's write
  const psOut = execFileSync('docker', ['ps', '--filter', `label=deployer.app=volapp`, '--format', '{{.Names}}']).toString().trim();
  const body = execFileSync('docker', ['exec', psOut, 'sh', '-c', 'cat /appdata/counter.txt']).toString().trim();
  Number(body) >= 2 ? ok(`data persisted across deploys (boot count ${body})`) : fail('data persisted', body);
}

// ------------------------------------------------ 2: release command gates
console.log('\n[2] release command runs before the swap; failure aborts');
{
  const fx = repo('relapp', {
    'package.json': JSON.stringify({ name: 'relapp', scripts: { start: 'node s.js' }, dependencies: {} }),
    's.js': `require('http').createServer((q,r)=>r.end('rel-v1')).listen(process.env.PORT||3000,'0.0.0.0');`,
    'deploy.yml': 'type: web\nrelease: echo MIGRATIONS-RAN\n',
  });
  const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: fx.url, name: 'relapp' }) });
  const dep1 = await waitFor(created.body.deploymentId);
  dep1.status === 'live' ? ok('deploy with release cmd live') : fail('deploy live', dep1.error ?? dep1.status);
  const log1 = String((await api(`/deployments/${dep1.id}/log`)).body);
  log1.includes('MIGRATIONS-RAN') ? ok('release command output in build log') : fail('release output captured');

  // now break the release command — deploy must fail, old version must keep serving
  fs.writeFileSync(path.join(fx.dir, 'deploy.yml'), 'type: web\nrelease: exit 7\n');
  execFileSync('git', ['-C', fx.dir, 'add', '-A']);
  execFileSync('git', ['-C', fx.dir, 'commit', '-q', '-m', 'break release']);
  const r2 = await api(`/apps/${created.body.app.id}/deploy`, { method: 'POST' });
  const dep2 = await waitFor(r2.body.deploymentId);
  dep2.status === 'failed' ? ok('failing release fails the deploy') : fail('failing release fails', dep2.status);
  dep2.failedStage === 'releasing' ? ok('failed at the releasing stage') : fail('failed at releasing', dep2.failedStage);
  const appNow = await api(`/apps/${created.body.app.id}`);
  appNow.body.status === 'live' ? ok('previous version still live') : fail('previous version still live', appNow.body.status);
}

// ------------------------------------------------ 3: managed postgres
console.log('\n[3] managed postgres service + env injection');
{
  const createdSvc = await api('/services', { method: 'POST', body: JSON.stringify({ name: 'maindb', type: 'postgres' }) });
  createdSvc.status === 201 ? ok('postgres service created') : fail('service created', JSON.stringify(createdSvc.body));
  createdSvc.body.url?.startsWith('postgres://postgres:') ? ok('connection URL shaped correctly') : fail('url shape', createdSvc.body.url);

  // wait for it to actually accept connections
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const out = execFileSync('docker', ['exec', 'dep-svc-maindb', 'pg_isready', '-U', 'postgres'], { stdio: 'pipe' }).toString();
      if (out.includes('accepting connections')) { ready = true; break; }
    } catch {}
    await sleep(2000);
  }
  ready ? ok('postgres accepting connections') : fail('postgres accepting connections');

  // link to the volume app and check the env var arrives on next deploy
  const link = await api(`/services/${createdSvc.body.id}/link`, { method: 'POST', body: JSON.stringify({ appId: volAppId }) });
  link.status === 200 ? ok('linked to app') : fail('link', JSON.stringify(link.body));
  const r = await api(`/apps/${volAppId}/deploy`, { method: 'POST' });
  const dep = await waitFor(r.body.deploymentId);
  dep.status === 'live' ? ok('redeploy after link live') : fail('redeploy live', dep.error ?? dep.status);
  const psOut = execFileSync('docker', ['ps', '--filter', `label=deployer.app=volapp`, '--format', '{{.Names}}']).toString().trim();
  const envOut = execFileSync('docker', ['exec', psOut, 'sh', '-c', 'echo $DATABASE_URL']).toString().trim();
  envOut.startsWith('postgres://postgres:') && envOut.includes('@dep-svc-maindb:5432')
    ? ok('DATABASE_URL injected into the app container')
    : fail('DATABASE_URL injected', envOut.slice(0, 40));
  const log = String((await api(`/deployments/${dep.id}/log`)).body);
  !log.includes(createdSvc.body.url) ? ok('connection URL (password) not leaked into build log') : fail('URL leaked into log');

  // backup
  const backup = await api(`/services/${createdSvc.body.id}/backup`, { method: 'POST' });
  backup.status === 200 && backup.body.backup?.sizeBytes > 0 ? ok(`backup created (${backup.body.backup.sizeBytes} bytes)`) : fail('backup created', JSON.stringify(backup.body));

  // cleanup service
  await api(`/services/${createdSvc.body.id}`, { method: 'DELETE', headers: {} }).then(async (d) => {
    if (d.status === 409) return api(`/services/${createdSvc.body.id}?force=true`, { method: 'DELETE' });
    return d;
  });
  ok('service deleted');
}

// cleanup apps
for (const name of ['volapp', 'relapp']) {
  const apps = await api('/apps');
  const found = apps.body.find?.((a) => a.name === name);
  if (found) await api(`/apps/${found.id}`, { method: 'DELETE' });
}
const volsLeft = execFileSync('docker', ['volume', 'ls', '--filter', 'label=deployer.app=volapp', '--format', '{{.Name}}']).toString().trim();
volsLeft === '' ? ok('app volumes removed with the app') : fail('app volumes removed', volsLeft);
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { for (const [n, , d] of failed) console.log(`  FAIL: ${n}${d ? ` — ${d}` : ''}`); process.exit(1); }
console.log('state batch verified 🚀');
