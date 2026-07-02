# AgentGate — Engineering Spec (v1.0)

> **Authoritative build contract.** Every package MUST conform to the types, interfaces,
> ports, and REST shapes below. The product spec is `../AgentGate-PRD-Solo-Build-Plan.md`.
> Payment plan: **Plan B (default)** — native CSPR transfer with `transfer_id = nonce`
> carrying HTTP 402 semantics, verified via CSPR.cloud REST in live mode and via the
> local devnet in mock mode. A `PaymentVerifier`/`ChainClient` seam keeps Plan A
> (x402 Facilitator) pluggable later.

## 0. Repo layout (npm workspaces monorepo, ESM, TypeScript, run with tsx)

```
agentgate/
├── package.json              # workspaces root, scripts: dev/demo/typecheck/test/build
├── tsconfig.base.json
├── vitest.config.ts          # root config picking up packages/*/test + e2e/
├── .env.example  .gitignore  LICENSE (MIT)  README.md
├── docs/SPEC.md  docs/ARCHITECTURE.md
├── .github/workflows/ci.yml
├── contracts/                # Rust/Odra workspace (NOT an npm workspace)
│   └── agentgate-registry/
├── packages/
│   ├── shared/        # @agentgate/shared   — types, config, money, logger, errors. ZERO runtime deps.
│   ├── chain/         # @agentgate/chain    — ChainClient impls: MockChainHttpClient + LiveCasperClient
│   ├── devnet/        # @agentgate/devnet   — in-memory mock chain HTTP server (express)
│   ├── middleware/    # @agentgate/middleware — 402 paywall reverse proxy + admin API
│   ├── client/        # @agentgate/client   — agent-side pay helper (parse 402 → pay → retry)
│   ├── oracle/        # @agentgate/oracle   — RWA feed: USD/IDR + gold spot + confidence
│   ├── buyer-agent/   # @agentgate/buyer-agent — LLM decision loop demo agent
│   └── cli/           # @agentgate/cli      — `agentgate wrap|buy|list|status|pause|resume|demo-accounts`
├── dashboard/         # @agentgate/dashboard — Next.js 14 App Router + Tailwind (also the landing page)
├── e2e/               # loop.test.ts — full mock-mode loop, in-process servers
└── scripts/
    ├── dev.ts         # boots devnet+oracle+middleware (mock mode) concurrently
    └── demo.ts        # one-shot scripted demo: register → 402 → pay → serve → attest → score
```

Conventions:
- `"type": "module"` everywhere. TS `moduleResolution: "bundler"`, `strict: true`. No build step for
  Node packages — run from source with `tsx`. Each package's `package.json` `exports` points at `./src/index.ts`.
- Workspace deps use `"@agentgate/shared": "workspace:*"` → **NO**, npm doesn't support `workspace:*` ranges
  with install older semantics reliably — use `"*"` as the version range for internal deps (npm workspaces resolves locally).
- Every server package exports `createApp(deps): express.Express` (pure factory, no listen) AND
  `startServer(opts): Promise<{ port: number; close(): Promise<void> }>` so e2e can boot in-process on port 0.
- Logging: `createLogger(name)` from shared — leveled JSON lines to stdout (`{ts,level,name,msg,...fields}`).
- All packages: `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run, if tests exist) must pass.

## 1. Modes & environment

`AGENTGATE_MODE = "mock" | "live"` (default `mock`). Shared `loadConfig()` reads process.env once, validates, throws on invalid combos (e.g. live mode without CSPR_CLOUD_API_KEY, live mode with default admin token).

`.env.example` (root, documented):
```
AGENTGATE_MODE=mock
# --- ports ---
DEVNET_PORT=4030
ORACLE_PORT=4010
MIDDLEWARE_PORT=4021
DASHBOARD_PORT=3000
# --- mock mode ---
DEVNET_URL=http://localhost:4030
# --- middleware ---
AGENTGATE_ADMIN_TOKEN=dev-admin-token        # MUST be changed in live mode (config refuses default)
INVOICE_TTL_MS=300000
UPSTREAM_TIMEOUT_MS=30000
# --- live mode (Casper Testnet) — fill before deploy; deploy itself is out of scope for now ---
CASPER_NODE_URL=https://node.testnet.casper.network/rpc
CSPR_CLOUD_API_URL=https://api.testnet.cspr.cloud
CSPR_CLOUD_API_KEY=
CSPR_CLOUD_STREAMING_URL=wss://streaming.testnet.cspr.cloud
CASPER_NETWORK=casper-test
REGISTRY_CONTRACT_PACKAGE_HASH=
GATE_SIGNER_PEM_PATH=                         # middleware/attestor key
BUYER_SIGNER_PEM_PATH=                        # buyer agent key
SELLER_SIGNER_PEM_PATH=                       # CLI / seller key
# --- LLM ---
ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-6
# --- oracle ---
ORACLE_STATIC=0                               # 1 = serve deterministic fixture data (offline demo)
# --- buyer agent ---
BUYER_BUDGET_CSPR=5
# --- demo accounts (mock mode only) ---
MOCK_BUYER_ACCOUNT=
MOCK_SELLER_ACCOUNT=
```

## 2. Shared package — `@agentgate/shared` (zero runtime deps)

`src/types.ts` — **copy verbatim**:
```ts
/** All money values are motes of native CSPR as decimal strings (1 CSPR = 1_000_000_000 motes). U512-safe via bigint. */
export type Motes = string;

export interface ServiceRecord {
  id: number;
  name: string;
  description: string;
  endpointUrl: string;       // PUBLIC gateway URL (middleware /svc/:id) — never the upstream
  priceMotes: Motes;
  paymentTarget: string;     // "account-hash-<64hex>"
  owner: string;             // public key hex ("01..."/"02...")
  attestor: string;          // public key hex allowed to record attestations
  active: boolean;
  createdAt: number;         // unix ms
}

export interface ServiceScore { totalCalls: number; successCalls: number; }

export interface AttestationRecord {
  serviceId: number;
  paymentDeployHash: string;
  success: boolean;
  timestamp: number;         // unix ms
  recordTxHash: string;      // the attestation tx itself
}

export interface ActivityEvent {
  kind: 'service_registered' | 'payment' | 'attestation';
  txHash: string;
  serviceId: number | null;
  amountMotes?: Motes;
  success?: boolean;
  timestamp: number;
  detail: string;            // human-readable one-liner for the dashboard feed
}

export interface PaymentRequirements {
  scheme: string;             // 'exact'
  network: string;            // 'mock' | 'casper-test'
  maxAmountRequired: string;  // price in motes, decimal string
  asset: string;              // 'CSPR'
  payTo: string;              // account-hash-<64hex>
  resource: string;           // absolute /svc/:id URL
  description: string;        // service name
  maxTimeoutSeconds: number;  // invoiceTtlMs / 1000
  extra: {
    nonce: string;            // u64 decimal — required transfer_id
    serviceId: number;
    expiresAtMs: number;      // unix ms
    settlement: 'casper-native-transfer';
    transferIdEncoding: 'u64-decimal';
  };
}

export interface PaymentRequiredResponse {
  x402Version: number;               // 1
  error: string;                     // human-readable reason
  accepts: PaymentRequirements[];    // >= 1 entry
}

export interface PaymentPayload {
  x402Version: number;   // 1
  scheme: string;        // 'exact'
  network: string;       // chain network
  payload: { transaction: string; transferId: string; from?: string };
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface RegisterServiceInput {
  name: string;
  description: string;
  endpointUrl: string;
  priceMotes: Motes;
  paymentTarget: string;
  attestor: string;
}

export interface VerifyTransferQuery {
  deployHash: string;
  expectedTarget: string;    // account-hash
  minAmountMotes: Motes;
  expectedTransferId: string;
  maxAgeMs: number;
}
export type VerifyResult =
  | { ok: true; amountMotes: Motes; from: string; timestamp: number }
  | { ok: false; reason: 'not_found' | 'wrong_target' | 'amount_too_low' | 'wrong_transfer_id' | 'expired' | 'pending' };

export interface SignerRef { kind: 'mock'; publicKey: string } // mock
export interface PemSignerRef { kind: 'pem'; pemPath: string } // live
export type AnySigner = SignerRef | PemSignerRef;

export interface ChainClient {
  readonly network: string;
  getService(id: number): Promise<ServiceRecord | null>;
  listServices(): Promise<ServiceRecord[]>;
  getScore(id: number): Promise<ServiceScore>;
  listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]>;
  listRecentActivity(limit?: number): Promise<ActivityEvent[]>;
  getBalance(account: string): Promise<Motes>;
  verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult>;
  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }>;
  recordAttestation(input: { serviceId: number; paymentDeployHash: string; success: boolean }, signer: AnySigner): Promise<{ txHash: string }>;
  setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }>;
  transfer(input: { to: string; amountMotes: Motes; transferId: string }, signer: AnySigner): Promise<{ deployHash: string }>;
}
```

`src/money.ts`: `csprToMotes(cspr: string): Motes` (decimal string × 1e9, bigint, throws on >9 dp or negative), `motesToCspr(m: Motes): string` (trim trailing zeros), `addMotes`, `compareMotes(a,b): -1|0|1`, `formatCspr(m: Motes): string` ("0.5 CSPR"). All bigint-backed; never use Number for money.

`src/nonce.ts`: `randomNonce(): string` — 63-bit random from `crypto.getRandomValues`, decimal string (valid u64 transfer_id).

`src/config.ts`: `loadConfig(env = process.env): AgentGateConfig` per §1. `src/logger.ts`: tiny JSON logger with `debug/info/warn/error`, level from `LOG_LEVEL`. `src/errors.ts`: `AgentGateError(code, message, httpStatus)`.

Score → trust badge (shared `src/trust.ts`, used by dashboard + buyer agent):
`trustTier(score: ServiceScore): 'new' | 'reliable' | 'trusted'` — `new` if totalCalls < 5; `trusted` if totalCalls ≥ 25 AND success ratio ≥ 0.95; `reliable` if totalCalls ≥ 5 AND ratio ≥ 0.9; else `new`.

## 3. Devnet (mock chain) — `@agentgate/devnet`, express, port **4030**

In-memory state simulating exactly what we use on Casper: account balances (motes), native transfers with `transfer_id`, the registry contract's state, and an activity log. Deterministic-ish tx hashes: `sha256(JSON.stringify(payload) + monotonicCounter)` hex, 64 chars.

REST (all JSON):
| Method/Path | Body / Query | Returns |
|---|---|---|
| `POST /faucet` | `{account, amountMotes}` | `{balanceMotes}` |
| `GET  /chain/balance/:account` | | `{account, balanceMotes}` |
| `POST /chain/transfers` | `{fromPublicKey, to, amountMotes, transferId}` | `{deployHash, timestamp}` — debits sender (account-hash derived `account-hash-<sha256(pubkey) hex>`), credits target; 400 `insufficient_balance` |
| `GET  /chain/transfers/:deployHash` | | transfer record or 404 |
| `POST /chain/register-service` | `RegisterServiceInput & {ownerPublicKey}` | `{serviceId, txHash}` — also activity event |
| `POST /chain/attestations` | `{serviceId, paymentDeployHash, success, byPublicKey}` | `{txHash}` — 403 if `byPublicKey` ≠ service.attestor and ≠ owner; 404 unknown service; 409 duplicate paymentDeployHash for that service |
| `POST /chain/services/:id/active` | `{active, byPublicKey}` | `{txHash}` — owner only |
| `GET  /chain/services` | | `ServiceRecord[]` |
| `GET  /chain/services/:id` | | `ServiceRecord` or 404 |
| `GET  /chain/services/:id/score` | | `ServiceScore` |
| `GET  /chain/services/:id/attestations?limit=` | | `AttestationRecord[]` (newest first) |
| `GET  /chain/activity?limit=` | | `ActivityEvent[]` (newest first, default 50) |
| `GET  /healthz` | | `{ok:true, network:'mock'}` |

Mirrors the on-chain rules of the Odra contract (auth, duplicate attestation guard, active flag) so mock and live behave identically.

## 4. Chain package — `@agentgate/chain`

- `createChainClient(config): ChainClient` — picks impl by `config.mode`.
- `MockChainHttpClient` — fetch against `DEVNET_URL`, maps REST ↔ `ChainClient`. Account-hash derivation helper `mockAccountHash(publicKey)` = `account-hash-` + sha256(publicKey) hex.
- `LiveCasperClient` — casper-js-sdk v5 (`casper-js-sdk@^5.0.12`) + CSPR.cloud REST:
  - reads: services/score/attestations via CSPR.cloud contract-state + the deployed registry's named keys; activity via CSPR.cloud deploys/transfers endpoints; `verifyTransfer` via CSPR.cloud `GET /transfers?deploy_hash=` checking target account-hash, amount, `transfer_id`, age. CSPR.cloud auth header is the **raw token** (no `Bearer` prefix).
  - writes: native transfer with id via SDK `TransferDeployItem`/SessionBuilder; `register_service` / `record_attestation` / `set_active` via ContractCallBuilder against `REGISTRY_CONTRACT_PACKAGE_HASH`.
  - Anything that requires the not-yet-deployed contract throws `AgentGateError('NOT_DEPLOYED', 'requires REGISTRY_CONTRACT_PACKAGE_HASH — run contracts deploy first', 503)` when the hash is unset, with the call path otherwise fully implemented and compiling. Mark with `// ⚠️ verify against deployed contract` where arg names/gas need on-chain confirmation.

## 5. Middleware (the product core) — `@agentgate/middleware`, express, port **4021**

402 paywall reverse proxy. State: upstream map (`data/upstreams.json`, atomic writes) + nonce/invoice store (in-memory Map + TTL sweep; interface `InvoiceStore` so Redis can swap in).

Flow for `ALL /svc/:id` (GET/POST pass-through):
1. Look up service by id from `ChainClient` (60s cache). 404 if unknown, 403 `service_inactive` if `!active`.
2. No `X-PAYMENT` header → **402** with `PaymentRequiredResponse` JSON body (`x402Version:1`, `error:"X-PAYMENT header is required"`, `accepts:[requirements(freshNonce)]`). Invoice persisted (nonce → {serviceId, expiresAtMs, used:false}).
3. With `X-PAYMENT` header (base64-encoded `PaymentPayload`):
   - Decode and validate `x402Version===1`, `scheme==="exact"`, `network===chain.network`; extract `payload.transaction` + `payload.transferId`. Malformed → **402** + fresh requirements + `error:"invalid_payment_header"`.
   - Invoice lookup by `transferId`: must exist, match serviceId, be unused, be within `expiresAtMs` — else **402** fresh requirements + reason (`invoice_expired`, `invoice_used`, `unknown_nonce`).
   - `chain.verifyTransfer({deployHash: transaction, expectedTarget: service.paymentTarget, minAmountMotes: service.priceMotes, expectedTransferId: transferId, maxAgeMs: INVOICE_TTL_MS})` → on `{ok:false}` **402** + fresh requirements + reason. `pending` → **402** + same requirements (nonce kept) + `Retry-After: 2` (seconds) + `error:"settlement_pending"`.
   - Mark nonce used **before** proxying (single-use even if upstream fails).
4. Proxy to upstream (undici/fetch, timeout `UPSTREAM_TIMEOUT_MS`, max body 1 MiB both ways, strip hop-by-hop headers, forward query string + JSON body, pass through status/content-type).
5. Respond to buyer, then **async** `chain.recordAttestation({serviceId, paymentDeployHash, success: upstreamOk})` signed by gate signer; never blocks the response; on failure log + retry once after 5s.

Admin API (Bearer `AGENTGATE_ADMIN_TOKEN`):
- `POST /admin/services` `{serviceId, upstreamUrl}` → 204 (validates URL http/https, **rejects** private/loopback hosts in live mode — SSRF guard; allowed in mock for local demo).
- `GET /admin/services` → mappings. `DELETE /admin/services/:id` → 204.
- `GET /svc/:id/meta` (public) → `{service, score, trustTier}` without paying.
- `GET /healthz`.

Hardening: helmet, JSON body limit 256 KiB inbound, rate limit 60 req/min/IP on `/svc`, structured request logs, graceful SIGTERM shutdown, never leak upstream URL in responses or errors.

## 6. Client helper — `@agentgate/client`

```ts
export interface PayAndFetchResult { status: number; body: unknown; paid: boolean; requirements?: PaymentRequirements; settlement?: SettlementResponse; deployHash?: string; priceMotes?: Motes; }
export interface AgentGateClientOpts { chain: ChainClient; signer: AnySigner; maxPriceMotes?: Motes; logger?: Logger; settleDelayMs?: number; }
export function createAgentGateClient(opts): {
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
}
```
`fetchPaid`: GET → if 402: `parsePaymentRequired` selects the `accepts[]` entry matching `chain.network` + `scheme:"exact"` (throws `NETWORK_MISMATCH` if none), refuses if `maxAmountRequired > maxPriceMotes` (`PRICE_EXCEEDED`). `chain.transfer({to: req.payTo, amountMotes: req.maxAmountRequired, transferId: req.extra.nonce}, signer)`, wait `settleDelayMs` (default 0 mock / 3000 live), retry with `X-PAYMENT: encodeXPayment(...)`. On a paid 200 decodes `X-PAYMENT-RESPONSE` into `settlement`. Retries `Retry-After` (seconds) 402-pending (`error:"settlement_pending"`) up to 5×. Non-402 first responses pass straight through.

## 7. Oracle — `@agentgate/oracle`, express, port **4010**

`GET /feed` → `{ pairs: { usd_idr: {value, sources: [{name, value}], confidence}, xau_usd: {...} }, asOf, attribution }`.
Also `GET /feed/usd-idr`, `GET /feed/gold`, `GET /healthz`.
Sources (free, no key): `https://open.er-api.com/v6/latest/USD` (IDR) and `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json` (idr + xau→invert for XAU/USD). 5s timeout per source, 60s in-memory cache, `confidence = max(0, 1 - (maxDev/mean) * 10)` rounded 2dp across available sources; single source → 0.5. `ORACLE_STATIC=1` or all sources failing → deterministic fixture (`usd_idr 16250.5`, `xau_usd 3310.25`, confidence 0.97, `attribution: 'static-fixture'`). Never throws to the consumer — always 200 with best-effort data.

## 8. Buyer agent — `@agentgate/buyer-agent`

`npm run agent -- --task "Get today's USD/IDR rate and gold price, summarize for a treasury report" [--budget 5]`.
Loop (each step logged as pretty console block AND `logs/decisions.jsonl`):
1. `chain.listServices()` → table (id, name, price CSPR, trust tier, score).
2. LLM (`LlmClient` seam: `AnthropicLlm` via raw `fetch` to `https://api.anthropic.com/v1/messages` with `LLM_MODEL`, else deterministic `MockLlm`) gets task + catalog JSON → returns `{serviceId, reason}` (MockLlm: cheapest active service whose name/description matches task keywords; ties → highest trust).
3. Budget check (`BUYER_BUDGET_CSPR` cap, refuse + log if exceeded), then `client.fetchPaid(service.endpointUrl)`.
4. LLM summarizes the data for the task → final report printed.
5. Prints receipt: payment deployHash, amount, remaining budget, and (after 2s) the attestation it triggered (`chain.listAttestations`).

## 9. CLI — `@agentgate/cli` (commander)

Bin name `agentgate` (root script `npm run agentgate -- ...` + package bin field).
- `agentgate wrap <upstreamUrl> --price <cspr> --name <name> [--description <d>] [--gateway <url=http://localhost:4021>] [--payment-target <account-hash>]`
  1. `chain.registerService` (endpointUrl = `<gateway>/svc/<id>` — two-step: register with placeholder, then the devnet/contract computes id; SOLUTION: registry computes `endpoint_url` itself as `<gateway>/svc/<id>`? NO — keep it simple: CLI sends `endpointUrl: '<gateway>/svc/?'` is ugly. **Decision:** `registerService` returns `serviceId`; the canonical public URL is ALWAYS `<gateway>/svc/<serviceId>`; the `endpointUrl` field stored on-chain is set by the CLI to `<gateway>/svc/{id}` template resolved client-side via a second `setEndpoint`? Too much. **Final decision: the registry stores `gatewayBaseUrl` provided at registration; `ServiceRecord.endpointUrl` is computed by every reader as `${gatewayBaseUrl}/svc/${id}`.** To keep `ServiceRecord` unchanged, devnet + contract store the base URL internally and return the computed `endpointUrl`. CLI passes `endpointUrl = <gateway base>`; readers see the full computed URL.
  2. `POST <gateway>/admin/services` with the upstream mapping (admin token from env).
  3. Prints: service id, public endpoint, dashboard URL `http://localhost:3000/services/<id>`, register txHash.
- `agentgate list` — catalog table with scores/tiers.
- `agentgate status <id>` — service + score + recent attestations.
- `agentgate demo-accounts` (mock only) — creates buyer/seller accounts, faucets 1000 CSPR each, prints export lines.
- Payment target default: derived from seller signer (mock: `mockAccountHash(publicKey)`; live: account hash of PEM key).

## 10. Contract — `contracts/agentgate-registry` (Odra, Rust)

Odra latest 2.x (`odra = "2.7.2"` or newest resolving), `rust-toolchain.toml` pinning the nightly that OdraVM tests need; `cargo odra test` green; `cargo odra build` produces wasm (record gas notes in contract README).

Module `AgentGateRegistry`:
- Storage: `services_count: Var<u64>`; `services: Mapping<u64, Service>`; `scores: Mapping<u64, (u64, u64)>` (total, success); `seen_payments: Mapping<(u64, String), bool>` duplicate-attestation guard; `attestations: Mapping<u64, Vec<Attestation>>` capped at last **100** per service (drop oldest).
- `Service { name: String, description: String, gateway_base_url: String, price: U512, payment_target: Address, owner: Address, attestor: Address, active: bool, created_at: u64 }`
- Entrypoints:
  - `register_service(name, description, gateway_base_url, price: U512, payment_target: Address, attestor: Address) -> u64` — validates non-empty name, price ≥ 1000 motes; caller = owner; emits `ServiceRegistered`.
  - `record_attestation(service_id: u64, payment_deploy_hash: String, success: bool)` — caller must be attestor or owner; service must exist & be active; rejects duplicate payment_deploy_hash per service; bumps score; appends capped list; emits `AttestationRecorded`.
  - `set_active(service_id: u64, active: bool)` — owner only; emits `ServiceStatusChanged`.
  - `get_service(service_id) -> Option<Service>`, `get_score(service_id) -> (u64, u64)`, `services_count() -> u64`, `get_attestations(service_id) -> Vec<Attestation>`.
- Errors enum via `odra::execution_error!` (NotAuthorized, ServiceNotFound, ServiceInactive, DuplicateAttestation, InvalidPrice, EmptyName).
- Tests (OdraVM): happy register+get, count increments, score math, attestor auth (owner ok / attestor ok / stranger reverts), duplicate payment hash reverts, inactive service reverts attestation, set_active auth, attestation cap behavior, price/name validation. ≥10 tests.
- `bin/build_schema.rs` if Odra needs it per template; keep template's livenet example with a `deploy.rs` (documented, NOT run).

## 11. Dashboard — `dashboard/` (Next.js 14.2 App Router, Tailwind 3, TypeScript)

Also serves as the landing page (PRD judging criterion #7).
- `/` — landing: hero ("Stripe for AI agents on Casper"), one-command pitch with copyable `npx agentgate wrap ...`, how-it-works 3 steps (wrap → discover → get paid), live stats strip (services, total calls, revenue — from `/api/stats`), roadmap section (mainnet, x402 Facilitator Plan A, streaming, MCP), links (GitHub/X/docs).
- `/catalog` — service cards: name, description, price (CSPR), trust badge, score, active dot; links to detail.
- `/services/[id]` — detail: metadata, trust badge tier, score donut/sparkbar, copyable endpoint + 402 curl snippet, live attestation feed (5s polling), revenue counter (price × successCalls, plus `getBalance(paymentTarget)` shown in mock).
- `/activity` — global live feed of `ActivityEvent`s with tx hashes (mock: plain code text; live: link to `https://testnet.cspr.live/deploy/<hash>`), 5s polling, "LIVE" pulse indicator.
- API routes (`app/api/*/route.ts`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`): `/api/services`, `/api/services/[id]` (record+score+attestations), `/api/activity`, `/api/stats` — thin wrappers over `createChainClient(loadConfig())`. Client components poll with SWR `refreshInterval: 5000`.
- `next.config.mjs`: `transpilePackages: ['@agentgate/shared','@agentgate/chain']`.
- Design: dark theme, distinctive (not default-shadcn-looking): near-black `#0A0E14` bg, electric red accent `#FF3B30` (Casper-adjacent) + neutral grays, `Space Grotesk` headings / `Inter` body / `JetBrains Mono` for hashes & money, generous spacing, real empty/loading/error states. `npm run build` must succeed with zero type errors.

## 12. Root scripts & e2e

Root `package.json` scripts:
- `dev` — `tsx scripts/dev.ts` (devnet → seed demo accounts → oracle → middleware; prints next steps)
- `dev:dashboard` — `npm run dev -w dashboard`
- `demo` — `tsx scripts/demo.ts`: boots devnet+oracle+middleware in-process (ports from env), creates accounts + faucet, wraps the oracle via the CLI's programmatic API (`wrapService()` exported from cli), runs the buyer agent loop once (MockLlm if no key), prints the two tx hashes (payment + attestation) + final score + where to see it in the dashboard. Exits 0.
- `typecheck` — `tsc --noEmit` in every TS package + dashboard (`npm run typecheck --workspaces --if-present`)
- `test` — `vitest run` (packages unit tests + e2e)
- `build` — dashboard `next build`
- `agent`, `agentgate` — forwarders into the packages.

`e2e/loop.test.ts` (vitest): boots devnet/oracle/middleware in-process on port 0; asserts the **full loop**: faucet → wrap (register + admin mapping) → unpaid GET = 402 with valid invoice → underpay rejected → pay exact → 200 with oracle JSON → replayed proof = 402 `invoice_used` → attestation recorded (poll ≤5s) → score = (1,1) → activity feed contains payment + attestation + registration. Plus `expired invoice` test (TTL 100ms) and `inactive service` test.

## 13. Production-readiness bar (what "done" means without deploying)

- `npm install && npm run typecheck && npm test && npm run build` all green from a fresh clone; `cargo odra test` green in `contracts/`.
- `npm run demo` completes the full PRD §2 loop offline and prints 2 tx hashes.
- No secrets in repo; `.env.example` complete; MIT LICENSE; README with architecture diagram (mermaid), quickstart, mode matrix, deploy runbook (documented, not executed); CI workflow (node job + contracts job).
- Live-mode code paths compile and are unit-tested where possible without a node; every spot that needs the deployed contract throws `NOT_DEPLOYED` with a clear message and is listed in `docs/DEPLOY.md`.
