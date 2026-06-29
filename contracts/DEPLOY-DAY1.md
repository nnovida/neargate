# Day-1 deploy kit — AgentGateRegistry + SpendGuard → Casper Testnet

Generated 18 Jun 2026. Day-1 gate already validated on this machine:
`cargo-odra 0.1.7` + `nightly-2026-01-01` + `wasm32` ✓ · registry 20/20 tests ✓ ·
livenet deploy bin compiles ✓ · **SpendGuard 25/25 tests ✓** · `SpendGuard.wasm` built ✓.
> Build needs `wasm-opt` (binaryen ≥ 121) + `wasm-strip` on `PATH` — see `docs/DEPLOY.md` §2.

Everything below is the ONE remaining step that needs a funded key (your part).

## 1. One-time: a funded Testnet key

You need an ed25519 secret key with ~600 CSPR (≈300 per contract install; refunded if unspent).

**Option A — casper-client (canonical):**
```bash
cargo install casper-client --locked          # one-time, ~few min
casper-client keygen ./contracts/.keys         # writes secret_key.pem + public_key_hex
cat ./contracts/.keys/public_key_hex           # copy this
```
**Option B — CasperWallet / cspr.live:** create a Testnet account, export `secret_key.pem`, copy the public key hex.

Then **fund** the public key hex at the faucet (twice if you want headroom for both installs):
→ https://testnet.cspr.live/tools/faucet

> `./contracts/.keys/` is gitignored. NEVER commit a secret key.

## 2. Set the Odra livenet env (per shell, before deploy)

```bash
export ODRA_CASPER_LIVENET_NODE_ADDRESS="https://node.testnet.casper.network/rpc"
export ODRA_CASPER_LIVENET_CHAIN_NAME="casper-test"
export ODRA_CASPER_LIVENET_SECRET_KEY_PATH="$(pwd)/contracts/.keys/secret_key.pem"
```

## 3. Deploy (run from the repo root)

```bash
# Registry (the never-deployed foundation)
( cd contracts/agentgate-registry \
  && cargo run --bin agentgate_registry_deploy --features livenet --release -- deploy )

# SpendGuard (the new spend-firewall)
( cd contracts/spend-guard \
  && cargo run --bin spend_guard_deploy --features livenet --release -- deploy )
```

Each writes the deployed **contract package hash** to
`resources/deployed_contracts.toml` (and prints it). Record both:

```bash
REGISTRY_CONTRACT_PACKAGE_HASH=<from agentgate-registry deploy>
SPENDGUARD_CONTRACT_PACKAGE_HASH=<from spend-guard deploy>   # see note below — not yet consumed by any code
```

> Note: `SPENDGUARD_CONTRACT_PACKAGE_HASH` is **not yet consumed by any code** —
> it is reserved for the planned SpendGuard wiring (see the roadmap in §5).
> `loadConfig()` does not read it and it is intentionally absent from
> `.env.example`. Record it here for later, but it is NOT a required live-mode
> setting today.

Confirm both on https://testnet.cspr.live (search the package hash → see the install deploy).

## 4. Wire live mode (app `.env`)

```bash
AGENTGATE_MODE=live
CASPER_NODE_URL=https://node.testnet.casper.network/rpc
CSPR_CLOUD_API_URL=https://api.testnet.cspr.cloud
CSPR_CLOUD_API_KEY=<from https://console.cspr.cloud>
CASPER_NETWORK=casper-test
REGISTRY_CONTRACT_PACKAGE_HASH=<step 3>
AGENTGATE_ADMIN_TOKEN=<strong unique token>   # loadConfig() refuses the default in live mode
```

> `SPENDGUARD_CONTRACT_PACKAGE_HASH` is **deliberately omitted** from the live
> `.env` above: no code reads it yet (it is reserved for the planned SpendGuard
> wiring — see §5). Adding it now is harmless but has no effect; do not treat it
> as a required live-mode setting.

## 5. Next (post-deploy, the build phase)

1. Walk the `contracts/README.md` §6 "verify against deployed contract" checklist for the registry
   (gas constants, Odra state layout, dictionary key scheme) — then repeat it for SpendGuard.
2. Wire `packages/chain/src/live.ts` with a `SpendGuardClient` (openPolicy/deposit/debit/getPolicy/getRemaining),
   mirroring the existing registry client; add the `STATE_INDEX`/byte-layout reads for `Policy`.
3. Add the policy-proxy hook in `packages/middleware/src/app.ts` `/svc/:id` (call `debit` before `proxyToUpstream`).
4. Add the Sentinel panel to the dashboard (budget/remaining, rate window, on-chain BLOCKED feed with the revert tx hash).
5. Demo: honest agent pays (DebitApproved on-chain) → attacker/over-budget agent gets **atomically reverted** on-chain.

> Cut-to-ship (if behind): drop the rate-window path; OverBudget + PerCallExceeded + UntrustedService
> already prove the atomic-revert thesis on stage.
