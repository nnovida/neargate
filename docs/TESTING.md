# AgentGate — Testing Guide

How to test AgentGate at every level: automated tests (offline), the scripted demo, the
local mock stack in a browser, and the **live Casper Testnet** deployment. Each level is
independent — you can stop after level 1 (no keys/network needed) or go all the way to a
real paid call on-chain.

> **Current deployment (level 4):** `AgentGateRegistry` is live on Casper Testnet
> (`casper-test`), package hash
> `hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df`. Real tx links
> are in the [README "Deployed addresses"](../README.md#deployed-addresses-casper-testnet) table.

## Prerequisites

- **Node ≥ 22** (`node -v`). Then `npm install` at the repo root.
- For the **contract** tests/build only: Rust (pinned nightly auto-selected by
  `contracts/agentgate-registry/rust-toolchain.toml`) + `cargo install cargo-odra --locked`,
  plus **binaryen ≥ 123** and wabt `wasm-strip` on `PATH` (both pinned in the git-ignored
  `contracts/.tools/bin/` — prefix `PATH="$(pwd)/../.tools/bin:$PATH"`). ⚠️ Binaryen < 123 leaves
  a bulk-memory `DataCount` section that makes deployed entry-point calls revert "Sections out of
  order" (see Troubleshooting).
- For **live** tests (level 4): a funded Casper Testnet account (faucet:
  https://testnet.cspr.live/tools/faucet) and a CSPR.cloud API key
  (https://console.cspr.cloud). See "Live setup" below.

---

## Level 1 — Automated tests (offline, no keys, ~seconds)

```bash
npm install
npm run typecheck     # tsc --noEmit across all 9 packages + dashboard — must be clean
npm test              # vitest: 289 tests across 18 files — all green
```

What `npm test` covers (highlights): the x402 codec (encode/decode + every malformed-input
rejection), the 402 paywall state machine (single-use nonce, SSRF guard, header-whitelist
proxy, admin auth, Retry-After/X-PAYMENT-RESPONSE), the `fetchPaid` client (parse → pay →
retry, price cap, network-mismatch), the mock chain client, money/bigint math, the buyer
agent, and the full **e2e loop** (`e2e/loop.test.ts`: register → 402 → underpay → pay →
serve → replay-reject → attest → score, with TTL + inactive paths).

**Smart contracts** (Rust/Odra, OdraVM — no node needed):

```bash
cd contracts/agentgate-registry && cargo odra test    # 20 tests
cd ../spend-guard              && cargo odra test      # 25 tests
```

---

## Level 2 — Scripted full-loop demo (offline, no keys/network, ~0.1s)

```bash
npm run demo
```

Boots an in-memory mock chain + oracle + gateway in-process, wraps the oracle at 0.5 CSPR,
runs the LLM buyer agent (deterministic `MockLlm` — no API key), and walks the whole loop.
**Expected:** exits 0 and prints a **payment deploy hash**, an **attestation tx hash**, and
**final score `1/1`**. This is the fastest end-to-end proof the product logic works.

> The demo boots its own throwaway chain and exits, so its data does **not** appear in the
> dashboard. Use level 3 (or 4) to view data live.

---

## Level 3 — Local mock stack in a browser

```bash
npm run dev:seed        # boots devnet :4030 + oracle :4010 + middleware :4021,
                        # seeds one wrapped service + a real (mock) paid call, then stays up
npm run dev:dashboard   # second terminal → open the URL it prints (http://localhost:3000)
```

Then exercise it:

- **Dashboard** `http://localhost:3000` — catalog shows the seeded service with a trust score;
  `/services/1` has the metadata + a copyable curl snippet; `/activity` shows the events.
- **402 challenge** (the paywall):
  ```bash
  curl -i http://localhost:4021/svc/1     # → HTTP 402 + x402 PaymentRequiredResponse JSON
  ```
- **Manual pay loop** with the CLI/agent (the printed export lines set the mock accounts):
  ```bash
  npm run agent -- --task "Get today's USD/IDR rate and gold price"
  ```

In mock mode the SSRF guard is off (localhost upstreams allowed) and no real keys are used.

---

## Level 4 — Live Casper Testnet (the real deployment)

### 4a. Verify the on-chain deployment (read-only, no setup)

Open these on the explorer — they should all show **`Success`**:

- Contract: `testnet.cspr.live` → search the package hash `e09869a1…` (or the contract
  `fe134f78…`). The 4 transactions (install / `register_service` / payment transfer /
  `record_attestation`) are linked in the README "Deployed addresses" table.

### 4b. Live setup (one time)

Create the root `.env` from `.env.example` and fill the live values:

```bash
cp .env.example .env
# then set in .env:
#   AGENTGATE_MODE=live
#   REGISTRY_CONTRACT_PACKAGE_HASH=hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df
#   CSPR_CLOUD_API_KEY=<your key>
#   AGENTGATE_ADMIN_TOKEN=<a strong non-default token>   # live mode refuses the default
#   GATE_SIGNER_PEM_PATH / BUYER_SIGNER_PEM_PATH / SELLER_SIGNER_PEM_PATH=<your secret_key.pem paths>
```

> 🔒 **Keep secret keys OUT of the repo.** `.env`, `*.pem`, and `Priv_key_*/` are gitignored —
> never commit key material. Store PEMs outside the repo (e.g. `~/.config/agentgate-keys/`).

The **dashboard** loads env from its own directory, so for a live dashboard create
`dashboard/.env.local` (gitignored) with the **read-only** subset (no signer paths needed —
the dashboard only reads): `AGENTGATE_MODE`, `CASPER_NODE_URL`, `CSPR_CLOUD_API_URL`,
`CSPR_CLOUD_API_KEY`, `CASPER_NETWORK`, `REGISTRY_CONTRACT_PACKAGE_HASH`, `AGENTGATE_ADMIN_TOKEN`.

### 4c. Live dashboard

```bash
npm run dev:dashboard    # reads dashboard/.env.local → live mode
```

Open `http://localhost:3000/catalog` — it now reads the **deployed testnet contract**: the
"RWA FX & Gold Oracle" service with its real `(1,1)` trust score. `/api/services` returns
`"network": "casper-test"`.

### 4d. Live x402 gateway

```bash
npm run dev:live    # boots the middleware in live mode against the deployed contract
```

It prints the next steps. Map the service to a **public** upstream (live-mode SSRF blocks
localhost), then hit the paywall:

```bash
# (in a shell where the .env vars are exported, or copy the token from .env)
curl -X POST http://localhost:4021/admin/services \
  -H "authorization: Bearer $AGENTGATE_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"serviceId":1,"upstreamUrl":"https://open.er-api.com/v6/latest/USD"}'

curl -i http://localhost:4021/svc/1     # → HTTP 402 read from the LIVE testnet registry
```

### 4e. Full paid loop on testnet (spends gas)

1. `GET /svc/1` → read the 402: note `accepts[0].payTo`, `maxAmountRequired`, and `extra.nonce`.
2. Pay: native CSPR transfer to `payTo` with `transfer_id = extra.nonce`, amount **≥ 2.5 CSPR**
   (native-transfer minimum, and ≥ the price). Capture the deploy hash.
3. Retry with the proof header: `X-PAYMENT: <base64 of {x402Version:1, scheme:"exact",
   network:"casper-test", payload:{transaction:<deployHash>, transferId:<nonce>}}>` → **200 +
   upstream data**, and the gateway records an on-chain `record_attestation` (score → `(1,1)`).

The product's own `LiveCasperClient` does all of this — see `packages/chain/src/live.ts`
(`registerService`, `transfer`, `verifyTransfer`, `recordAttestation`).

---

## Expected results — quick checklist

| Check | Pass condition |
|---|---|
| `npm run typecheck` | clean, exit 0 |
| `npm test` | 289 passed (18 files) |
| `cargo odra test` (registry / spend-guard) | 20 / 25 passed |
| `npm run demo` | exit 0; payment + attestation tx hashes + score `1/1` |
| `npm run dev:seed` + dashboard | catalog populated; `/svc/1` → 402; `/activity` has events |
| Live dashboard `/api/services` | `"network":"casper-test"`, service `(1,1)` |
| `npm run dev:live` + `curl /svc/1` | HTTP 402 x402 `PaymentRequiredResponse` |
| Explorer (4 tx) | all `Success` |

---

## Troubleshooting (real gotchas)

- **Dashboard catalog empty / "chain unreachable":** the dashboard is in mock mode. Next.js
  loads env from `dashboard/`, not the repo root — create `dashboard/.env.local` (4c) and
  restart `npm run dev:dashboard`.
- **`curl :4021/...` connection refused:** the gateway isn't running. Start it: `npm run dev`
  (mock) or `npm run dev:live` (live).
- **Stored call reverts "Sections out of order" (`consumed:0`):** the wasm has a bulk-memory
  `DataCount` section. Rebuild with **binaryen ≥ 123 + wabt wasm-strip** (the pinned
  `contracts/.tools/bin/`); verify section ids are `[1,2,3,4,5,6,7,9,10,11]` (no id 12), then
  redeploy.
- **Native transfer "Invalid transaction":** the amount is below the **~2.5 CSPR minimum**.
  Pay ≥ 2.5 CSPR (and ≥ the service price).
- **Live `/svc/:id` → 503 instead of 402:** the service isn't mapped on the gateway, or the
  mapped upstream is private/localhost (live-mode SSRF rejects it) — map a public URL (4d).
- **`NOT_DEPLOYED` (503) on any read/write:** `REGISTRY_CONTRACT_PACKAGE_HASH` is unset in the
  env that process sees. Set it (4b).
- **`cargo odra build` aborts `Unknown option '--llvm-memory-copy-fill-lowering'`:** binaryen is
  too old — use ≥ 123.
