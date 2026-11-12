# Hosting NearGate

Two long-running processes, one registry on NEAR:

| process   | what it is                                         | port |
| --------- | -------------------------------------------------- | ---- |
| gateway   | the live x402 paywall (`npm run dev:live`)         | 3012 |
| dashboard | the read-only Next.js app (`next start`)           | 3011 |

`<dashboard-host>` and `<gateway-host>` below are the two public hostnames. Pick them first: the
registry stores a service's gateway URL for good, so `GATEWAY_PUBLIC_URL` must be final before you
run `npm run near:seed`.

Rules for every option:

- **One gateway instance.** Receipts and rate limits are per-process memory; a second instance
  splits them.
- **`TRUST_PROXY=1` behind any proxy** (cloudflared, nginx, a platform router). The pm2 file and the
  compose file set it. Never set it above the real number of proxy hops.
- **Keys stay out of the repo.** The gateway's key lives in
  `~/.near-credentials/testnet/<account>.json` (`npm run near:bootstrap` writes it). Only that
  account id goes in `.env`.
- **Keep both up through 2026-11-25.**
- **No hostname is baked in.** Until `DEFAULT_GATEWAY_URL` and `DEFAULT_DASHBOARD_URL`
  (`packages/shared/src/config.ts`) are set, together, once the hosts exist, a live `neargate wrap`
  needs `--gateway https://<gateway-host>` and prints no dashboard link; the dashboard's own site
  origin comes from `NEXT_PUBLIC_SITE_URL`. The GitHub links on the dashboard show only when
  `NEXT_PUBLIC_REPO_URL` is set at build time.

The root `.env` (copy `.env.example`) needs `AGENTGATE_MODE=live`, `REGISTRY_CONTRACT_ID`,
`GATEWAY_ACCOUNT_ID` and a strong `AGENTGATE_ADMIN_TOKEN`.

## (a) This box: pm2 and an existing cloudflared tunnel

```bash
npm install
NEXT_PUBLIC_SITE_URL=https://<dashboard-host> npm run build   # the docs pages are built here, with this origin (add NEXT_PUBLIC_REPO_URL to show the GitHub links)
pm2 start deploy/neargate.ecosystem.config.cjs                # neargate-gateway and neargate-dashboard
pm2 save
```

pm2 does not read `.env`. The gateway loads the root `.env` itself. The dashboard cannot (Next looks
in `dashboard/`), so the ecosystem file copies `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_EXPLORER_URL`
and `REGISTRY_CONTRACT_ID` from the root `.env` into the dashboard's env block and sets
`AGENTGATE_MODE=live`. It never copies the admin token, an account id or a key. The copy happens when
pm2 reads the file, so after editing `.env` run `pm2 delete neargate-dashboard` and start it again
with `--only neargate-dashboard`.

**Start pm2 from a shell where `.env` is not exported** (no `set -a; source .env`). pm2 hands the
invoking shell's environment to every app it starts, and a value already in the environment wins
over the file, so an exported `.env` would give the dashboard process the admin token and any key
that file holds. Check with `env | grep -c ADMIN_TOKEN` (it should print `0`).

Add two ingress lines to the tunnel's `config.yml`, above the catch-all rule, and route DNS for each
host:

```yaml
  - hostname: <dashboard-host>
    service: http://localhost:3011
  - hostname: <gateway-host>
    service: http://localhost:3012
```

```bash
cloudflared tunnel route dns <tunnel> <dashboard-host>
cloudflared tunnel route dns <tunnel> <gateway-host>
```

Then restart the tunnel service so it reloads the config.

## (b) Vercel for the dashboard, a tunnel for the gateway

Import the repo into Vercel with the repo root as the project root: `vercel.json` sets the install
and build commands. Vercel does not read `.env`; set these in the project settings:
`AGENTGATE_MODE=live`, `NEAR_NETWORK=testnet`, `REGISTRY_CONTRACT_ID`, `NEXT_PUBLIC_SITE_URL`
(`https://<dashboard-host>`), and optionally `NEAR_RPC_URL`, `NEAR_EXPLORER_URL` and `NEXT_PUBLIC_REPO_URL`. No key and no
admin token belong there. Each Vercel instance keeps its own response cache.

Run only the gateway on this box and give it one ingress line:

```bash
pm2 start deploy/neargate.ecosystem.config.cjs --only neargate-gateway
```

## (c) docker compose

```bash
docker compose -f docker-compose.hosting.yml up -d --build
```

Compose fills its values from the root `.env`, mounts `~/.near-credentials` read-only into the
gateway container (the key file must be readable by uid 1000) and publishes both ports on
`127.0.0.1` only. Point the same tunnel ingress lines at them. Set `NEXT_PUBLIC_SITE_URL` in `.env`
before `--build` (and `NEXT_PUBLIC_REPO_URL`, if the GitHub links should show).

## (d) Railway (the current hosting)

NearGate runs on Railway as one project with two services, both deployed from this repository's
`main` branch. Railway's config-as-code files can no longer be opted into, so every setting below
lives in each service's settings and variables (`packages/*/railway.json` predate this).

| | `neargate-gateway` | `neargate-dashboard` |
|---|---|---|
| Public URL | https://neargate-gateway-production.up.railway.app | https://neargate-dashboard-production.up.railway.app |
| Builder, Dockerfile path | Dockerfile, `packages/middleware/Dockerfile` | Dockerfile, `dashboard/Dockerfile` |
| Healthcheck path | `/healthz` | `/api/health` |
| Volume | mounted at `/app/packages/middleware/data` (upstream map, invoices, attestation queue) | none |
| Variables | `AGENTGATE_MODE=live`, `NEAR_NETWORK=testnet`, `REGISTRY_CONTRACT_ID`, `GATEWAY_ACCOUNT_ID`, `GATEWAY_PRIVATE_KEY`, `AGENTGATE_ADMIN_TOKEN=${{secret(64)}}`, `RELAYER_ENABLED=1`, `TRUST_PROXY=1`, `PORT=3012`, `INVOICE_STORE_PATH` and `ATTESTATION_QUEUE_PATH` under the volume, `RAILWAY_RUN_UID=0` (the volume is owned by root) | `AGENTGATE_MODE=live`, `NEAR_NETWORK=testnet`, `REGISTRY_CONTRACT_ID`, `PORT=3011`, `NEXT_PUBLIC_SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`, `NEXT_PUBLIC_REPO_URL` |

Keep one replica of the gateway. `GATEWAY_PRIVATE_KEY` is the `private_key` of the gateway
account's key file; paste it into Railway yourself and never commit it. The project was created from
the public repository URL, without Railway's GitHub app, so a push does not deploy by itself:
redeploy both services from Railway after each push to `main`.

## Check it

```bash
# The paywall answers: HTTP 402 with the x402 body (x402Version 1, one "exact" option on near-testnet).
curl -sS -i https://<gateway-host>/svc/1

# A read-only end-to-end check of the live deployment: exit code 0.
GATEWAY_PUBLIC_URL=https://<gateway-host> SMOKE_SERVICE_ID=1 npm run smoke:live

# The dashboard is up and reads the registry.
curl -sS https://<dashboard-host>/api/health
curl -sS -i https://<dashboard-host>/api/services    # x-cache: miss, then hit for 15 s
```
