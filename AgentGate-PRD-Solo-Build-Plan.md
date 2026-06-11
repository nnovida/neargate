# AgentGate v2 — PRD Ringkas + Solo Build Plan
### Casper Agentic Buildathon 2026 · Qualification deadline: 30 Juni 2026 · Sprint: 16–30 Juni (15 hari, ~8 jam/hari, WITA)

---

## 1) Problem Statement & Target User

**Problem statement.** AI agent tidak bisa membayar API: tidak punya kartu kredit, tidak bisa lewat KYC, dan tidak bisa membuat akun — sementara penyedia API tidak bisa memonetisasi traffic mesin karena rel pembayaran existing (Stripe dkk.) punya minimum fee yang membunuh micropayment dan model billing yang mengasumsikan manusia. Di Casper masalah ini lebih tajam lagi: x402 baru live Juni 2026 dan **belum ada satu pun tooling** untuk meng-onboard layanan — setiap provider harus hand-roll verifikasi pembayaran sendiri, dan agent tidak punya cara menemukan ataupun mempercayai layanan yang ada.

**Target user (two-sided, ICP tajam):**

- **Seller — indie API/data provider & oracle operator.** Developer crypto-native (solo s.d. tim kecil) yang punya data berharga (harga RWA, kurs, feed apa pun) dan ingin revenue stream baru dari agent traffic tanpa membangun billing. Berkumpul di: GitHub, X, Discord ekosistem chain, DoraHacks.
- **Buyer — agent developer.** Builder yang merangkai agent (Claude/GPT + MCP/skills) dan butuh data berbayar *on-demand, tanpa pre-registrasi, tanpa API key.*
- **Persona demo:** RWA data feed (kurs USD/IDR + harga emas spot) yang dikonsumsi oleh research agent otonom.

**One-liner produk:** *"Stripe untuk AI agent di Casper — ubah API apa pun jadi layanan berbayar x402 dalam satu perintah, lengkap dengan discovery dan reputasi on-chain."*

---

## 2) Core User Flow (happy path saja)

```
SELLER (sekali, <5 menit)
  npx agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"
   └─→ middleware ter-konfigurasi → TX register_service ke kontrak Registry (Testnet)
   └─→ output: endpoint URL + halaman listing di katalog dashboard

BUYER AGENT (berulang, otonom)
  1. Agent query Registry on-chain → menemukan "Gold Spot Feed" (harga, endpoint, skor reputasi)
  2. GET endpoint → HTTP 402 Payment Required + invoice {price, payment_target, nonce}
  3. Agent sign & transfer CSPR (Testnet) dengan transfer_id = nonce   ← TX #1 on-chain
  4. Retry GET dengan payment proof → middleware verifikasi via CSPR.cloud → 200 + data
  5. Middleware memanggil record_attestation di kontrak                ← TX #2 on-chain
  6. Dashboard update live: revenue naik, attestation tercatat, skor reputasi +1
```

Satu loop = **dua transaksi on-chain riil** yang terlihat di explorer testnet. Itulah wow moment demo: selesai di layar dalam <60 detik.

---

## 3) Fitur MVP — Triage Table

Hanya fitur yang melayani demo. Budget total sprint ≈ 15 hari × 8 jam = **120 jam**; MVP = 81 jam + overhead (setup 8j, debugging 10j, docs 4j, video 6j, submit 2j) ≈ **111 jam**. Margin tipis tapi realistis.

| Fitur | Impact | Estimasi jam | MVP? |
|---|---|---|---|
| Kontrak Odra `AgentGateRegistry` (register_service, record_attestation, get_service, get_score) — SATU kontrak, bukan dua | **H** | 16 | **YA** |
| Payment middleware "wrap" (402 challenge → verifikasi bayar → proxy serve → trigger attestation) | **H** | 14 | **YA** |
| TS client helper untuk agent (parse 402 → sign & pay via casper-js-sdk → retry) | **H** | 8 | **YA** |
| Buyer demo agent (LLM loop: baca registry → pilih → bayar → konsumsi → ringkas) | **H** | 10 | **YA** |
| RWA Oracle service (kurs USD/IDR + emas, confidence heuristic, di-wrap AgentGate, terdaftar on-chain) | **H** | 6 | **YA** |
| Dashboard (katalog, detail layanan + trust badge, live feed TX/attestation via polling, revenue counter) | **H** | 16 | **YA** |
| CLI `agentgate wrap <url> --price` (kalimat "satu perintah" di pitch) | M | 6 | **YA** |
| Landing page + akun X proyek (kriteria juri #7 Long-Term Launch Plans) | M | 5 | **YA** |
| CSPR.cloud **Streaming** real-time (ganti polling) | M | 6 | TIDAK — Final Round |
| Casper MCP Server demo (Claude query chain state langsung) | M | 4 | TIDAK — Final Round |
| Reputation decay / slashing logic | L | 6 | TIDAK — skor counter sederhana cukup |
| Multi-asset feeds tambahan | L | 8 | TIDAK — seed manual 2–3 entri katalog |
| x402 Facilitator jalur mainnet | M | ? | TIDAK — kualifikasi wajib Testnet |
| Fiat off-ramp seller | L | — | TIDAK — roadmap slide saja |
| Auth/akun dashboard | L | — | TIDAK — dashboard read-only publik |

---

## 4) Arsitektur & Tech Stack

Prinsip: **logika berat di TypeScript (zona kekuatanmu), Rust/Odra seminimal mungkin (satu kontrak kecil), semua infra managed.**

| Layer | Pilihan | Alasan / catatan |
|---|---|---|
| Smart contract | **Odra (Rust) → Casper Testnet** — 1 kontrak `AgentGateRegistry` | Satu-satunya komponen di luar zona nyamanmu. Mitigasi: Odra punya `llms.txt` → tulis dengan AI-assisted coding (Claude Code); event sendiri mendorong "working with AI for building onchain solutions". Scope dikunci: 4 entrypoint, storage sederhana (Mapping service_id → metadata; Mapping service_id → Vec<attestation>) |
| Payment & signing | **casper-js-sdk (TS)** untuk transfer + signing; verifikasi via **CSPR.cloud REST** | Plan A: x402 Facilitator jika tersedia di Testnet (tanya Discord SEKARANG). Plan B (fallback, default rencana ini): transfer CSPR testnet dengan `transfer_id = nonce` ber-semantik 402 — tetap "transaction-producing on-chain component" ✓ |
| Middleware/proxy | **Node.js + Express (TS)**, deploy **Railway** (managed) | Reverse-proxy + 402 logic + attestation trigger. Stateless; config layanan dari registry on-chain |
| Buyer agent | **Node TS + Anthropic API (Claude)** sebagai decision loop | Otonom tapi ter-kurasi untuk demo; log setiap keputusan agar terlihat agentic di video |
| Oracle data | exchangerate API / metals API free tier | Confidence score = heuristik sederhana (deviasi antar-sumber), bukan model berat |
| Dashboard | **Next.js 14 + Tailwind**, deploy **Vercel** | Zona kekuatan product design-mu; polling CSPR.cloud tiap 5 detik (streaming = Final Round) |
| Repo | Monorepo: `/contracts` `/middleware` `/agents` `/dashboard` `/cli` | Satu repo publik, rapi untuk juri |

**REAL (wajib nyata):** kontrak ter-deploy di Testnet · transfer pembayaran on-chain · TX attestation · dashboard membaca data chain sungguhan · satu API ter-wrap end-to-end (oracle RWA).
**MOCK/SEED (sah untuk demo):** 2–3 entri katalog tambahan (seed manual) · risk/confidence model (heuristik) · buyer agent semi-scripted (LLM tetap mengambil keputusan, alur dikurasi) · fiat off-ramp (roadmap saja).

---

## 5) Integrasi Sponsor-Tech → Mapping ke Kriteria

**Catatan jujur:** event ini **tidak punya sponsor bounties terpisah** — satu track terpadu (Casper Innovation Track). In-kind co-sponsor rewards ($20k) ada, tapi kriterianya tidak dipublikasikan (**DATA TIDAK DITEMUKAN** — pantau announcement Discord/DoraHacks). Maka mapping dilakukan ke **8 kriteria juri resmi**, yang fungsinya setara "bounty criteria" di event ini:

| Komponen Casper AI Toolkit | Cara dipakai AgentGate | Kriteria juri yang dipenuhi | Status |
|---|---|---|---|
| **x402 Micropayments** | Semantik 402 di seluruh payment flow (challenge → pay → proof); Facilitator asli jika tersedia di Testnet | #2 Innovation · #3 AI/Agentic · #4 Real-World (DeFi) | REAL (Plan A/B) |
| **Odra Framework** | Kontrak `AgentGateRegistry` ditulis & ter-deploy di Testnet; manfaatkan llms.txt utk AI-assisted dev | **#6 Working Smart Contracts** · #1 Technical Execution | REAL |
| **CSPR.cloud (REST)** | Verifikasi pembayaran + data feed dashboard | #1 Technical Execution · #5 UX | REAL |
| **casper-js-sdk / CSPR.click Agent Skill** | Wallet & signing sisi agent (Skill = stretch; minimal js-sdk) | #3 AI/Agentic | REAL (sdk) / stretch (Skill) |
| **Casper MCP Server** | Claude query state chain dalam demo | #3 AI/Agentic | Final Round |
| **CSPR.cloud Streaming** | Live feed real-time dashboard | #5 UX | Final Round |
| RWA oracle use-case (example build #2 panitia) | Flagship demo service | **#4 Real-World (RWA)** · #8 LT Impact | REAL |
| Landing + socials + roadmap mainnet | Bukti proyek hidup | **#7 Launch Plans** · #8 LT Impact | REAL |

Semua 8 kriteria tertutup; tidak ada kriteria yang bergantung pada komponen mock.

---

## 6) Timeline Jam-per-Jam (WITA) — 16–30 Juni

Asumsi 8 jam produktif/hari (09:00–13:00, 14:00–18:00). **Sebelum 16 Juni (≤30 menit, jangan ganggu deadline 15 Juni):** register DoraHacks · join Discord/Telegram Casper · post pertanyaan *"apakah x402 Facilitator tersedia di Testnet?"* · bookmark docs Odra + llms.txt.

| Hari | Blok jam | Pekerjaan |
|---|---|---|
| **D1 · Sel 16/6** | 09–12 | Setup env: Rust toolchain, cargo-odra, casper client, faucet testnet, CSPR.cloud API key |
| | 13–16 | Tutorial Odra: kontrak hello-world → deploy Testnet → verifikasi di explorer |
| | 16–17 | Cek jawaban Discord → **kunci Plan A (x402 testnet) atau Plan B (CSPR transfer)** |
| | 17–18 | Scaffold monorepo + commit pertama (mulai jejak commit history) |
| **D2 · Rab 17/6** | 09–13 | Kontrak `AgentGateRegistry`: storage + entrypoints |
| | 14–16 | Unit tests Odra |
| | 16–18 | Deploy Testnet + query state via CSPR.cloud |
| **D3 · Kam 18/6** | 09–13 | Hardening kontrak (edge cases) + redeploy final |
| | 14–18 | Middleware: proxy skeleton + 402 challenge (nonce, price, target) |
| **D4 · Jum 19/6** | 09–13 | Verifikasi pembayaran (CSPR.cloud lookup by transfer_id) + serve-after-pay |
| | 14–18 | Trigger `record_attestation` on-chain pasca-serve. **⚠️ CHECKPOINT PIVOT 18:00: satu loop bayar→data→2 TX hash HARUS jalan. Kalau tidak → buang discovery, fokus loop saja** |
| **D5 · Sab 20/6** | 09–13 | TS client helper agent (parse 402 → pay → retry) |
| | 14–18 | CLI `agentgate wrap` v0 |
| **D6 · Min 21/6** (6j) | 09–13 | RWA oracle service: fetch kurs + emas, confidence heuristic |
| | 14–16 | Wrap via AgentGate + `register_service` on-chain |
| **D7 · Sen 22/6** | 09–13 | Buyer agent: LLM loop (registry → pilih → bayar) |
| | 14–18 | Konsumsi → ringkasan → logging keputusan yang demo-friendly |
| **D8 · Sel 23/6** | 09–18 | **Hari integrasi & bug.** Loop penuh dijalankan berulang; rekam test internal. Buffer — integration debt selalu muncul |
| **D9 · Rab 24/6** | 09–18 | Dashboard #1: Next.js + Tailwind — katalog (read registry) + detail layanan + trust badge |
| **D10 · Kam 25/6** | 09–13 | Dashboard #2: live feed TX/attestation (polling), revenue counter |
| | 14–17 | Deploy Vercel + polish visual |
| | 17–18 | **Mulai kampanye CSPR.fans** (post X, minta vote komunitas) |
| **D11 · Jum 26/6** | 09–18 | Polish UX end-to-end · seed 2–3 layanan katalog · copywriting produk |
| **D12 · Sab 27/6** (6j) | 09–12 | Landing page + akun X proyek |
| | 13–16 | README lengkap (arsitektur, cara run, alamat kontrak + contoh TX hash) + isi BUIDL page DoraHacks |
| **D13 · Min 28/6** (6j) | 09–15 | Bug terakhir + 2× dry-run skrip demo + storyboard video |
| | **18:00** | **🛑 HARD STOP CODING — tidak ada fitur baru setelah ini** |
| **D14 · Sen 29/6** (6j) | 09–13 | Rekam demo video (loop penuh + TX hash di explorer) |
| | 14–16 | Edit + upload YouTube (public) · final check repo (license, .env.example, no secrets) |
| **D15 · Sel 30/6** | 08–10 | **SUBMIT** di DoraHacks (pagi WITA = aman terhadap interpretasi timezone deadline mana pun) |
| | 10–12 | Verifikasi submission tampil benar · standby Discord |

Hotfix pasca-28/6 hanya boleh untuk bug yang *memblokir demo* — bukan improvement.

---

## 7) Checklist Submission

**Wajib menurut rules event (3 item):**
- [ ] **Working prototype di Casper Testnet** dengan transaction-producing on-chain component → bukti: alamat kontrak + ≥2 jenis TX hash (payment transfer + attestation) dicantumkan di README & BUIDL page
- [ ] **GitHub repo open-source** + README berisi dokumentasi & usage instructions
- [ ] **Demo video publik** — durasi **tidak ditentukan event (DATA TIDAK DITEMUKAN)** → target 3 menit: hook 20s → problem 20s → live demo loop 90s → arsitektur 20s → launch plan 20s → CTA 10s. Wajib memperlihatkan TX hash di explorer testnet secara live

**Repo hygiene (kriteria #1 + compliance original-code):**
- [ ] Repo dibuat ≥16 Juni (dalam periode buildathon); commit history bertahap & bermakna (conventional commits), BUKAN satu dump raksasa
- [ ] License MIT/Apache-2.0 · `.env.example` · tidak ada secrets/API keys ter-commit
- [ ] README: problem → arsitektur (diagram) → alamat kontrak testnet → cara run lokal → link video & dashboard → catatan tanggal mulai build (jejak originality)
- [ ] **Zero kode dari proyek Mantle/MetaMask** — konsep boleh mirip, kode harus 100% baru (stack-nya pun beda: Rust/Odra)

**Tidak diwajibkan, tapi memperkuat:**
- [ ] **Deploy URL** dashboard (Vercel) + endpoint demo live — tidak eksplisit disyaratkan, sangat direkomendasikan
- [ ] **Slide deck: TIDAK dibutuhkan untuk Qualification** (syarat hanya prototype+repo+video). Siapkan draft 8–10 slide untuk Final Round demo day akhir Juli
- [ ] Landing page + akun X aktif (kriteria juri #7)
- [ ] Project terdaftar & ter-publish di CSPR.fans untuk voting; 2–3 post kampanye mulai 25/6
- [ ] BUIDL page DoraHacks lengkap: logo, tagline, screenshot, tags, semua link

---

*Dokumen ini adalah turunan eksekusi dari "AgentGate-Strategi-Final-Casper-Agentic-Buildathon-2026.md". Jika jawaban Discord soal x402 Testnet mengubah Plan A/B, hanya D1 16–17 dan D4 yang terdampak — sisanya tetap.*
