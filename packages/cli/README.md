# @neargate/cli

Wrap any HTTP API into a **paid x402 service on Casper** — HTTP 402 micropayments in native CSPR, with on-chain discovery and reputation. One command turns your endpoint into a machine-payable service that AI agents can discover, pay, and rate autonomously.

## Read the live catalog — zero setup

The read commands run against Casper Testnet with **no configuration and no keys**:

```bash
npx @neargate/cli list        # on-chain service catalog with scores + trust tiers
npx @neargate/cli status 1    # one service: record, price, trust, attestations
```

## Wrap your API (writes)

`wrap` registers your service **on Casper Testnet** and drops a 402 paywall in front of it — one line, the only thing besides the args is your funded wallet key:

```bash
npx @neargate/cli wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --pem ./key.pem
```

It signs the on-chain registration with `--pem`, then maps your upstream on the gateway by **signing an ownership challenge with the same key** — no shared admin token. `--gateway` defaults to the hosted gateway; pass it to target a local or self-hosted one. (`--pem` is irreducible: registering on-chain is a signed, gas-paying transaction.)

## Buy a call (writes)

`buy` runs the whole x402 exchange for you: fetch the `402` invoice, pay it with a **native CSPR transfer carrying the invoice nonce as `transfer_id`**, retry with the `X-PAYMENT` proof, and print the result — response body on **stdout** (pipeable), payment receipt on **stderr**:

```bash
npx @neargate/cli buy 1 --pem ./buyer.pem --max 5
```

`--max` is a budget cap: any invoice priced above it is refused (`PRICE_EXCEEDED`) before a single mote moves. Unknown or paused services fail fast before any payment.

## Flags & environment

Every config value can be given as a flag **or** an env var; precedence is **flag > env var > built-in default**.

| Flag | Env var | Needed for |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all (CLI defaults to `live`) |
| `--node-url <url>` | `CASPER_NODE_URL` | all (defaults to Testnet) |
| `--registry <hash>` | `REGISTRY_CONTRACT_PACKAGE_HASH` | all (defaults to the deployed registry) |
| `--gateway <url>` | — | wrap (defaults to the hosted gateway in live) · buy (defaults to the service's on-chain endpoint) |
| `--pem <path>` | `SELLER_SIGNER_PEM_PATH` (wrap/pause/resume) · `BUYER_SIGNER_PEM_PATH` (buy) | live writes — your wallet key |
| `--max <cspr>` | — | buy: refuse invoices priced above this many CSPR |
| `--api-key <key>` | `CSPR_CLOUD_API_KEY` | `status` attestation history only |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | mock / self-hosted-admin mapping only |

> Live `wrap` uses owner-signature auth, so no admin token is needed. `--pem` is a **path**, not a secret — safe in shell history. `--api-key` / `--admin-token` **are** secrets (visible in history and `ps`); prefer their env vars.

On an invalid value the CLI fails fast with a clear one-line message (e.g. `error: SIGNER_MISSING: live mode needs a seller key — pass --pem <path> or set SELLER_SIGNER_PEM_PATH`) — never a stack trace.

## Commands

- `list` — list on-chain services (zero-config)
- `status <id>` — service detail + reputation (zero-config; `--api-key` adds attestation history)
- `wrap <url> --price <CSPR> --name <name>` — register + put a 402 paywall in front of an API
- `buy <id> --pem <key>` — pay a service's 402 invoice and print the response (`--max` caps the price)
- `pause <id>` / `resume <id>` — toggle a service you own
- `demo-accounts` — mint faucet-funded buyer/seller accounts on the mock devnet (mock mode only)

## Notes

- Node ≥ 22 required.
- Source: https://example.invalid/AgentGate
