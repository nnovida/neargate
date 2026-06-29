# @neargate/cli

Wrap any HTTP API into a **paid x402 service on Casper** — HTTP 402 micropayments in native CSPR, with on-chain discovery and reputation. One command turns your endpoint into a machine-payable service that AI agents can discover, pay, and rate autonomously.

```bash
npx @neargate/cli wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"
```

## Requirements

`wrap` registers your service **on Casper Testnet**, so it needs chain config and one funded signer key. Set these in your environment (or a `.env` file in the working directory):

| Variable | What it is |
|---|---|
| `AGENTGATE_MODE` | `live` (Casper Testnet) |
| `CASPER_NODE_URL` | a Casper Testnet node RPC, e.g. `https://node.testnet.casper.network/rpc` |
| `CSPR_CLOUD_API_KEY` | a CSPR.cloud API key (https://console.cspr.cloud) |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | the deployed AgentGateRegistry package hash |
| `SELLER_SIGNER_PEM_PATH` | path to a funded secp256k1/ed25519 PEM (≥ a few CSPR for gas) |

Without config the CLI fails fast with a clear, actionable one-line message — e.g. `error: CONFIG_INVALID: live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)` — never a stack trace.

## Commands

- `wrap <url> --price <CSPR> --name <name>` — register + put a 402 paywall in front of an API
- `list` — list on-chain services
- `status <id>` — service detail + reputation
- `pause <id>` / `resume <id>` — toggle a service you own

## Notes

- Node ≥ 22 required.
- Source: https://example.invalid/AgentGate
