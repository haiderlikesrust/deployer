#!/usr/bin/env node
/**
 * deployer CLI — one file, zero dependencies.
 *
 *   npm i -g .            (or: alias deployer="node /path/to/cli/deployer.mjs")
 *   deployer login https://deploy.yourdomain.com dpl_xxx
 *   deployer ls
 *   deployer deploy my-app            # or run inside a repo with a matching name
 *   deployer logs my-app --follow
 *   deployer env set my-app KEY=value
 *   deployer exec my-app "npm run migrate"
 *   deployer rollback my-app
 *
 * Config lives in ~/.deployer.json (mode 600). Create tokens in the dashboard
 * under System → API tokens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(os.homedir(), '.deployer.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function api(pathname, init = {}) {
  const cfg = loadConfig();
  if (!cfg) die('not logged in — run: deployer login <url> <token>');
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.status === 401) die('unauthorized — the token was rejected. Create a new one in System → API tokens.');
  if (!res.ok) die(typeof body === 'object' && body?.error ? body.error : `HTTP ${res.status}`);
  return body;
}

/** Resolve an app name, defaulting to the current directory's name. */
async function resolveApp(name) {
  const wanted = name ?? path.basename(process.cwd());
  const apps = await api('/apps');
  const app = apps.find((a) => a.name === wanted);
  if (!app) die(`no app named '${wanted}'${name ? '' : ' (run from the repo directory or pass a name)'}`);
  return app;
}

const STATUS_ICON = { live: '●', deploying: '◐', failed: '✕', stopped: '○', needs_env: '◌', new: '·' };

function pollDeployment(id) {
  return new Promise((resolve) => {
    let last = '';
    const tick = async () => {
      const dep = await api(`/deployments/${id}`);
      if (dep.status !== last) {
        last = dep.status;
        process.stdout.write(`  ${dep.status}\n`);
      }
      if (['live', 'failed', 'canceled', 'superseded', 'needs_env'].includes(dep.status)) return resolve(dep);
      setTimeout(tick, 2000);
    };
    tick();
  });
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'login': {
    const [url, token] = rest;
    if (!url || !token) die('usage: deployer login <dashboard-url> <token>');
    saveConfig({ url, token });
    const apps = await api('/apps');
    console.log(`logged in to ${url} — ${apps.length} app(s) visible`);
    break;
  }

  case 'ls':
  case 'list': {
    const apps = await api('/apps');
    if (!apps.length) console.log('no apps yet');
    for (const a of apps) {
      const icon = STATUS_ICON[a.status] ?? '·';
      const where = a.isWorker ? '(worker)' : (a.url ?? '');
      console.log(`${icon} ${a.name.padEnd(24)} ${a.status.padEnd(10)} ${where}`);
    }
    break;
  }

  case 'deploy': {
    const app = await resolveApp(rest[0]);
    const { deploymentId } = await api(`/apps/${app.id}/deploy`, { method: 'POST', body: JSON.stringify({}) });
    console.log(`deploying ${app.name} (#${deploymentId})`);
    const dep = await pollDeployment(deploymentId);
    if (dep.status !== 'live') {
      console.error(dep.error ?? `finished as ${dep.status}`);
      process.exit(1);
    }
    console.log(`✓ live${app.url ? ` at ${app.url}` : ''}`);
    break;
  }

  case 'rollback': {
    const app = await resolveApp(rest[0]);
    const deployments = await api(`/apps/${app.id}/deployments?limit=20`);
    const target = deployments.find((d) => d.imageTag && d.id !== app.activeDeploymentId && d.status !== 'failed');
    if (!target) die('no previous deployment with a retained image');
    const { deploymentId } = await api(`/deployments/${target.id}/rollback`, { method: 'POST' });
    console.log(`rolling back ${app.name} to #${target.id} (${target.commitSha?.slice(0, 8) ?? target.imageTag})`);
    const dep = await pollDeployment(deploymentId);
    console.log(dep.status === 'live' ? '✓ rolled back' : `✗ ${dep.error ?? dep.status}`);
    break;
  }

  case 'logs': {
    const follow = rest.includes('--follow') || rest.includes('-f');
    const app = await resolveApp(rest.find((a) => !a.startsWith('-')));
    if (!follow) {
      const { lines } = await api(`/apps/${app.id}/logs/history?q=&limit=200`);
      console.log(lines.reverse().join('\n'));
      break;
    }
    const cfg = loadConfig();
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/apps/${app.id}/logs/stream`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok || !res.body) die(`could not stream logs (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.text != null) console.log(payload.text);
        } catch {}
      }
    }
    break;
  }

  case 'env': {
    const [sub, nameOrPair, ...pairs] = rest;
    if (sub === 'ls' || sub === 'list') {
      const app = await resolveApp(nameOrPair);
      for (const v of await api(`/apps/${app.id}/env`)) console.log(`${v.key}=${v.value}`);
      break;
    }
    if (sub === 'set') {
      // `deployer env set app KEY=v` or, inside the repo, `deployer env set KEY=v`
      const inline = nameOrPair?.includes('=');
      const app = await resolveApp(inline ? undefined : nameOrPair);
      const all = [...(inline ? [nameOrPair] : []), ...pairs].filter(Boolean);
      if (!all.length) die('usage: deployer env set [app] KEY=value [KEY2=value2]');
      const current = await api(`/apps/${app.id}/env`);
      const merged = new Map(current.map((v) => [v.key, v.value]));
      for (const pair of all) {
        const eq = pair.indexOf('=');
        if (eq <= 0) die(`not a KEY=value pair: ${pair}`);
        merged.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      await api(`/apps/${app.id}/env`, {
        method: 'PUT',
        body: JSON.stringify({ vars: [...merged].map(([key, value]) => ({ key, value })) }),
      });
      console.log(`set ${all.length} variable(s) on ${app.name} — redeploy to apply`);
      break;
    }
    die('usage: deployer env <ls|set> ...');
    break;
  }

  case 'exec': {
    const app = await resolveApp(rest.length > 1 ? rest[0] : undefined);
    const command = rest.length > 1 ? rest.slice(1).join(' ') : rest[0];
    if (!command) die('usage: deployer exec [app] "<command>"');
    const res = await api(`/apps/${app.id}/exec`, { method: 'POST', body: JSON.stringify({ cmd: command }) });
    if (res.output) console.log(res.output);
    process.exit(res.code === 0 ? 0 : res.code);
    break;
  }

  case 'open': {
    const app = await resolveApp(rest[0]);
    if (!app.url) die(`${app.name} is a worker — it has no URL`);
    console.log(app.url);
    break;
  }

  default:
    console.log(`deployer — control your VPS from the terminal

  deployer login <url> <token>     save credentials (~/.deployer.json)
  deployer ls                      list apps and their status
  deployer deploy [app]            deploy and follow until live
  deployer rollback [app]          re-run the previous retained image
  deployer logs [app] [-f]         recent logs, or follow live
  deployer env ls [app]            print env vars
  deployer env set [app] K=V ...   set env vars
  deployer exec [app] "<cmd>"      run a command in the container
  deployer open [app]              print the app's URL

App name defaults to the current directory name.`);
    process.exit(cmd ? 1 : 0);
}
