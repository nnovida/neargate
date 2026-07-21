<!-- trace: idea="One command wraps any HTTP API into an agent-payable x402 service — dual rails: native CSPR + Casper's official CEP-18/EIP-712 facilitator settling WCSPR, live on Testnet" | event="Casper Agentic Buildathon 2026 — Final Round" | deadline="2026-07-26 23:59 (TZ UNCONFIRMED — verify on DoraHacks portal)" | source=submission-packager -->

# AgentGate — Judge Q&A (FINALS) — the jury is Casper's own x402 team

The Final Round jury built `make-software/casper-x402` + the CSPR.cloud facilitator. They will
probe the facilitator integration at the protocol level. Answer with tx hashes, not adjectives.

---

## 🎙️ Proactive real-vs-mocked disclosure (say this BEFORE anyone asks)

> "Everything on the wow beat is live: the EIP-712 authorization is signed with the buyer's own
> secp256k1 key, verified and settled through **your** CSPR.cloud facilitator, and 0.1 WCSPR
> actually moves — settle tx `17ad3580…8979e4c`, gas sponsored by your feePayer. The autonomous
> agent runs a real Claude loop; if there's no API key it degrades to a deterministic MockLlm so
> anyone can run the whole loop offline. The upstream data APIs are real third-party feeds. Nothing
> in the payment path is mocked."

Disclosed mocks are forgiven; hidden ones are fatal — lead with this.

---

## The 10 hardest questions (2-sentence answers)

**1. "You say you run our facilitator — do you actually `/settle`, or just `/verify`?"**
We call `/verify` then `/settle` server-side: settle tx `17ad3580544c1f09a8bc67da513c284840bdf138f4e68af576194d7da8979e4c`, `error: None`, and your facilitator's feePayer sponsored ~6 CSPR of gas. The buyer only signs an EIP-712 authorization and never needs CSPR for gas.

**2. "Which x402 version, scheme, and header — and which libraries?"**
x402 **version 2**, scheme **`exact`**, header **`PAYMENT-SIGNATURE`**, network `casper:casper-test`. We use `@make-software/casper-x402@1.0.0` (`exact/client` + `exact/server`) and `@casper-ecosystem/casper-eip-712@1.2.1`, both pinned to `casper-js-sdk 5.0.12` — our exact SDK version.

**3. "The official WCSPR `deposit()` is a no-arg session wasm you don't have — how did you get WCSPR without self-wrapping?"**
We deliberately did **not** self-wrap — we acquired WCSPR through the `testnet.cspr.trade` DEX UI (CSPR↔WCSPR swap). The canonical WCSPR testnet package `3d80df21…847c1e` already implements the CEP-18 x402 `transfer_with_authorization` extension; we verified our EIP-712 domain against make-software's own `.env.testnet` (name "Wrapped CSPR", version "1").

**4. "Your registry has no on-chain asset field and `price` is CSPR-motes-shaped. How is a WCSPR payment bound to the attestation?"**
`record_attestation` takes an **opaque** `payment_deploy_hash` string and dedups via `seen_payments`, so we feed the `/settle` tx hash in unchanged — asset and amount are denominated at the invoice/gateway layer in the v2 `PaymentRequirements`. Adding an on-chain asset field is an optional upgrade; it isn't required for the attestation to correctly reference a real, unique settlement.

**5. "What stops replay — reusing a settle hash to farm reputation?"**
The contract dedups payment hashes (`seen_payments`), so any settle/transfer hash scores at most once. On the native rail the invoice nonce rides the transfer's `transfer_id` and is single-use — burned and persisted across restarts — and a seller paying itself is served but never scored.

**6. "Isn't the gateway custodial — it holds the CSPR.cloud key and settles for the buyer?"**
No principal is ever custodied: the buyer signs an EIP-712 authorization over **their own** WCSPR, and the facilitator executes `transfer_with_authorization` buyer→payee. The gateway only relays that signed authorization to your facilitator (which sponsors gas) — it never holds or moves the buyer's funds itself.

**7. "The ≥2.5 CSPR native-transfer floor kills micropayments — so why keep the native rail at all?"**
Exactly why the facilitator rail exists: CEP-18 allows true sub-CSPR micropayments (the contract's `MIN_PRICE` is 1000 motes; the demo charges 0.1 WCSPR), which the 2.5-CSPR native floor cannot. Native is the zero-dependency path for simple ≥2.5-CSPR transfers; the facilitator is for micropricing with sponsored gas — same 402→pay→settle→attest loop, same `buy` command.

**8. "Sluice already runs x402 settlement with 275+ real settlements. Why does the ecosystem need AgentGate?"**
We don't claim volume — Sluice leads there. We're the only project running **both** a native-CSPR rail **and** your official CEP-18/EIP-712 WCSPR facilitator behind **one** buy command, with a one-command seller onboarding (`wrap`) and on-chain, payment-backed reputation that another agent can trust without meeting the service.

**9. "Is the agent real reasoning or a script? What happens with no API key?"**
It's a real Claude tool-use loop — discover from the on-chain catalog, reason about fit, check its own budget cap, pay, write the report, record the receipt — with every decision written to `logs/decisions.jsonl`. Without `ANTHROPIC_API_KEY` it degrades to a deterministic MockLlm so any judge can run the entire loop offline (`npm run demo`); we disclose that, we don't hide it.

**10. "What's the real security posture, and what is honestly NOT done yet?"**
Proxy: SSRF guard with an IP-pinned dispatcher (DNS-rebind safe), strict header whitelist, and the upstream URL never appears in any response; money is bigint-only motes end to end; 386 TS tests + Rust contract tests, CI green. Not done yet: an on-chain asset field (optional upgrade), staking-weighted attestation with slashing (next milestone), and mainnet deploy (2-week roadmap).

---

## One-line differentiation vs each named rival

- **Sluice (275+ settlements):** they win on volume; we're the only **dual-rail** project (native CSPR + your official WCSPR facilitator) behind one command, with payment-backed reputation.
- **MidOS (#46086, closest rival):** closest agentic-payments neighbor, but AgentGate turns the rail into a **one-command product** (`wrap`/`buy`) + native **MCP tools** any agent gets for free, and runs the official facilitator live.
- **Vouch (#45565, trust/vouch model):** their reputation is attestation/vouch-based; ours is a **payment receipt** — every trust point references a verified on-chain settlement, not a social vouch, so it can't be Sybil-padded without spending.
- **Escrow402 (escrow model):** escrow adds a holding intermediary; AgentGate is **non-custodial** — the buyer's signed authorization settles buyer→payee directly via the facilitator, no funds parked.

## Feasibility / "what's next" (honest, no over-claim)

- **Now (verified live):** dual rails on Testnet, CLI on npm (`@neargate/cli@0.1.6`), MCP server, dashboard + on-chain `/activity` ledger, 386 tests green.
- **~2 weeks:** mainnet deploy + onboard the first external data vendor (`wrap` is the funnel).
- **~1 month:** deeper facilitator alignment (optional on-chain asset field so WCSPR/CEP-18 is first-class in the registry, not just the invoice layer).
- **~2 months:** staking-weighted attestation with slashing — the reputation upgrade that raises the cost of a Sybil attack from "spend once" to "stake and risk slashing."
- **Known limits stated plainly:** trust score v1 counts verified-payment attestations only; the on-chain record is asset-agnostic today (WCSPR denominated at the invoice layer); solo build, so roadmap velocity is one shipper's throughput — which is exactly why every claim above is already on-chain, not a promise.
