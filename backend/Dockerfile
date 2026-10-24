# Node 24 LTS, Alpine base per spec.
# Node is pinned to an exact patched release; bump it here for Node security updates.
ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-alpine

WORKDIR /app

# Install dependencies first so this layer is cached across code-only changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Non-root user — Alpine's node image ships a "node" user/group (uid/gid 1000)
# for exactly this purpose.
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Migrations always run before the server starts; if migrate.js exits
# non-zero (see migrate.js), `&&` short-circuits and the server never
# starts, so the container fails fast instead of serving against a
# not-yet-migrated (or broken) schema.
CMD ["sh", "-c", "node migrate.js && node server.js"]
