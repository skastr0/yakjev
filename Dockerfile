# yakjev production image: public HTTPS on Railway. The owner token is the lock.
# Keep this at the repository root for Railway's Dockerfile detection.
FROM oven/bun:1.4.2-debian

USER root
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile \
  && bun run build

COPY deploy/entrypoint.sh /usr/local/bin/yakjev-entrypoint.sh
RUN chmod 0755 /usr/local/bin/yakjev-entrypoint.sh

ENV NODE_ENV=production \
    YAKJEV_DATA_DIR=/data/yakjev \
    YAKJEV_LISTEN_HOST=0.0.0.0

# Mount a Railway-managed volume at /data; Railway rejects Docker VOLUME declarations.
# Railway injects PORT and routes the service domain to it.

# tini as PID 1: reap zombies and forward SIGTERM. Do not rely on shell job control.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yakjev-entrypoint.sh"]
