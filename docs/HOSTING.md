# AgentGate — Hosting runbook

How to put the stack on the public internet once accounts/credentials exist.
Deploying the **registry contract** itself is a separate runbook
([docs/DEPLOY.md](DEPLOY.md)); this document covers the **services**.

| Component | Where | Config in repo |
|---|---|---|
| Dashboard (Next.js) | Vercel | [`vercel.json`](../vercel.json) (root), [`.vercelignore`](../.vercelignore) |
| Middleware (402 gateway) | Railway | [`packages/middleware/Dockerfile`](../packages/middleware/Dockerfile), [`packages/middleware/railway.json`](../packages/middleware/railway.json) |
| Oracle (RWA feed) | Railway | [`packages/oracle/Dockerfile`](../packages/oracle/Dockerfile), [`packages/oracle/railway.json`](../packages/oracle/railway.json) |
| Devnet (mock chain, demo only) | Docker (compose) | [`packages/devnet/Dockerfile`](../packages/devnet/Dockerfile), [`docker-compose.hosting.yml`](../docker-compose.hosting.yml) |

Everything runs TypeScript directly via **tsx** (a root devDependency) — there is no
compile step for the Node services; the Docker images install the workspace and run
`npx tsx …/src/main.ts`.

---

## 1. Dashboard → Vercel

The repo is an npm-workspaces monorepo with the Next.js app in `dashboard/`
(hoisted `node_modules` at the root, `transpilePackages: ['@agentgate/shared',
'@agentgate/chain']` already set in `dashboard/next.config.mjs`).

### Option A — root `vercel.json` (committed, recommended)

Import the repo into Vercel and **leave Root Directory at the repo root**. The
committed [`vercel.json`](../vercel.json) does the rest:

```json
{
  "framework": "nextjs",
  "installCommand": "npm install",
  "buildCommand": "npm run build -w dashboard",
  "outputDirectory": "dashboard/.next"
}
```

`npm install` at the root installs the whole workspace (so `@agentgate/shared` and
`@agentgate/chain` resolve as workspace symlinks), and the build targets the
`dashboard` workspace. `.vercelignore` keeps the 7 GB `contracts/` tree out of the
upload.

### Option B — project settings instead of `vercel.json`

If you prefer dashboard-side settings (delete `vercel.json` first — it overrides
the UI):

- **Root Directory** = `dashboard`
- Enable **"Include files outside the Root Directory"** (Settings → General) —
  required so `packages/shared`, `packages/chain` and the root lockfile are
  available to the build
- Framework preset: **Next.js**; Install Command: `npm install` (runs at the
  monorepo root automatically when the lockfile is at the root)

### Environment variables (Vercel → Settings → Environment Variables)

For **live mode** (the normal hosted configuration):

| Var | Value |
|---|---|
| `AGENTGATE_MODE` | `live` |
| `CSPR_CLOUD_API_URL` | `https://api.testnet.cspr.cloud` |
| `CSPR_CLOUD_API_KEY` | your key from console.cspr.cloud (raw token, no `Bearer`) |
| `CASPER_NODE_URL` | `https://node.testnet.casper.network/rpc` |
| `CASPER_NETWORK` | `casper-test` |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | set after the contract deploy (see §7) |
| `AGENTGATE_ADMIN_TOKEN` | any strong unique value — `loadConfig()` **refuses the default token in live mode**, and the dashboard's API routes call `loadConfig()` |

> **Mock-mode caveat:** in mock mode every chain read goes to `DEVNET_URL`
> (default `http://localhost:4030`) — meaningless from Vercel's servers. A hosted
> dashboard should therefore run in **live mode**. For a pure demo you *can* keep
> `AGENTGATE_MODE=mock` and point `DEVNET_URL` at a publicly hosted devnet (e.g.
> the `packages/devnet/Dockerfile` image on Railway), but never expose a mock
> devnet as if it were real chain state.

No `vercel` CLI needed: connect the Git repo and every push deploys.

---

## 2. Middleware + Oracle → Railway

Railway's model: one **project**, multiple **services**, each service points at the
same repo but builds its own Dockerfile. A single config file cannot express two
services, so each service carries its own config-as-code file.

### Per-service settings

Create two services from the same GitHub repo, then in each service's
**Settings → Config-as-code**, set the file path:

| Setting | middleware service | oracle service |
|---|---|---|
| Config-as-code path | `packages/middleware/railway.json` | `packages/oracle/railway.json` |
| → Builder | `DOCKERFILE` | `DOCKERFILE` |
| → Dockerfile path | `packages/middleware/Dockerfile` | `packages/oracle/Dockerfile` |
| → Healthcheck path | `/healthz` | `/healthz` |
| Networking | Generate Domain (public) | Generate Domain (public — buyers fetch the feed through the middleware, but a public oracle URL is handy for debugging) |

Railway builds with the **repo root as context**, which is exactly what the
Dockerfiles expect (equivalent to `docker build -f packages/middleware/Dockerfile .`).

### PORT mapping (how Railway's `PORT` reaches our config)

Railway injects a `PORT` env var and routes traffic to it. AgentGate's config
contract reads `MIDDLEWARE_PORT` / `ORACLE_PORT` instead, so each Dockerfile uses a
shell-form CMD that bridges the two:

```dockerfile
CMD ["sh", "-c", "MIDDLEWARE_PORT=${PORT:-4021} exec npx tsx packages/middleware/src/main.ts"]
```

No Railway-specific code anywhere — locally (no `PORT`) the defaults 4021/4010
apply, on Railway the injected `PORT` wins.

### Environment variables

**middleware** (live mode):

| Var | Value |
|---|---|
| `AGENTGATE_MODE` | `live` |
| `AGENTGATE_ADMIN_TOKEN` | strong unique token (config refuses the default in live mode) |
| `CSPR_CLOUD_API_URL` | `https://api.testnet.cspr.cloud` |
| `CSPR_CLOUD_API_KEY` | your key (required in live mode) |
| `CASPER_NODE_URL` | `https://node.testnet.casper.network/rpc` |
| `CASPER_NETWORK` | `casper-test` |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | set after contract deploy (see §7) |
| `GATE_SIGNER_PEM_PATH` | path to the attestor PEM **inside the container** — put the key file on the persistent volume (e.g. `/app/packages/middleware/data/gate.pem`) and point this at it |
| `INVOICE_TTL_MS`, `UPSTREAM_TIMEOUT_MS` | optional tuning (defaults 300000 / 30000) |

**oracle**: needs nothing for the feed itself. Optionally `ORACLE_STATIC=1` for the
deterministic fixture feed (offline demo), `0` (default) for real FX/gold sources.
Leave `AGENTGATE_MODE` unset (= `mock`): the oracle never touches the chain, and
setting `live` would make `loadConfig()` demand `CSPR_CLOUD_API_KEY` +
a non-default admin token for no benefit.

### Middleware state: persistent volume (or accept ephemeral)

The middleware persists exactly one file: the serviceId → upstream-URL map at
`/app/packages/middleware/data/upstreams.json`.

- **Persistent (recommended):** attach a Railway **Volume** to the middleware
  service with mount path `/app/packages/middleware/data`. Mappings (and the gate
  signer PEM, if you keep it there) survive redeploys.
- **Ephemeral (acceptable):** without a volume, every redeploy starts with an empty
  map. On-chain registrations are untouched; just re-add each mapping:

  ```bash
  curl -X POST https://<middleware-domain>/admin/services \
    -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"serviceId": 1, "upstreamUrl": "https://<oracle-domain>/feed"}'
  ```

Invoices are in-memory by design (5-minute TTL) — no volume needed for them.

---

## 3. Local "production" demo — Docker Compose

A self-contained mock-mode stack (devnet + oracle + middleware) built from the
same production Dockerfiles. Host ports are **14030/14010/14021** so it never
collides with a `npm run dev` stack on 4030/4010/4021.

```bash
docker compose -f docker-compose.hosting.yml up -d --build

curl http://localhost:14030/healthz   # {"ok":true,"network":"mock"}   devnet
curl http://localhost:14010/healthz   # {"ok":true,"static":true}      oracle
curl http://localhost:14021/healthz   # {"ok":true,"network":"mock"}   middleware
```

Containers talk to each other by service name (`DEVNET_URL=http://devnet:4030` is
wired in the compose file). Point a locally running dashboard at it:

```bash
AGENTGATE_MODE=mock DEVNET_URL=http://localhost:14030 npm run dev:dashboard
```

Tear down (removes the named volume holding `upstreams.json`):

```bash
docker compose -f docker-compose.hosting.yml down -v
```

Individual images, built **from the repo root**:

```bash
docker build -f packages/middleware/Dockerfile -t agentgate-middleware .
docker build -f packages/oracle/Dockerfile     -t agentgate-oracle .
docker build -f packages/devnet/Dockerfile     -t agentgate-devnet .
```

---

## 4. Environment variable matrix

`✓ req` = required for that service in live mode; `opt` = optional; `—` = unused.

| Var | middleware (Railway) | oracle (Railway) | dashboard (Vercel) | devnet (demo) |
|---|---|---|---|---|
| `AGENTGATE_MODE` | `live` | leave `mock` | `live` | `mock` |
| `AGENTGATE_ADMIN_TOKEN` | ✓ req (non-default) | — | ✓ req in live mode (non-default; `loadConfig()` check) | — |
| `CSPR_CLOUD_API_URL` | ✓ req | — | ✓ req | — |
| `CSPR_CLOUD_API_KEY` | ✓ req | — | ✓ req | — |
| `CASPER_NODE_URL` | ✓ req | — | ✓ req | — |
| `CASPER_NETWORK` | ✓ req (`casper-test`) | — | ✓ req | — |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | ✓ after deploy | — | ✓ after deploy | — |
| `GATE_SIGNER_PEM_PATH` | ✓ req (file on volume) | — | — | — |
| `DEVNET_URL` | mock mode only | — | mock mode only | — |
| `ORACLE_STATIC` | — | opt (`1` = fixture) | — | — |
| `INVOICE_TTL_MS` / `UPSTREAM_TIMEOUT_MS` | opt | — | — | — |
| `PORT` (injected by PaaS) | → `MIDDLEWARE_PORT` | → `ORACLE_PORT` | handled by Vercel | → `DEVNET_PORT` |

Unset values fall back to the defaults in `packages/shared/src/config.ts`
(`loadConfig()`), which also enforces the live-mode invariants: missing
`CSPR_CLOUD_API_KEY` or a default admin token make boot fail loudly with
`CONFIG_INVALID`.

---

## 5. Healthchecks

Every service exposes `GET /healthz` returning `200 {"ok":true,…}`:

| Service | Path | Wired into |
|---|---|---|
| middleware | `/healthz` | Railway healthcheck (`railway.json`) + compose `healthcheck` |
| oracle | `/healthz` | Railway healthcheck (`railway.json`) + compose `healthcheck` |
| devnet | `/healthz` | compose `healthcheck` (middleware waits for devnet-healthy) |

---

## 6. What changes after the contract deploy

Until the registry contract is on Casper Testnet, live mode boots fine but every
contract-dependent call throws `NOT_DEPLOYED` (503) — the full list is in
[docs/DEPLOY.md](DEPLOY.md). The moment the contract is deployed:

1. Record the **contract package hash** from the deploy.
2. Set `REGISTRY_CONTRACT_PACKAGE_HASH=<hash>` on **every** live-mode service:
   the middleware (Railway) and the dashboard (Vercel) — plus any CLI/agent env.
3. Ensure `AGENTGATE_MODE=live` everywhere (middleware, dashboard), with the
   live-mode invariants satisfied: real `CSPR_CLOUD_API_KEY`, non-default
   `AGENTGATE_ADMIN_TOKEN`, `GATE_SIGNER_PEM_PATH` pointing at a funded
   attestor key on the middleware.
4. Redeploy/restart both services (Railway and Vercel redeploy on env change).
5. Wrap the oracle for real: `npm run agentgate -- wrap --url https://<oracle-domain>/feed …`
   against the hosted middleware, then re-check `GET /healthz` and a full
   402 → pay → 200 round trip.

The devnet image and the compose stack stay what they always were: a mock-mode
demo. Nothing live ever points at them.
