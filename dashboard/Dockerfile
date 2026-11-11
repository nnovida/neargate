# syntax=docker/dockerfile:1
# NearGate dashboard: the Next.js app that reads the NEAR registry through its own /api routes.
# Build from the REPO ROOT (workspace-aware):
#   docker build -f dashboard/Dockerfile -t neargate-dashboard .
# For production, pin to a digest: FROM node:22-alpine@sha256:<digest>
FROM node:22-alpine

WORKDIR /app

# 1. Manifests only, so the `npm ci` layer caches across source edits. npm ci validates
#    package-lock.json against EVERY workspace manifest, so all of them must be present even
#    though only the dashboard's slice of the tree is installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY dashboard/package.json dashboard/
COPY packages/buyer-agent/package.json packages/buyer-agent/
COPY packages/chain/package.json packages/chain/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/devnet/package.json packages/devnet/
COPY packages/middleware/package.json packages/middleware/
COPY packages/oracle/package.json packages/oracle/
COPY packages/shared/package.json packages/shared/

# 2. Install the dashboard's dependencies (next, react, swr, tailwind) plus the root toolchain
#    (typescript, @types/node) that `next build` type-checks with. Dev dependencies stay: the
#    build needs them.
RUN npm ci -w dashboard --include-workspace-root \
  && npm cache clean --force

# 3. Sources: the dashboard and the two workspace packages its server code imports. The
#    .dockerignore leaves out dashboard/test (it imports workspaces this image does not carry).
COPY packages/shared packages/shared
COPY packages/chain packages/chain
COPY dashboard dashboard

# 4. Build. Next inlines NEXT_PUBLIC_* here, so the site origin and the repository link are fixed at
#    build time; an empty value counts as unset.
ARG NEXT_PUBLIC_SITE_URL=
ARG NEXT_PUBLIC_REPO_URL=
RUN npm run build -w dashboard \
  && chown -R node:node dashboard/.next
USER node

ENV NODE_ENV=production
ENV PORT=3011
EXPOSE 3011

# Liveness: /api/health answers without touching the chain.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

# The chain settings (AGENTGATE_MODE=live, NEAR_NETWORK, REGISTRY_CONTRACT_ID, ...) come from the
# container environment at run time. Exec form, so next is PID 1 and gets SIGTERM.
CMD ["./node_modules/.bin/next", "start", "dashboard", "-H", "0.0.0.0"]
