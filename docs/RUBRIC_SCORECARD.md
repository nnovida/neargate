<!-- trace: idea="One command wraps any HTTP API into an agent-payable x402 service — dual rails: native CSPR + Casper's official CEP-18/EIP-712 facilitator settling WCSPR, live on Testnet" | event="Casper Agentic Buildathon 2026 — Final Round" | deadline="2026-07-26 23:59 (TZ UNCONFIRMED — verify on DoraHacks portal)" | source=submission-packager -->

# Rubric scorecard — Casper Agentic Buildathon 2026, Final Round

**JUDGING WEIGHTS NOT PUBLISHED as percentages.** The finals page was behind AWS WAF (405 to
plain fetch), so no numeric weights were captured. Scored against the organizer's stated **8
criteria** and the finals **emphasis order** for a professional/technical jury (Casper's own x402
team): **Technical Execution, Working Smart Contracts, and Use of AI weighted heaviest.** Scores
are for the **built project** as a Casper engineer would see it in the video + a live Q&A, 1–5.

**Jury reality:** the finalists' jury built `make-software/casper-x402` + the CSPR.cloud
facilitator. They can tell a native-CSPR shortcut from their real stack in seconds — which is
exactly why the finals cut leads with the WCSPR facilitator settle (Scene 1).

| Criterion (emphasis) | Predicted (1–5) | Evidence the judge will SEE | Cheapest +1 before deadline |
|---|---|---|---|
| **Technical Execution** (heavy) | **5** | Scene 1: EIP-712 auth signed with buyer secp256k1 key → CSPR.cloud `/verify`+`/settle` → 0.1 WCSPR moves, facilitator-sponsored gas; 386 tests + Rust contract tests, CI green | Already strong — record the terminal + explorer + `/activity` in one unbroken take so it reads as unquestionably live (0h). |
| **Working Smart Contracts (Testnet)** (heavy) | **5** | Registry pkg `hash-10f92725…` live; attestation tx carries the settle hash (`04028b92…` refs `17ad3580…`); native lifecycle #5 (install/register/payment/attestation) all Success | Show `record_attestation` args on the explorer on-screen so the payment→attestation binding is visible, not just asserted (15m). |
| **Use of AI / Agentic Systems** (heavy) | **4** | Scene 4: real Claude tool-use loop (discover→reason→budget→pay→report→receipt), `logs/decisions.jsonl`; Scene 5: MCP tools any agent can call | Have the agent pick the **facilitator** service #9 (WCSPR) autonomously on camera, so "AI + your official rail" land in ONE beat (~1h: point the agent task at the FX feed). |
| **Innovation & Originality** | **4** | Rail-agnostic: SAME `buy` command drives native CSPR OR the official CEP-18/EIP-712 WCSPR facilitator; reputation = payment receipt | State the one-liner no rival can: "both rails, one command, on-chain payment-backed reputation" — put it as an on-screen lower-third in Scene 1 (15m). |
| **Real-World Applicability (DeFi/RWA)** | **4** | Live RWA FX + gold oracle (#5) and USD FX feed (#9); WCSPR enables true **sub-CSPR micropayments** (0.1) that the 2.5-CSPR native floor can't | Say the number: "the facilitator rail unlocks payments below the 2.5-CSPR native floor — real per-call micropricing" (0h, VO already drafted). |
| **UX & Design** | **4** | One-command sell/buy; dashboard + `/activity` on-chain ledger now renders "payment of 0.1 WCSPR"; zero-config `list` | Show the `/activity` WCSPR row updating live right after the Scene 1 buy (the "it just happened" beat) (15m). |
| **Long-Term Launch Plans** | **3** | CLI on npm (`@neargate/cli@0.1.6`); roadmap: mainnet → external vendors → staking-weighted attestations; `wrap` = onboarding funnel | Add ONE concrete near-term commitment with a date (e.g. "mainnet deploy + first external vendor in 2 weeks") to the SUBMISSION/close (30m). |
| **Long-Term Impact** | **3** | Shared on-chain reputation graph on Casper; moat = accumulated payment history that can't be forked | Frame impact as ecosystem-level: "every wrapped API deepens one Casper-native reputation graph other agents reuse" — one sentence in the close (0h). |

**Weighted projected total:** with the three heavy criteria at 5/5/4 and the rest 4/4/4/3/3, this
projects to a **strong-finalist / podium-contention** package — **PASS** for a shortlist bar.
The single biggest lift vs. the qualification round is that Technical Execution + Working Contracts
now score a genuine **5** because the demo runs the jury's *own* official stack live, not a
divergent rail.

**Lowest criteria:** **Long-Term Launch Plans** and **Long-Term Impact** (both 3). These are
narrative, not build, gaps — a technical jury discounts vision unless it's specific and dated. The
cheapest lift is verbal/on-slide (below), not more code.

---

## What WINS points (lean into these on camera)

1. **"We run your stack, live."** Scene 1 is the whole ballgame for this jury — real EIP-712 →
   CSPR.cloud verify/settle → WCSPR moved → attestation. No other finalist is likely to show the
   official facilitator settling their own token in production.
2. **Rail-agnostic under one command.** Native CSPR *and* official WCSPR facilitator, buyer never
   changes a flag — this is the originality claim rivals can't copy.
3. **Verifiability first.** Every claim maps to a tx hash / live endpoint; the jury can re-run
   `npx @neargate/cli buy 9` themselves.
4. **Real AI, disclosed honestly.** A real Claude loop for Use of AI, with the MockLlm fallback
   disclosed proactively (see `docs/JUDGE_QA.md`) — execs forgive disclosed mocks.

## What LOSES points (avoid / neutralize)

1. **Over-claiming vs. Sluice on volume.** Sluice has 275+ real settlements. Do NOT claim "most
   settlements." Claim the *only dual-rail + official-facilitator + reputation* combination.
2. **An all-mock-looking wow beat.** If Scene 1 is shown from cached footage without the explorer
   cut, a Casper engineer will ask "was that live?" Always cut to the explorer settle tx + `/activity`.
3. **Vague roadmap.** "Someday mainnet" reads as filler to this jury. Give a dated, single next step.
4. **Implying authorship of WCSPR/the facilitator.** Say "canonical WCSPR" and "the CSPR.cloud
   hosted facilitator" — we integrate, we didn't build them.
