#!/usr/bin/env node
/**
 * End-to-end test for deployer. Requires:
 *   - docker daemon running, `deployer` network created
 *   - traefik dev stack up (docker-compose.dev.yml) on :80
 *   - deployer server running (default http://localhost:3000)
 *
 * Usage:
 *   node scripts/e2e.mjs --password test123 [--base http://localhost:3000] [--traefik 127.0.0.1:80]
 *
 * It copies examples/ into a temp dir, turns them into git repos, deploys all
 * three through the API, checks the routed domains, exercises env precedence,
 * broken-build resilience, and app deletion.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? ''] : null)).filter(Boolean)
);
const BASE = args.base ?? 'http://localhost:3000';
const PASSWORD = args.password ?? 'test123';
const [TRAEFIK_HOST, TRAEFIK_PORT] = (args.traefik ?? '127.0.0.1:80').split(':');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cookie = '';
const results = [];
const ok = (name) => {
  results.push([name, true]);
  console.log(`  ✓ ${name}`);
};
const fail = (name, detail) => {
  results.push([name, false, detail]);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}/api${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** GET through traefik with an explicit Host header (fetch forbids Host, http doesn't). */
function viaTraefik(host, pathname = '/') {
  return new Promise((resolve) => {
    const req = http.request(
      { host: TRAEFIK_HOST, port: Number(TRAEFIK_PORT), path: pathname, headers: { Host: host }, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    req.end();
  });
}

/**
 * Where the deployer will find the fixture repos. Defaults to the host path
 * (server running on this machine). When the deployer runs inside a container,
 * mount WORK into it and pass --repo-base file:///fixtures.
 */
const REPO_BASE = args['repo-base'] ?? null;
const fixtureDirs = new Map();

function makeFixtureRepo(name, extraFiles = {}) {
  const src = path.join(ROOT, 'examples', name);
  const dest = path.join(WORK, name);
  fixtureDirs.set(name, dest);
  fs.cpSync(src, dest, { recursive: true });
  for (const [rel, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), content);
  }
  const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@test.local');
  git('config', 'user.name', 'e2e');
  git('add', '-A');
  git('commit', '-q', '-m', `fixture: ${name}`);
  if (REPO_BASE) return `${REPO_BASE.replace(/\/$/, '')}/${name}`;
  return 'file:///' + dest.replaceAll('\\', '/').replace(/^\//, '');
}

function commitFile(fixtureName, rel, content, msg) {
  const dir = fixtureDirs.get(fixtureName);
  fs.writeFileSync(path.join(dir, rel), content);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-q', '-m', msg);
}

async function waitForDeployment(id, timeoutMs = 8 * 60 * 1000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/deployments/${id}`);
    if (body.status !== last) {
      last = body.status;
      process.stdout.write(`    [dep ${id}] ${body.status}\n`);
    }
    if (['live', 'failed', 'canceled', 'superseded'].includes(body.status)) return body;
    await sleep(2500);
  }
  throw new Error(`deployment ${id} timed out`);
}

async function deployApp(input) {
  const created = await api('/apps', { method: 'POST', body: JSON.stringify(input) });
  if (created.status !== 201) throw new Error(`create app failed: ${created.status} ${JSON.stringify(created.body)}`);
  const dep = await waitForDeployment(created.body.deploymentId);
  return { app: created.body.app, dep };
}

const WORK = args.work ? (fs.mkdirSync(args.work, { recursive: true }), path.resolve(args.work)) : fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-e2e-'));
console.log(`fixtures in ${WORK}\n`);

// ---------------------------------------------------------------- login
{
  const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (r.status !== 200) {
    console.error(`cannot login (${r.status}) — is the server running with ADMIN_PASSWORD=${PASSWORD}?`);
    process.exit(1);
  }
  ok('login');
  const unauth = await fetch(`${BASE}/api/apps`);
  unauth.status === 401 ? ok('unauthenticated requests rejected') : fail('unauthenticated requests rejected', `got ${unauth.status}`);
}

// ---------------------------------------------------- 1: repo with Dockerfile
let dockerfileApp;
{
  console.log('\n[1] express app WITH Dockerfile (EXPOSE sniffing)');
  const url = makeFixtureRepo('express-dockerfile');
  const { app, dep } = await deployApp({ repoUrl: url, name: 'exdocker' });
  dockerfileApp = app;
  dep.status === 'live' ? ok('deploys to live') : fail('deploys to live', dep.error ?? dep.status);
  dep.config?.builder === 'dockerfile' ? ok('used repo Dockerfile') : fail('used repo Dockerfile', dep.config?.builder);
  dep.config?.containerPort === 4567 ? ok('port 4567 sniffed from EXPOSE') : fail('port sniffed from EXPOSE', String(dep.config?.containerPort));
  const page = await viaTraefik('exdocker.localhost');
  page.status === 200 && page.body.includes('express-dockerfile')
    ? ok('routed at exdocker.localhost')
    : fail('routed at exdocker.localhost', `status ${page.status}`);
}

// ------------------------------------------- 2: node app WITHOUT Dockerfile
let nodetectApp;
{
  console.log('\n[2] express app WITHOUT Dockerfile (generated image + deploy.yml)');
  const url = makeFixtureRepo('express-nodetect');
  const { app, dep } = await deployApp({ repoUrl: url, name: 'nodetect' });
  nodetectApp = app;
  dep.status === 'live' ? ok('deploys to live') : fail('deploys to live', dep.error ?? dep.status);
  dep.config?.builder === 'node' ? ok('node builder generated a Dockerfile') : fail('node builder used', dep.config?.builder);
  dep.config?.healthPath === '/healthz' && dep.config?.sources?.health === 'yml'
    ? ok('health path came from deploy.yml')
    : fail('health path came from deploy.yml', JSON.stringify([dep.config?.healthPath, dep.config?.sources?.health]));
  const page = await viaTraefik('nodetect.localhost');
  page.body.includes('MESSAGE=hello-from-deploy-yml')
    ? ok('deploy.yml env var injected')
    : fail('deploy.yml env var injected', page.body.slice(0, 120));
}

// ---------------------------------------------- 3: env precedence UI > yml
{
  console.log('\n[3] dashboard env overrides deploy.yml');
  await api(`/apps/${nodetectApp.id}/env`, {
    method: 'PUT',
    body: JSON.stringify({ vars: [{ key: 'MESSAGE', value: 'ui-wins' }] }),
  });
  const r = await api(`/apps/${nodetectApp.id}/deploy`, { method: 'POST' });
  const dep = await waitForDeployment(r.body.deploymentId);
  dep.status === 'live' ? ok('redeploy live') : fail('redeploy live', dep.error ?? dep.status);
  const page = await viaTraefik('nodetect.localhost');
  page.body.includes('MESSAGE=ui-wins') ? ok('UI env beat deploy.yml env') : fail('UI env beat deploy.yml env', page.body.slice(0, 120));
}

// ------------------------------------------------------------ 4: static site
{
  console.log('\n[4] plain static site');
  const url = makeFixtureRepo('static-site');
  const { dep } = await deployApp({ repoUrl: url, name: 'statictest' });
  dep.status === 'live' ? ok('deploys to live') : fail('deploys to live', dep.error ?? dep.status);
  dep.config?.builder === 'static' ? ok('static builder chosen') : fail('static builder chosen', dep.config?.builder);
  const page = await viaTraefik('statictest.localhost');
  page.status === 200 && page.body.includes('static-site') ? ok('served by nginx') : fail('served by nginx', `status ${page.status}`);
  const css = await viaTraefik('statictest.localhost', '/style.css');
  css.status === 200 && css.body.includes('system-ui') ? ok('assets served') : fail('assets served', `status ${css.status}`);
}

// --------------------------------------- 5: broken build keeps old version
{
  console.log('\n[5] broken build never touches the running version');
  commitFile('express-nodetect', 'Dockerfile', 'FROM node:22-slim\nRUN echo boom && exit 1\n', 'break the build');
  const r = await api(`/apps/${nodetectApp.id}/deploy`, { method: 'POST' });
  const dep = await waitForDeployment(r.body.deploymentId);
  dep.status === 'failed' ? ok('broken deployment failed') : fail('broken deployment failed', dep.status);
  dep.failedStage === 'building' ? ok('failed at building stage') : fail('failed at building stage', dep.failedStage ?? 'null');
  const page = await viaTraefik('nodetect.localhost');
  page.status === 200 && page.body.includes('MESSAGE=ui-wins')
    ? ok('previous version still serving')
    : fail('previous version still serving', `status ${page.status}`);
  const logText = await api(`/deployments/${dep.id}/log`);
  String(logText.body).includes('boom') ? ok('build log captured the failure') : fail('build log captured the failure');
}

// ------------------------------------------------------------- 6: deletion
{
  console.log('\n[6] delete removes route + containers + images');
  const apps = await api('/apps');
  const statictest = apps.body.find((a) => a.name === 'statictest');
  await api(`/apps/${statictest.id}`, { method: 'DELETE' });
  await sleep(3000);
  const page = await viaTraefik('statictest.localhost');
  page.status === 404 ? ok('route gone (traefik 404)') : fail('route gone', `status ${page.status}`);
  const ps = execFileSync('docker', ['ps', '-a', '--filter', 'label=deployer.app=statictest', '--format', '{{.Names}}']).toString().trim();
  ps === '' ? ok('no containers left') : fail('no containers left', ps);
  const imgs = execFileSync('docker', ['images', 'dep-statictest', '--format', '{{.Tag}}']).toString().trim();
  imgs === '' ? ok('no images left') : fail('no images left', imgs);
}

// ------------------------------------------------------------------ summary
console.log('\n──────── summary ────────');
const failed = results.filter((r) => !r[1]);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}
console.log('all good 🚀');
