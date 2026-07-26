#!/usr/bin/env node
/**
 * E2E for observability: metrics samples, log history search, reachability.
 *   node scripts/e2e-observe.mjs --password test123
 * Takes ~2.5 minutes (waits for 30s-interval collectors to produce data).
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
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

async function waitFor(id) {
  for (let i = 0; i < 120; i++) {
    const { body } = await api(`/deployments/${id}`);
    if (['live', 'failed', 'canceled', 'needs_env'].includes(body.status)) return body;
    await sleep(2000);
  }
  throw new Error('timeout');
}

{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) { console.error('login failed'); process.exit(1); }
  ok('login');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'obsapp', scripts: { start: 'node s.js' } }));
fs.writeFileSync(
  path.join(dir, 's.js'),
  `setInterval(() => console.log('heartbeat', Date.now()), 3000);
require('http').createServer((q, r) => r.end('obs-ok')).listen(process.env.PORT || 3000, '0.0.0.0');
`
);
const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t');
g('config', 'user.name', 't');
g('add', '-A');
g('commit', '-q', '-m', 'v1');
const url = 'file:///' + dir.replaceAll('\\', '/').replace(/^\//, '');

const created = await api('/apps', { method: 'POST', body: JSON.stringify({ repoUrl: url, name: 'obsapp' }) });
const dep = await waitFor(created.body.deploymentId);
dep.status === 'live' ? ok('app live') : fail('app live', dep.error ?? dep.status);
const appId = created.body.app.id;

console.log('  … waiting 100s for the 30s/60s collectors to produce data');
await sleep(100_000);

const app = (await api(`/apps/${appId}`)).body;
app.httpUp === true ? ok('reachability probe reports up') : fail('reachability up', String(app.httpUp));

const metrics = (await api(`/apps/${appId}/metrics?range=1h`)).body;
metrics.points.length >= 2 ? ok(`metrics collected (${metrics.points.length} samples)`) : fail('metrics collected', String(metrics.points.length));
const last = metrics.points.at(-1);
last && last.memBytes > 0 ? ok(`memory sample plausible (${Math.round(last.memBytes / 1024 / 1024)}MB)`) : fail('memory sample', JSON.stringify(last));

const hist = (await api(`/apps/${appId}/logs/history?q=heartbeat`)).body;
hist.lines.length >= 2 ? ok(`log history collected + searchable (${hist.lines.length} matches)`) : fail('log history', String(hist.lines?.length));
/^\d{4}-\d{2}-\d{2}T/.test(hist.lines[0] ?? '') ? ok('history lines timestamped') : fail('history timestamped', (hist.lines[0] ?? '').slice(0, 30));
const none = (await api(`/apps/${appId}/logs/history?q=zzz-not-there`)).body;
none.lines.length === 0 ? ok('search filters correctly') : fail('search filters', String(none.lines.length));

await api(`/apps/${appId}`, { method: 'DELETE' });
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { for (const [n, , d] of failed) console.log(`  FAIL: ${n}${d ? ` — ${d}` : ''}`); process.exit(1); }
console.log('observability verified 🚀');
