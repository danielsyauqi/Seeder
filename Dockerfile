# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────
# Stage 1: prod-deps
# Production-only install (no devDependencies).  Copied into the runtime
# image to guarantee native packages like @libsql/client are present —
# the Next.js standalone trace does not reliably follow native .node binaries.
# ──────────────────────────────────────────────
FROM node:24-slim AS prod-deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ──────────────────────────────────────────────
# Stage 2: builder
# Full toolchain: installs all deps (including devDeps needed by the build),
# compiles the Next.js standalone output, and bundles the migration script to
# plain JS so the runtime stage needs no TypeScript tooling.
#
# Pinned to $BUILDPLATFORM so the heavy Next.js compile always runs natively
# on the build host (e.g. arm64 on Apple Silicon) regardless of the target
# platform.  The output is pure JS — not architecture-specific.
# ──────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# RUNTIME=node activates output:standalone in next.config.ts and swaps in
# the libSQL / local-disk adapters.
RUN RUNTIME=node npx next build --webpack

# Bundle the TypeScript migration script to a single CommonJS file.
# @libsql/client is left external — it's a native module supplied by the
# prod-deps stage rather than bundled.
RUN npx esbuild scripts/migrate-node.ts \
      --bundle \
      --platform=node \
      --format=cjs \
      --external:@libsql/client \
      --outfile=.next/standalone/migrate.js

# ──────────────────────────────────────────────
# Stage 3: runtime
# Minimal image — no bun, no npm, no build toolchain.
# ──────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV RUNTIME=node \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 seeder && \
    adduser  --system --uid 1001 --ingroup seeder seeder

# Standalone server bundle (includes its own minimal traced node_modules).
COPY --from=builder --chown=seeder:seeder /app/.next/standalone ./
# Overlay the full production node_modules so native packages (@libsql/client
# and its Rust-compiled binaries) are guaranteed to be present regardless of
# what the standalone tracer picked up.
COPY --from=prod-deps --chown=seeder:seeder /app/node_modules   ./node_modules
# Static assets and public dir must live alongside the standalone server.
COPY --from=builder --chown=seeder:seeder /app/.next/static ./.next/static
COPY --from=builder --chown=seeder:seeder /app/public        ./public
# Raw SQL migration files read at runtime by migrate.js.
COPY --from=builder --chown=seeder:seeder /app/migrations    ./migrations

COPY --chown=seeder:seeder docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /app/data && chown seeder:seeder /app/data

# Entrypoint runs as root so it can fix /app/data ownership if the host
# volume was created as root:root (common on Linux).  It drops to seeder
# via gosu before running migrations or the server.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
