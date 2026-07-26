#!/usr/bin/env node
/**
 * Regression fixtures for stack detection. Each case is a repo shape that has a
 * single correct answer; several exist because an earlier heuristic got them
 * wrong and silently mis-deployed the app.
 *
 *   node scripts/detect-fixtures.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve(import.meta.dirname, '..', 'server', 'src');
const load = async (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const { analyzeNode } = await load('core/detect/node.ts');
const { analyzePython } = await load('core/detect/python.ts');
const { parseEnvExample } = await load('core/detect/envexample.ts');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-detect-'));
let pass = 0;
const failures = [];

function repo(name, files) {
  const dir = path.join(WORK, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${name}  ->  ${actual}`);
  } else {
    failures.push(`${name}: expected ${expected}, got ${actual}`);
    console.log(`  FAIL ${name}  ->  expected ${expected}, got ${actual}`);
  }
}

/** What configResolve would pick for a repo with no explicit type and no history. */
const nodeType = (dir) => {
  const a = analyzeNode(dir);
  if (a.kind === 'static') return 'static';
  return a.webEvidence ? 'web' : 'worker';
};
const pyType = (dir) => (analyzePython(dir).webEvidence ? 'web' : 'worker');

console.log('\nNode — must be web (a wrong "worker" silently removes the route):');
check(
  'express api',
  nodeType(repo('n-express', {
    'package.json': JSON.stringify({ dependencies: { express: '^4' }, scripts: { start: 'node index.js' } }),
    'index.js': 'require("express")().listen(process.env.PORT)',
  })),
  'web'
);
check(
  'create-react-app (start script, dev server)',
  nodeType(repo('n-cra', {
    'package.json': JSON.stringify({ dependencies: { react: '^18', 'react-scripts': '5' }, scripts: { start: 'react-scripts start' } }),
    'src/index.js': 'import React from "react";',
  })),
  'web'
);
check(
  'docusaurus site',
  nodeType(repo('n-docu', {
    'package.json': JSON.stringify({ dependencies: { '@docusaurus/core': '3' }, scripts: { start: 'docusaurus start' } }),
    'src/index.js': 'export default {}',
  })),
  'web'
);
check(
  'hand-rolled server reading PORT',
  nodeType(repo('n-bundle', {
    'package.json': JSON.stringify({ dependencies: {}, scripts: { start: 'node dist/bundle.js' } }),
    'index.js': 'const port = process.env.PORT || 3000; require("http").createServer(h).listen(port);',
  })),
  'web'
);

console.log('\nNode — must be worker (a wrong "web" fails the health check):');
check(
  'discord bot',
  nodeType(repo('n-discord', {
    'package.json': JSON.stringify({ dependencies: { 'discord.js': '^14' }, scripts: { start: 'node bot.js' } }),
    'bot.js': 'new (require("discord.js").Client)().login(process.env.TOKEN)',
  })),
  'worker'
);
check(
  'trading bot (ccxt + ws + axios)',
  nodeType(repo('n-trader', {
    'package.json': JSON.stringify({ dependencies: { ccxt: '^4', ws: '^8', axios: '^1' }, scripts: { start: 'node bot.js' } }),
    'bot.js': 'const ccxt = require("ccxt"); setInterval(tick, 1000);',
  })),
  'worker'
);
check(
  'queue consumer',
  nodeType(repo('n-queue', {
    'package.json': JSON.stringify({ dependencies: { bullmq: '^5' }, scripts: { start: 'node worker.js' } }),
    'worker.js': 'new Worker("jobs", handler)',
  })),
  'worker'
);

console.log('\nNode — static:');
check(
  'vite SPA',
  nodeType(repo('n-vite', {
    'package.json': JSON.stringify({ devDependencies: { vite: '^5' }, scripts: { build: 'vite build' } }),
    'index.html': '<html></html>',
  })),
  'static'
);

console.log('\nPython:');
check(
  'fastapi with extras (uvicorn[standard])',
  pyType(repo('p-fastapi', {
    'requirements.txt': 'fastapi==0.110.0\nuvicorn[standard]==0.27.0\n',
    'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  })),
  'web'
);
check(
  'discord.py bot (pins aiohttp)',
  pyType(repo('p-discord', {
    'requirements.txt': 'discord.py==2.3.2\naiohttp==3.9.1\n',
    'bot.py': 'import discord\nclient = discord.Client()\n',
  })),
  'worker'
);
check(
  'celery worker',
  pyType(repo('p-celery', {
    'requirements.txt': 'celery==5.3.6\nredis==5.0.1\n',
    'worker.py': 'from celery import Celery\napp = Celery()\n',
  })),
  'worker'
);

// the extras fix must also restore the correct start command, not just the type
const fastapiStart = analyzePython(path.join(WORK, 'p-fastapi')).startCmd ?? '';
check('fastapi start command uses uvicorn', fastapiStart.startsWith('uvicorn') ? 'uvicorn' : fastapiStart, 'uvicorn');

console.log('\n.env.example parsing:');
const parsed = parseEnvExample(
  [
    '# Stripe secret key',
    'STRIPE_KEY=sk_test_xxxx',
    'SENTRY_DSN="" # optional, leave blank to disable',
    'ADMIN_PASS="changeme" # optional',
    'DATABASE_URL=postgres://localhost:5432/app',
    'PORT=3000',
    'export TOKEN=<your-token>',
  ].join('\r\n'),
  '.env.example'
);
const spec = (k) => parsed.vars.find((v) => v.key === k);
check('quoted empty + "# optional" is optional', String(spec('SENTRY_DSN')?.required), 'false');
check('quoted placeholder + "# optional" is optional', String(spec('ADMIN_PASS')?.required), 'false');
check('placeholder value is required', String(spec('STRIPE_KEY')?.required), 'true');
check('angle-bracket placeholder is required', String(spec('TOKEN')?.required), 'true');
check('concrete default is optional', String(spec('DATABASE_URL')?.required), 'false');
check('PORT is never required', String(spec('PORT')?.required), 'false');
check('description from preceding comment', spec('STRIPE_KEY')?.description ?? 'null', 'Stripe secret key');


console.log('\nRust / Go:');
const { analyzeRust, rustDockerfile } = await load('core/detect/rust.ts');
const { analyzeGo } = await load('core/detect/go.ts');

const rustWeb = repo('r-axum', {
  'Cargo.toml': '[package]\nname = "my-api"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n',
  'src/main.rs': 'fn main() {}',
});
check('rust axum -> web', analyzeRust(rustWeb).webEvidence ? 'web' : 'worker', 'web');

const rustBot = repo('r-bot', {
  'Cargo.toml': '[package]\nname = "trader"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
  'src/main.rs': 'fn main() { loop {} }',
});
check('rust cli/bot -> worker', analyzeRust(rustBot).webEvidence ? 'web' : 'worker', 'worker');
check('rust binary name from Cargo.toml', analyzeRust(rustBot).binName, 'trader');
check(
  'rust dockerfile copies that binary',
  rustDockerfile({ binName: 'trader', port: 3000 }).includes('/app/target/release/trader') ? 'yes' : 'no',
  'yes'
);

const goWeb = repo('g-gin', {
  'go.mod': 'module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
  'main.go': 'package main',
});
check('go gin -> web', analyzeGo(goWeb).webEvidence ? 'web' : 'worker', 'web');

const goBot = repo('g-worker', {
  'go.mod': 'module x\n',
  'main.go': 'package main\nfunc main() { for {} }',
});
check('go worker -> worker', analyzeGo(goBot).webEvidence ? 'web' : 'worker', 'worker');

fs.rmSync(WORK, { recursive: true, force: true });

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
