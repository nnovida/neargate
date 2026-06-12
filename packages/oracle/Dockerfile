# syntax=docker/dockerfile:1
# AgentGate oracle — RWA FX & gold feed (the demo "sellable API").
# Build from the REPO ROOT (workspace-aware):
#   docker build -f packages/oracle/Dockerfile -t agentgate-oracle .
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
#    pulls in those root deps; `-w` limits workspace deps to what the oracle
#    actually imports (@agentgate/shared + express only).
RUN npm ci -w @agentgate/oracle --include-workspace-root \
  && npm cache clean --force

# 3. Sources — exactly the packages the oracle imports
#    (packages/oracle/package.json: @agentgate/shared only).
COPY packages/shared packages/shared
COPY packages/oracle packages/oracle

# 4. Non-root (the oracle is stateless — nothing to chown).
USER node

ENV NODE_ENV=production
EXPOSE 4010

# Railway injects PORT; our config contract reads ORACLE_PORT — map it.
# Shell form so ${PORT:-4010} expands; `exec` so tsx is PID 1 and gets SIGTERM.
CMD ["sh", "-c", "ORACLE_PORT=${PORT:-4010} exec npx tsx packages/oracle/src/main.ts"]
