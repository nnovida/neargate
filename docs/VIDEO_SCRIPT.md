<!-- trace: idea="One command wraps any HTTP API into an agent-payable x402 service — dual rails: native CSPR + Casper's official CEP-18/EIP-712 facilitator settling WCSPR, live on Testnet" | event="Casper Agentic Buildathon 2026 — Final Round" | deadline="2026-07-26 23:59 (TZ UNCONFIRMED — verify on DoraHacks portal)" | source=submission-packager -->

# AgentGate — FINALS Demo Video Script (per-scene cards + bilingual VO)

Format = same as `DEMO-SCRIPT.md`: each scene is a self-contained card with three
parts recorded separately and joined in the edit.

- **🖥️ LAYAR** — what is captured (dashboard / terminal / explorer) and what to highlight.
- **⌨️ TERMINAL** — the exact copy-paste command (tested; matches the current CLI).
- **🎙️ VO** — the narration, English (international/technical jury) + Indonesian below.

**Target total ≈ 3:00** with a tight **2:00 cut** (see the cut plan at the bottom).
All live state verified on-chain **2026-07-19** (dual rails green — see `DEMO_RUNBOOK.md`).

---

## ✅ CONFIRMED FROM THE OFFICIAL FINALS BRIEF

The finals rules are now in hand (`docs/HACKATHON_BRIEF.md`). Anchors this script is built to:

- **Judging criteria (8) — `RUBRIC_SCORECARD.md` maps 1:1:** Technical Execution · Innovation & Originality · Use of AI / Agentic Systems · Real-World Applicability (DeFi & RWA) · User Experience & Design · Working Smart Contracts (Testnet) · Long-Term Launch Plans (real project, **socials in place**, deployment plan) · Potential for Long-Term Impact.
- **Required deliverables:** (1) working prototype on Casper Testnet with a transaction-producing on-chain component ✅; (2) open-source GitHub repo with README + usage ✅; (3) **public demo video explaining the project, features, and a walkthrough** — that is THIS script.
- **Video length:** the brief states **no explicit maximum** — it asks for an explanatory walkthrough. Keep it tight anyway (**≤ 3:00**; the 2:00 cut is the safer upload).
- **Deadline:** **2026-07-26** (finals email: 23:59). Still confirm the **timezone** on the portal.
- **Demo day:** the brief lists "demo day presentations" at end of July — a LIVE pitch is likely, so treat `DEMO_RUNBOOK.md` as the stage script and this video as the recorded walkthrough/backup.

---

## 🎥 THE VIDEO MUST DO 3 THINGS (deliverable: "explain the project, features, and a walkthrough")

The finals brief asks for a *public video explaining the project, its features, and a walkthrough*.
This script delivers all three explicitly — don't drop any of them, even in the 2:00 cut:

| Required element | Where it's delivered |
|---|---|
| **Explain the project** | **Scene 0 Beat A** — what AgentGate is + the problem, in plain terms for any viewer |
| **Explain the features** | **Scene 0 Beat B + features overlay** (wrap / buy / two rails / autonomous agent / MCP / trust score), each then shown live |
| **Walkthrough** | **Scenes 1–6** — the live, on-chain demo of every feature |

Even in the 2:00 cut, keep Scene 0 (trimmed) so the video still *states what it is and names the
features* before the walkthrough — a walkthrough with no project explanation misses the deliverable.

---

## 🎯 WHY THIS CUT LANDS WITH THIS SPECIFIC JURY

Jury = Casper Association leadership + **the technical team behind the official x402 stack** + partner orgs, Web3 investors, and media. Three facts in the official brief make our angle nearly on-the-nose:

1. **We use Casper's own AI Toolkit — all of it.** The brief promotes x402 micropayments, MCP servers, and CSPR.cloud APIs. AgentGate runs **x402** (their CSPR.cloud facilitator, settling WCSPR), ships an **MCP** server, and reads/settles via **CSPR.cloud** APIs. We use the toolkit, we don't reimplement it — say that.
2. **We ARE their example build direction #2.** The brief's own example — *"an RWA oracle agent that posts verified data on-chain via Casper's native x402, with a verifiable on-chain identity and reputation score based on historical accuracy"* — is precisely AgentGate's flagship (the RWA FX & gold oracle service + payment-backed trust scores). Say this out loud in the close.
3. **$100k of the $150k pool is "x402 ecosystem credits."** x402 is the center of gravity — a live, production x402 integration is the highest-signal thing to lead with.

For the investor/media half of the panel, keep the plain-value line: *machine-to-machine commerce — agents discovering, paying for, and trusting real APIs with no humans, no cards, no accounts.*

---

## 🔁 WHAT CHANGED vs. the qualification video (read this first)

The **Final Round jury is Casper's own team — the people who built the official x402 stack**
(`make-software/casper-x402` + the CSPR.cloud x402 facilitator). So this cut **LEADS** with
the one thing that lands hardest with them: **AgentGate now speaks their official x402 stack,
live in production** — CEP-18 + EIP-712 signed authorization, settled through the CSPR.cloud
facilitator, denominated in **WCSPR** (canonical Wrapped CSPR), with **gas sponsored by the
facilitator**.

> **The qualification-era caveat "do NOT claim official x402 spec" is now REVERSED and obsolete.**
> We integrated the real facilitator rail and verified it on-chain (settle tx
> `17ad3580…8979e4c`). Claim it, on camera, directly to the jury.

---

## ⚙️ SETUP ONCE (before recording any scene)

```bash
# terminal: font ≥18pt, dark theme, ≥100 cols, short prompt
export PS1='$ '
cd ~/projects/Dorahacks/casper
set -a; source .env; set +a           # WAJIB — loads keys; without it the agent falls to mock mode
npx @neargate/cli@latest list >/dev/null 2>&1     # pre-warm npx (kills on-camera download delay)
# quick liveness: BOTH rails answer 402
curl -s -o /dev/null -w "svc/5 native   -> %{http_code}\n" https://gateway.example.org/svc/5
curl -s -o /dev/null -w "svc/9 facilitator -> %{http_code}\n" https://gateway.example.org/svc/9
```

**Browser tabs (open left→right before recording):**
1. Dashboard — https://agentgate.example.org
2. Activity ledger — https://agentgate.example.org/activity  *(shows the "0.1 WCSPR" row)*
3. Catalog — https://agentgate.example.org/catalog
4. Explorer — facilitator settle tx — https://testnet.cspr.live/transaction/17ad3580544c1f09a8bc67da513c284840bdf138f4e68af576194d7da8979e4c
5. Explorer — facilitator attestation — https://testnet.cspr.live/transaction/04028b925e22609035af66351c0cc1d0458b7aab1dc516496534de26e7ccb2cc
6. Explorer — native register #5 — https://testnet.cspr.live/transaction/dbfdecbbc43441fe8d59876387bfd9520e8f63bfc36ab79ddb0905903e3bf78f
7. Explorer — native payment #5 — https://testnet.cspr.live/transaction/d6cbfcab88a68c3b20c48fc7b47f1e814a9f9e0f0b716c4c5a1d9d3e0380f318
8. Explorer — native attestation #5 — https://testnet.cspr.live/transaction/23ddacf9e6c969afb1461d15f5fe87576e073d6f0e890ab58644d8be2d9bc251

**Cost per take:** facilitator buy = **0.1 WCSPR** (buyer holds ~50 → ~500 takes, CSPR.cloud
quota is the real limit — retake sparingly). Native buy = **~2.5 CSPR** (buyer holds ~21 → ~8
takes). Gate/seller ~3249 CSPR for `wrap`.

**ElevenLabs voice:** regenerate VO with the **"Roger — Laid-Back, Casual, Resonant"** preset,
same settings as the qualification file (`ElevenLabs_2026-07-05…Roger…mp3`). Tone: confident,
unhurried, technical-peer-to-peer (you are talking to engineers who built this stack).

---
---

# 🎬 SCENE 0 — Hook: what it is + what it does + "we run your stack" (0:00–0:22)

**Tujuan:** this is a PUBLIC video for a MIXED jury (Casper engineers + investors + media), and the
deliverable asks the video to *explain the project, its features, and a walkthrough*. So the first
~22s does all three jobs up front — **explain the project**, then **name the features**, then land
the technical payoff. Two micro-beats, cut back-to-back.

**🖥️ LAYAR:**
- Beat A: dashboard hero (`agentgate.example.org`) — let the typewriter `wrap` animation settle.
- Beat B: hold on the headline, then drop a **features overlay** (lower third):
  `wrap = sell · buy = pay · x402 facilitator (WCSPR) · autonomous agent · MCP · on-chain trust score`
- Optional second lower-third on the final line: `x402 v2 · CEP-18 + EIP-712 · CSPR.cloud facilitator`.

**⌨️ TERMINAL:** — (none)

**🎙️ VO EN — Beat A · explain the project (~11s):**
> "AI agents can do real work now — but they can't pay for the APIs they use: no cards, no logins,
> no accounts. AgentGate turns any HTTP API into a service an agent can discover, pay for per call,
> and trust — with every payment settled on Casper."

**🎙️ VO EN — Beat B · features + jury payoff (~11s):**
> "Sell an API in one command, buy it in one — on two rails: native CSPR, or Casper's own official
> x402 facilitator settling WCSPR. And for this round, the headline: that official stack is live in
> production, inside AgentGate."

**🎙️ VO ID — Beat A (~11s):**
> "Agen AI kini bisa melakukan pekerjaan nyata — tapi mereka belum bisa membayar API yang mereka
> pakai: tanpa kartu, tanpa login, tanpa akun. AgentGate mengubah API HTTP apa pun jadi layanan yang
> bisa ditemukan, dibayar per panggilan, dan dipercaya oleh agen — dengan setiap pembayaran
> diselesaikan di Casper."

**🎙️ VO ID — Beat B (~11s):**
> "Jual API dengan satu perintah, beli dengan satu perintah — di dua rail: CSPR native, atau
> facilitator x402 resmi milik Casper yang menyelesaikan WCSPR. Dan untuk babak ini, intinya: stack
> resmi itu live di produksi, di dalam AgentGate."

**🎬 Sutradara:** Beat A explains the project to anyone; Beat B names the features + the insider
payoff. Emphasis on **"any HTTP API"**, **"two rails"**, **"your"**, **"in production."** This opener
is ~10s longer than the old hook → total ≈ **3:15**; for a hard ≤ 3:00, trim ~10s from Scene 2
(explorer cycle) or Scene 6. Kriteria: Innovation & Originality, Technical Execution, UX (explains
the project clearly to a non-insider).

---

# 🎬 SCENE 1 — 🌟 THE WOW: official facilitator rail, live (0:12–0:55) · MUST-KEEP

**Tujuan:** demonstrate the exact stack the jury shipped, end to end, on the public gateway.
This is the beat a Casper engineer remembers at hour 6. **This is REAL** — real EIP-712 signing,
real CSPR.cloud verify+settle, real WCSPR moving, facilitator-sponsored gas.

**🖥️ LAYAR:** terminal, then cut to (a) explorer settle tx, (b) `/activity` ledger row.

**⌨️ TERMINAL — step 1, show the v2 invoice:**
```bash
curl -s https://gateway.example.org/svc/9 | jq .
```
_Expected (x402 **v2** — the shape the CSPR.cloud facilitator speaks):_
```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "casper:casper-test",
    "asset": "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
    "amount": "100000000",
    "payTo": "0019ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0",
    "maxTimeoutSeconds": 600,
    "extra": { "name": "Wrapped CSPR", "version": "1", "decimals": 9, "symbol": "WCSPR" }
  }]
}
```
_Highlight `scheme:"exact"`, `network:"casper:casper-test"`, `asset` = WCSPR pkg, and the
`extra` **EIP-712 token domain** (`name`/`version`)._

**⌨️ TERMINAL — step 2, the facilitator buy (same buy command, WCSPR rail):**
```bash
npm run agentgate -- buy 9 --pem "$BUYER_SIGNER_PEM_PATH"
```
_Expected (payment receipt → stderr, body → stdout):_
```
service:  #9 Global Currency Feed
url:      https://gateway.example.org/svc/9
paid:     0.1 WCSPR
payment:  17ad3580…8979e4c
explorer: https://testnet.cspr.live/transaction/17ad3580544c1f09a8bc67da513c284840bdf138f4e68af576194d7da8979e4c
settled:  ok  (payer 434870ff…)
status:   200
{ "base_code": "USD", "rates": { "IDR": 16xxx, ... }, ... }
```
Then **cut to explorer** (settle tx, error=None, facilitator feePayer paid ~6 CSPR gas) and to
`/activity` showing **"payment of 0.1 WCSPR to 19ffec2c…b5f0"**.

**🎙️ VO EN (~40s):**
> "Here's service nine on our public gateway. Ask it for data without paying and it answers with
> an x402 **version-two** invoice — the exact shape your facilitator speaks: scheme 'exact',
> network casper-test, asset **Wrapped CSPR**, and an EIP-712 token domain. Now the buyer pays —
> one command. It signs an EIP-712 authorization with its own secp256k1 key, the gateway calls the
> **CSPR.cloud facilitator** to verify and settle, and **zero-point-one WCSPR** moves — with the
> facilitator sponsoring the gas. Here's the settle transaction on the explorer, and here it is
> again in our on-chain activity ledger: 'payment of zero-point-one WCSPR'. That is **your** stack —
> make-software's casper-x402 and the CSPR.cloud facilitator — running end to end inside AgentGate."

**🎙️ VO ID (~40s):**
> "Ini service nomor sembilan di gateway publik kami. Minta datanya tanpa membayar, ia menjawab
> dengan invoice x402 **versi dua** — persis bentuk yang dipahami facilitator kalian: scheme
> 'exact', network casper-test, aset **Wrapped CSPR**, dan sebuah domain token EIP-712. Sekarang
> pembeli membayar — satu perintah. Ia menandatangani otorisasi EIP-712 dengan kunci secp256k1-nya
> sendiri, gateway memanggil **facilitator CSPR.cloud** untuk verify dan settle, dan **nol-koma-satu
> WCSPR** berpindah — dengan gas disubsidi facilitator. Ini transaksi settle-nya di explorer, dan
> ini lagi di ledger aktivitas on-chain kami: 'payment of 0.1 WCSPR'. Itu stack **kalian** —
> casper-x402 dari make-software dan facilitator CSPR.cloud — berjalan penuh di dalam AgentGate."

**🎬 Sutradara:** the buy takes ~5–15s (facilitator verify+settle) — do NOT cut mid-run. Pause VO
~2s on the settle tx and again on the `/activity` row. If the live buy stalls on camera, cut to the
proven fallback `npx tsx --env-file=.env scripts/facilitator-e2e.ts` (same loop, isolated port) or
to the pre-recorded settle-tx clip — see `DEMO_RUNBOOK.md`. Kriteria: **Working Smart Contracts,
Technical Execution, Innovation & Originality, Use of AI.**

---

# 🎬 SCENE 2 — Rail-agnostic + native on-chain proof (0:55–1:20) · MUST-KEEP (trim for 2:00)

**Tujuan:** show the buyer did NOT change anything — the same `buy` command drives the native-CSPR
rail — and prove the full on-chain lifecycle for a native service. Strongest position in a field of
mock demos: verifiability before flourish.

**🖥️ LAYAR:** cycle the 3 native explorer tabs (register → payment → attestation) for #5; on the
attestation tab highlight `payment_deploy_hash` = the payment hash from the previous tab.

**⌨️ TERMINAL (optional — same command, native rail):**
```bash
npm run agentgate -- buy 5 --pem "$BUYER_SIGNER_PEM_PATH" --max 3 | jq '{date, idr: .usd.idr, gold_xau: .usd.xau}'
```
_Expected: `paid: 2.5 CSPR`, a new payment hash, `settled: ok`, `status: 200`, then the FX+gold JSON._

**🎙️ VO EN (~25s):**
> "And notice what the buyer did **not** do — change anything. That same buy command drives our
> native-CSPR rail too. Here's the full on-chain lifecycle of service five: contract install,
> registration, a real buyer-paid transfer, and an attestation that carries **that exact** payment
> hash. Native CSPR for simple transfers, or the official CEP-18 facilitator for sub-CSPR
> micropayments with sponsored gas — same four-oh-two, pay, settle, attest loop. AgentGate is
> rail-agnostic."

**🎙️ VO ID (~25s):**
> "Perhatikan apa yang **tidak** dilakukan pembeli — mengubah apa pun. Perintah buy yang sama juga
> menjalankan rail CSPR native kami. Ini siklus penuh on-chain service lima: install kontrak,
> registrasi, transfer nyata yang dibayar pembeli, dan attestation yang membawa hash pembayaran
> **yang persis itu**. CSPR native untuk transfer sederhana, atau facilitator CEP-18 resmi untuk
> mikropembayaran sub-CSPR dengan gas disubsidi — loop 402, pay, settle, attest yang sama.
> AgentGate rail-agnostic."

**🎬 Sutradara:** pause ~2s per explorer tab so the jury reads `Success` / `error: None`.
**2:00 cut:** drop the live native buy, keep only the 3-tab explorer cycle (~12s). Kriteria:
**Working Smart Contracts, Technical Execution, Real-World Applicability (RWA).**

---

# 🎬 SCENE 3 — Sell in one command (wrap) (1:20–1:40) · droppable in the 2:00 cut

**Tujuan:** show the supply side is one command. This IS the onboarding funnel.

**🖥️ LAYAR:** terminal.

**⌨️ TERMINAL (LIVE — creates a new on-chain service; ~5 CSPR gas from the gate key):**
```bash
npm run agentgate -- wrap "https://open.er-api.com/v6/latest/USD" \
  --price 2.5 --name "Global Currency Feed" \
  --description "Live USD exchange rates for 160+ currencies incl IDR" \
  --gateway https://gateway.example.org --pem "$SELLER_SIGNER_PEM_PATH"
```
_Expected: a new `service id`, `public endpoint`, and a `register tx` you can open on the explorer._

**🎙️ VO EN (~18s):**
> "Supply side is one command too. A seller wraps any HTTP API — it registers on-chain and maps the
> private upstream on the gateway with an owner-signed challenge. No shared admin token, and the
> real URL never touches the chain. Thirty seconds later it's a paid service any agent can buy — on
> either rail."

**🎙️ VO ID (~18s):**
> "Sisi penjual juga satu perintah. Penjual membungkus API HTTP apa pun — ia mendaftar on-chain dan
> memetakan upstream privat di gateway dengan challenge bertanda tangan pemilik. Tanpa admin token
> bersama, dan URL asli tak pernah menyentuh chain. Tiga puluh detik kemudian ia jadi layanan
> berbayar yang bisa dibeli agen mana pun — di rail mana pun."

**🎬 Sutradara:** note the printed `service id` if you want to buy the fresh service later. To avoid
adding catalog rows, you may show the command + existing #9/#5 output instead. Kriteria: **UX &
Design, Technical Execution, Long-Term Launch Plans.**

---

# 🎬 SCENE 4 — 🌟 Autonomous Claude agent (1:40–2:20) · MUST-KEEP · most screen time

**Tujuan:** close the historically-weakest criterion (Use of AI) with a **real Claude tool-use loop**,
not a script and not MockLlm. Give it the most screen time.

**🖥️ LAYAR:** wide terminal. Highlight **STEP 2 · DECISION (anthropic)** and the `reason:` line.

**⌨️ TERMINAL (env already sourced in SETUP):**
```bash
npm run agent -- --task "Get today's USD/IDR rate and the gold price for a treasury report" --budget 3
```
_Block order:_ STEP 1 CATALOG (on-chain services) → **STEP 2 DECISION (anthropic)** (Claude picks a
service + reason) → STEP 3 BUDGET OK → STEP 4 PAYMENT (real value, deploy/settle hash) → STEP 5
REPORT → STEP 6 RECEIPT (attestation tx, success=true). Also appended to `logs/decisions.jsonl`.

**🎙️ VO EN (~38s):**
> "Now the agent does it alone. This is a real Claude tool-use loop — not a script. It reads the
> on-chain catalog, reasons about which service fits the task, checks its own budget cap before
> spending, pays real value on Casper, writes the report, and logs every decision. No human in the
> loop. Watch step two — that's Claude choosing the service and telling you why. The agent is
> spending on-chain money and getting an on-chain receipt for it."

**🎙️ VO ID (~38s):**
> "Sekarang agen melakukannya sendiri. Ini loop tool-use Claude yang asli — bukan skrip. Ia membaca
> katalog on-chain, menalar layanan mana yang cocok, mengecek batas anggarannya sebelum
> membelanjakan, membayar nilai nyata di Casper, menulis laporan, dan mencatat setiap keputusan.
> Tanpa campur tangan manusia. Perhatikan step dua — itu Claude memilih layanan dan menjelaskan
> alasannya. Agen membelanjakan uang on-chain dan menerima kuitansi on-chain untuk itu."

**🎬 Sutradara:** PAUSE VO ~3s on STEP 2 `reason:` — that's the "real AI" core. Total run ~30–45s;
you may speed footage 1.25× except STEP 2 and STEP 5. Kriteria: **Use of AI / Agentic Systems.**

---

# 🎬 SCENE 5 — Any MCP agent gets AgentGate natively (2:20–2:40) · droppable in the 2:00 cut

**Tujuan:** lift Use of AI one more level — not just our agent, ANY MCP client gets AgentGate as
native tools via one config line, on either rail.

**🖥️ LAYAR:** (a) the one-line config, (b) an MCP client listing AgentGate tools, (c) the agent
calling `agentgate_list_services` then `agentgate_buy`.

**⌨️ TERMINAL / CONFIG:**
```bash
npx @neargate/cli@latest mcp        # the MCP stdio server — exactly what a judge can run
```
```jsonc
// claude_desktop_config.json — one line and any MCP agent gets AgentGate tools
{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "@neargate/cli", "mcp"] } } }
```
_Tools:_ `agentgate_list_services`, `agentgate_get_service`, `agentgate_get_invoice` (read, no key)
+ **`agentgate_buy`** (pays a 402 — native CSPR **or** the WCSPR facilitator invoice, capped by `maxCspr`).

**🎙️ VO EN (~18s):**
> "And it isn't tied to our agent. One line in an MCP client — Claude Desktop, or any MCP-capable
> framework — and AgentGate becomes native tools: discover, inspect, and pay a four-oh-two, on
> either rail. The payment rail is just a tool the agent already knows how to call."

**🎙️ VO ID (~18s):**
> "Dan ini tidak terikat ke agen kami. Satu baris di klien MCP — Claude Desktop, atau framework
> MCP apa pun — dan AgentGate jadi tools native: temukan, inspeksi, dan bayar 402, di rail mana pun.
> Rail pembayaran hanyalah tool yang sudah tahu cara dipanggil oleh agen."

**🎬 Sutradara:** if Claude Desktop isn't camera-ready, show `npx @neargate/cli mcp` running + the
4-tool list from any MCP client + one `agentgate_buy`. Emphasize it's from the **public npm
registry** (`@latest`), not local. Kriteria: **Use of AI / Agentic Systems, Innovation.**

---

# 🎬 SCENE 6 — Trust = receipts + verify-it-yourself + close (2:40–3:05) · MUST-KEEP (trim for 2:00)

**Tujuan:** reputation is a payment receipt, on both rails — then hand verification to the jury.

**🖥️ LAYAR:** catalog/`/activity` (score `reliable`, the WCSPR row), then a freeze end-card.

**⌨️ TERMINAL (fast, zero-config):**
```bash
npx @neargate/cli@latest list                # live on-chain catalog + trust tiers
curl -sS https://gateway.example.org/svc/9     # a real x402 v2 WCSPR invoice
```

**🎙️ VO EN (~24s):**
> "Every paid call — native or facilitator — is attested on-chain, and that feeds a trust score
> that's a receipt of real value moved, not a claim. The CLI is on npm, both rails are live, the
> contract's on the explorer. Native CSPR and **your** official WCSPR facilitator — one loop, one
> command. That's AgentGate, on Casper."

**🎙️ VO ID (~24s):**
> "Setiap panggilan berbayar — native atau facilitator — di-attest on-chain, dan itu memberi makan
> skor kepercayaan yang merupakan kuitansi nilai nyata yang berpindah, bukan klaim. CLI-nya di npm,
> kedua rail live, kontraknya di explorer. CSPR native dan facilitator WCSPR resmi **kalian** — satu
> loop, satu perintah. Itulah AgentGate, di Casper."

**🖥️ LAYAR AKHIR (freeze 3–4s):**
```
example.invalid/AgentGate   ·   npx @neargate/cli@latest   ·   agentgate.example.org
native CSPR + official CSPR.cloud WCSPR facilitator — both live on Casper Testnet
```

**🎬 Sutradara:** end calm; hold the end-card for a thumbnail. Kriteria: **Innovation, Long-Term
Impact, Long-Term Launch Plans.**

---
---

## ✂️ THE 2:00 CUT (if the portal limit is 2:00 or less)

| Keep | Scene | ~time |
|------|-------|-------|
| ✅ | 0 — Hook (trim to 1 sentence) | 0:00–0:10 |
| ✅ **MUST** | 1 — Official facilitator rail (WCSPR settle) | 0:10–0:50 |
| ✅ (trim) | 2 — Rail-agnostic + native explorer cycle only | 0:50–1:05 |
| ✅ **MUST** | 4 — Autonomous Claude agent | 1:05–1:42 |
| ✅ (trim) | 6 — Trust + close | 1:42–2:00 |
| ❌ drop | 3 — wrap | — |
| ❌ drop | 5 — MCP | — |

The two non-negotiable scenes for this jury: **Scene 1 (their facilitator, live)** and **Scene 4
(autonomous agent)**.

---

## 🏆 Scene → 8 Casper criteria map

| Criterion | Scenes |
|---|---|
| Working Smart Contracts (Testnet) | 1 (attestation w/ settle hash), 2 (full lifecycle), 6 |
| Technical Execution | 1 (EIP-712 + facilitator settle), 2, 4 (386 tests in repo) |
| **Use of AI / Agentic Systems** | **4** (real Claude loop), 5 (MCP tools) |
| Real-World Applicability (DeFi/RWA) | 1 (FX feed, WCSPR micropayment), 2 (RWA FX+gold oracle) |
| Innovation & Originality | 1 (rail-agnostic on official + native), 6 (reputation = receipt) |
| UX & Design | 0/6 (dashboard, `/activity`), 3 (one-liner wrap) |
| Long-Term Launch Plans | 3 (wrap = funnel), 6 (npm live, mainnet roadmap) |
| Long-Term Impact | 6 (shared on-chain reputation graph on Casper) |

---

## 🚫 DON'T CLAIM (updated for finals — a Casper engineer will check)

- ✅ **NOW CLAIM (reversed from qualification):** "AgentGate runs the official CSPR.cloud x402
  facilitator, CEP-18 + EIP-712, settling WCSPR, live" — this is verified (settle tx `17ad3580…`).
  The old "don't claim official x402 spec" caveat is **retired**.
- ❌ "most settlements / highest volume" — **Sluice has 275+ real settlements.** Our claim is
  *"the only project running BOTH a native-CSPR rail AND your official CEP-18/EIP-712 WCSPR
  facilitator behind one buy command, with on-chain payment-backed reputation."*
- ❌ "fully autonomous AI with no fallback" — it's a real Claude loop (autonomous claim is valid);
  just don't deny the MockLlm offline fallback if asked (disclose it — see `JUDGE_QA.md`).
- ❌ Any social/traction metric that doesn't exist. Anchor every claim to a tx hash / live endpoint.
- ❌ Don't imply we authored WCSPR or the facilitator — we *integrate* their canonical token + hosted
  facilitator. Say "canonical WCSPR" and "the CSPR.cloud hosted facilitator."
