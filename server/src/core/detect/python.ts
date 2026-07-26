import fs from 'node:fs';
import path from 'node:path';

export interface PythonAnalysis {
  installLines: string[];
  startCmd: string | null;
  /** Short phrase proving this repo serves HTTP; null means "run it as a worker". */
  webEvidence: string | null;
  notes: string[];
}

const PY_WEB_PACKAGES = [
  'fastapi',
  'flask',
  'django',
  'starlette',
  'uvicorn',
  'gunicorn',
  'sanic',
  'tornado',
  'bottle',
  'falcon',
  'quart',
  'litestar',
  'hypercorn',
  'waitress',
  'daphne',
];

// aiohttp and werkzeug are deliberately absent above: aiohttp is discord.py's
// HTTP *client* and werkzeug arrives transitively with Flask, so treating either
// as proof of a server classifies bots as web apps. APP_PATTERNS still catches
// a genuine aiohttp server via web.Application().

/**
 * Bare package names out of requirements.txt / pyproject.toml, extras and version
 * pins stripped. `[` must terminate a name or `uvicorn[standard]` — the install
 * line FastAPI's own docs give — would read as the package "standard".
 */
const PY_PACKAGE_RE = /(?:^|[\s"'\[,(])([A-Za-z][A-Za-z0-9._-]{1,40})(?=[\s"'\[\],;=<>!~)]|$)/gm;

const ENTRY_CANDIDATES = [
  'main.py',
  'app.py',
  'bot.py',
  'worker.py',
  'run.py',
  'start.py',
  '__main__.py',
  'src/main.py',
  'src/bot.py',
  'src/app.py',
];

const SOURCE_SCAN_CANDIDATES = ['main.py', 'app.py', 'wsgi.py', 'asgi.py', 'server.py', 'src/main.py', 'src/app.py'];

const APP_PATTERNS: { re: RegExp; api: string }[] = [
  { re: /\b(FastAPI|Flask|Sanic|Quart|Litestar|Starlette)\s*\(/, api: 'web framework constructor' },
  { re: /\bweb\.Application\s*\(/, api: 'aiohttp web.Application()' },
  { re: /\btornado\.web\b/, api: 'tornado.web' },
  { re: /\bapp\.run\s*\(/, api: 'app.run()' },
];

const MAX_SOURCE_BYTES = 256_000;

export function analyzePython(repoDir: string): PythonAnalysis | null {
  const hasReqs = fs.existsSync(path.join(repoDir, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(repoDir, 'pyproject.toml'));
  if (!hasReqs && !hasPyproject) return null;

  const notes: string[] = [];
  const installLines = hasReqs
    ? ['COPY requirements.txt ./', 'RUN pip install --no-cache-dir -r requirements.txt']
    : ['COPY . .', 'RUN pip install --no-cache-dir .'];
  if (hasReqs) notes.push('requirements.txt found');
  else notes.push('pyproject.toml found — installing with pip (no requirements.txt)');

  // poetry/uv projects declare everything in pyproject.toml, so both files count
  const deps = new Map<string, string>();
  for (const file of ['requirements.txt', 'pyproject.toml']) {
    for (const pkg of readPackages(repoDir, file)) if (!deps.has(pkg)) deps.set(pkg, file);
  }
  const has = (dep: string) => deps.has(dep);

  const entryRel = ENTRY_CANDIDATES.find((f) => fs.existsSync(path.join(repoDir, f))) ?? null;
  const entryModule = entryRel ? entryRel.replace(/\.py$/, '').replace(/\//g, '.') : null;

  // aiohttp/werkzeug are deliberately not in PY_WEB_PACKAGES: they only count as
  // web evidence when the source scan finds a server being started.
  const webPkg = PY_WEB_PACKAGES.find((p) => has(p));
  const webEvidence = webPkg ? `${webPkg} in ${deps.get(webPkg)}` : scanForApp(repoDir);

  let startCmd: string | null = null;
  if (webEvidence) {
    if ((has('fastapi') || has('starlette')) && has('uvicorn')) {
      const mod = entryModule ?? 'main';
      startCmd = `uvicorn ${mod}:app --host 0.0.0.0 --port \${PORT}`;
      notes.push(`fastapi + uvicorn detected — start: ${startCmd}`);
    } else if (has('flask') && has('gunicorn')) {
      const mod = entryModule ?? 'app';
      startCmd = `gunicorn --bind 0.0.0.0:\${PORT} ${mod}:app`;
      notes.push(`flask + gunicorn detected — start: ${startCmd}`);
    } else if (has('django') && has('gunicorn')) {
      const wsgiPkg = findWsgiPackage(repoDir);
      if (wsgiPkg) {
        startCmd = `gunicorn --bind 0.0.0.0:\${PORT} ${wsgiPkg}.wsgi`;
        notes.push(`django + gunicorn detected — start: ${startCmd}`);
      }
    }
  }

  if (!startCmd && entryRel) {
    startCmd = `python ${entryRel}`;
    notes.push(
      webEvidence
        ? `no framework/server combo recognized — falling back to "python ${entryRel}" (make sure it binds 0.0.0.0:$PORT)`
        : `no web framework detected — falling back to "python ${entryRel}"`
    );
  }
  if (!startCmd) {
    notes.push('could not determine a start command');
  }
  return { installLines, startCmd, webEvidence, notes };
}

function readPackages(repoDir: string, file: string): string[] {
  const full = path.join(repoDir, file);
  let content: string;
  try {
    if (!fs.existsSync(full) || fs.statSync(full).size > MAX_SOURCE_BYTES) return [];
    content = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of content.matchAll(PY_PACKAGE_RE)) out.push(m[1].toLowerCase().replace(/[._]/g, '-'));
  return out;
}

function scanForApp(repoDir: string): string | null {
  for (const rel of SOURCE_SCAN_CANDIDATES) {
    try {
      const full = path.join(repoDir, rel);
      if (!fs.existsSync(full) || fs.statSync(full).size > MAX_SOURCE_BYTES) continue;
      const src = fs.readFileSync(full, 'utf8');
      const hit = APP_PATTERNS.find((p) => p.re.test(src));
      if (hit) return `${hit.api} in ${rel}`;
    } catch {
      // unreadable file — not evidence either way
    }
  }
  return null;
}

function findWsgiPackage(repoDir: string): string | null {
  try {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(repoDir, entry.name, 'wsgi.py'))) return entry.name;
    }
  } catch {}
  return null;
}

export function pythonDockerfile(a: { installLines: string[]; buildCmd: string | null; startCmd: string; port: number }): string {
  return [
    'FROM python:3.12-slim',
    'WORKDIR /app',
    'ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1',
    ...a.installLines,
    'COPY . .',
    ...(a.buildCmd ? [`RUN ${a.buildCmd}`] : []),
    `ENV PORT=${a.port}`,
    `EXPOSE ${a.port}`,
    `CMD ${a.startCmd}`,
    '',
  ].join('\n');
}
