# AgentGate — Live-mode deploy runbook (documented, NOT executed)

> SPEC §13: live-mode code paths compile and are unit-tested without a node; every spot
> that needs the deployed contract throws `AgentGateError('NOT_DEPLOYED', …, 503)` and is
> listed here. Deploying is **out of scope for the current milestone** — this runbook is
> the recipe for when it happens.

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
cargo odra test            # 17 OdraVM tests, must be green
cargo odra build           # writes wasm/AgentGateRegistry.wasm (~288 KiB post wasm-opt)
```

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
- [ ] **Odra state layout** — `STATE_INDEX` (services_count=0, services=1, scores=2) and
      the `"state"` dictionary name match the deployed Odra 2.x layout.
- [ ] **Dictionary item key scheme** — blake2b256(index byte ++ LE key bytes) matches
      Odra's key derivation for `Var`/`Mapping`.
- [ ] **Service struct byte layout** — the `ByteReader` field order/types decode the
      deployed `Service` (name, description, gateway_base_url, price, payment_target,
      owner, attestor, active, created_at) incl. Address tag values.
- [ ] **Service ids are 1-based** and `registerService` may assume `id == services_count`
      after insert.
- [ ] **Entrypoint arg names/encodings** — `register_service` / `record_attestation` /
      `set_active` args (CLString/CLU512/CLKey/CLU64/CLBool) match the contract schema
      (`cargo odra schema` output is the source of truth).
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
