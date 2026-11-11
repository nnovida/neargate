# contracts/ — NearGate registry

The on-chain layer of NearGate (the NEAR port of AgentGate): one NEAR smart contract,
**`neargate-registry`**, written in Rust on `near-sdk` 5.30.1.

Buyers pay **through** the registry. `pay(service_id, nonce)` forwards exactly the service price to the
seller's `payment_target`, keeps a small storage fee, refunds the excess and stores a payment record.
`record_attestation` is only accepted for a payment the contract itself received, that is not yet
attested and was not paid by the service owner or the payment target. A service's score therefore
counts only real transfers between distinct parties.

The contract has no owner and no admin. Per service there are two roles: the **owner** (switches the
service on or off, rotates the attestor) and the **attestor** (records outcomes; the owner may too).

```
contracts/
├── Cargo.toml              workspace (registry, integration-tests), release profile
├── rust-toolchain.toml     rustc 1.95.0 + wasm32-unknown-unknown
├── registry/               the contract (crate `neargate-registry`)
│   └── src/{lib.rs,types.rs,tests.rs}
└── integration-tests/      near-workspaces sandbox tests (tests/flow.rs)
```

## Build

```bash
cd contracts/registry
cargo near build non-reproducible-wasm
# -> contracts/target/near/neargate_registry/neargate_registry.wasm  (+ _abi.json)
```

Needs `cargo-near` (0.22) and the pinned toolchain; `rustup` installs both from `rust-toolchain.toml`.

## Test

```bash
cd contracts
cargo test -p neargate-registry          # unit tests (no network)

cd registry && cargo near build non-reproducible-wasm && cd ..
cargo test -p integration-tests -- --nocapture   # sandbox tests, need the wasm from the step above
```

The first sandbox run downloads the `near-sandbox` binary; set `NEAR_SANDBOX_BIN_PATH` to reuse one you
already have, and `NEARGATE_REGISTRY_WASM` to test a wasm at another path.

## Deploy (testnet)

The contract account needs about 3 NEAR: the code (about 180 KB) plus the 200 activity-ring placeholder
records that `new()` writes.

```bash
near account create-account sponsor-by-faucet-service neargate-registry.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create     # or any funded testnet account

near contract deploy neargate-registry.testnet \
  use-file contracts/target/near/neargate_registry/neargate_registry.wasm \
  with-init-call new json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

`new()` takes no arguments and sets no admin. It burns about 17 Tgas.

## Use

```bash
# register a service: 0.1 NEAR deposit, price 0.01 NEAR
near contract call-function as-transaction neargate-registry.testnet register_service json-args '{
  "name": "Weather API", "description": "Hourly forecasts",
  "gateway_base_url": "https://gateway.example/svc/1",
  "accepts": [{"asset": "near", "amount": "10000000000000000000000", "decimals": 24, "symbol": "NEAR"}],
  "payment_target": "seller.testnet", "attestor": "gateway.testnet"
}' prepaid-gas '30 Tgas' attached-deposit '0.1 NEAR' sign-as owner.testnet network-config testnet sign-with-keychain send

# pay for one call: price 0.01 + fee 0.002 NEAR (anything above is refunded)
near contract call-function as-transaction neargate-registry.testnet pay json-args '{"service_id": 1, "nonce": "424242"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.012 NEAR' sign-as buyer.testnet network-config testnet sign-with-keychain send

# read
near contract call-function as-read-only neargate-registry.testnet get_payment json-args '{"nonce": "424242"}' network-config testnet now
```

## ABI

| Method | Kind | Notes |
|---|---|---|
| `new()` | init | No arguments, no admin. |
| `register_service(name, description, gateway_base_url, accepts, payment_target, attestor) -> u64` | payable | Deposit at least 0.1 NEAR, kept; the excess is refunded. 1 to 4 `accepts`, each at least 10^18 yocto, at most one `"near"`. Ids are 1-based. |
| `pay(service_id, nonce)` | payable | Attach price + 0.002 NEAR. Nonce: 1 to 20 decimal digits, single-use. Forwards the price, refunds the rest. |
| `record_attestation(service_id, nonce, payment_tx_hash, success)` | change | Attestor or owner. Once per payment; not for self-paid payments. Hash at most 64 chars. |
| `set_active(service_id, active)` / `set_attestor(service_id, attestor)` | change | Owner only. |
| `get_service`, `list_services(from_index, limit)`, `services_count`, `get_score`, `get_attestations`, `get_payment(nonce)`, `get_recent_activity(limit)` | view | `list_services` clamps `limit` to 50 and starts at id `from_index` (1-based). Activity is newest first, clamped to 200. |

JSON views use snake_case and `U128` amounts as decimal strings (see `registry/src/types.rs`).

Constants: `MIN_PRICE_YOCTO` 10^18, `PAYMENT_STORAGE_FEE_YOCTO` 2·10^21 (0.002 NEAR),
`REGISTRATION_DEPOSIT_YOCTO` 10^23 (0.1 NEAR), at most 100 attestations per service, a 200-entry activity
ring, `name` 64 / `description` 280 / `gateway_base_url` 200 / `accepts` 4 / `payment_tx_hash` 64.

### Errors

Every panic message starts with a stable code followed by `:`, so clients can map errors by prefix.

`ERR_NOT_AUTHORIZED`, `ERR_SERVICE_NOT_FOUND`, `ERR_SERVICE_INACTIVE`, `ERR_EMPTY_NAME`,
`ERR_FIELD_TOO_LONG`, `ERR_INVALID_PRICE`, `ERR_DEPOSIT_TOO_LOW`, `ERR_STORAGE_EXCEEDED`,
`ERR_INVALID_NONCE`, `ERR_NONCE_USED`, `ERR_NO_NATIVE_PRICE`, `ERR_PAYMENT_NOT_FOUND`,
`ERR_PAYMENT_WRONG_SERVICE`, `ERR_ALREADY_ATTESTED`, `ERR_SELF_PAYMENT`.

### Events

NEP-297 `EVENT_JSON` logs with `standard: "neargate"`, `version: "1.0.0"` and the events
`service_registered`, `payment`, `attestation`, `service_status`, `attestor_changed`.

## Storage accounting

The contract measures its own storage use (`env::storage_usage()` before and after) and panics
`ERR_STORAGE_EXCEEDED` if one `register_service` costs more than 0.1 NEAR or one `pay` costs more than
0.002 NEAR (200 bytes). A `pay` writes a payment record and one activity-ring entry. The ring entry for
a payment holds only the nonce, and `new()` pre-writes all 200 ring slots with a one-byte placeholder, so
a `pay` replaces a slot and never grows the ring. The worst case, a 64-character payer account and a
20-digit nonce, costs 199 bytes; typical calls cost about 140. The unspent part of each fee stays in the
contract and funds the storage of attestations.

`payment_target` must be an existing account: a transfer to a missing account cannot be reversed by the
registry, which has already recorded the payment.
