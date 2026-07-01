# Hosting the live AgentGate gateway

The CLI's live `wrap` defaults `--gateway` to `DEFAULT_GATEWAY_URL`
(`https://gateway.example.org`, in `packages/shared/src/config.ts`). For the
one-line `npx @neargate/cli wrap … --pem ./key.pem` to complete its upstream
mapping, a **live-mode middleware** must be reachable at that URL. Reads
(`list`/`status`) never touch the gateway, so they work regardless.

The gateway exposes an owner-signature self-service map endpoint
(`POST /services/:id/map`) — sellers authorize their mapping by signing an
ownership challenge with their wallet key, so **no shared admin token is handed
out**. The gateway still needs its own credentials for payment verification and
attestations.

## Required environment (live)

| Var | Why |
|---|---|
| `AGENTGATE_MODE=live` | Casper Testnet, SSRF guard on, fail-closed gate signer |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | the deployed `hash-10f92725…` |
| `CSPR_CLOUD_API_KEY` | payment-transfer verification + attestation history |
| `GATE_SIGNER_PEM_PATH` | attestor key the gateway signs `record_attestation` with (funded) |
| `AGENTGATE_ADMIN_TOKEN` | a strong unique token (the shipped default is refused in live) — only guards the legacy `/admin/services`; self-service mapping does not use it |
| `TRUST_PROXY=1` | when behind exactly one platform proxy (Railway/Fly/Cloudflare), so rate-limit keys off the real client IP |

## Run it

The middleware ships a production Dockerfile (`packages/middleware/Dockerfile`).

```bash
docker build -f packages/middleware/Dockerfile -t agentgate-gateway .
docker run -d --name agentgate-gateway -p 4021:4021 \
  -e AGENTGATE_MODE=live \
  -e REGISTRY_CONTRACT_PACKAGE_HASH=hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9 \
  -e CSPR_CLOUD_API_KEY="$CSPR_CLOUD_API_KEY" \
  -e AGENTGATE_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -e GATE_SIGNER_PEM_PATH=/keys/gate.pem \
  -e TRUST_PROXY=1 \
  -v /path/to/gate.pem:/keys/gate.pem:ro \
  -v agentgate-gateway-data:/app/packages/middleware/data \
  agentgate-gateway
```

Then put a TLS-terminating reverse proxy / tunnel in front and point the DNS for
`gateway.example.org` at it. Health check: `GET /healthz` → `{ ok, network }`;
readiness (chain reachable): `GET /readyz`.

## Verify

```bash
# from a seller box, with a funded wallet key:
npx @neargate/cli wrap https://api.example.com/gold --price 2.5 --name "My API" --pem ./key.pem
# → prints service id + public endpoint; the gateway logs `self_mapped`.
curl https://gateway.example.org/svc/<id>        # → 402 payment challenge
```

If the gateway is unreachable when you `wrap`, the on-chain registration still
succeeds; the CLI prints a warning and the `/svc/<id>` endpoint 404s until the
mapping is (re-)done against a reachable gateway. Price services **≥ 2.5 CSPR**
for the native-transfer settlement rail.

## Notes / security

- Self-service mapping is authenticated by an on-chain-owner signature over a
  domain-separated challenge (`packages/shared/src/self-map.ts`), verified in
  `packages/middleware/src/app.ts` against `service.owner`. It is rate-limited,
  freshness-windowed (120 s), and monotonic-per-service against replay, and runs
  the same SSRF guard as the admin path.
- Keep `GATE_SIGNER_PEM_PATH` at mode `600`; the gateway warns if it is
  group/other-readable.
- Until this gateway is live, sellers can point `--gateway http://localhost:4021`
  at a locally-run middleware.
