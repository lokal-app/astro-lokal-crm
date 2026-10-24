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

USER node

EXPOSE 3000
CMD ["node", "server.js"]
