# syntax=docker/dockerfile:1.7
# Cloud edition image: Fastify server bundle + static web build, one process.
#   docker build -t scg-shop-erp .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e JWT_SECRET=... scg-shop-erp
# The on-premise edition is NOT built here; see .github/workflows/release-windows.yml.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.28.0

# ---- 1. dependencies (cached on the lockfile only) -------------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# `pnpm fetch` only needs the lockfile, so new workspace packages do not bust this layer.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

# ---- 2. build web + bundle server (cloud) ----------------------------------
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN VITE_EDITION=cloud pnpm --filter @erp/web build
RUN node apps/server/build.cloud.mjs
# Native modules left external by the bundler (argon2) get their linux prebuilds here.
RUN cd apps/server/dist-cloud && npm install --omit=dev --no-audit --no-fund --no-package-lock

# ---- 3. runtime ------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    EDITION=cloud \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    RUN_MIGRATIONS=0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/server/dist-cloud/ ./
COPY --from=build --chown=node:node /repo/apps/web/dist/ ./web/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# RUN_MIGRATIONS=1 runs migrate.mjs (if the db package provides one) before start.
# Keep it 0 on multi-replica deployments and run migrations as a separate one-off job.
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = 1 ] && [ -f migrate.mjs ]; then node migrate.mjs || exit 1; fi; exec node server.mjs"]
