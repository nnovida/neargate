# AgentGate — Live-mode deploy runbook

> **DEPLOYED to Casper Testnet 2026-06-29.** Package hash
> `hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9` (see README for tx
> links). The full loop runs on-chain (register → pay → attest → score `(1,1)`). This runbook
> is the recipe + the three gotchas that actually bit us:
>
> 1. **Wasm toolchain matters (root-cause bug):** build with **binaryen ≥ 123** + real **wabt
>    `wasm-strip`**. Binaryen 121 / a `wasm-opt --strip` shim leaves a **bulk-memory `DataCount`
>    section** in the wasm — the install succeeds but every *stored entry-point call* reverts
>    on-chain with **"Sections out of order"** (`consumed: 0`). Verify the wasm has no section
>    id 12: section order must be `[1,2,3,4,5,6,7,9,10,11]`.
> 2. **Deploy via casper-js-sdk `SessionBuilder`** (`.wasm().installOrUpgrade().runtimeArgs(odra_cfg_* args)
>    .payment(300e9).build()` + `tx.sign(key)` + `RpcClient.putTransaction`). The odra livenet bin
>    additionally needs `ODRA_CASPER_LIVENET_EVENTS_URL=https://node.testnet.casper.network/events`
>    and still fails reading back the package hash on Casper 2.0 — the SDK path is simpler.
> 3. **Native transfers have a ~2.5 CSPR minimum** — a 0.5 CSPR payment is rejected "Invalid
>    transaction". Price services ≥ 2.5 CSPR for the Plan-B native rail (buyer pays ≥ price).

## 1. Prerequisites

- Funded Casper **Testnet** account keys (ed25519 PEM) for three roles:
  gate/attestor (`GATE_SIGNER_PEM_PATH`), buyer (`BUYER_SIGNER_PEM_PATH`),
  seller (`SELLER_SIGNER_PEM_PATH`). Faucet: https://testnet.cspr.live/tools/faucet
- A CSPR.cloud API key (https://console.cspr.cloud) → `CSPR_CLOUD_API_KEY`.
  The auth header is the **raw token** (no `Bearer` prefix).
- Rust toolchain per `contracts/agentgate-registry/rust-toolchain.toml`
  (pinned nightly, auto-selected by rustup) + `cargo install cargo-odra --locked`.

## 2. Build & test the contract

```bash
cd contracts/agentgate-registry
cargo odra test            # 20 OdraVM tests, must be green
cargo odra build           # writes wasm/AgentGateRegistry.wasm (~291 KiB post wasm-opt)
```

> **Build toolchain (CRITICAL — see gotcha #1 above):** use **`wasm-opt` (binaryen ≥ 123)** + real
> **wabt `wasm-strip`** on `PATH` (the repo pins both in git-ignored `contracts/.tools/bin/`; prefix
> `PATH="$(pwd)/../.tools/bin:$PATH"`). Binaryen < 123 (e.g. 121) or a `wasm-opt`-based `wasm-strip`
> *shim* leaves a bulk-memory `DataCount` section → stored calls revert "Sections out of order".
> Binaryen ≥ 121 is needed at minimum for `--llvm-memory-copy-fill-lowering`; **123 is what actually
> produces a DataCount-free, callable wasm.** Verify: section ids must be `[1,2,3,4,5,6,7,9,10,11]`
> (no id 12). Always regenerate the committed schema after any contract change: `cargo odra schema`.

## 3. Deploy the registry (when the time comes)

Use the documented livenet deploy bin (see `contracts/README.md`, kept from the Odra
template, **not run in CI**), or `casper-client put-deploy` with the built wasm against
`https://node.testnet.casper.network/rpc`. Record:

- the **contract package hash** → `REGISTRY_CONTRACT_PACKAGE_HASH`
- actual gas costs per entrypoint → update `contracts/README.md` gas notes and the
  `GAS_*` constants at the top of `packages/chain/src/live.ts`.

## 4. Configure live mode

```bash
AGENTGATE_MODE=live
CASPER_NODE_URL=https://node.testnet.casper.network/rpc
CSPR_CLOUD_API_URL=https://api.testnet.cspr.cloud
CSPR_CLOUD_API_KEY=<your key>
CASPER_NETWORK=casper-test
REGISTRY_CONTRACT_PACKAGE_HASH=<from step 3>
GATE_SIGNER_PEM_PATH=…  BUYER_SIGNER_PEM_PATH=…  SELLER_SIGNER_PEM_PATH=…
AGENTGATE_ADMIN_TOKEN=<strong unique token>   # loadConfig() refuses the default in live mode
```

`loadConfig()` hard-fails on live mode without an API key or with the default admin token.

## 5. `NOT_DEPLOYED` call paths (all gated, checked before any IO)

`LiveCasperClient` (`packages/chain/src/live.ts`) throws
`AgentGateError('NOT_DEPLOYED', 'requires REGISTRY_CONTRACT_PACKAGE_HASH — run contracts deploy first', 503)`
from every contract-dependent method while `REGISTRY_CONTRACT_PACKAGE_HASH` is unset:

| # | Method | Needs the contract for |
|---|---|---|
| 1 | `getService(id)` | registry dictionary read (`services`) |
| 2 | `listServices()` | `services_count` + per-id reads |
| 3 | `getScore(id)` | `scores` dictionary read |
| 4 | `listAttestations(serviceId)` | deploys against the package |
| 5 | `listRecentActivity()` | deploys/transfers against the package |
| 6 | `registerService(...)` | `register_service` ContractCallBuilder |
| 7 | `recordAttestation(...)` | `record_attestation` ContractCallBuilder |
| 8 | `setActive(...)` | `set_active` ContractCallBuilder |

Native paths (`transfer`, `verifyTransfer`, `getBalance`) work without the contract.

## 6. ⚠️ verify-against-deployed-contract checklist

Every assumption that can only be confirmed on-chain is marked
`// ⚠️ verify against deployed contract` in `packages/chain/src/live.ts`. After the first
deploy, walk this list top to bottom:

- [ ] **Gas constants** (`GAS_*`, live.ts top) — measure real costs, update.
- [ ] **Odra state layout** — `STATE_INDEX` is **1-based** (odra-macros emits `idx as u8 + 1`):
      services_count=1, services=2, scores=3 (then seen_payments=4, attestations=5), and the
      `"state"` dictionary name matches the deployed Odra 2.x layout. *(A 0-based index here makes
      `scores[id]` collide byte-for-byte with `services[id]` — the bug fixed in `live.ts`.)*
- [ ] **Dictionary item key scheme** — blake2b256(**4-byte big-endian u32** field index ++ LE key
      bytes) matches Odra's key derivation for `Var`/`Mapping` (see `odraDictionaryItemKey`).
- [ ] **Stored-value `List<U8>` prefix** — Odra stores each value as `CLValue::from_t(Vec<u8>)` →
      CLType `List<U8>`; the SDK's `.bytes()` prepends a **4-byte little-endian length** that
      `stripListU8Prefix` must remove before `ByteReader` decodes the struct.
- [ ] **Service struct byte layout** — the `ByteReader` field order/types decode the
      deployed `Service` (name, description, gateway_base_url, price, payment_target,
      owner, attestor, active, created_at) incl. Address tag values.
- [ ] **Service ids are 1-based** and `registerService` may assume `id == services_count`
      after insert.
- [ ] **Entrypoint arg names/encodings** — `register_service` / `record_attestation` /
      `set_active` / `set_attestor` args (CLString/CLU512/CLKey/CLU64/CLBool) match the contract
      schema (`cargo odra schema` is the source of truth — the regenerated schema now includes
      `set_attestor` and the `ServiceAttestorChanged` event).
- [ ] **CSPR.cloud payload field names** — `/transfers?deploy_hash=`, `/deploys`,
      `/accounts/:id`, contract-package resolution, pending-deploy detection
      (`block_hash`/`error_message` fields).
- [ ] **End-to-end smoke**: `agentgate wrap` a real upstream, pay 0.5 CSPR from the buyer
      key, confirm 200 + attestation on https://testnet.cspr.live, score (1,1).

## 7. Rollout order

1. Deploy contract → set `REGISTRY_CONTRACT_PACKAGE_HASH`.
2. Run the §6 checklist (read paths first: `agentgate list`, dashboard).
3. Start middleware + dashboard in live mode.
4. `agentgate wrap` the oracle (or any API) with a non-default admin token.
5. Run the buyer agent with a small budget (`--budget 1`).
