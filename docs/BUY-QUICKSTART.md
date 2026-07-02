# Buy Quickstart — Membeli Service AgentGate dari PC/Laptop Lain

Panduan membeli (memanggil) sebuah service berbayar AgentGate dari mesin lain.

**Update (v0.1.2):** CLI terpublish `@neargate/cli` kini **punya** command
`buy` — cara termudah membeli dari mesin mana pun, tanpa clone repo:

```bash
npx @neargate/cli buy <id> --pem ./key.pem --max 5
# body respons → stdout (pipeable); kuitansi pembayaran → stderr
```

`buy` menjalankan seluruh **protokol x402** untuk Anda:

```
GET /svc/<id>  →  HTTP 402 + invoice (nonce, payTo, harga)
     →  bayar: native CSPR transfer ke payTo, transfer-id = nonce
     →  GET /svc/<id> lagi dengan header X-PAYMENT (bukti bayar)
     →  gateway verifikasi transfer on-chain  →  200 + data upstream
```

Ada **tiga cara** menjalankan alur ini dari PC lain:

- **Cara 0 — `agentgate buy`** (di atas): satu perintah, hanya butuh PEM funded.
  Flag: `--max <cspr>` (tolak invoice di atas budget), `--method`, `--body <json>`,
  `--gateway <url>`. Env alternatif `--pem`: `BUYER_SIGNER_PEM_PATH`.
- **Cara A — Buyer agent otonom** (`npm run agent`): agen LLM yang memilih
  service, membayar, dan merangkum datanya. Butuh repo di-clone.
- **Cara B — Manual x402** (curl + transfer): integrasi mentah dari bahasa/PC
  apa pun, tanpa clone repo (tapi Anda yang melakukan transfer-nya).

---

## Prasyarat umum (untuk kedua cara)

1. **Akun Casper Testnet ber-PEM yang sudah funded.** Tiap panggilan memerlukan
   **≥ 2.5 CSPR** (lihat catatan minimum di bawah) + ~0.1 CSPR gas transfer.
   Isi dari faucet: <https://testnet.cspr.live/tools/faucet>.
2. **Service tujuan harus aktif, sudah ter-map di gateway, dan berharga ≥ 2.5 CSPR.**
   Cek dulu dari mesin mana pun (zero-env):
   ```bash
   npx @neargate/cli list           # lihat id, harga, tier, ACTIVE
   npx @neargate/cli status <id>    # lihat payTo, endpoint, harga
   curl -i https://gateway.example.org/svc/<id>   # harus 402 (bukan 403/404/503)
   ```

> **⚠️ Minimum transfer native Casper ~2.5 CSPR.** Transfer native di bawah
> ~2.5 CSPR ditolak node dengan *"Invalid transaction"*. Jadi Anda selalu
> membayar **≥ max(2.5 CSPR, harga service)**. Konsekuensinya: service yang
> diberi harga < 2.5 CSPR (mis. "Test Feed" 0.5 CSPR) **tidak bisa dibeli**
> lewat rail native ini — buyer agent membayar tepat sebesar harga, sehingga
> transfernya akan gagal. Untuk uji beli end-to-end, targetkan service yang
> harganya ≥ 2.5 CSPR.

> **⏱️ Invoice berlaku 5 menit.** `nonce` yang diterbitkan gateway hanya sah
> selama `INVOICE_TTL_MS` (default 300000 ms). Transfer + kirim bukti dalam
> jendela itu, dan tiap `nonce` hanya bisa dipakai **sekali**.

---

## Cara A — Buyer agent otonom (`npm run agent`)

Paket buyer bersifat privat (tidak di npm), jadi jalankan dari repo yang
di-clone.

```bash
git clone https://example.invalid/AgentGate.git
cd AgentGate
npm install
```

Set environment (buyer agent memakai `loadConfig()` langsung — tidak ada
default live seperti pada CLI, jadi mode/registry/cloud-key harus eksplisit):

```bash
export AGENTGATE_MODE=live
export REGISTRY_CONTRACT_PACKAGE_HASH=hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9
export CSPR_CLOUD_API_KEY=<kunci CSPR.cloud Anda>   # WAJIB di live mode
export BUYER_SIGNER_PEM_PATH=./buyer.pem            # PEM Testnet yang funded
# opsional:
export ANTHROPIC_API_KEY=<kunci>   # tanpa ini, pemilih service pakai MockLlm
export BUYER_BUDGET_CSPR=5         # batas belanja, default 5
export CASPER_NODE_URL=<rpc>       # default node.testnet.casper.network/rpc
```

Jalankan:

```bash
npm run agent -- --task "Ambil kurs USD/IDR & harga emas untuk laporan treasury" --budget 5
```

Yang dilakukan agen (dicetak sebagai blok STEP 1–6, juga ke `logs/decisions.jsonl`):

1. **Catalog** — baca daftar service on-chain + skor + trust tier.
2. **Decision** — LLM memilih satu service (MockLlm bila tanpa `ANTHROPIC_API_KEY`).
3. **Budget** — tolak bila harga melebihi budget (sebelum membayar).
4. **Payment** — bayar via transfer native (transfer-id = nonce invoice), lalu
   kirim ulang dengan `X-PAYMENT`; menangani `settlement_pending` (retry s/d 5×).
5. **Report** — merangkum data yang dibeli.
6. **Receipt** — polling attestation on-chain (≤ 5 dtk) untuk bukti skor.

> Catatan: `CSPR_CLOUD_API_KEY` di sini dipakai buyer agent untuk membaca
> attestation (langkah 6) dan divalidasi saat startup live mode. Registrasi dan
> transfer sendiri lewat node RPC.

---

## Cara B — Manual x402 (curl + transfer, dari PC/bahasa apa pun)

Tidak perlu clone repo. Sisi buyer **tidak** butuh kunci CSPR.cloud (verifikasi
transfer dilakukan server). Anda hanya perlu: PEM Testnet funded + cara mengirim
transfer native ber-transfer-id + `curl`.

Anggap `GW=https://gateway.example.org` dan service id `ID`.

### 1. Ambil invoice (402)

```bash
curl -s $GW/svc/$ID
```

Contoh body (ambil tiga nilai ini):

```json
{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{
  "scheme":"exact","network":"casper-test",
  "maxAmountRequired":"2500000000",          // ← harga dalam MOTES (1 CSPR = 1e9)
  "asset":"CSPR",
  "payTo":"account-hash-de24…",              // ← tujuan transfer (ACCOUNT-HASH)
  "resource":"https://gateway.example.org/svc/ID",
  "extra":{"nonce":"1729132567522738", ...}  // ← transfer-id yang WAJIB dipakai
}]}
```

### 2. Kirim transfer native CSPR

Buat **native transfer** dengan:
- **target** = `payTo` (sebuah **account-hash**, bukan public key),
- **amount** = `max(2500000000, maxAmountRequired)` motes (≥ 2.5 CSPR & ≥ harga),
- **transfer-id (`id`)** = `extra.nonce` (u64 desimal), **persis** nilai itu,
- **chain-name** = `casper-test`, **payment (gas)** = `100000000` (0.1 CSPR).

Simpan **deploy hash**-nya. Ini persis yang dilakukan
`LiveCasperClient.transfer` di `packages/chain/src/live.ts` — sketsa dengan
`casper-js-sdk` v5 (mirror kode repo):

```js
// casper-js-sdk v5 tidak andal di-`import` bernama pada node/tsx polos —
// muat lewat createRequire (lihat packages/chain/src/sdk.ts). Di dalam bundler
// (Vite/Next/webpack) import biasa boleh dipakai.
import { createRequire } from 'node:module';
import { BigNumber } from '@ethersproject/bignumber';
const { RpcClient, HttpHandler, NativeTransferBuilder, AccountHash, KeyAlgorithm, PrivateKey } =
  createRequire(import.meta.url)('casper-js-sdk');

const key = PrivateKey.fromPem(pemString, KeyAlgorithm.ED25519); // coba SECP256K1 bila gagal
const rpc = new RpcClient(new HttpHandler('https://node.testnet.casper.network/rpc'));

const tx = new NativeTransferBuilder()
  .from(key.publicKey)
  .targetAccountHash(AccountHash.fromString(payTo))  // payTo dari invoice
  .amount('2500000000')                              // ≥ 2.5 CSPR & ≥ harga (motes)
  .id(BigNumber.from(nonce))                         // transfer-id = extra.nonce (u64)
  .chainName('casper-test')
  .payment(100000000)                                // 0.1 CSPR gas
  .build();
tx.sign(key);
const result = await rpc.putTransaction(tx);
const deployHash = result.transactionHash.toHex();   // ← 64-hex, dipakai di X-PAYMENT
```

Alternatif `casper-client transfer` juga bisa, tetapi target di sini berupa
**account-hash**; pastikan versi/flag klien Anda mendukung target account-hash
dan `--transfer-id <nonce>` (perilaku flag berbeda antar versi — verifikasi
dengan `casper-client transfer --help`).

### 3. Susun header `X-PAYMENT`

Header = **base64 dari JSON** berikut (field persis; deploy hash 64-hex,
transferId = nonce yang sama):

```json
{"x402Version":1,"scheme":"exact","network":"casper-test",
 "payload":{"transaction":"<deployHash 64-hex>","transferId":"<nonce>"}}
```

```bash
XPAY=$(printf '%s' '{"x402Version":1,"scheme":"exact","network":"casper-test","payload":{"transaction":"<deployHash>","transferId":"<nonce>"}}' | base64 -w0)
```

### 4. Kirim ulang dengan bukti

```bash
curl -i $GW/svc/$ID -H "X-PAYMENT: $XPAY"
```

- **200** + body upstream → sukses. Header `X-PAYMENT-RESPONSE` (base64) berisi
  konfirmasi settlement `{success, transaction, network, payer}`.
- **402 `settlement_pending`** dengan `Retry-After: 2` → transfer belum
  ter-finalize; tunggu ~2 dtk dan **kirim ulang header yang sama** (s/d ~5×).
- **402 lain** (`invalid_payment_header`, `unknown_nonce`, `invoice_used`,
  `invoice_expired`, `wrong_target`, `amount_too_low`, `wrong_transfer_id`,
  `expired`, `not_found`) → invoice/pembayaran tidak cocok; ambil invoice
  **baru** (langkah 1) dan ulangi.

---

## Verifikasi hasil

```bash
# Skor service bertambah setelah panggilan sukses (butuh CSPR.cloud key untuk riwayat)
npx @neargate/cli status <id> --api-key <CSPR.cloud key>
```

Panggilan sukses memicu `record_attestation` on-chain, jadi kolom trust
`(sukses/total)` naik. Pembayaran oleh pemilik/akun payout service tidak
dihitung (anti wash-trading).

## Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Transfer gagal *"Invalid transaction"* | Amount < ~2.5 CSPR. Bayar ≥ 2.5 CSPR **dan** ≥ harga. |
| Selalu dapat 402 walau sudah bayar | `nonce`/`payTo`/amount/deploy-hash tidak cocok, atau invoice sudah kedaluwarsa (>5 mnt) / terpakai. Ambil invoice baru lalu bayar ulang dengan nonce baru. |
| `402 settlement_pending` terus | Transfer belum masuk blok; tunggu Retry-After dan kirim ulang header yang sama. Cek deploy di <https://testnet.cspr.live>. |
| `403 service_inactive` | Service di-pause pemilik. |
| `404 service_not_found` | Id salah. |
| `503 service_unavailable` | Service belum ter-map di gateway (atau upstream-nya privat). |
| Buyer agent gagal start di live | Kurang `AGENTGATE_MODE=live`, `REGISTRY_CONTRACT_PACKAGE_HASH`, `CSPR_CLOUD_API_KEY`, atau `BUYER_SIGNER_PEM_PATH`. |

Terkait: alur penjual di [WRAP-QUICKSTART.md](WRAP-QUICKSTART.md); loop berbayar
lengkap di [TESTING.md](TESTING.md) §4e.
