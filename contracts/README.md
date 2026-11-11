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

Needs `cargo-near` (0.22) and the pinned toolchain. `rustup` installs the toolchain from
`rust-toolchain.toml` on first use; `cargo-near` is a separate tool:

```bash
cargo install --locked cargo-near
# or the prebuilt installer:
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
```

## Test

```bash
cd contracts
cargo test -p neargate-registry          # unit tests (no network)

cd registry && cargo near build non-reproducible-wasm && cd ..   # build the wasm FIRST
cargo test -p integration-tests -- --nocapture   # sandbox tests, read the wasm built above
```

The integration tests read the pre-built wasm and fail with a message naming the build command when it is
missing. A plain `cargo test` in `contracts/` runs both suites, so build the wasm before it.

The first sandbox run downloads the `near-sandbox` binary; set `NEAR_SANDBOX_BIN_PATH` to reuse one you
already have, and `NEARGATE_REGISTRY_WASM` to test a wasm at another path.

## Deploy (testnet)

Fund the contract account with at least 3 NEAR. Once the activity ring is full it locks about 2.3 NEAR for
storage: the code (about 181 KB, 1.81 NEAR) plus up to 0.47 NEAR for the ring (see Storage accounting).

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
# register a service: 0.12 NEAR deposit, price 0.01 NEAR
near contract call-function as-transaction neargate-registry.testnet register_service json-args '{
  "name": "Weather API", "description": "Hourly forecasts",
  "gateway_base_url": "https://gateway.example.com",
  "accepts": [{"asset": "near", "amount": "10000000000000000000000", "decimals": 24, "symbol": "NEAR"}],
  "payment_target": "seller.testnet", "attestor": "gateway.testnet"
}' prepaid-gas '30 Tgas' attached-deposit '0.12 NEAR' sign-as owner.testnet network-config testnet sign-with-keychain send

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
| `register_service(name, description, gateway_base_url, accepts, payment_target, attestor) -> u64` | payable | Deposit at least 0.12 NEAR, kept; the excess is refunded. 1 to 4 `accepts`; the `"near"` option (at most one) is at least 10^18 yocto, any other asset is priced in its own base units and only needs an amount above zero. Ids are 1-based. |
| `pay(service_id, nonce)` | payable | Attach price + 0.002 NEAR. Nonce: 1 to 20 decimal digits, single-use. Forwards the price, refunds the rest. |
| `record_attestation(service_id, nonce, payment_tx_hash, success)` | change | Attestor or owner. Once per payment; not for self-paid payments. Hash at most 64 bytes. |
| `set_active(service_id, active)` / `set_attestor(service_id, attestor)` | change | Owner only. |
| `get_service`, `list_services(from_index, limit)`, `services_count`, `get_score`, `get_attestations`, `get_payment(nonce)`, `get_recent_activity(limit)` | view | `list_services` clamps `limit` to 50 and starts at id `from_index` (1-based). Activity is newest first, clamped to 200. |

JSON views use snake_case and `U128` amounts as decimal strings (see `registry/src/types.rs`).

Constants: `MIN_PRICE_YOCTO` 10^18 (`"near"` option only), `PAYMENT_STORAGE_FEE_YOCTO` 2·10^21 (0.002 NEAR),
`REGISTRATION_DEPOSIT_YOCTO` 1.2·10^23 (0.12 NEAR), at most 100 attestations per service, a 200-entry
activity ring, `name` 64 / `description` 280 / `gateway_base_url` 200 / `accepts` 4 / `accepts[].asset` 64 /
`accepts[].symbol` 64 / `payment_tx_hash` 64. **Every length limit counts UTF-8 bytes, not characters.**
`gateway_base_url` is a base URL: readers build `{gateway_base_url}/svc/{id}` from it.

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

NEAR charges 10^19 yocto per stored byte, plus 40 bytes of overhead per record. The registry pays for
storage from its own balance, so every byte a caller can make it store must be prepaid by that caller or
bounded globally. The contract measures its own storage use (`env::storage_usage()` before and after) and
panics `ERR_STORAGE_EXCEEDED` when a call goes over its budget.

| What | Paid by | How |
|---|---|---|
| Service record | the owner | `register_service` deposit, 0.12 NEAR (12,000 bytes) |
| A service's score and attestation list | the owner | the same deposit: `ATTESTATION_RESERVE_YOCTO`, 10,218 bytes = 1.0218·10^23 yocto |
| A payment record (kept forever, that is the nonce replay guard) | the payer | `pay` fee, 0.002 NEAR (200 bytes) |
| The 200-entry activity ring | nobody per call | bounded globally, see below |

**Registration.** `register_service` requires the measured storage of the registration plus
`ATTESTATION_RESERVE_YOCTO` to fit in the 0.12 NEAR deposit. `record_attestation` is not payable, so a
service's attestation storage has to be prepaid. The reserve is the largest thing a service can ever store
there: the score record (40 overhead + 9 key + 16 value = 65 bytes) plus the list at its cap of 100
attestations, each at most 101 bytes (20-digit nonce 4+20, 64-byte hash 4+64, success 1, timestamp 8), so
40 + 9 + 4 + 100 x 101 = 10,153 bytes. A service registered with every field at its maximum (4 options,
64-byte accounts, 280-byte description) uses 1,466 bytes including its ring entry, so 11,684 of the 12,000
bytes are used in the worst case.

**Pay.** A `pay` writes the payment record and one ring entry. The ring entry for a payment holds only the
nonce, and `new()` pre-writes all 200 ring slots with a one-byte placeholder, so a `pay` replaces a slot and
never creates a record. The worst case, a 64-byte payer account and a 20-digit nonce, costs 199 of the 200
bytes; typical calls cost about 140.

**Activity ring.** At most 200 records of at most 235 bytes each (40 overhead + 9 key + 186 for the largest
entry, an attestation with a 64-byte hash and a 64-byte account): 47,000 bytes = 0.47 NEAR. The placeholders
that `new()` writes account for 10,000 of those bytes (0.10 NEAR, paid at deploy); the other 37,000 bytes
(0.37 NEAR) fill up as the registry is used. This cost is never charged per call. With the code (about
181 KB, 1.81 NEAR) the registry account locks about 2.3 NEAR once the ring is full, so fund it with at
least 3 NEAR.

A unit test (`adversarial_services_are_self_funded`) runs a hostile service end to end: every field at its
byte maximum, 100 pays from a 64-byte payer with 20-digit nonces, 100 attestations with 64-byte hashes. The
first costs the registry 49,992 bytes (0.4999 NEAR), within the 0.12 deposit + 100 fees + 0.37 ring growth
it is allowed; the second costs 29,092 bytes (0.2909 NEAR), within deposit + 100 fees. Once the ring is
full, an additional hostile service costs the registry nothing.

`payment_target` must be an existing account: a transfer to a missing account cannot be reversed by the
registry, which has already recorded the payment.
