#!/usr/bin/env bash
# Runs install/install.sh inside a throwaway Ubuntu container with a STUB docker
# CLI, to exercise the installer's audit + config generation on real Linux
# without touching any real daemon. Prints the generated .env and compose file
# so they can be validated afterwards.
#
#   docker run --rm -v "$PWD:/repo:ro" ubuntu:24.04 bash /repo/scripts/test-installer-sandbox.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq git curl iproute2 ca-certificates >/dev/null

# --- stub docker CLI: answers the few things the installer asks ---
cat > /usr/local/bin/docker <<'STUB'
#!/usr/bin/env bash
# Stub that mimics the REAL stdin behaviour of each subcommand, so the piped
# install is tested honestly: `compose exec` drains stdin like the real thing.
case "$1 $2" in
  "version --format") echo "27.5.1" ;;
  "compose version") echo "Docker Compose version v2.32.0" ;;
  "network inspect") exit 1 ;;          # pretend the network is missing
  "network create") echo "created" ;;
  "compose build") echo "stub: would build" ;;
  "compose up") echo "stub: would start" ;;
  "compose ps") echo "stubcid123" ;;
  "compose down") echo "stub: would stop" ;;
  "inspect --format") echo "healthy" ;;
  "compose exec"|"exec ") cat >/dev/null 2>&1; exit 0 ;;   # drains stdin, as the real CLI does
  *) echo "stub docker: $*" ;;
esac
STUB
chmod +x /usr/local/bin/docker

# --- a committable copy of the repo (the real one may have no commits yet) ---
mkdir -p /tmp/srcrepo
cp -r /repo/. /tmp/srcrepo/ 2>/dev/null || true
rm -rf /tmp/srcrepo/.git /tmp/srcrepo/node_modules /tmp/srcrepo/*/node_modules /tmp/srcrepo/data
cd /tmp/srcrepo
git init -q -b main && git config user.email t@t.local && git config user.name t
git add -A && git commit -q -m "sandbox fixture"

echo "════════ running installer (generated password, prod SSL, PIPED) ════════"
# Piped through stdin exactly like `curl ... | bash` — this is what catches
# commands that steal the script off stdin. Deliberately no --admin-password
# and no staging, so the generator and production-CA branches run too.
cat /repo/install/install.sh | bash -s -- \
  --base-domain example.com \
  --email admin@example.com \
  --repo /tmp/srcrepo

grep -q '^ADMIN_PASSWORD=.\{12,\}$' /opt/deployer/.env \
  && echo "PASSWORD_GENERATED_OK" \
  || { echo "FAIL: no usable generated password in .env"; exit 1; }
grep -q 'acme.caserver' /opt/deployer/docker-compose.yml \
  && { echo "FAIL: staging CA leaked into a prod install"; exit 1; } \
  || echo "PROD_CA_OK"

echo "════════ re-running installer (explicit password + staging) ════════"
bash /repo/install/install.sh \
  --base-domain example.com \
  --email admin@example.com \
  --admin-password 'sandbox-pw' \
  --ssl-mode letsencrypt-staging \
  --repo /tmp/srcrepo

echo
echo "════════ generated .env ════════"
cat /opt/deployer/.env
echo
echo "════════ generated docker-compose.yml ════════"
cat /opt/deployer/docker-compose.yml
echo
echo "════════ permission checks ════════"
stat -c '%a %n' /opt/deployer/.env /opt/deployer/data /opt/deployer/letsencrypt/acme.json
echo
echo "════════ python yaml parse ════════"
if command -v python3 >/dev/null; then
  python3 - <<'PY' || echo "YAML PARSE FAILED"
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
d = yaml.safe_load(open('/opt/deployer/docker-compose.yml'))
print("services:", list(d['services']))
print("traefik cmd flags:", len(d['services']['traefik']['command']))
print("deployer labels:", len(d['services']['deployer']['labels']))
PY
fi
echo "SANDBOX_OK"
