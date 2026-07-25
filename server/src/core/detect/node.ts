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
  notes: string[];
}

const FRONTEND_DEPS = ['vite', 'react-scripts', '@angular/cli', 'astro', 'parcel', '@11ty/eleventy'];

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

  // Server vs static discrimination
  if (scripts.start) {
    notes.push(`start script found — treating as a Node server ("${scripts.start}")`);
    return { kind: 'server', installCmds, buildCmd, startCmd: runScript('start').replace(/^npm run start$/, 'npm start'), pruneCmd, copyFiles, notes };
  }

  const frontendDep = FRONTEND_DEPS.find((d) => d in allDeps);
  if (frontendDep && scripts.build) {
    notes.push(`no start script + ${frontendDep} dependency — treating as a static frontend (build then serve with nginx)`);
    return { kind: 'static', installCmds, buildCmd, startCmd: null, pruneCmd: null, copyFiles, notes };
  }

  const entry = ['server.js', 'index.js', 'app.js', 'main.js', pkg.main].filter(Boolean).find((f) => fs.existsSync(path.join(repoDir, f)));
  if (entry) {
    notes.push(`no start script — falling back to "node ${entry}"`);
    return { kind: 'server', installCmds, buildCmd, startCmd: `node ${entry}`, pruneCmd, copyFiles, notes };
  }

  if (scripts.build) {
    notes.push('no start script and no server entry, but a build script exists — treating as a static frontend');
    return { kind: 'static', installCmds, buildCmd, startCmd: null, pruneCmd: null, copyFiles, notes };
  }

  throw new Error(
    'package.json found, but no start script, no recognizable server entry (server.js/index.js/app.js/main), and no build script. ' +
      'Add a "start" script (or a start command in the app settings / deploy.yml), or commit a Dockerfile.'
  );
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
