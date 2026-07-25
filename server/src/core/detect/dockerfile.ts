import fs from 'node:fs';
import path from 'node:path';

/** Resolve which Dockerfile to use: explicit override > ./Dockerfile. */
export function findDockerfile(repoDir: string, override: string | null): { relPath: string } | null {
  if (override) {
    const p = path.join(repoDir, override);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return { relPath: override };
    throw new Error(`configured dockerfile '${override}' not found in the repository`);
  }
  if (fs.existsSync(path.join(repoDir, 'Dockerfile'))) return { relPath: 'Dockerfile' };
  return null;
}

/** First `EXPOSE <port>` in the Dockerfile, if any. */
export function sniffExpose(repoDir: string, relPath: string): number | null {
  try {
    const content = fs.readFileSync(path.join(repoDir, relPath), 'utf8');
    const m = content.match(/^\s*EXPOSE\s+(\d{2,5})/im);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  } catch {}
  return null;
}
