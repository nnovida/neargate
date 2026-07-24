<div align="center">

# AgentGate

### Stripe for AI agents on Casper

**Turn any HTTP API into a paid, on-chain service in one command — HTTP 402 micropayments in CSPR or WCSPR, with an on-chain registry and payment-backed reputation.**

[![ci](https://example.invalid/AgentGate/actions/workflows/ci.yml/badge.svg)](https://example.invalid/AgentGate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@neargate/cli.svg)](https://www.npmjs.com/package/@neargate/cli)
[![license](https://img.shields.io/npm/l/@neargate/cli.svg)](LICENSE)
[![Casper Testnet](https://img.shields.io/badge/Casper-Testnet%20live-c2410c.svg)](https://agentgate.example.org)

**[Dashboard](https://agentgate.example.org)** · **[Gateway](https://gateway.example.org)** · **[npm](https://www.npmjs.com/package/@neargate/cli)** · **[Docs](https://agentgate.example.org/docs)** · **[Contract](https://testnet.cspr.live/contract-package/e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df)**

[![AgentGate dashboard — live catalog of on-chain registered services](docs/assets/dashboard.png)](https://agentgate.example.org)

</div>

---

## Contents

- [What is AgentGate](#what-is-agentgate)
- [Try it in 30 seconds](#try-it-in-30-seconds)
- [The one-liners](#the-one-liners)
- [How it works](#how-it-works)
- [Quickstart (offline)](#quickstart-offline)
- [Configuration and modes](#configuration-and-modes)
- [Repository layout](#repository-layout)
- [Scripts and tests](#scripts-and-tests)
- [Deployed addresses](#deployed-addresses)
- [Deployment and hosting](#deployment-and-hosting)
- [Roadmap](#roadmap)
- [About](#about)

---

## What is AgentGate

AI agents can't pay for the APIs they use — no cards, no logins, no accounts. AgentGate is the payment layer that fixes this on Casper: a seller wraps an API in one command, a buyer agent discovers and pays it in one command, and every paid call leaves a verifiable on-chain receipt.

**Everything below is live on Casper Testnet and verifiable right now.**

- **One-command wrap** — any HTTP API becomes a paid, on-chain-registered service; the private upstream never touches the chain.
- **One-command buy** — discover from the on-chain registry, pay a machine-readable 402 invoice, get the data back.
- **On-chain multi-asset price list** — each service stores an `accepts[]` price list *in the contract* (registry v2): pay in **native CSPR**, or in **WCSPR through the official Casper x402 facilitator** — gas sponsored, no native-transfer floor, true sub-CSPR micropayments.
- **Native MCP tools** — one line of config and any MCP-capable agent (Claude Desktop, custom clients) gets discover / inspect / pay as native tools.
- **Payment-backed reputation** — each served call is attested on-chain, so trust scores are receipts of real value transfer, not marketing.
- **Zero-config reads** — `list` and `status` read the public node with no keys, no `.env`, no clone.

---

## Try it in 30 seconds

Zero setup, no keys — reads the live on-chain registry straight from the public node (Node ≥ 22):

```bash
npx @neargate/cli@latest list          # the live on-chain service catalog
curl -sS https://gateway.example.org/svc/2   # a real HTTP 402 invoice from the live gateway
```

<details>
<summary><b>For judges / reviewers — drive the live MCP server in one paste</b></summary>

<br>

The published CLI defaults to **live Casper Testnet** + the deployed registry, and the read tools use the public node RPC — no `.env`, no CSPR.cloud key, no clone. From any directory:

```bash
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"judge","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agentgate_list_services","arguments":{}}}' ; \
  sleep 8 ) | npx -y @neargate/cli@latest mcp 2>/dev/null \
  | jq -r 'select(.id==2) | .result.content[0].text | fromjson'
```

Cloned the repo? `scripts/mcp.sh` wraps the same handshake:

```bash
scripts/mcp.sh list
scripts/mcp.sh invoice 2     # a real HTTP 402 invoice; the nonce changes each call
```

Only `agentgate_buy` needs a funded buyer key — every read tool is zero-setup.

</details>

---

## The one-liners

**Sell** — wrap any HTTP API into a paid service. Registers on-chain (signed by `--pem`) and maps your upstream on the gateway via an owner-signed challenge (no shared admin token):

```bash
npx @neargate/cli wrap https://api.example.com/data --price 2.5 --name "My Data API" --pem ./key.pem
```

**Buy** — pay one call to any listed service. The CLI pays the 402 invoice (native transfer, or an EIP-712 authorization on the facilitator rail) and prints the data — body to stdout, payment receipt to stderr:

```bash
npx @neargate/cli buy 2 --pem ./buyer.pem --max 5
```

**Hand it to an agent** — one command exposes the whole loop to any MCP-capable client as native tools:

```bash
npx @neargate/cli mcp          # a Model Context Protocol stdio server
```

Tools: `agentgate_list_services`, `agentgate_get_service`, `agentgate_get_invoice` (read-only, no key) and `agentgate_buy` (pays a 402 invoice from the buyer key, capped by `maxCspr`). Wire it into Claude Desktop's `claude_desktop_config.json`:

```json
{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "@neargate/cli", "mcp"] } } }
```

---

## How it works

Sellers put a **402 paywall** in front of their API and register it in an on-chain registry with a per-asset **`accepts[]` price list**. Buyer agents discover services from the registry and pay on the rail the service advertises — a **native CSPR transfer carrying the invoice nonce as `transfer_id`**, or an **EIP-712 authorization settled by the official CSPR.cloud x402 facilitator** (gas sponsored). Either way the buyer retries with the payment proof, gets the data, and the gateway records an **on-chain attestation** that feeds each service's trust score. No accounts, no API keys, no subscriptions: HTTP 402 + Casper.

```mermaid
sequenceDiagram
    autonumber
    participant Seller as Seller (CLI)
    participant Chain as Casper (registry)
    participant Gate as AgentGate gateway
    participant Agent as Buyer agent
    participant API as Upstream API

    Seller->>Chain: register service (accepts[] price list, payment target, attestor)
    Seller->>Gate: map upstream (owner-signed challenge → /services/:id/map)
    Agent->>Chain: discover catalog + trust scores
    Agent->>Gate: GET /svc/:id
    Gate-->>Agent: 402 PaymentRequiredResponse (x402Version, error, accepts[])
    Agent->>Chain: CSPR transfer (transfer_id = nonce)
    Agent->>Gate: GET /svc/:id + X-PAYMENT: <base64 proof>
    Gate->>Chain: verify transfer (target, amount, transfer_id, age)
    Gate->>API: proxy (nonce burned first — single use)
    API-->>Gate: data
    Gate-->>Agent: 200 data
    Gate--)Chain: attestation (success) → score → trust tier
```

The diagram shows the native rail. A service whose on-chain `accepts[]` includes a CEP-18 option (e.g. `0.1 WCSPR`) runs the **official x402 facilitator rail** instead: the 402 is an x402 v2 body derived from the contract, the buyer signs an EIP-712 authorization (`PAYMENT-SIGNATURE` header), and the CSPR.cloud facilitator verifies + settles on-chain with sponsored gas before the gateway proxies and attests.

> Full component breakdown: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · engineering contract: [docs/SPEC.md](docs/SPEC.md).

---

## Quickstart (offline)

Requires Node ≥ 22. No keys, no network, no chain access needed:

```bash
npm install
npm run demo     # full loop: register → 402 → pay → serve → attest → score, exits 0
```

The demo boots a mock chain + oracle + gateway in-process, wraps the oracle at 0.5 CSPR, runs the LLM buyer agent (deterministic MockLlm — no API key needed), and prints the **payment deploy hash**, the **attestation tx hash**, and the final score.

### See it in the dashboard

```bash
npm run dev:seed          # boots devnet+oracle+middleware AND seeds one wrapped
                          # service + a real paid call, then STAYS UP
npm run dev:dashboard     # in a second terminal → open the URL it prints
```

### Manual dev loop

```bash
npm run dev               # empty stack: devnet :4030 + oracle :4010 + middleware :4021
# paste the printed MOCK_BUYER_ACCOUNT / MOCK_SELLER_ACCOUNT export lines, then:
npm run agentgate -- wrap http://localhost:4010/feed --price 0.5 --name "RWA FX & Gold Oracle"
npm run agent -- --task "Get today's USD/IDR rate and gold price, summarize for a treasury report"
npm run agentgate -- buy 1 --mode mock    # or skip the agent: pay once, print the data
```

Set `ANTHROPIC_API_KEY` to let the buyer agent use Claude instead of the MockLlm.

<details>
<summary><b>Port notes and gotchas</b></summary>

<br>

- **Demo ports:** the demo binds `:4030` (devnet), `:4010` (oracle) and `:4021` (gateway). If one is taken (`EADDRINUSE`), override: `DEVNET_PORT=14030 ORACLE_PORT=14010 MIDDLEWARE_PORT=14021 npm run demo`.
- **`npm run demo` won't show in the dashboard** — it boots its *own* in-memory chain, runs the loop, and exits, so its data is gone by the time you open a browser. Use `npm run dev:seed` (persistent + populated) to view it live. The dashboard polls the running stack every 5 s.
- **Dashboard port:** defaults to `http://localhost:3000`, but if 3000 is taken Next.js silently moves to **3001** (or the next free port). Always open the URL printed in the `dev:dashboard` terminal.

</details>

---

## Configuration and modes

`AGENTGATE_MODE=mock|live` (default `mock` for the repo stack; the published CLI defaults to `live`) selects the chain backend behind the `ChainClient` seam — everything above it is identical:

| | `mock` | `live` (Casper Testnet) |
|---|---|---|
| Chain | in-memory devnet (`@agentgate/devnet`) | casper-js-sdk v5 + CSPR.cloud REST |
| Signers | mock account strings | PEM keys |
| Payment verify | devnet transfer lookup | CSPR.cloud `GET /transfers?deploy_hash=` |
| Registry | devnet mirrors the Odra contract rules | deployed `AgentGateRegistry` contract |
| Guardrails | default admin token OK, SSRF guard off | default token refused, SSRF guard on |

All env vars are documented in [.env.example](.env.example). In **live mode** the gateway and background services require `CSPR_CLOUD_API_KEY` and a non-default `AGENTGATE_ADMIN_TOKEN` (enforced by config). The **CLI is looser**: `list`/`status` read the public node with no keys; only `status` attestation history needs `CSPR_CLOUD_API_KEY`. Live `wrap` needs **no** admin token — it maps the upstream by signing an ownership challenge with your `--pem` key (verified against the on-chain `owner`). Live `buy` needs only a funded buyer key (`--pem` or `BUYER_SIGNER_PEM_PATH`). Every value can also be passed as a flag (`--mode`, `--node-url`, `--registry`, `--pem`, `--api-key`, `--admin-token`; flag > env > default).

---

## Repository layout

```
packages/
  shared/        types · config · bigint money · trust tiers (zero runtime deps)
  devnet/        in-memory mock chain HTTP server                         :4030
  chain/         ChainClient: MockChainHttpClient + LiveCasperClient
  middleware/    the product core — 402 paywall proxy + owner-signed self-map   :4021
  client/        agent-side fetchPaid (parse 402 → pay → retry)
  oracle/        demo RWA feed: USD/IDR + gold spot + confidence          :4010
  buyer-agent/   LLM decision loop (AnthropicLlm / MockLlm)
  cli/           agentgate wrap | buy | list | status | pause | resume | demo-accounts
dashboard/       Next.js 16 landing + catalog + live activity + docs      :3000
contracts/       AgentGateRegistry (Rust/Odra) — registry, scores, attestations
e2e/             full-loop test, in-process servers on port 0
scripts/         dev.ts (stack) · demo.ts (one-shot scripted demo)
```

---

## Scripts and tests

| Command | What it does |
|---|---|
| `npm run demo` | one-shot full loop, offline, exits 0 with both tx hashes |
| `npm run dev` | boots devnet + oracle + middleware, seeds demo accounts |
| `npm run dev:dashboard` | Next.js dashboard at :3000 |
| `npm run agentgate -- …` | the `agentgate` CLI |
| `npm run agent -- --task "…"` | run the buyer agent once |
| `npm run typecheck` | `tsc --noEmit` in every package + dashboard + root scripts/e2e |
| `npm test` | vitest: all package units + the e2e loop (399 tests) |
| `npm run build` | dashboard `next build` |

Contract tests: `cd contracts/agentgate-registry && cargo odra test` (22 OdraVM tests, incl. the v2 `accepts[]` paths), plus `contracts/spend-guard` (25 tests via `cargo test`).

---

## Deployed addresses

**Live on Casper Testnet** (Casper 2.0, network `casper-test`) — **registry v2** with the on-chain multi-asset `accepts[]` price list (unlocked/upgradable package). The full loop — register (accepts[]) → pay (native CSPR transfer **or** WCSPR via the x402 facilitator) → attest → score — runs on-chain; every catalog service carries a genuine payment-backed attestation. Set `REGISTRY_CONTRACT_PACKAGE_HASH` to the package hash for live mode (the published CLI already defaults to it).

| Artifact | Value |
|---|---|
| `AgentGateRegistry` **v2** package hash | `hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df` |
| Install (unlocked/upgradable) tx | [`825e0e0f…`](https://testnet.cspr.live/transaction/825e0e0fbdefa2ca25b526bde27493948b5e369132ddf96e8d801954d8ad702a) |
| `register_service` #1 with 2-asset `accepts[]` (native 2.5 CSPR + 0.1 WCSPR) | [`38836425…`](https://testnet.cspr.live/transaction/38836425b749f0fe492cd1fbf90c5b523516bdb7840460c7f83e797a7e4699e1) |
| #2 native buy via `agentgate buy` (2.5 CSPR, `transfer_id` = nonce) | [`1fa1078c…`](https://testnet.cspr.live/transaction/1fa1078ca4e5f2bfa4d61516332c18175f6b6eb30c7c6de96f0ae36fdfec60b1) |
| #2 `record_attestation` | [`62d44ea7…`](https://testnet.cspr.live/transaction/62d44ea7c2a27b9240e183112fcb2b425f894e7bcfd528d7152d3cbf0b8677f4) |
| #1 facilitator settle (0.1 WCSPR, gas sponsored) | [`c190bcc5…`](https://testnet.cspr.live/transaction/c190bcc528f32c197f8c4f59ade398816bff2320c70891252860b2f0ef96e6e8) |
| #1 `record_attestation` (references the settle tx) | [`ba36811b…`](https://testnet.cspr.live/transaction/ba36811b9533b56b38f6b0dea60600b3c242f7a72d661bec47d1dbffdb467430) |
| Legacy **v1** registry (locked; rollback target, still readable) | `hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9` |

---

## Deployment and hosting

The registry is **deployed to Casper Testnet** (addresses above). **Currently hosted:** the live-mode gateway runs at **https://gateway.example.org** and the dashboard at **https://agentgate.example.org** (cloudflared tunnels → local PM2 services). The CLI is published to npm as [`@neargate/cli`](https://www.npmjs.com/package/@neargate/cli).

<details>
<summary><b>Deploy runbook and self-hosting</b></summary>

<br>

- **Contract deploy:** [docs/DEPLOY.md](docs/DEPLOY.md), including the wasm toolchain requirement (**binaryen ≥ 123** + `wasm-strip`; older binaryen leaves a bulk-memory `DataCount` section that makes stored entry-point calls revert with *"Sections out of order"*) and the verify-against-deployed-contract notes.
- **Hosting the services:** [docs/HOSTING.md](docs/HOSTING.md) — dashboard → Vercel (root `vercel.json`), middleware + oracle → Railway (per-package Dockerfiles + `railway.json`), plus a self-contained `docker-compose.hosting.yml` demo stack.
- **Gateway runbook:** `deploy/agentgate.ecosystem.config.cjs` in [docs/DEPLOY-GATEWAY.md](docs/DEPLOY-GATEWAY.md).

</details>

---

## Roadmap

**Shipped**

- Native CSPR rail — transfer with the invoice nonce bound as `transfer_id`
- Official x402 facilitator rail — WCSPR via CSPR.cloud, EIP-712, gas sponsored
- On-chain multi-asset `accepts[]` price list — registry v2 (unlocked/upgradable)
- MCP server for any agent framework — `npx @neargate/cli mcp`
- CLI **v0.2.1** published to npm

**Next**

- Mainnet deploy
- CSPR.cloud streaming for real-time catalog updates
- Staking-weighted attestations with slashing

---

## About

Built solo by its author for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon) — Casper Innovation Track (Agentic AI × DeFi/RWA on Casper).

**License:** [MIT](LICENSE)
