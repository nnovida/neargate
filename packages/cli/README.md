# @neargate/cli

Wrap any HTTP API into a **paid x402 service on Casper** — HTTP 402 micropayments in native CSPR, with on-chain discovery and reputation. One command turns your endpoint into a machine-payable service that AI agents can discover, pay, and rate autonomously.

## Read the live catalog — zero setup

The read commands run against Casper Testnet with **no configuration and no keys**:

```bash
npx @neargate/cli list        # on-chain service catalog with scores + trust tiers
npx @neargate/cli status 1    # one service: record, price, trust, attestations
```

## Wrap your API (writes)

`wrap` registers your service **on Casper Testnet** and drops a 402 paywall in front of it, so it needs a funded seller key and a running gateway. Everything goes on one line via flags (or the matching env vars):

```bash
npx @neargate/cli wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" \
  --pem ./seller.pem --gateway https://your-gateway --admin-token "$AGENTGATE_ADMIN_TOKEN"
```

## Flags & environment

Every config value can be given as a flag **or** an env var; precedence is **flag > env var > built-in default**.

| Flag | Env var | Needed for |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all (CLI defaults to `live`) |
| `--node-url <url>` | `CASPER_NODE_URL` | all (defaults to Testnet) |
| `--registry <hash>` | `REGISTRY_CONTRACT_PACKAGE_HASH` | all (defaults to the deployed registry) |
| `--pem <path>` | `SELLER_SIGNER_PEM_PATH` | wrap / pause / resume (live) |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | wrap (live) |
| `--api-key <key>` | `CSPR_CLOUD_API_KEY` | `status` attestation history only |

> ⚠️ Secret flags (`--api-key`, `--admin-token`) are visible in your shell history and `ps`. Prefer the env vars for secrets; the flags exist for a one-line invocation.

On an invalid value the CLI fails fast with a clear one-line message (e.g. `error: CONFIG_INVALID: live mode requires CSPR_CLOUD_API_KEY`) — never a stack trace.

## Commands

- `list` — list on-chain services (zero-config)
- `status <id>` — service detail + reputation (zero-config; `--api-key` adds attestation history)
- `wrap <url> --price <CSPR> --name <name>` — register + put a 402 paywall in front of an API
- `pause <id>` / `resume <id>` — toggle a service you own

## Notes

- Node ≥ 22 required.
- Source: https://example.invalid/AgentGate
