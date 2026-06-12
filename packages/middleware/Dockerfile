# syntax=docker/dockerfile:1
# AgentGate middleware — 402 paywall reverse proxy + admin API.
# Build from the REPO ROOT (workspace-aware):
#   docker build -f packages/middleware/Dockerfile -t agentgate-middleware .
FROM node:22-alpine

WORKDIR /app

# 1. Manifests only, so the `npm ci` layer caches across source edits.
#    npm ci validates package-lock.json against EVERY workspace manifest,
#    so all workspace package.json files must be present even though we
#    install just this service's slice of the tree.
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

# 2. Install. Deliberately NOT `--omit=dev`: the whole stack runs TypeScript
#    directly via tsx, and tsx is a ROOT devDependency (see /package.json) —
#    omitting dev deps would strip the runtime itself. `--include-workspace-root`
#    pulls in those root deps; `-w` limits workspace deps to what middleware
#    actually imports (@agentgate/shared, @agentgate/chain) instead of
#    installing the dashboard's Next.js tree too.
RUN npm ci -w @agentgate/middleware --include-workspace-root \
  && npm cache clean --force

# 3. Sources — exactly the packages middleware imports
#    (packages/middleware/package.json: @agentgate/shared, @agentgate/chain).
COPY packages/shared packages/shared
COPY packages/chain packages/chain
COPY packages/middleware packages/middleware

# 4. Non-root. The upstream map persists at packages/middleware/data/upstreams.json;
#    pre-create the dir so the unprivileged user can write it (mount a volume at
#    /app/packages/middleware/data to keep mappings across restarts).
RUN mkdir -p packages/middleware/data \
  && chown -R node:node packages/middleware/data
USER node

ENV NODE_ENV=production
EXPOSE 4021

# Railway injects PORT; our config contract reads MIDDLEWARE_PORT — map it.
# Shell form so ${PORT:-4021} expands; `exec` so tsx is PID 1 and gets SIGTERM.
CMD ["sh", "-c", "MIDDLEWARE_PORT=${PORT:-4021} exec npx tsx packages/middleware/src/main.ts"]
