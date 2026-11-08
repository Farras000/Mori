# Deploy VPS + Google Login (cara ringan, tanpa browser di VPS)

Panduan ini khusus untuk VPS kecil (misal Azure free tier, Ubuntu). Prinsipnya:

> VPS **tidak pernah** membuka Google. Bagian klik-klik Google dikerjakan di
> Chrome laptop kamu (persis seperti WebView2 di game asli), lalu **tokennya**
> dikirim ke VPS. VPS hanya menjalankan bot.

Tidak perlu install Chrome / Chromium / Xvfb / Docker-with-browser di VPS.

---

## 0. Yang kamu butuhkan

- VPS Ubuntu (SSH bisa login: `ssh azureuser@IP-VPS`)
- Mori jalan di VPS (binary release atau Docker — lihat bagian 1)
- Proxy residential/sticky yang biasa dipakai bot (misal VSPROXY) — **wajib**,
  karena IP Azure ditolak Growtopia
- Laptop dengan Chrome
- MAC address bot (XX:XX:XX:XX:XX:XX)

---

## 1. Deploy Mori ke VPS

**Opsi A — binary (paling simpel):**
```bash
# di VPS
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
# clone repo, lalu:
cargo build --release
mkdir -p logs
MORI_GRPC_ADDR=127.0.0.1:50051 MORI_GRPC_TOKEN=isi-dengan-token-panjang-acak \
  nohup ./target/release/Mori > logs/mori.log 2>&1 &
```

**Opsi B — Docker:**
```bash
# di VPS: clone repo, buat .env (MORI_GRPC_ADDR=0.0.0.0:50051, MORI_GRPC_TOKEN=...)
docker compose up -d --build
```
`data/` (token Google, user.json, bots.json) tersimpan di volume `mori-data`.
Port compose ter-bind ke `127.0.0.1` saja (lihat docker-compose.yml) — akses dari
laptop lewat tunnel `ssh -L 3000:localhost:3003 azureuser@IP-VPS`.

**Jangan expose port 3000/3003/50051 ke internet.** Bind gRPC ke `0.0.0.0` itu internal container saja; di host, firewall tutup semuanya kecuali 22:
```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw enable
```

---

## 2. Buka dashboard dari laptop lewat SSH tunnel

Di terminal laptop:
```bash
ssh -L 3000:localhost:3000 azureuser@IP-VPS
```
Biarkan terminal itu terbuka, lalu buka **http://localhost:3000** di Chrome laptop.
(Kalau tidak pakai tunnel: Tailscale juga bisa. Jangan `http://IP-VPS:3000`
langsung ke internet.)

Catatan: tunnel hanya menyambungkan laptop ↔ Mori. Request mint ke Growtopia
tetap berangkat dari VPS — makanya proxy di langkah 3 itu wajib diisi.

---

## 3. Google login (klik di laptop, token ke VPS)

1. Di dashboard → **Add Bot → tab Google**.
2. Isi **MAC** (format XX:XX:XX:XX:XX:XX) dan kolom **proxy** (sticky residential,
   sama seperti bot). Klik **Start Google login**.
3. Session dibuat (`waiting_browser` / `watching`). VPS tidak punya browser, jadi
   status "Open browser" tidak akan muncul — itu normal.
4. Klik link **"Open externally instead"** → terbuka `accounts.google.com/...`
   di **Chrome laptop**. Login Google seperti biasa sampai halaman sukses.
5. Hasilnya kembali ke VPS lewat salah satu cara:

   **Cara A — helper extension (paling mulus, sekali install):**
   - Chrome → `chrome://extensions` → aktifkan **Developer mode** →
     **Load unpacked** → pilih `assets/mori-extension` di folder Mori.
   - Klik ikon extension → **Options**:
     - Backend address: biarkan `http://127.0.0.1:3000` (default, cocok dengan tunnel),
     - Mori API token: klik tombol **"Copy API token for the extension"** di tab
       Google (di bawah "Start Google login") lalu paste ke extension → **Save**.
   - Selesai install sekali; login berikutnya otomatis (halaman sukses terdeteksi,
     checktoken dijalankan **di dalam Chrome laptop** — persis pola embed game —
     lalu hasilnya dikirim ke VPS).

   **Cara B — manual (tanpa install apa-apa):**
   - Halaman sukses menampilkan token (deretan huruf panjang).
   - Copy token → paste di field **"Paste landing token"** → **Submit token**.
   - Kalau ditolak (jar split), paste **URL `/google/callback?...`** dari address
     bar ke field **"Paste /google/callback URL…"** → **Submit callback URL**.

6. Status berubah jadi **Validated** → klik **Spawn bot**. Bot masuk game lewat
   proxy yang sama.

---

## 4. Login berikutnya (tanpa browser)

- Tab Google → **Re-validate token** = refresh sekali POST, tanpa browser.
- Token tervalidasi tersimpan di VPS: `data/google_oauth_tokens.jsonl`.

---

## 5. Kalau gagal — cek ini dulu

| Gejala | Penyebab | Solusi |
|---|---|---|
| Start gagal: `403` / `http status: 403` | IP VPS (datacenter) ditolak Akamai | Isi proxy residential di form Google, ulangi Start |
| Status `waiting_browser` terus | Wajar — VPS tidak punya browser | Pakai "Open externally instead" + Cara A/B di atas |
| Landing page sukses tapi `failed` "jar split" | Token divalidasi dari VPS, cookie ada di laptop | Pakai extension (Cara A), atau paste callback URL |
| Extension tidak melaporkan | Token belum di-paste ke options / backend bukan `127.0.0.1:3000` | Isi ulang options + klik "Test connection" |
| `mint failed after 3 attempts` | Semua kandidat (proxy+gt1/gt2, direct) ditolak | Ganti IP proxy; coba beberapa kali (throttle) |
| Bot gagal connect setelah spawn | IP/proxy bot juga ditolak Growtopia | Proxy yang sama untuk bot; cek log `[Bot]` di Console |

---

## 6. Ringkasan kenapa ini ringan

- Tidak ada browser di VPS → RAM tetap kecil (~cukup untuk Mori + bot).
- Tidak ada tampilan virtual (Xvfb) → CPU idle.
- Klik Google terjadi di laptop kamu → Google percaya (IP rumah).
- VPS tidak pernah terekspos internet selama pakai SSH tunnel / Tailscale.
