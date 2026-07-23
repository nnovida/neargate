<!-- trace: idea="One command wraps any HTTP API into an agent-payable x402 service — dual rails: native CSPR + Casper's official CEP-18/EIP-712 facilitator settling WCSPR, live on Testnet" | event="Casper Agentic Buildathon 2026 — Final Round" | deadline="2026-07-26 23:59 (TZ UNCONFIRMED — verify on DoraHacks portal)" | source=submission-packager -->

# AgentGate — Demo Runbook (FINALS) — copy-paste commands, expected output, fallbacks

**Target:** ~3:00 recorded (2:00 cut available). **Wow-moment at 0:12–0:55** — the official
CSPR.cloud facilitator settling **0.1 WCSPR** end to end. This runbook binds every scene in
`docs/VIDEO_SCRIPT.md` to a real, tested command and a pre-wired fallback.

**Wow beat is REAL** — Scene 1 exercises real EIP-712 signing, real CSPR.cloud `/verify`+`/settle`,
real WCSPR transfer, facilitator-sponsored gas. Nothing in the wow beat is `src/lib/mock-data`.

---

## Live state (verified on-chain 2026-07-19 — trust these; re-verify cheaply, don't burn quota)

| Thing | Value |
|---|---|
| Gateway (public) | `https://gateway.example.org` |
| Dashboard / activity ledger | `https://agentgate.example.org` · `/activity` |
| Registry contract package | `hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df` |
| **Facilitator service #9** | "Global Currency Feed" — active, tier **reliable**, x402 **v2** WCSPR |
| WCSPR asset pkg | `3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e` (name "Wrapped CSPR", 9dp) |
| Facilitator (hosted) | `https://x402-facilitator.cspr.cloud` (`/supported` `/verify` `/settle`) |
| **Native service #5** | "RWA FX & Gold Oracle" — active, 2.5 CSPR, tier **reliable** |
| Proven facilitator settle tx | `17ad3580544c1f09a8bc67da513c284840bdf138f4e68af576194d7da8979e4c` (0.1 WCSPR, gas 6 CSPR by facilitator, error None) |
| Proven facilitator attestation | `04028b925e22609035af66351c0cc1d0458b7aab1dc516496534de26e7ccb2cc` |
| Native #5 lifecycle | install `4eace325…` · register `dbfdecbb…` · payment `d6cbfcab…` · attestation `23ddacf9…` |
| Buyer balances | ~50 WCSPR (facilitator) · ~21 CSPR native (~8 native buys) |
| Gate/seller balance | ~3249 CSPR |
| CLI on npm | `@neargate/cli@0.1.6` (facilitator-buy token amount + MCP) |

**Cheap re-verify (no payment, minimal quota):**
```bash
curl -s -o /dev/null -w "svc/5 native   -> %{http_code}\n" https://gateway.example.org/svc/5
curl -s -o /dev/null -w "svc/9 faciltor -> %{http_code}\n" https://gateway.example.org/svc/9   # expect 402 + x402Version:2
curl -s https://gateway.example.org/svc/9 | jq .x402Version                                    # expect 2
```

---

## Pre-demo setup (do this before recording / before you walk on stage)

- [ ] **Seed / source env (known-good every run):**
  ```bash
  export PS1='$ '
  cd ~/projects/Dorahacks/casper
  set -a; source .env; set +a       # loads GATE/SELLER/BUYER PEM paths + facilitator key
  ```
- [ ] **Pre-warm npx** (kills the on-camera download delay + deprecation warnings):
  ```bash
  npx @neargate/cli@latest list >/dev/null 2>&1
  ```
- [ ] **Warm the facilitator + gateway once** (avoids cold-start on the wow beat): run the
  liveness curls above; both must return the expected codes.
- [ ] **Confirm buyer holds WCSPR** (need ≥0.1 per facilitator take): the wallet showed ~50 WCSPR
  on 2026-07-19. If low, wrap CSPR→WCSPR on `testnet.cspr.trade` (no self-wrap needed).
- [ ] **Confirm buyer holds CSPR** (~2.5 per native take, ~21 available). Faucet-refill if low.
- [ ] **Backup:** keep a full screen-recording of the wow beat on a SECOND device (wifi-independent).
- [ ] **Stage hygiene:** projector zoom checked, notifications off, terminal ≥18pt dark theme ≥100 cols,
  browser at readable zoom, phone hotspot ready if venue wifi dies.
- [ ] **CSPR.cloud quota:** each facilitator buy + each read consumes quota — rehearse with the
  offline `npm run demo` and reserve live runs for the final takes.

**Reset between takes / judging rounds:** nothing to reset — reads are idempotent and each buy is a
fresh on-chain tx. To keep the catalog clean after `wrap` takes:
```bash
npm run agentgate -- pause <newId> --pem "$SELLER_SIGNER_PEM_PATH"
```

---

## Click / command path (timed) — bound to VIDEO_SCRIPT scenes

| Time | Scene | Command / action | What the judge sees | REAL / MOCKED |
|------|-------|------------------|---------------------|----------------|
| 0:00–0:12 | 0 | (dashboard hero, no terminal) | "AgentGate runs your official x402 stack, live" | — |
| 0:12–0:30 | 1 | `curl -s https://gateway.example.org/svc/9 \| jq .` | x402 **v2** invoice: `exact` / `casper:casper-test` / WCSPR asset / EIP-712 domain | **REAL** |
| 0:30–0:55 | 1 | `npm run agentgate -- buy 9 --pem "$BUYER_SIGNER_PEM_PATH"` → cut to explorer + `/activity` | `paid: 0.1 WCSPR`, settle tx, `settled: ok`, status 200; explorer error=None; ledger "0.1 WCSPR" | **REAL (wow)** |
| 0:55–1:20 | 2 | cycle explorer tabs (register/payment/attestation #5); optional `buy 5` | Success on each; `payment_deploy_hash` = payment tx | **REAL** |
| 1:20–1:40 | 3 | `npm run agentgate -- wrap "https://open.er-api.com/v6/latest/USD" --price 2.5 --name "Global Currency Feed" --gateway https://gateway.example.org --pem "$SELLER_SIGNER_PEM_PATH"` | new service id + register tx | **REAL** |
| 1:40–2:20 | 4 | `npm run agent -- --task "Get today's USD/IDR rate and the gold price for a treasury report" --budget 3` | 6 STEP blocks; STEP 2 Claude `reason:`; STEP 6 attestation success | **REAL** (Claude) |
| 2:20–2:40 | 5 | `npx @neargate/cli@latest mcp` + config line | 4 AgentGate MCP tools; `agentgate_buy` | **REAL** |
| 2:40–3:05 | 6 | `npx @neargate/cli@latest list` ; `curl -sS https://gateway.example.org/svc/9` | trust tiers; live v2 invoice; end-card | **REAL** |

### Exact expected output — Scene 1 step 1 (`curl svc/9`)
```json
{ "x402Version": 2, "error": "PAYMENT-SIGNATURE header is required",
  "accepts": [{ "scheme": "exact", "network": "casper:casper-test",
    "asset": "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
    "amount": "100000000",
    "payTo": "0019ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0",
    "maxTimeoutSeconds": 600,
    "extra": { "name": "Wrapped CSPR", "version": "1", "decimals": 9, "symbol": "WCSPR" } }] }
```

### Exact expected output — Scene 1 step 2 (`buy 9`, receipt → stderr)
```
service:  #9 Global Currency Feed
url:      https://gateway.example.org/svc/9
paid:     0.1 WCSPR
payment:  17ad3580…8979e4c
explorer: https://testnet.cspr.live/transaction/<new settle tx>
settled:  ok  (payer 434870ff…)
status:   200
```
(`paid:` prints the CEP-18 token amount, not CSPR — CLI ≥0.1.6. The `payment:`/`explorer:` hash is
the facilitator **settle** tx; on a fresh run it will differ from the reference `17ad3580…`.)

> **Note on `--max`:** the `--max <cspr>` guard compares the service's on-chain CSPR-shaped price
> (2.5 for #9), not the WCSPR invoice amount. The real charge is fixed by the v2 invoice (0.1 WCSPR).
> Omit `--max` on the facilitator buy, or keep it ≥3.

---

## Murphy's-law fallbacks (one per live dependency on the demo path)

| If this breaks | Symptom | Fallback (pre-wired) |
|----------------|---------|----------------------|
| **Facilitator buy stalls / verify+settle slow** | `buy 9` spins >20s | Cut to the proven, isolated e2e that settled `17ad3580…` this session: `npx tsx --env-file=.env scripts/facilitator-e2e.ts` (boots an in-process gateway on an ephemeral port, real facilitator, real WCSPR). |
| **CSPR.cloud facilitator 5xx / rate-limit** | `settled: FAILED` or 402 after pay | Play the pre-recorded settle-tx clip; open the reference settle tx `17ad3580…8979e4c` on `testnet.cspr.live` — it's permanent proof the rail works. |
| **Buyer out of WCSPR** | facilitator `/verify` rejects | Wrap CSPR→WCSPR on `testnet.cspr.trade` before recording; or narrate over the reference tx. |
| **Venue wifi / network down** | nothing loads | Backup recording on the second device; `npm run demo` (offline, full loop, exits <2s, prints two tx hashes). |
| **Cold start (first request 20–30s)** | first curl slow | Hit `curl svc/9` and `svc/5` once during setup to warm the tunnel + facilitator. |
| **Native buy stalls (node lag)** | `buy 5` spins | Settlement race is fixed (commit `dbf31c7`); if still slow, cut to explorer tab #5 (already loaded) or `npm run demo`. |
| **Claude API key missing / rate-limited** | agent falls to MockLlm | Ensure `set -a; source .env` ran (loads `ANTHROPIC_API_KEY`); if it still degrades, disclose it honestly (see `JUDGE_QA.md`) — the loop is identical, and `npm run demo` shows it offline. |
| **npx download delay on camera** | 10–15s hang on first `npx` | Pre-warm in setup (`npx …@latest list >/dev/null`); use `npm run agentgate -- …` (local tsx) for live scenes. |

### The always-works offline fallback (never fails, ~2s)
```bash
npm run demo        # full 402→pay→settle→attest loop, deterministic MockLlm, prints both tx hashes
```
Narrate it as "the same loop, fully offline" — never show a red error without an explanation.

---

## Full command cheat-sheet (in scene order, copy-paste)

```bash
# SETUP (once)
export PS1='$ '
cd ~/projects/Dorahacks/casper
set -a; source .env; set +a
npx @neargate/cli@latest list >/dev/null 2>&1
curl -s -o /dev/null -w "svc/9 -> %{http_code}\n" https://gateway.example.org/svc/9

# SCENE 1 — WOW: official facilitator rail (WCSPR, gas sponsored)
curl -s https://gateway.example.org/svc/9 | jq .
npm run agentgate -- buy 9 --pem "$BUYER_SIGNER_PEM_PATH"
#   fallback (proven this session): npx tsx --env-file=.env scripts/facilitator-e2e.ts

# SCENE 2 — rail-agnostic native rail (same buy command)
npm run agentgate -- buy 5 --pem "$BUYER_SIGNER_PEM_PATH" --max 3 | jq '{date, idr: .usd.idr, gold_xau: .usd.xau}'

# SCENE 3 — sell in one command
npm run agentgate -- wrap "https://open.er-api.com/v6/latest/USD" \
  --price 2.5 --name "Global Currency Feed" \
  --description "Live USD exchange rates for 160+ currencies incl IDR" \
  --gateway https://gateway.example.org --pem "$SELLER_SIGNER_PEM_PATH"

# SCENE 4 — autonomous Claude agent
npm run agent -- --task "Get today's USD/IDR rate and the gold price for a treasury report" --budget 3

# SCENE 5 — MCP
npx @neargate/cli@latest mcp
# claude_desktop_config.json:
# { "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "@neargate/cli", "mcp"] } } }

# SCENE 6 — trust + verify + close
npm run agentgate -- status 9
npm run agentgate -- status 5
npx @neargate/cli@latest list
curl -sS https://gateway.example.org/svc/9

# OFFLINE FALLBACK (any scene stalls live)
npm run demo
```

---

## Rehearsal log (REQUIRED before recording/submission — 3 passes, all < the portal limit)

- [ ] Pass 1: ____ s   (note: which scenes ran live vs. footage)
- [ ] Pass 2: ____ s
- [ ] Pass 3: ____ s   (all must be < the confirmed portal video limit — default ≤ 3:00)
- [ ] Facilitator buy (`buy 9`) settled REAL on at least one rehearsal pass (settle tx recorded: ________)
- [ ] Offline `npm run demo` verified as the failsafe (exits <2s, prints two hashes)
- [ ] Backup recording of the wow beat exists on a second device
