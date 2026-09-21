# yakjev production image: Bun app + userspace Tailscale in one container.
# Build context is the repository root (see railway.json dockerfilePath).
FROM oven/bun:1.3.14-debian

ARG TAILSCALE_VERSION=1.102.4

USER root
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && mkdir -p --mode=0755 /usr/share/keyrings \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "tailscale=${TAILSCALE_VERSION}*" \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile \
  && bun run build

COPY deploy/entrypoint.sh /usr/local/bin/yakjev-entrypoint.sh
RUN chmod 0755 /usr/local/bin/yakjev-entrypoint.sh

ENV NODE_ENV=production \
    YAKJEV_DATA_DIR=/data/yakjev \
    TS_STATE_DIR=/data/tailscale \
    TS_SOCKET=/var/run/tailscale/tailscaled.sock \
    YAKJEV_LISTEN_HOST=127.0.0.1 \
    YAKJEV_LISTEN_PORT=3210

# Single Railway volume should be mounted at /data (app + Tailscale state).
VOLUME ["/data"]

# tini as PID 1: reap zombies and forward SIGTERM. Do not rely on shell job control.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yakjev-entrypoint.sh"]
