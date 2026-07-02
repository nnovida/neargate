# Wrap Quickstart — Test `agentgate wrap` dari PC Lain

Panduan singkat menjalankan `agentgate wrap` di mesin baru (tanpa clone repo,
tanpa env var, tanpa API key). CLI terpublish di npm sebagai
[`@neargate/cli`](https://www.npmjs.com/package/@neargate/cli) dan
default-nya langsung menargetkan **Casper Testnet live** + gateway hosted.

## Prasyarat

1. **Node.js ≥ 22** — cek dengan `node -v`. Bila masih lama (Ubuntu/WSL
   bawaan sering masih v12), upgrade dulu via nvm:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   exec bash
   nvm install 22
   ```
2. **File PEM Casper Testnet yang punya saldo.** Registrasi memakai gas
   **5 CSPR**, jadi siapkan minimal ±10 CSPR. Dua cara:
   - Salin PEM yang sudah funded dari PC utama (mis. `Priv_key_1`), **atau**
   - Buat key baru (ed25519 atau secp256k1) lalu isi dari faucet:
     <https://testnet.cspr.live/tools/faucet>
3. Koneksi internet (node RPC Testnet + gateway hosted).

Hanya itu. Perintah `wrap` dengan `--pem` tidak butuh env var apa pun — tidak
perlu API key CSPR.cloud, tidak perlu admin token (mapping ke gateway memakai
tanda tangan owner dari PEM yang sama).

## Jalankan

```bash
npx @neargate/cli wrap https://api.example.com/gold \
  --price 0.5 \
  --name "Gold Spot Feed" \
  --pem ./key.pem
```

> **Tip:** `https://api.example.com/gold` hanya placeholder — registrasi dan
> invoice 402 tetap jalan, tapi panggilan berbayar akan gagal di upstream
> karena URL itu tidak ada. Untuk test end-to-end penuh pakai API yang hidup,
> mis. `https://httpbin.org/json`.

Yang terjadi (±1–2 menit, menunggu eksekusi on-chain):

1. **Registrasi on-chain** — `register_service` ke registry yang sudah
   ter-deploy (`hash-10f92725…`) via node RPC
   `https://node.testnet.casper.network/rpc`, gas 5 CSPR.
2. **Mapping upstream ke gateway** — POST bertanda tangan owner ke
   `https://gateway.example.org/services/<id>/map`. URL upstream **tidak**
   disimpan on-chain; hanya gateway yang mengetahuinya.

Output sukses terlihat seperti:

```
service id:      7
public endpoint: https://gateway.example.org/svc/7
dashboard:       https://agentgate.example.org/services/7
register tx:     a1b2c3…
```

Baris `dashboard:` menunjuk ke dashboard hosted — buka di browser untuk
melihat detail service. (CLI < 0.1.1 masih mencetak `http://localhost:3000/…`;
ganti host-nya dengan `https://agentgate.example.org`.)

## Verifikasi

```bash
# katalog on-chain (zero-env, tanpa key)
npx @neargate/cli list

# detail satu service
npx @neargate/cli status <id>

# paywall hidup: harus menjawab HTTP 402 + invoice JSON
curl -i https://gateway.example.org/svc/<id>
```

## Aturan & flag penting

| Hal | Nilai |
| --- | --- |
| `--price` | CSPR desimal, minimal 0.000001 CSPR (1000 motes), maksimal 9 angka di belakang koma |
| `--pem` | private key Casper (ed25519 / secp256k1), wajib untuk write di mode live |
| `--description <d>` | deskripsi service (opsional) |
| `--gateway <url>` | ganti gateway (default hosted: `https://gateway.example.org`) |
| `--payment-target <accountHash>` | tujuan pembayaran (default: akun dari PEM) |
| `--attestor <publicKeyHex>` | key yang boleh mencatat attestation (default: public key PEM) |
| `--node-url` / `--registry` / `--mode` | override RPC node, registry hash, atau mode (default CLI terpublish: `live`) |

## Troubleshooting

- **`SIGNER_MISSING: live mode needs a seller key`** — path `--pem` salah atau
  file tidak terbaca.
- **`TX_FAILED` / saldo kurang** — key belum di-fund; isi dari faucet lalu
  ulangi.
- **`TX_TIMEOUT`** — testnet sedang lambat; cek tx hash di
  <https://testnet.cspr.live> sebelum mencoba lagi.
- **Warning "gateway upstream mapping … failed"** — registrasi on-chain
  **sudah jadi** dan tidak di-rollback. **Jangan jalankan `wrap` ulang**
  (akan membuat service duplikat); ulangi hanya langkah mapping setelah
  gateway bisa diakses (ikuti hint pada warning).
- **`SyntaxError: Unexpected token '?'` atau warning `EBADENGINE`** — Node
  terlalu lama (< 22); upgrade dengan perintah nvm di bagian Prasyarat, lalu
  jalankan ulang.
