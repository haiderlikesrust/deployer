import fs from 'node:fs';
import path from 'node:path';

export interface RustAnalysis {
  binName: string;
  webEvidence: string | null;
  notes: string[];
}

const RUST_WEB_DEPS = ['actix-web', 'axum', 'rocket', 'warp', 'tide', 'poem', 'salvo', 'ntex', 'viz'];

export function analyzeRust(repoDir: string): RustAnalysis | null {
  const cargoPath = path.join(repoDir, 'Cargo.toml');
  if (!fs.existsSync(cargoPath)) return null;
  const cargo = fs.readFileSync(cargoPath, 'utf8');

  const notes: string[] = [];
  // [[bin]] name wins over [package] name when present
  const binSection = cargo.match(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/);
  const pkgName = cargo.match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/);
  const binName = binSection?.[1] ?? pkgName?.[1] ?? null;
  if (!binName) throw new Error('Cargo.toml has no [package] name — cannot determine the binary to run');
  notes.push(`Cargo.toml found — building release binary '${binName}'`);

  let webEvidence: string | null = null;
  const dep = RUST_WEB_DEPS.find((d) => new RegExp(`^\\s*"?${d}"?\\s*=`, 'm').test(cargo));
  if (dep) webEvidence = `${dep} in Cargo.toml`;
  if (!webEvidence) {
    for (const rel of ['src/main.rs', 'src/lib.rs']) {
      try {
        const src = fs.readFileSync(path.join(repoDir, rel), 'utf8');
        if (/env(?:::var)?\s*\(\s*"PORT"/.test(src) || /\.bind\s*\(/.test(src)) {
          webEvidence = `server bind / PORT read in ${rel}`;
          break;
        }
      } catch {}
    }
  }
  return { binName, webEvidence, notes };
}

export function rustDockerfile(a: { binName: string; port: number }): string {
  return [
    'FROM rust:1-slim AS build',
    'WORKDIR /app',
    'COPY . .',
    'RUN cargo build --release --locked || cargo build --release',
    '',
    'FROM debian:bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*',
    'WORKDIR /app',
    `COPY --from=build /app/target/release/${a.binName} /app/${a.binName}`,
    `ENV PORT=${a.port}`,
    `EXPOSE ${a.port}`,
    `CMD ["/app/${a.binName}"]`,
    '',
  ].join('\n');
}
