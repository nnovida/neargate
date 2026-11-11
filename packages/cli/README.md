# @neargate/cli — the `neargate` CLI

Wrap any HTTP API into a **paid x402 service on NEAR**: HTTP 402 micropayments in native NEAR, with on-chain discovery and a payment-backed reputation score kept by the `neargate-registry` contract. One command turns your endpoint into a machine-payable service that AI agents can discover, pay and rate on their own.

The package installs one binary, `neargate`. From a clone of the repository: `npm install`, then `npm run neargate -- <command>`.

## How a paid call works

1. The gateway answers an unpaid request with **HTTP 402** and an x402 invoice: the price, a fixed **0.002 NEAR storage fee** (the registry stores a record of every payment), the total to attach, a one-time nonce and the registry contract id.
2. The buyer calls the registry's `pay` method with that nonce, attaching price + storage fee. The registry forwards the price to the seller's payment target.
3. The buyer retries with the `pay` transaction as its `X-PAYMENT` proof. The gateway checks the payment on chain, serves the call and attests the outcome on chain; the score counts those attestations. A call the owner pays for itself is served but never attested.

## Read the catalog

```bash
neargate list            # id  name  price(NEAR)  calls  tier  active
neargate status 1        # one service: record, price, trust tier, recent attestations
```

The read commands need no key.

## Wrap your API (seller)

```bash
neargate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" \
  --account seller.testnet --key-file ~/.near-credentials/testnet/seller.testnet.json
```

Before anything goes on chain, `wrap` resolves your key and checks that the payment target exists (it defaults to `--account`; a missing account would strand every payment). It then registers the service (registering attaches a 0.12 NEAR deposit) and maps your upstream on the gateway by **signing an ownership challenge with the same key** — no shared admin token. The upstream URL is only ever sent to the gateway. In mock mode the mapping goes through the gateway admin token instead.

## Buy a call (buyer)

```bash
neargate buy 2 --account buyer.testnet --max 1
```

`buy` runs the whole exchange: fetch the 402 invoice, pay it with a registry `pay` call (price + 0.002 NEAR storage attached), retry with the transaction as proof, and print the result — the response body on **stdout** (pipeable), the receipt on **stderr** (what was paid, the payment tx, an explorer link).

`--max` caps the **total** a call attaches, price plus storage fee: above it the CLI refuses with `BUDGET_EXCEEDED` before anything is paid. Unknown or paused services also fail before any payment.

## Use from any MCP agent

```bash
neargate mcp --account buyer.testnet
```

`mcp` serves NearGate as a Model Context Protocol **stdio server**. Tools: `neargate_list_services`, `neargate_get_service`, `neargate_get_invoice` (read-only, no key), `neargate_escrow_balance` (read-only: the prepaid escrow left, for the buyer account or any `account`) and `neargate_buy` (pays the 402 invoice in NEAR from the buyer key, capped by `maxNear` on the total attached; with `fromEscrow: true` it pays out of the prepaid escrow instead, which is what a key restricted by `agent-key add` can do). The buyer key is resolved only when `neargate_buy` runs (and by `neargate_escrow_balance` without an `account`), so the catalog tools work without one. Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "neargate": { "command": "node", "args": ["/path/to/repo/packages/cli/dist/bin.js", "mcp", "--account", "buyer.testnet"] } } }
```

(`npm run build -w @neargate/cli` produces `packages/cli/dist/bin.js`.)

## Flags & environment

Precedence is **flag > env var > built-in default**.

| Flag | Env var | Used by |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all (the CLI defaults to `live`) |
| `--rpc <url>` | `NEAR_RPC_URL` | live (default: the `NEAR_NETWORK` RPC) |
| `--registry <contract id>` | `REGISTRY_CONTRACT_ID` | live: the registry contract account |
| — | `NEAR_NETWORK` | `testnet` (default) or `mainnet`: default RPC and explorer, and the `~/.near-credentials/<network>` folder |
| `--account <id>` | `SELLER_ACCOUNT_ID` (wrap/pause/resume) · `BUYER_ACCOUNT_ID` (buy/mcp) | live writes: the account you act as (mock: `MOCK_SELLER_ACCOUNT` / `MOCK_BUYER_ACCOUNT`) |
| `--key-file <path>` | `SELLER_KEY_PATH` · `BUYER_KEY_PATH` | live writes: that account's near-cli credentials JSON |
| — | `SELLER_PRIVATE_KEY` · `BUYER_PRIVATE_KEY` | live writes: an `ed25519:…` secret key instead of a file |
| `--price <near>` | — | wrap: price per call in NEAR (at least 0.000001; buyers also attach the 0.002 NEAR storage fee) |
| `--max <near>` | — | buy: cap on the total a call attaches (price + storage fee) |
| `--gateway <url>` | — | wrap (default: the hosted gateway in live, `http://localhost:4021` in mock) · buy (default: the service's on-chain endpoint) |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | mock `wrap` only: the gateway admin mapping |

**Key resolution** for live writes, first match wins:

1. `SELLER_PRIVATE_KEY` / `BUYER_PRIVATE_KEY` (`ed25519:…`). It takes precedence over `--key-file`, and the CLI notes it when both are set.
2. `--key-file <path>`, else `SELLER_KEY_PATH` / `BUYER_KEY_PATH`: a near-cli credentials JSON (`account_id`, `public_key`, `private_key`) whose `account_id` must match the account.
3. `~/.near-credentials/<NEAR_NETWORK>/<account>.json`, where `near login` writes it.

The CLI warns when a key file is readable by group or others (`chmod 600` it) and never prints key material. `--key-file` is a path, not a secret; `--admin-token` **is** a secret (visible in shell history and `ps`), so prefer its env var.

On an invalid value the CLI fails fast with a one-line message — e.g. `error: SIGNER_MISSING: live mode needs a seller account — pass --account <id> or set SELLER_ACCOUNT_ID (…)` — never a stack trace.

## Commands

- `list` — the on-chain catalog with scores and trust tiers
- `status <id>` — one service: record, price, trust tier, recent attestations
- `wrap <url> --price <near> --name <name>` — register a service and put a 402 paywall in front of an API (name up to 64 bytes, description up to 280 bytes)
- `buy <id>` — pay a service's 402 invoice and print the response (`--max` caps the total; `--from-escrow` pays out of your prepaid escrow with `pay_from_escrow`, attaching nothing)
- `escrow deposit <near>` / `escrow withdraw <near>` / `escrow balance [account]` — fund, drain and read your prepaid registry escrow (the first deposit keeps 0.002 NEAR as storage; withdrawing needs the full-access key)
- `agent-key add --allowance <near>` — live only: add a function-call key restricted to `pay_from_escrow` on the registry, so an AI agent can spend your escrow and nothing else. The secret goes to `~/.near-credentials/<network>/<account>.neargate-agent.json` (mode 0600, never overwritten); only the public key and the path are printed. The agent then runs `neargate buy <id> --from-escrow --account <account> --key-file <that path>`
- `mcp` — serve NearGate as an MCP stdio server (agent tools: list / inspect / invoice / buy, with `fromEscrow`, and `neargate_escrow_balance`)
- `pause <id>` / `resume <id>` — toggle a service you own
- `demo-accounts` — mint faucet-funded buyer/seller accounts on the mock devnet (mock mode only)

## Try it offline

`npm run demo` runs the whole loop on an in-process mock chain — register, 402 invoice, pay, serve, attest, score — with no network access and no keys. `npm run dev` keeps the same mock stack up for the CLI (`--mode mock`), the buyer agent and the dashboard.

## Notes

- Node ≥ 22.22.2 required.
- Source: https://example.invalid/AgentGate
