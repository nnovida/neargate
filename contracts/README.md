# contracts/ — AgentGate Odra Smart Contract

The on-chain layer of AgentGate: a single Casper contract,
**`AgentGateRegistry`** (Rust + [Odra](https://odra.dev), resolved to Odra
2.8.x via the `2.7.2` semver range — SPEC §10), living in
[`agentgate-registry/`](./agentgate-registry). The crate follows the
`cargo odra new --template full` layout: one crate, an `Odra.toml` listing the
deployable contract, and the `*_build_contract` / `*_build_schema` bins that
`cargo odra build` / `cargo odra schema` drive.

> This directory is a standalone Rust workspace — it is **not** an npm
> workspace. All `cargo odra` commands below run from
> `contracts/agentgate-registry/`.

## SpendGuard integration status — NOT yet wired into the product

A second contract, **SpendGuard** (`contracts/spend-guard/`), is implemented and
unit-tested (`open_policy` / `deposit` / `debit` / `getPolicy` / `getRemaining`,
plus a new **owner-only `withdraw`** entrypoint so escrowed funds are never
locked). **However, it is NOT integrated into the running AgentGate product:**

- there is **no off-chain `SpendGuardClient`** (`packages/chain/` has only the
  registry client);
- the middleware **does not call `debit` before proxying** (`/svc/:id` in
  `packages/middleware/src/app.ts` has no policy-proxy hook);
- `loadConfig()` does **not** read `SPENDGUARD_CONTRACT_PACKAGE_HASH`, and it is
  absent from `.env.example`.

Until that wiring exists (the roadmap is in `contracts/DEPLOY-DAY1.md` §5),
**SpendGuard must not be presented as an active spend-firewall.** The contract
is real and tested; the live spend-control path it would enable is not yet
built.

## What the contract does

| Concern | Mechanism |
|---|---|
| **Discovery** | `register_service(name, description, gateway_base_url, price, payment_target, attestor) -> u64` — caller becomes `owner`, service starts `active`, ids are 1-based and sequential (`1..=services_count`; id `0` is reserved for "absent" by every off-chain reader). |
| **Endpoint URL** | NOT stored verbatim. The contract stores `gateway_base_url`; every reader computes `endpoint_url = {gateway_base_url}/svc/{id}` (SPEC §9/§10 decision). |
| **Validation** | `EmptyName` if the name is empty/whitespace-only; `InvalidPrice` if `price < 1000` motes. Money is `U512` motes (`odra::casper_types::U512` — not in the prelude). |
| **Reputation** | `record_attestation(service_id, payment_deploy_hash, success)` — attestor **or** owner only (`NotAuthorized`), service must exist (`ServiceNotFound`) and be active (`ServiceInactive`), one attestation per `(service_id, payment_deploy_hash)` (`DuplicateAttestation`). Bumps the `(total_calls, success_calls)` score and appends to the attestation list, capped at the **last 100** entries, newest first (oldest dropped — counters keep full history). |
| **Lifecycle** | `set_active(service_id, active)` — owner only. |
| **Reads** | `get_service(id) -> Option<Service>`, `get_score(id) -> (u64, u64)` (`(0,0)` default), `services_count() -> u64`, `get_attestations(id) -> Vec<Attestation>` (newest first). |
| **Events** | `ServiceRegistered`, `AttestationRecorded`, `ServiceStatusChanged` (Casper Event Standard via Odra). |

Errors are declared with `#[odra::odra_error]` (the Odra 2.x replacement for
the legacy `odra::execution_error!` named in SPEC §10): `NotAuthorized=1`,
`ServiceNotFound=2`, `ServiceInactive=3`, `DuplicateAttestation=4`,
`InvalidPrice=5`, `EmptyName=6`.

## Prerequisites

```bash
# Rust via rustup. The pinned nightly + wasm32 target auto-install from
# agentgate-registry/rust-toolchain.toml (channel nightly-2026-01-01) on first
# cargo invocation. Nightly is mandatory — odra-macros uses unstable features;
# stable fails with E0554.

# cargo-odra CLI (verified with 0.1.7)
cargo install cargo-odra --locked

# WASM post-processing — needed by `cargo odra build` only:
#   wasm-strip  (wabt)
#   wasm-opt    (binaryen >= 121 — older versions lack
#                --llvm-memory-copy-fill-lowering, which cargo-odra passes for
#                rustc >= 2025-02-17 and the build hard-fails without it;
#                Ubuntu 22.04's binaryen 108 and the cargo-installed wasm-opt
#                116 are both too old)
sudo apt-get install -y wabt          # wasm-strip
# binaryen >= 121: grab a release binary if your distro's package is older:
#   https://github.com/WebAssembly/binaryen/releases (e.g. version_123)
```

> Local-machine note: this repo keeps a git-ignored `contracts/.tools/bin/`
> with pinned `wasm-strip` (wabt 1.0.37) and `wasm-opt` (binaryen 123)
> binaries. If your system tools are older, prefix the build with
> `PATH="$(pwd)/../.tools/bin:$PATH"`.

## Test

```bash
cd contracts/agentgate-registry

# Fast unit tests on the in-process OdraVM (no WASM, no network) — 17 tests:
cargo odra test

# Optional: same tests against the real CasperVM backend (slower, needs the
# wasm32 target; run before deploying):
cargo odra test -b casper
```

The suite covers: register/get happy path, sequential ids + `services_count`,
empty/whitespace name and `< 1000` motes price validation (incl. the exact
1000-motes boundary), `Option`/default reads for unknown ids, attestor-or-owner
auth (stranger reverts), duplicate `payment_deploy_hash` guard (and that the
guard is per-service), inactive-service revert + reactivation, score math,
the 100-entry attestation cap dropping the oldest entries while counters keep
full history, owner-only `set_active` (attestor explicitly rejected), unknown
service reverts for both mutating entrypoints, and event emission for all
three events.

## Build (WASM)

```bash
cd contracts/agentgate-registry
cargo odra build           # writes wasm/AgentGateRegistry.wasm
```

Measured on this machine (Odra 2.8.1, pinned nightly-2026-01-01 = rustc
1.94.0-nightly, wasm-opt 123 + wasm-strip):
**`wasm/AgentGateRegistry.wasm` = 294,374 bytes (~288 KiB)** after
cargo-odra's automatic `wasm-opt --signext-lowering --enable-bulk-memory
--llvm-memory-copy-fill-lowering` + `wasm-strip` pass.

```bash
# Contract schema (entrypoints/types/events JSON for clients & explorers):
cargo odra schema          # writes resources/casper_contract_schemas/agent_gate_registry_schema.json
```

`cargo odra test` and `cargo odra build` share one toolchain config — no
special-casing needed: the pinned nightly includes the `wasm32-unknown-unknown`
target via `rust-toolchain.toml`.

---

## Testnet deploy runbook (DOCUMENTED — not executed; deploy is out of scope)

Deployment to Casper Testnet is intentionally **not** performed by the build
(SPEC §10/§13). Everything below is the verified procedure to run later, by a
human, from `contracts/agentgate-registry/`.

### 0. Keys & funding

```bash
# Generate an ed25519 keypair for the deployer (becomes the tx payer;
# NOT baked into the contract — the registry has no constructor args and no
# privileged admin):
casper-client keygen ./keys           # writes secret_key.pem / public_key.pem / public_key_hex

# Fund it on testnet (needs ~ the install budget below):
#   https://testnet.cspr.live/tools/faucet
# Check the balance:
casper-client get-balance \
  --node-address https://node.testnet.casper.network/rpc \
  --purse-identifier "$(cat ./keys/public_key_hex)"
```

Never commit `keys/` (it is git-ignored). The middleware/attestor and seller
keys referenced by the root `.env` (`GATE_SIGNER_PEM_PATH`, …) are separate
application-level keys — the deployer key is only used here.

### Option A — `casper-client put-deploy` (plain CLI)

Odra-generated installer wasm REQUIRES the `odra_cfg_*` session args below
(the generated `call()` reverts on missing args — verified against
odra-core/odra-casper-wasm-env 2.8.1 sources). This contract has no `init`,
so no further constructor args are needed.

```bash
cargo odra build    # produce wasm/AgentGateRegistry.wasm first

# ⚠️ verify against deployed contract: 300 CSPR (300_000_000_000 motes) is a
# deliberately generous install budget for a ~288 KiB session wasm; Casper 2.0
# refunds unspent gas. Tune after the first real install (inspect "cost" in
# the deploy result; typical installs of this size land well under the cap).
casper-client put-deploy \
  --node-address https://node.testnet.casper.network/rpc \
  --chain-name casper-test \
  --secret-key ./keys/secret_key.pem \
  --payment-amount 300000000000 \
  --session-path ./wasm/AgentGateRegistry.wasm \
  --session-arg "odra_cfg_package_hash_key_name:string='AgentGateRegistry_package_hash'" \
  --session-arg "odra_cfg_allow_key_override:bool='false'" \
  --session-arg "odra_cfg_is_upgradable:bool='false'" \
  --session-arg "odra_cfg_is_upgrade:bool='false'"
# -> prints { "deploy_hash": "<hash>" }

# Poll until executed (look for "Success" under execution results):
casper-client get-deploy \
  --node-address https://node.testnet.casper.network/rpc \
  <deploy_hash>
```

### Option B — Odra livenet CLI (`bin/deploy.rs`)

A documented `odra-cli` deploy binary ships in the crate behind the `livenet`
feature (it is compiled-checked but never run in CI):

```bash
# .env / exported environment:
export ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.casper.network/rpc
export ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
export ODRA_CASPER_LIVENET_SECRET_KEY_PATH=./keys/secret_key.pem

cargo run --bin agentgate_registry_deploy --features livenet --release -- deploy
# Records the deployed address in resources/deployed_contracts.toml so
# follow-up `... -- contract agent-gate-registry <entrypoint>` calls reuse it.
```

### Finding the contract package hash afterwards

The root `.env` needs `REGISTRY_CONTRACT_PACKAGE_HASH` (SPEC §1). After the
install deploy succeeds:

1. **Explorer:** open
   `https://testnet.cspr.live/deploy/<deploy_hash>` → the resulting contract,
   or `https://testnet.cspr.live/account/<deployer_public_key_hex>` →
   *Named Keys* → entry **`AgentGateRegistry_package_hash`** (the value of
   `odra_cfg_package_hash_key_name`; the Odra HostEnv deployer defaults to
   `<ContractIdent>_package_hash` — the sibling
   `AgentGateRegistry_package_hash_access_token` URef is the admin access
   token). The **package** hash is what the TS `LiveCasperClient` calls.
2. **CLI:**
   ```bash
   # account hash of the deployer
   casper-client account-address --public-key "$(cat ./keys/public_key_hex)"
   # read the named key (state root hash first)
   casper-client get-state-root-hash --node-address https://node.testnet.casper.network/rpc
   casper-client query-global-state \
     --node-address https://node.testnet.casper.network/rpc \
     --state-root-hash <srh> \
     --key <account-hash-...> \
     -q "AgentGateRegistry_package_hash"
   ```
3. **CSPR.cloud:** `GET https://api.testnet.cspr.cloud/accounts/<account_hash>`
   (raw token auth header, no `Bearer` prefix) also lists named keys.

Then set in the root `.env`:

```
REGISTRY_CONTRACT_PACKAGE_HASH=hash-<64 hex>
```

### Gas notes (record actuals here after first deploy)

| Action | Budget to set | Notes |
|---|---|---|
| Install (this wasm, ~288 KiB) | 300 CSPR | ⚠️ verify against deployed contract — generous cap, unspent gas refunds under Casper 2.0 |
| `register_service` | 2–5 CSPR | string-heavy args; storage write + event |
| `record_attestation` | 2–5 CSPR | rewrites the capped `Vec<Attestation>` (up to 100 entries) — worst case is the most expensive entrypoint; re-measure at the cap |
| `set_active` | 1–2 CSPR | single record rewrite + event |

Smoke-test a freshly deployed registry from the CLI:

```bash
casper-client put-deploy \
  --node-address https://node.testnet.casper.network/rpc \
  --chain-name casper-test \
  --secret-key ./keys/secret_key.pem \
  --payment-amount 5000000000 \
  --session-package-hash hash-<64 hex> \
  --session-entry-point register_service \
  --session-arg "name:string='Smoke Test'" \
  --session-arg "description:string='hello'" \
  --session-arg "gateway_base_url:string='http://localhost:4021'" \
  --session-arg "price:u512='1000'" \
  --session-arg "payment_target:key='account-hash-<64 hex>'" \
  --session-arg "attestor:key='account-hash-<64 hex>'"
```

> ⚠️ verify against deployed contract: Odra `Address` args serialize as
> `Key`/`key` CLType; confirm the exact arg CLTypes against
> `resources/casper_contract_schemas/agent_gate_registry_schema.json`
> (generated by `cargo odra schema`) before scripting against testnet.
