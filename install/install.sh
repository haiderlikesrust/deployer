#!/usr/bin/env bash
# deployer VPS installer — audits the box, writes /opt/deployer, starts the stack.
#
#   curl -fsSL <raw-url>/install/install.sh | sudo bash -s -- \
#     --base-domain example.com --email you@example.com --admin-password 'secret'
#
# Flags (all optional — the script prompts or picks safe defaults):
#   --base-domain <domain>   apps live at <name>.<domain>, dashboard at deploy.<domain>
#                            default: <public-ip>.sslip.io (works with zero DNS setup)
#   --email <email>          Let's Encrypt account email
#   --admin-password <pw>    dashboard password (generated if omitted)
#   --ssl-mode <mode>        letsencrypt | letsencrypt-staging | none   (default: letsencrypt)
#   --repo <git-url>         where to clone the deployer from (default: this repo's origin)
#   --mode <mode>            traefik | behind-nginx   (default: auto-detected from ports)
#   --uninstall              stop the stack (keeps /opt/deployer/data)
set -euo pipefail

INSTALL_DIR=/opt/deployer
REPO_URL_DEFAULT="https://github.com/haiderlikesrust/deployer.git"
BASE_DOMAIN="" EMAIL="" ADMIN_PASSWORD="" SSL_MODE="letsencrypt" REPO_URL="" MODE="" UNINSTALL=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Never die silently: under `set -euo pipefail` a stray non-zero (a SIGPIPE in a
# pipeline, an unset variable) would otherwise end the install with no message.
trap 'rc=$?; printf "\033[1;31merror:\033[0m installer aborted at line %s (exit %s)\n" "$LINENO" "$rc" >&2' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-domain) BASE_DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --ssl-mode) SSL_MODE="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"

if [[ $UNINSTALL -eq 1 ]]; then
  log "stopping deployer stack (data in $INSTALL_DIR/data is preserved)"
  (cd "$INSTALL_DIR" && docker compose down </dev/null) || true
  log "done — remove $INSTALL_DIR manually if you want a full wipe"
  exit 0
fi

# ---------- audit ----------
log "auditing this machine"

source /etc/os-release 2>/dev/null || true
case "${ID:-unknown}" in
  ubuntu|debian) log "OS: ${PRETTY_NAME:-$ID}" ;;
  *) warn "untested OS (${PRETTY_NAME:-unknown}) — continuing, but Ubuntu/Debian is the tested path" ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  warn "docker not found"
  read -r -p "install docker via get.docker.com? [Y/n] " yn </dev/tty || yn=Y
  [[ "${yn:-Y}" =~ ^[Yy]?$ ]] || die "docker is required"
  curl -fsSL https://get.docker.com | sh
fi

DOCKER_MAJOR=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1 || echo 0)
[[ "$DOCKER_MAJOR" -ge 24 ]] || die "docker engine >= 24 required (found major version: $DOCKER_MAJOR) — BuildKit must be the default builder"
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (apt install docker-compose-plugin)"

PORTS_BUSY=""
for p in 80 443; do
  if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; then
    proc=$(ss -ltnp "sport = :$p" 2>/dev/null | awk 'NR==2 {print $NF}' | sed 's/.*"\(.*\)".*/\1/' || true)
    PORTS_BUSY+="$p(${proc:-unknown}) "
  fi
done

# Re-running over an existing install is normal (upgrades, a previous run that
# stopped early). Our own traefik holding 80/443 is not a conflict — every
# published container port shows up as "docker-proxy", so match the container.
if [[ -n "$PORTS_BUSY" ]] && docker ps --format '{{.Names}}' 2>/dev/null </dev/null | grep -q '^deployer-traefik'; then
  log "ports 80/443 are held by this deployer's own traefik — re-running over the existing install"
  PORTS_BUSY=""
fi

if [[ -z "$MODE" ]]; then
  if [[ -z "$PORTS_BUSY" ]]; then
    MODE=traefik
  else
    warn "ports already in use: $PORTS_BUSY"
    if [[ "$PORTS_BUSY" == *nginx* || "$PORTS_BUSY" == *apache* ]]; then
      echo "  An existing web server holds 80/443. Two options:"
      echo "    1) behind-nginx: deployer's proxy binds 127.0.0.1:8081; you add ONE wildcard site to nginx (see install/nginx-fallback.md)"
      echo "    2) abort, move those sites into the deployer later, and re-run"
      read -r -p "continue in behind-nginx mode? [y/N] " yn </dev/tty || yn=N
      [[ "$yn" =~ ^[Yy]$ ]] || die "aborted — free ports 80/443 or re-run with --mode behind-nginx"
      MODE=behind-nginx
    else
      die "ports 80/443 are taken by: $PORTS_BUSY — free them or re-run with --mode behind-nginx"
    fi
  fi
fi
log "mode: $MODE"

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
[[ "${FREE_GB:-0}" -ge 5 ]] || warn "only ${FREE_GB}GB free on / — builds need room, consider cleaning up"

PUBLIC_IP=$(curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
log "public IP: $PUBLIC_IP"

# ---------- configure ----------
if [[ -z "$BASE_DOMAIN" ]]; then
  SSLIP="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
  echo
  echo "  No --base-domain given. Options:"
  echo "    - press ENTER to use $SSLIP (works instantly, no DNS setup, HTTPS is best-effort)"
  echo "    - or type your domain (you'll add DNS records: A @ -> $PUBLIC_IP and A * -> $PUBLIC_IP)"
  read -r -p "base domain [$SSLIP]: " BASE_DOMAIN </dev/tty || true
  BASE_DOMAIN="${BASE_DOMAIN:-$SSLIP}"
fi

PUBLIC_SCHEME=https
if [[ "$MODE" == "behind-nginx" ]]; then
  SSL_MODE=none  # the existing nginx terminates TLS (and keeps serving https)
fi
[[ "$SSL_MODE" == "none" && "$MODE" != "behind-nginx" ]] && PUBLIC_SCHEME=http

# Re-running must not invent a new password: the server hashed the first one
# into its database on first boot and ignores later ADMIN_PASSWORD changes, so
# a freshly generated one would simply be wrong.
if [[ -z "$ADMIN_PASSWORD" && -f "$INSTALL_DIR/.env" ]]; then
  EXISTING_PW="$(sed -n 's/^ADMIN_PASSWORD=//p' "$INSTALL_DIR/.env" | head -n 1)"
  if [[ -n "$EXISTING_PW" ]]; then
    ADMIN_PASSWORD="$EXISTING_PW"
    log "reusing the existing admin password from $INSTALL_DIR/.env"
  fi
fi

if [[ -z "$ADMIN_PASSWORD" ]]; then
  # Careful: `tr </dev/urandom | head -c N` looks obvious but is a trap here —
  # head exits early, tr dies of SIGPIPE (141), and `set -o pipefail` turns
  # that into a silent installer death. Feed a bounded source instead.
  ADMIN_PASSWORD=$(openssl rand -base64 24 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' || true)
  ADMIN_PASSWORD=${ADMIN_PASSWORD:0:20}
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD=$(LC_ALL=C head -c 64 /dev/urandom 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' || true)
    ADMIN_PASSWORD=${ADMIN_PASSWORD:0:20}
  fi
  [[ -n "$ADMIN_PASSWORD" ]] || die "could not generate a password — re-run with --admin-password '<your password>'"
  GENERATED_PW=1
fi

if [[ "$SSL_MODE" == letsencrypt* && -z "$EMAIL" ]]; then
  read -r -p "Let's Encrypt email: " EMAIL </dev/tty || true
  [[ -n "$EMAIL" ]] || die "--email is required for Let's Encrypt"
fi

REPO_URL="${REPO_URL:-$REPO_URL_DEFAULT}"

log "writing $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"/{data,letsencrypt}
chmod 700 "$INSTALL_DIR/data"
touch "$INSTALL_DIR/letsencrypt/acme.json"
chmod 600 "$INSTALL_DIR/letsencrypt/acme.json"

export GIT_TERMINAL_PROMPT=0  # never block on credentials in a piped install
if [[ -d "$INSTALL_DIR/src/.git" ]]; then
  log "updating existing checkout"
  git -C "$INSTALL_DIR/src" pull --ff-only </dev/null
else
  log "cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR/src" </dev/null
fi

cat > "$INSTALL_DIR/.env" <<EOF
BASE_DOMAIN=$BASE_DOMAIN
SSL_MODE=$SSL_MODE
PUBLIC_SCHEME=$PUBLIC_SCHEME
LETSENCRYPT_EMAIL=${EMAIL:-none@example.com}
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
chmod 600 "$INSTALL_DIR/.env"

# ---------- compose file ----------
TRAEFIK_CMDS=(
  "--providers.docker=true"
  "--providers.docker.exposedbydefault=false"
  "--providers.docker.network=deployer"
  "--entrypoints.web.address=:80"
  "--log.level=INFO"
)
TRAEFIK_PORTS='      - "80:80"'
DASH_ENTRYPOINT=web
DASH_TLS=""

if [[ "$SSL_MODE" != "none" ]]; then
  TRAEFIK_CMDS+=(
    "--entrypoints.websecure.address=:443"
    "--entrypoints.web.http.redirections.entrypoint.to=websecure"
    "--entrypoints.web.http.redirections.entrypoint.scheme=https"
    "--certificatesresolvers.le.acme.email=\${LETSENCRYPT_EMAIL}"
    "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
    "--certificatesresolvers.le.acme.httpchallenge=true"
    "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web"
  )
  [[ "$SSL_MODE" == "letsencrypt-staging" ]] && TRAEFIK_CMDS+=("--certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory")
  TRAEFIK_PORTS=$'      - "80:80"\n      - "443:443"'
  DASH_ENTRYPOINT=websecure
  DASH_TLS='      - traefik.http.routers.deployer.tls.certresolver=le'
fi

if [[ "$MODE" == "behind-nginx" ]]; then
  TRAEFIK_PORTS='      - "127.0.0.1:8081:80"'
fi

CMD_YAML=""
for c in "${TRAEFIK_CMDS[@]}"; do CMD_YAML+="      - $c"$'\n'; done

cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  traefik:
    image: traefik:v3.7
    restart: unless-stopped
    command:
$CMD_YAML
    ports:
$TRAEFIK_PORTS
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - deployer

  deployer:
    build: ./src
    restart: unless-stopped
    environment:
      - DATA_DIR=/data
      - BASE_DOMAIN=\${BASE_DOMAIN}
      - SSL_MODE=\${SSL_MODE}
      - PUBLIC_SCHEME=\${PUBLIC_SCHEME}
      - ADMIN_PASSWORD=\${ADMIN_PASSWORD}
      - DOCKER_NETWORK=deployer
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
    networks:
      - deployer
    labels:
      - traefik.enable=true
      - traefik.http.routers.deployer.rule=Host(\`deploy.\${BASE_DOMAIN}\`)
      - traefik.http.routers.deployer.entrypoints=$DASH_ENTRYPOINT
      - traefik.http.routers.deployer.service=deployer
      - traefik.http.services.deployer.loadbalancer.server.port=3000
$DASH_TLS

networks:
  deployer:
    external: true
EOF

# ---------- launch ----------
docker network inspect deployer >/dev/null 2>&1 </dev/null || docker network create deployer </dev/null
log "building the deployer image (first run takes a few minutes)"
(cd "$INSTALL_DIR" && docker compose build </dev/null)
(cd "$INSTALL_DIR" && docker compose up -d </dev/null)

log "waiting for the deployer to come up"
# The deployer publishes no host port (traefik reaches it over the docker
# network), so health comes from the image's own HEALTHCHECK.
#
# NOTE: every docker call here redirects stdin from /dev/null. When this script
# is run as `curl ... | bash`, the SCRIPT ITSELF is on stdin — and any command
# that attaches stdin (`docker compose exec` notably) swallows the rest of it,
# ending the install silently with exit 0.
READY=0
CID="$(cd "$INSTALL_DIR" && docker compose ps -q deployer 2>/dev/null </dev/null || true)"
for _ in $(seq 1 45); do
  if [[ -z "$CID" ]]; then
    CID="$(cd "$INSTALL_DIR" && docker compose ps -q deployer 2>/dev/null </dev/null || true)"
  fi
  if [[ -n "$CID" ]]; then
    HS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}}' "$CID" 2>/dev/null </dev/null || echo unknown)"
    if [[ "$HS" == "healthy" ]]; then
      READY=1
      break
    fi
    if [[ "$HS" == "nohealthcheck" ]] && docker exec "$CID" curl -fsS http://localhost:3000/api/health >/dev/null 2>&1 </dev/null; then
      READY=1
      break
    fi
  fi
  sleep 2
done
if [[ $READY -eq 0 ]]; then
  warn "the deployer did not report healthy within 90s"
  warn "check the logs:  cd $INSTALL_DIR && docker compose logs deployer"
fi

SCHEME=https; [[ "$SSL_MODE" == "none" ]] && SCHEME=http
echo
echo "─────────────────────────────────────────────────────"
if [[ $READY -eq 1 ]]; then
  echo "  deployer is up 🚀"
else
  echo "  deployer installed, but not healthy yet ⚠"
fi
echo
echo "  dashboard:  $SCHEME://deploy.$BASE_DOMAIN"
echo "  password:   $ADMIN_PASSWORD"
[[ -n "${GENERATED_PW:-}" ]] && echo "              (generated — save it now)"
echo
if [[ "$BASE_DOMAIN" != *sslip.io && "$MODE" == "traefik" ]]; then
  echo "  DNS records to add (if you haven't):"
  echo "    A  $BASE_DOMAIN      -> $PUBLIC_IP"
  echo "    A  *.$BASE_DOMAIN    -> $PUBLIC_IP"
  echo
fi
if [[ "$MODE" == "behind-nginx" ]]; then
  echo "  behind-nginx mode: add the wildcard site from install/nginx-fallback.md"
  echo "  (proxy *.$BASE_DOMAIN and deploy.$BASE_DOMAIN to 127.0.0.1:8081)"
  echo
fi
if [[ "$SSL_MODE" == "letsencrypt-staging" ]]; then
  echo "  NOTE: staging certificates — browsers will warn. Re-run with"
  echo "  --ssl-mode letsencrypt once everything works."
  echo
fi
echo "  password also stored in:  $INSTALL_DIR/.env"
echo
echo "  update later:  cd $INSTALL_DIR/src && git pull && cd .. && docker compose build && docker compose up -d"
echo "─────────────────────────────────────────────────────"
