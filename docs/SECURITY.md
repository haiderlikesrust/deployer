# Security model

deployer is a **single-admin personal tool**. Its threat model is "I deploy my
own repos on my own VPS" — not multi-tenant hosting of untrusted code.

## The docker socket = root

The deployer container mounts `/var/run/docker.sock`. Anything that controls
that socket effectively has root on the host (it can start privileged
containers, mount `/`, etc.). This is inherent to what the tool does — it
builds and runs containers. Consequences:

- **The dashboard password protects root on your VPS.** Use a long one.
- Anyone who can push to a repo you deploy can run code on your VPS (inside a
  container, but still). Only deploy repos you control.
- A docker socket proxy would not help: deployer legitimately needs
  create/build/run/exec/rm — exactly the calls a proxy would have to allow.

Mitigations in place:

- Dashboard sits behind auth (scrypt-hashed password, signed HttpOnly
  SameSite=Strict session cookie) and HTTPS in production.
- Login is rate-limited (10 attempts / 15 min / IP).
- App containers never get the socket, never publish host ports, and can get
  memory limits.
- Traefik's socket mount is read-only and its API/dashboard is disabled.

## Secrets

- Git tokens are delivered to `git` via `GIT_ASKPASS` — never on a command
  line, never embedded in remote URLs. Known token values are scrubbed from
  build logs, runtime logs, and error messages. The API never returns a stored
  token.
- Env vars and tokens are stored **plaintext** in SQLite at
  `/opt/deployer/data` (mode 0700, root-owned). Encrypting them with a key
  stored on the same disk would be security theater; treat filesystem access
  as game over (it implies root anyway, see above).
- `--env-file` temp files are 0600 and deleted right after `docker run`.

## Network exposure

- Only Traefik binds public ports (80/443). The deployer API is reachable
  exclusively through it.
- Deployed apps are isolated on the `deployer` bridge network. They can reach
  each other by container name — if that bothers you, run sensitive apps
  elsewhere (per-app networks are a planned option).

## Updating

`cd /opt/deployer/src && git pull && cd .. && docker compose build && docker compose up -d`

Pin your repo remote to your own fork so a compromised upstream can't ship you
code.
