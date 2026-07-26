import fs from 'node:fs';
import path from 'node:path';

export interface GoAnalysis {
  webEvidence: string | null;
  hasGoSum: boolean;
  notes: string[];
}

const GO_WEB_MODULES = ['gin-gonic/gin', 'labstack/echo', 'gofiber/fiber', 'go-chi/chi', 'gorilla/mux', 'beego/beego'];

export function analyzeGo(repoDir: string): GoAnalysis | null {
  const modPath = path.join(repoDir, 'go.mod');
  if (!fs.existsSync(modPath)) return null;
  const mod = fs.readFileSync(modPath, 'utf8');

  const notes: string[] = ['go.mod found — building a static binary'];
  let webEvidence: string | null = null;
  const dep = GO_WEB_MODULES.find((d) => mod.includes(d));
  if (dep) webEvidence = `${dep} in go.mod`;
  if (!webEvidence) {
    for (const rel of ['main.go', 'server.go', 'cmd/server/main.go', 'cmd/app/main.go']) {
      try {
        const src = fs.readFileSync(path.join(repoDir, rel), 'utf8');
        if (/http\.ListenAndServe|os\.Getenv\(\s*"PORT"/.test(src)) {
          webEvidence = `http server / PORT read in ${rel}`;
          break;
        }
      } catch {}
    }
  }
  return { webEvidence, hasGoSum: fs.existsSync(path.join(repoDir, 'go.sum')), notes };
}

export function goDockerfile(a: { hasGoSum: boolean; port: number }): string {
  return [
    'FROM golang:1.23-alpine AS build',
    'WORKDIR /app',
    a.hasGoSum ? 'COPY go.mod go.sum ./' : 'COPY go.mod ./',
    'RUN go mod download',
    'COPY . .',
    'RUN CGO_ENABLED=0 go build -o /out/app .',
    '',
    'FROM alpine:3.20',
    'RUN apk add --no-cache ca-certificates',
    'COPY --from=build /out/app /app/app',
    `ENV PORT=${a.port}`,
    `EXPOSE ${a.port}`,
    'CMD ["/app/app"]',
    '',
  ].join('\n');
}
