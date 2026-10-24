# Multi-stage build for the Next.js CRM — Node 24 LTS, Alpine base.
# Node is pinned to an exact patched release; bump it here for Node security updates.

ARG NODE_VERSION=24.22.1

# ---- deps: install once, cached across source-only changes ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: compile with output: 'standalone' (next.config.mjs) ----
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal image — just the standalone server + static assets ----
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Alpine's node image ships a "node" user/group (uid/gid 1000) for exactly
# this purpose — same non-root pattern as backend/Dockerfile.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Schema migrations run in THIS container now (single-app deployment — no
# separate backend service). backend/migrations stays the source of truth
# for the SQL; migrate.mjs uses the `pg` package already present in the
# standalone node_modules.
COPY --chown=node:node migrate.mjs ./migrate.mjs
COPY --chown=node:node backend/migrations ./migrations

USER node

EXPOSE 3000

# Migrations always run before the server starts; if migrate.mjs exits
# non-zero, `&&` short-circuits and the server never starts, so the
# container fails fast instead of serving against a broken schema.
CMD ["sh", "-c", "node migrate.mjs && node server.js"]
