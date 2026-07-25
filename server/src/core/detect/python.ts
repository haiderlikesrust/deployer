import fs from 'node:fs';
import path from 'node:path';

export interface PythonAnalysis {
  installLines: string[];
  startCmd: string | null;
  notes: string[];
}

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

  const reqs = hasReqs ? fs.readFileSync(path.join(repoDir, 'requirements.txt'), 'utf8').toLowerCase() : '';
  const has = (dep: string) => reqs.includes(dep);
  const entryModule = ['main.py', 'app.py'].find((f) => fs.existsSync(path.join(repoDir, f)))?.replace('.py', '') ?? null;

  let startCmd: string | null = null;
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
  if (!startCmd && entryModule) {
    startCmd = `python ${entryModule}.py`;
    notes.push(`no framework/server combo recognized — falling back to "python ${entryModule}.py" (make sure it binds 0.0.0.0:$PORT)`);
  }
  if (!startCmd) {
    notes.push('could not determine a start command');
  }
  return { installLines, startCmd, notes };
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
