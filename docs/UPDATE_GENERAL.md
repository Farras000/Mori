# Catatan Update Native Web Game (Panduan Umum)

Dokumen ini merangkum pembaruan terbaru pada mode bermain langsung di browser (**Native Web Game Mode** `/game`) serta perbaikan sistem gerakan, lompatan, dan efek perlengkapan karakter di **Mori**.

---

## Ringkasan Apa yang Berubah

### 1. Gerakan Jalan & Lari Lebih Alami (Tidak Lagi "Makin Lama Makin Kencang")
* **Sebelumnya:** Menahan tombol kiri/kanan terlalu lama membuat kecepatan karakter terus menanjak tidak wajar, dan tap singkat terasa kurang responsif.
* **Sekarang:** Kecepatan lari mengikuti batas kecepatan Growtopia normal (250 px/s default, maksimal 335 px/s saat memakai buff kecepatan), baik saat tap sebentar maupun saat tombol ditahan lama.

### 2. Logika Lompat Asli Growtopia (Tahan untuk Tinggi, Maks 2x Lompat, Bebas Spam Suara)
* **Tinggi lompatan mengikuti durasi tahan tombol:**
  * **Tap singkat:** Lompat rendah (< 1 block).
  * **Tahan sedang / dilepas di udara:** Karakter berhenti naik dan langsung turun tertarik gravitasi.
  * **Tahan penuh (tanpa Wings):** Bisa mencapai hingga **~3 block** (contoh: berdiri di `y=23` naik hingga `y=20`), dan tidak bisa melompat lagi atau melayang terus saat tombol tetap ditahan setelah mendarat.
* **Batas maksimal Double Jump:** Jika memakai Wings atau item lain dengan efek double jump (seperti sepatu khusus), klik tombol lompat kedua kali di udara memberi 1 lompatan tambahan (total **maksimal 2 kali** per lompatan, contoh hingga `y=17`). Tidak bisa melakukan lompat ke-3 di udara.
* **Suara lompat (SFX) & keamanan server:** Saat dipantau dari akun/client Growtopia lain, menahan tombol lompat sekarang hanya mengirim **1 sinyal lompat per lompatan** (atau 2 sinyal saat double jump). Suara lompat tidak lagi berbunyi berulang-ulang seperti spam, sehingga jauh lebih aman terhadap deteksi anti-cheat server.

### 3. Posisi Karakter Menapak Penuh di Permukaan Tanah
* **Sebelumnya:** Saat spawn, diam, berjalan, maupun setelah mendarat, posisi karakter tampak sedikit mengambang di atas block (baik terlihat di client Growtopia lain maupun di layar `/game`).
* **Sekarang:** Hitbox karakter diselaraskan dengan standar Growtopia (`20×30` px tanpa celah offset 2 px), posisi awal spawn langsung mengecek lantai di bawah kaki, dan tampilan sepatu/sol karakter di `/game` diturunkan agar menapak rapat di permukaan block rumput, batu, maupun platform.

### 4. Efek Item, Pakaian (Outfit), & Malady Otomatis Aktif + Bisa Dikombinasikan
Mori kini membaca item yang sedang dipakai bot across 9 slot pakaian serta status dari server (`items.dat`, efek karakter dari server, dan notifikasi Malady):
* **Item Gerak & Lompat:**
  * **Speedy** (menambah kecepatan jalan, bisa ditumpuk hingga 3 item).
  * **Double Jump** (tidak terbatas pada Wings saja — sepatu/item kaki dengan efek double jump juga terdeteksi otomatis).
  * **High Jump** & **Jetpack** (lompatan lebih tinggi atau lebih jauh ke samping saat menahan lompat di udara).
  * **Slow Fall / Parasol** (melayang turun lebih lambat saat tombol lompat ditahan ketika jatuh).
* **Item Tambang & Bangun:**
  * **Pickaxe / Punch Damage** meningkatkan damage pukulan per hit sehingga block lebih cepat hancur.
  * **Punch Range & Build Range** memperjauh jarak pukul dan jarak pasang block (bawaan 2 tile, bertambah otomatis sesuai perlengkapan, bisa dikombinasikan misalnya Pickaxe + item penambah jarak pukul).
* **Malady (Status Negatif):** Mendeteksi efek seperti *Chicken Feet* (jalan melambat & lompat lebih pendek) dan *Brainworms*, serta otomatis kembali normal saat sembuh.

### 5. Pembaruan Tampilan Layar Game (`/game`)
* **Lencana Efek Aktif di HUD:** Menampilkan daftar buff/debuff yang sedang aktif di karakter (contoh: `Speedy +10%`, `Double Jump`, `Punch Damage (8)`, `Punch Range (3t)`).
* **Backpack Lebih Rapi:** Tersedia tab **All**, **Blocks**, dan **Wearables**, serta penanda item pakaian yang sedang dipakai. Quickbar slot `1–2` tetap untuk **Fist** & **Wrench**, sedangkan slot `3–8` berisi item yang bisa dipakai/ditempatkan.
* **Progres Retak Block (`TileDamage`):** Animasi retak dan hitungan damage block menyesuaikan damage asli item (misalnya lebih cepat saat memakai Pickaxe).
* **Chat Lebih Bersih:** Pesan internal suara (`play_sfx`) difilter agar tidak mengotori jendela chat.
* **Ikon & Karakter Lebih Jelas:** Item datar (seperti celana/sepatu) diskalakan proporsional agar mudah dilihat di inventory, lengkap dengan animasi karakter dan arah hadap yang sinkron.

---

## Cara Menggunakan Secara Singkat

1. Jalankan Mori hasil build terbaru, buka dashboard di browser, lalu pilih **Go to Game** / **Play in Game** ke halaman `/game`.
2. Kontrol dasar tetap sama: `A`/`D` atau Panah Kiri/Kanan untuk berjalan, `W`/`Space`/Panah Atas untuk lompat (tahan lebih lama untuk lompat lebih tinggi), `S`/Panah Bawah turun dari platform, `B` buka Backpack, `Esc` buka Menu Game (termasuk opsi **Extended Reach** jika ingin memperluas jangkauan manual di luar item).
3. Ganti outfit/item (seperti Wings, Pickaxe, item Speedy, atau item Range) dari Backpack atau client — daftar efek aktif akan otomatis diperbarui di HUD.

---

## Update Lanjutan: Trade, Prioritas Wrench, Speech Bubble, Aset Dunia, & Perbaikan Dialog

Pembaruan lanjutan pada mode `/game` melengkapi interaksi native Growtopia agar sedekat mungkin dengan client asli:

* **Sistem Trade Player-to-Player (`TradeModal`):**
  * Mulai trade lewat chat `/trade <nama>`, wrench pemain lain, atau lewat daftar **Players** di header.
  * Menampilkan kolom item kedua pihak, status lock/accept, peringatan otomatis jika partner mengubah isi slot setelah terkunci, pemilih jumlah item dari Backpack, konfirmasi akhir, dan pembatalan trade.
* **Prioritas Wrench & Masuk Pintu Seperti Asli:**
  * Tile interaktif yang dipijak/diklik (Vending Machine, Pintu/Portal, Lock, Sign, Display Block, Shelf, Pohon) sekarang diprioritaskan saat klik Wrench/Klik Kanan agar tidak tertimpa aksi wrench diri sendiri.
  * Tahan `Shift + Klik` (atau tekan `R`) untuk wrench profil diri sendiri kapan saja, tahan `Alt + Klik` untuk mem-wrench tile di balik pemain lain, dan tekan `F` / Double-Click pintu (atau tombol HUD `Enter [F]`) untuk masuk pintu/portal.
  * Dialog pintu kini mendukung checkbox **Open to public**, pengaturan label/ID, dan opsi delete; Vending Machine/Lock/Sign mendukung elemen dialog native lengkap (`checkbox`, `add_item_picker`, `embed_data`).
* **Speech Bubble, Pakaian, Cuaca, & Audio (SFX):**
  * Balon dialog chat (`OnTalkBubble`) muncul menumpuk rapi di atas kepala karakter dan memudar otomatis.
  * Karakter menampilkan 9 slot pakaian (`OnSetClothing` & inventori), world menampilkan langit cuaca dinamis (Sunny, Sunset, Night, Storm, Desert, Snow, Space), serta memutar efek suara game dengan tombol Mute dan penyimpanan cache lokal (`cache/growtopia`) agar aset tidak terus diunduh ulang.
* **Perbaikan Aset Item & Rendering Tile:**
  * Pohon/benih (`Seed` dengan `action_type=19`) dirender dengan komposisi batang + daun + indikator buah matang (bukan lagi gambar tanah/cave bg biasa), ditambah overlay item & harga pada Vending Machine/Display Block/Shelf, lencana pintu publik, serta tint cat, api, dan air pada tile.
* **Perbaikan Tampilan & Duplikasi Dialog:**
  * Kode warna Growtopia di dalam popup dialog kini dirender langsung sebagai teks berwarna rapi (tidak lagi memunculkan tag HTML `<span ...>` mentah).
  * Judul dialog ganda di dalam isi popup (`Edit Sign`, `Edit House Entrance`) serta tombol tutup `X` rangkap sudah dirapikan, dan tap wrench dikirim atomik dengan debounce agar modal tidak muncul berulang kali.
