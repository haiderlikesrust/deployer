# deployer 🚀

A tiny self-hosted PaaS for one person and one VPS. Paste a Git repo URL into
the dashboard — deployer clones it, figures out how to build it, runs it in a
container, and puts it live on `https://<app-name>.<your-domain>` with
automatic HTTPS. No per-project server config, ever.

```
repo URL ──> clone ──> detect/build image ──> run container ──> Traefik routes
                                                               <name>.domain + TLS
```

## How it decides how to build (zero-config, with escape hatches)

1. **Repo has a `Dockerfile`?** It wins. deployer builds and runs it
   (container port sniffed from `EXPOSE`, overridable).
2. **No Dockerfile?** The stack is auto-detected and a clean Dockerfile is
   generated (and printed in the build log):
   - `package.json` with a `start` script → Node server (`node:22-slim`, `PORT` injected)
   - `package.json` with only a `build` script / Vite / CRA → static frontend (build → nginx)
   - `requirements.txt` / `pyproject.toml` → Python (uvicorn/gunicorn guessed)
   - bare `index.html` → static site (nginx)
3. **Overrides, per key, when you need them** — precedence:
   **dashboard settings > `deploy.yml` in the repo > auto-detection.**

`deploy.yml` (optional, all keys optional):

```yaml
type: web            # web | worker | static
port: 8080
build: "npm run build"
start: "node dist/server.js"
dockerfile: docker/Dockerfile.prod
health: /healthz
domain: notes.example.com
env:
  NODE_ENV: production
```

Every deployment snapshots its resolved config — the dashboard shows exactly
which value came from where.

## Install on a VPS

**Requirements**

| | |
|---|---|
| OS | Ubuntu/Debian (tested path); root/sudo access |
| Docker | Engine ≥ 24 with the compose plugin — the installer offers to install it |
| RAM | 2 GB recommended. 1 GB works only if you add swap: building frontends (vite/webpack) is the memory-hungry part, and the installer builds the dashboard too |
| Disk | 5 GB+ free (images add up; the deployer prunes old ones automatically) |
| Ports | 80/443 free, **or** use `--mode behind-nginx` |
| Arch | amd64 and arm64 both supported |

**Note:** the image build uses `npm ci`, so `server/package-lock.json` and `web/package-lock.json` must stay committed.

```bash
curl -fsSL https://raw.githubusercontent.com/haiderlikesrust/deployer/main/install/install.sh | sudo bash -s -- \
  --base-domain example.com --email you@example.com
```

- No domain yet? Skip `--base-domain` — you get `<ip>.sslip.io` and can deploy
  immediately (HTTPS on sslip.io is best-effort; bring a domain later).
- DNS: point `A example.com` and `A *.example.com` at the VPS. Dashboard lives
  at `deploy.example.com`.
- Box already runs nginx? See [install/nginx-fallback.md](install/nginx-fallback.md).
- First run on a fresh domain? Use `--ssl-mode letsencrypt-staging` to avoid
  Let's Encrypt rate limits while testing, then re-run with `letsencrypt`.

## Features

- **Deploy queue** with live-streamed build logs (SSE), deployment history,
  cancel, and per-deployment resolved-config panel
- **Zero-downtime-ish swaps**: the new container must pass a health gate before
  the old one is removed; failed builds never touch the running version
- **Private repos** via personal access token (GitHub/GitLab/Gitea) — delivered
  through `GIT_ASKPASS`, scrubbed from all logs
- **Env var editor** with bulk `.env` paste
- **Workers** (no HTTP route), **static sites**, custom domains per app
- **Housekeeping**: old images pruned (keep-N), orphan cleanup on boot, disk
  guard before builds

## Local development (Windows/macOS with Docker Desktop)

```bash
docker network create deployer
docker compose -f docker-compose.dev.yml up -d     # traefik on :80
cd server && npm install && npm run dev            # API on :3000
cd web && npm install && npm run dev               # dashboard on :5173 (proxies /api)
```

Deployed test apps appear at `http://<name>.localhost`. The `examples/` folder
has three sample apps covering the Dockerfile, generated-Node, and static
paths.

## Architecture (two containers + your apps)

- **traefik** owns 80/443, routes by Docker labels, does Let's Encrypt HTTP-01
- **deployer** (this app) — Fastify + SQLite + React, mounts the docker socket,
  shells out to `git`/`docker`
- each app runs as `dep-<name>-<deployment>` on the shared `deployer` network,
  never publishing host ports

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing this to the internet.

## Testing

`scripts/e2e.mjs` deploys the three `examples/` apps through the real pipeline and
asserts routing, config precedence, failure isolation, and cleanup.

Against a server running on the host:

```bash
node scripts/e2e.mjs --password <admin-password>
```

Against the deployer running as a container (the way it runs on a VPS — start it
with `-v <fixtures>:/fixtures` and publish 3100):

```bash
node scripts/e2e.mjs --password <pw> --base http://localhost:3100 --work <fixtures> --repo-base file:///fixtures
```

`scripts/test-installer-sandbox.sh` exercises `install/install.sh` inside a
throwaway Ubuntu container with a stubbed docker CLI, so the audit and the
generated `.env`/compose file can be checked without touching a real host.
