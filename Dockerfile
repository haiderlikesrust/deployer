# The deployer's own image: Fastify API + built dashboard + git + docker CLI.
# It talks to the host's docker daemon through the mounted socket — it never
# runs a daemon itself.

# ---- dashboard build ----
FROM node:22-bookworm-slim AS webbuild
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# ---- server build ----
FROM node:22-bookworm-slim AS serverbuild
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# static docker CLI (client only, no daemon) + the buildx plugin.
# buildx is REQUIRED: BuildKit is the default builder on Engine 23+, and the
# static CLI tarball does not bundle it — without the plugin every build fails
# with "BuildKit is enabled but the buildx component is missing".
# The plugin talks to the daemon's embedded BuildKit over the mounted socket
# (driver=docker), so no privileged builder container is needed.
ARG DOCKER_CLI_VERSION=27.5.1
ARG BUILDX_VERSION=0.35.0
RUN ARCH=$(dpkg --print-architecture) \
  && case "$ARCH" in amd64) DARCH=x86_64 ;; arm64) DARCH=aarch64 ;; *) echo "unsupported arch: $ARCH" && exit 1 ;; esac \
  && curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_CLI_VERSION}.tgz" | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${ARCH}" \
       -o /usr/local/lib/docker/cli-plugins/docker-buildx \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx \
  && docker buildx version

WORKDIR /app
COPY --from=serverbuild /build/server/dist ./server/dist
COPY --from=serverbuild /build/server/node_modules ./server/node_modules
COPY --from=serverbuild /build/server/package.json ./server/package.json
COPY --from=webbuild /build/web/dist ./web/dist

ENV NODE_ENV=production \
    WEB_DIST=/app/web/dist \
    DATA_DIR=/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server/dist/index.js"]
