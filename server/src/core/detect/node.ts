import fs from 'node:fs';
import path from 'node:path';

export interface NodeAnalysis {
  /** 'server' = long-running Node process; 'static' = frontend built to files. */
  kind: 'server' | 'static';
  installCmds: string[];
  buildCmd: string | null;
  startCmd: string | null; // only for kind=server
  pruneCmd: string | null;
  /** Exact lockfile COPY sources that exist (COPY with a non-matching glob fails the build). */
  copyFiles: string[];
  /** Short phrase proving this serves HTTP; null means "run it as a worker". */
  webEvidence: string | null;
  notes: string[];
}

const FRONTEND_DEPS = ['vite', 'react-scripts', '@angular/cli', 'astro', 'parcel', '@11ty/eleventy'];

/** next/nuxt/remix/sveltekit are deliberately absent — they are servers, not static builds. */
export const NODE_WEB_DEPS = [
  'express',
  'fastify',
  'koa',
  'hapi',
  '@hapi/hapi',
  'next',
  'nuxt',
  'remix',
  'hono',
  '@sveltejs/kit',
  'socket.io',
  'h3',
  'polka',
  'restify',
  'micro',
  'connect',
  'sails',
];

export const NODE_WEB_DEP_PREFIXES = [
  '@nestjs/',
  '@hono/',
  'apollo-server',
  '@apollo/server',
  '@trpc/server',
  '@adonisjs/',
  '@feathersjs/',
  '@remix-run/',
];

/** A client library is not a server — these never count as web evidence. */
export const NODE_WEB_DEP_DENYLIST = [
  'socket.io-client',
  'ws',
  'axios',
  'node-fetch',
  'undici',
  'got',
  'superagent',
  'express-rate-limit',
];

/** Probed (in order) for a start command AND for HTTP-listen evidence. */
export const SERVER_ENTRY_CANDIDATES = [
  'server.js',
  'index.js',
  'app.js',
  'main.js',
  'bot.js',
  'worker.js',
  'run.js',
  'start.js',
  'cli.js',
  'src/index.js',
  'src/main.js',
  'src/server.js',
  'src/bot.js',
  'src/app.js',
  'dist/index.js',
  'dist/main.js',
];

const ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

/**
 * Runners that serve HTTP. Frontend dev/preview servers count too: a repo whose
 * start script is `react-scripts start` or `docusaurus start` is a site, and
 * classifying it as a worker would silently leave it with no route at all.
 */
const START_SCRIPT_WEB_RE =
  /\b(next|nuxt|remix|astro|vite|serve|http-server|sirv|nest|react-scripts|docusaurus|gatsby|ng|webpack-dev-server|parcel|expo|vuepress|eleventy|nodemon)\b/;

const LISTEN_PATTERNS: { re: RegExp; api: string }[] = [
  { re: /\bhttps?2?\.createServer\s*\(/, api: 'http.createServer()' },
  { re: /\bBun\.serve\s*\(/, api: 'Bun.serve()' },
  { re: /\bDeno\.serve\s*\(/, api: 'Deno.serve()' },
  { re: /\b(app|server|httpServer|fastify|api)\.listen\s*\(/, api: '.listen()' },
  { re: /\.listen\s*\(\s*(?:process\.env\.PORT|PORT|\d{2,5})/, api: '.listen(PORT)' },
];

const MAX_SCANNED_SOURCES = 8;
const MAX_SOURCE_BYTES = 256_000;

export function analyzeNode(repoDir: string): NodeAnalysis | null {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error(`package.json exists but is not valid JSON: ${(e as Error).message}`);
  }

  const notes: string[] = [];
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  // package manager by lockfile
  const copyFiles = ['package.json'];
  let installCmds = ['RUN npm install'];
  let pruneCmd: string | null = 'RUN npm prune --omit=dev';
  let runScript = (s: string) => `npm run ${s}`;
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) {
    copyFiles.push('pnpm-lock.yaml');
    installCmds = ['RUN corepack enable', 'RUN pnpm install --frozen-lockfile'];
    pruneCmd = 'RUN pnpm prune --prod';
    runScript = (s: string) => `pnpm run ${s}`;
    notes.push('pnpm-lock.yaml found — using pnpm via corepack');
  } else if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) {
    copyFiles.push('yarn.lock');
    installCmds = ['RUN corepack enable', 'RUN yarn install --frozen-lockfile'];
    pruneCmd = null; // yarn classic has no prune; skip rather than guess
    runScript = (s: string) => `yarn ${s}`;
    notes.push('yarn.lock found — using yarn via corepack (no prod prune)');
  } else if (fs.existsSync(path.join(repoDir, 'package-lock.json'))) {
    copyFiles.push('package-lock.json');
    installCmds = ['RUN npm ci'];
    notes.push('package-lock.json found — using npm ci');
  } else {
    notes.push('no lockfile found — using npm install (consider committing a lockfile)');
  }

  const buildCmd = scripts.build ? `RUN ${runScript('build')}` : null;
  const mainEntry = typeof pkg.main === 'string' && pkg.main.trim() !== '' ? pkg.main.trim() : null;

  // Server vs static discrimination — static is decided before the web/worker split
  if (scripts.start) {
    notes.push(`start script found — treating as a Node server ("${scripts.start}")`);
    const webEvidence = detectWebEvidence(repoDir, allDeps, scripts.start, mainEntry);
    return {
      kind: 'server',
      installCmds,
      buildCmd,
      startCmd: runScript('start').replace(/^npm run start$/, 'npm start'),
      pruneCmd,
      copyFiles,
      webEvidence,
      notes,
    };
  }

  const frontendDep = FRONTEND_DEPS.find((d) => d in allDeps);
  if (frontendDep && scripts.build) {
    notes.push(`no start script + ${frontendDep} dependency — treating as a static frontend (build then serve with nginx)`);
    return { kind: 'static', installCmds, buildCmd, startCmd: null, pruneCmd: null, copyFiles, webEvidence: null, notes };
  }

  const entry = findServerEntry(repoDir, mainEntry);
  if (entry) {
    notes.push(`no start script — falling back to "node ${entry}"`);
    const webEvidence = detectWebEvidence(repoDir, allDeps, `node ${entry}`, entry);
    return { kind: 'server', installCmds, buildCmd, startCmd: `node ${entry}`, pruneCmd, copyFiles, webEvidence, notes };
  }

  if (scripts.build) {
    notes.push('no start script and no server entry, but a build script exists — treating as a static frontend');
    return { kind: 'static', installCmds, buildCmd, startCmd: null, pruneCmd: null, copyFiles, webEvidence: null, notes };
  }

  throw new Error(
    'package.json found, but no start script, no recognizable server entry (server.js/index.js/app.js/main), and no build script. ' +
      'Add a "start" script (or a start command in the app settings / deploy.yml), or commit a Dockerfile, ' +
      'or set type=worker with a start command if this is a background job.'
  );
}

/** First existing candidate, so a bare bot/CLI repo resolves a start command instead of throwing. */
function findServerEntry(repoDir: string, mainEntry: string | null): string | null {
  for (const base of [mainEntry, ...SERVER_ENTRY_CANDIDATES]) {
    if (!base) continue;
    for (const rel of variants(base, ['.js', '.mjs', '.cjs'])) {
      if (fs.existsSync(path.join(repoDir, rel))) return rel;
    }
  }
  return null;
}

/**
 * The signal that this repo actually serves HTTP. Order matters: a declared
 * dependency is the strongest claim, a source scan the weakest.
 */
function detectWebEvidence(
  repoDir: string,
  allDeps: Record<string, unknown>,
  startBody: string | null,
  mainEntry: string | null
): string | null {
  const dep = Object.keys(allDeps).find(
    (d) => !NODE_WEB_DEP_DENYLIST.includes(d) && (NODE_WEB_DEPS.includes(d) || NODE_WEB_DEP_PREFIXES.some((p) => d.startsWith(p)))
  );
  if (dep) return `${dep} dependency`;

  const runner = startBody?.match(START_SCRIPT_WEB_RE);
  if (runner) return `start script runs ${runner[1]}`;

  return scanForListen(repoDir, mainEntry);
}

/**
 * Reading PORT is the contract every app we can route must satisfy, so a repo
 * that reads it is asking to be served even when its framework is unknown
 * (hand-rolled servers, bundled output, unusual libraries).
 */
const PORT_REFERENCE_RE = /process\.env\.PORT|process\.env\[['"]PORT['"]\]|Bun\.env\.PORT|Deno\.env\.get\(\s*['"]PORT['"]/;

const SOURCE_SCAN_CANDIDATES = ['server.js', 'index.js', 'app.js', 'main.js', 'src/server.js', 'src/index.js', 'src/main.js', 'src/app.js'];

function scanForListen(repoDir: string, mainEntry: string | null): string | null {
  const seen = new Set<string>();
  const files: string[] = [];
  outer: for (const base of [mainEntry, ...SOURCE_SCAN_CANDIDATES]) {
    if (!base) continue;
    for (const rel of variants(base, ENTRY_EXTENSIONS)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!fs.existsSync(path.join(repoDir, rel))) continue;
      files.push(rel);
      if (files.length >= MAX_SCANNED_SOURCES) break outer;
    }
  }

  let portRef: string | null = null;
  for (const rel of files) {
    try {
      const full = path.join(repoDir, rel);
      if (fs.statSync(full).size > MAX_SOURCE_BYTES) continue;
      const src = fs.readFileSync(full, 'utf8');
      const hit = LISTEN_PATTERNS.find((p) => p.re.test(src));
      if (hit) return `${hit.api} in ${rel}`;
      if (!portRef && PORT_REFERENCE_RE.test(src)) portRef = `PORT is read in ${rel}`;
    } catch {
      // unreadable file — not evidence either way
    }
  }
  return portRef;
}

function variants(rel: string, extensions: string[]): string[] {
  const normalized = rel.replace(/^\.\//, '');
  const m = normalized.match(/^(.*)\.(js|mjs|cjs|ts)$/);
  if (!m) return [normalized];
  return extensions.map((e) => `${m[1]}${e}`);
}

const NODE_BASE = 'node:22-slim';

export function nodeServerDockerfile(a: {
  installCmds: string[];
  copyFiles: string[];
  buildCmd: string | null;
  startCmd: string;
  pruneCmd: string | null;
  port: number;
}): string {
  return [
    `FROM ${NODE_BASE}`,
    'WORKDIR /app',
    'ENV CI=true',
    `COPY ${a.copyFiles.join(' ')} ./`,
    ...a.installCmds,
    'COPY . .',
    ...(a.buildCmd ? [a.buildCmd] : []),
    'ENV NODE_ENV=production',
    ...(a.pruneCmd ? [a.pruneCmd] : []),
    `ENV PORT=${a.port}`,
    `EXPOSE ${a.port}`,
    `CMD ${a.startCmd}`,
    '',
  ].join('\n');
}

/** Output dirs probed (in order) for the static build result. */
export const STATIC_OUTPUT_DIRS = ['dist', 'build', 'out', 'public', '_site', '.output/public'];

export function nodeStaticDockerfile(a: { installCmds: string[]; copyFiles: string[]; buildCmd: string }): string {
  const probe = STATIC_OUTPUT_DIRS.map((d) => `if [ -f "/app/${d}/index.html" ]; then cp -r "/app/${d}/." /export/; fi`).join('; ');
  return [
    `FROM ${NODE_BASE} AS build`,
    'WORKDIR /app',
    'ENV CI=true',
    `COPY ${a.copyFiles.join(' ')} ./`,
    ...a.installCmds,
    'COPY . .',
    a.buildCmd,
    `RUN mkdir -p /export && ${probe}; [ -f /export/index.html ] || (echo "deployer: no build output containing index.html found (tried: ${STATIC_OUTPUT_DIRS.join(', ')})" && exit 1)`,
    '',
    'FROM nginx:1.27-alpine',
    'COPY .deployer/nginx.conf /etc/nginx/conf.d/default.conf',
    'COPY --from=build /export /usr/share/nginx/html',
    'EXPOSE 80',
    '',
  ].join('\n');
}
