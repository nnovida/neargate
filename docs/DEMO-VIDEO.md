# Demo video script (about 2 minutes)

One take of the live testnet loop: the problem, a seller's API in the on-chain catalog, a 402, one `npm run neargate -- buy`, the dashboard's score ticking up, and the payment on nearblocks. It runs just under 2 minutes, which fits X's 140-second limit for accounts without Premium.

## Before recording

- The registry is deployed on testnet and seeded (`neargate-1112-registry.testnet`), and the gateway and the dashboard are hosted (`https://<gateway-host>`, `https://<dashboard-host>`), with the gateway running `RELAYER_ENABLED=1` for the gasless shot.
- A buyer account `<buyer>.testnet` with its key in `~/.near-credentials/testnet/`, about 1 NEAR, an escrow of 0.1 NEAR (`npm run neargate -- escrow deposit 0.1 --account <buyer>.testnet`) and an agent key (`npm run neargate -- agent-key add --allowance 0.25 --account <buyer>.testnet`).
- Run every command once off camera, so nothing waits on a first compile. Terminal: dark theme, large font, about 110 × 30.
- Browser tabs, in order: the dashboard's service page for #1 (note its score, for example 3/3), and nearblocks (it opens from the `buy` receipt's link).

## Script

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Title card over the dashboard home: "NearGate: pay-per-call APIs for AI agents on NEAR". | "AI agents can hold NEAR, but they can't get API keys or enter a card. NearGate lets an agent pay for any API, per call, by itself." |
| 0:12–0:27 | Terminal: `npm run neargate -- list`, the testnet catalog. | "A seller wraps an API with one command, and it lands in our registry contract on NEAR testnet. Anyone can read the catalog, with prices and trust scores, without a key." |
| 0:27–0:40 | Terminal: `curl -i https://<gateway-host>/svc/1`, the 402 and its JSON; highlight `payTo`, `maxAmountRequired` and `nonce`. | "Call the API without paying, and the gateway answers HTTP 402 with an x402 invoice: pay the registry the price plus a 0.002 NEAR storage fee, under a one-time nonce." |
| 0:40–1:05 | Terminal: `npm run neargate -- buy 1 --account <buyer>.testnet --max 0.05`. The data on stdout; the receipt on stderr: paid, the `pay` tx, the explorer link, `status: 200`. | "One command does the rest. It checks the invoice against the cap, calls pay on the registry, and retries with the transaction as proof. The gateway checks that payment on chain, burns the nonce and serves the data." |
| 1:05–1:20 | Browser: the service page refreshes and the score ticks up by one (3/3 to 4/4); the activity feed shows the payment and the attestation. | "Seconds later the gateway's attestation lands, and the score goes up. Every point is a real payment: the registry accepts an attestation only for a payment it holds, and never for the seller paying itself." |
| 1:20–1:35 | Browser: the `pay` transaction on nearblocks: exactly the price to the seller, the 0.002 NEAR fee kept by the registry, and the NEP-297 `payment` event in the logs. | "Here is that payment on nearblocks. The registry forwarded exactly the price to the seller, kept the fee, and logged a NEP-297 event." |
| 1:35–1:50 | Terminal: `npm run neargate -- buy 1 --gasless --account <buyer>.testnet --key-file ~/.near-credentials/testnet/<buyer>.testnet.neargate-agent.json --max 0.05`; highlight `relayed: gasless`. | "An agent gets a function-call key that can only call pay from escrow: it spends a prepaid escrow and nothing else. Here it pays gasless: the gateway relays its signed call and pays the gas." |
| 1:50–1:58 | End card: the repository URL, "Built at NEAR HACKATHON", @NEARProtocol #NEARHackathon. | "NearGate. Built at NEAR HACKATHON. The code, the contract and the tests are in the repo." |

## If testnet is not ready

The same beats run locally on the mock chain (README, "Do X → see Y"):

- Terminal 1: `RELAYER_ENABLED=1 GATEWAY_ACCOUNT_ID=gateway.mock npm run dev:seed`; paste the two `export MOCK_…` lines it prints into the recording terminal. Terminal 2: `npm run dev:dashboard` (http://localhost:3000).
- Every `npm run neargate -- …` command takes `--mode mock` in place of `--account <buyer>.testnet` and `--key-file …`: the buyer is the exported `MOCK_BUYER_ACCOUNT`, and mock signers need no key. The mock service costs 0.5 NEAR, so use `--max 1`. The 402 comes from `curl -i http://localhost:4021/svc/1`.
- `agent-key add` is live only. Before the gasless shot, fund the mock escrow with `npm run neargate -- escrow deposit 2 --mode mock`; then `npm run neargate -- buy 1 --gasless --max 1 --mode mock` shows `relayed: gasless — gateway.mock …`.
- The mock chain has no explorer: replace the nearblocks scene with the `npm run demo` transcript, and say on screen that it is the local mock chain.
