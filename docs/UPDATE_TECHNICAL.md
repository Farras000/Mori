# Native Web Game & Physics Update — Technical Handoff

Dokumen teknis ini merangkum perubahan arsitektur, kontrak protokol/jaringan, detail implementasi lintas backend Rust dan frontend React/PixiJS pada checkpoint cabang `feature/native-web-game`, serta panduan bagi developer berikutnya yang akan melanjutkan pengembangan fitur baru.

> Referensi dasar terkait: [PHYSICS.md](file:///C:/Users/Administrator/Desktop/botting/Mori/docs/PHYSICS.md) dan [WEB_PLAY.md](file:///C:/Users/Administrator/Desktop/botting/Mori/docs/WEB_PLAY.md).

---

## 1. Arsitektur Aliran Data (End-to-End)

```
  ENet Server Packets                         Rust Bot Core (src/bot/core.rs)
  ───────────────────                         ───────────────────────────────
  • OnSpawn / OnSetPos ─────────────────────▶ reset_local_physics_at() + PhysicsEngine::settle_on_ground()
  • OnSetClothing (9 slot IDs) ─┐
  • SetCharacterState (0x14)   ─┼───────────▶ modifiers::resolve_character_modifiers(items.dat, slots, malady, server)
  • SetExtraMods (0x2D)        ─┤               └─▶ LocalPlayer.physics_mods + punch_reach / build_reach
  • OnTalkBubble / Console     ─┘               └─▶ WsEvent::BotPhysicsMods
                                                        │
  Browser Input (/api/bots/:id/cmd)                     ▼
  • set_input (W/A/S/D) ────────────────────▶ PhysicsEngine::step_with_modifiers() (50 Hz interactive loop)
  • hold_action (x, y, tool) ───────────────▶ Non-blocking tile action + record_tile_damage() ─▶ WsEvent::TileDamage
                                                        │
                               ┌────────────────────────┴────────────────────────┐
                               ▼                                                 ▼
                  consume_packet_flags()                            WsEvent::BotMove { x, y, on_ground }
                  (one-shot PacketFlags::JUMP)                      (pushed over WS, posSubscribers)
                               │                                                 │
                               ▼                                                 ▼
                  ENet GamePacketType::State                        PixiJS Canvas (game-canvas.tsx + gt-sprites.ts)
                  (0x00) ─▶ Real GT Server                          colrect (0,0,20,30) + flush boots + RTTEX sprites
```

---

## 2. Perubahan Backend (Rust)

### 2.1 Physics Engine, Hitbox Native `colrect|0|0|20|30`, & `jump_pulse`
* **[`src/physics/config.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/physics/config.rs)**:
  * Menambahkan `CharacterModifiers` (`speed_multiplier`, `jump_multiplier`, `max_air_jumps`, `slow_fall`, `slow_fall_max_vy`, `air_thrust_accel`, `long_jump_speed_boost`, `malady`, `punch_damage`, `punch_reach`, `build_reach`, `active_effects`) dan `MaladyKind`.
  * Menambahkan parameter kalibrasi pada `PhysicsConfig`: `walk_speed: 250.0`, `max_walk_speed_cap: 335.0`, `acceleration: 1200.0`, `ground_friction: 0.72`, `air_friction: 0.94`, `jump_impulse: -450.0`, `jump_cut_decel: 5000.0`.
  * **Koordinat Hitbox Native:** Mengatur `hitbox_width: 20.0`, `hitbox_height: 30.0`, `hitbox_offset_x: 0.0`, `hitbox_offset_y: 0.0` agar identik dengan `OnSpawn colrect|0|0|20|30`:
    * Posisi berdiri di atas tile floor baris `ty` adalah `y = ty * 32.0 - 30.0` (contoh row `24` -> `y = 738.0`).
    * Posisi terpusat horizontal di kolom `tx` adalah `x = tx * 32.0 + 6.0` (karena `(32 - 20) / 2 = 6`).
    * Titik tengah karakter adalah `(pos_x + 10.0, pos_y + 15.0)`.
* **[`src/physics/state.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/physics/state.rs)**:
  * Menambahkan field one-shot `pub jump_pulse: bool` (juga `air_jumps_used: u8`, `prev_jump_held: bool`, `slow_falling: bool`, `jetpack_thrust_timer: f32`).
  * `to_packet_flags(&self)` kini hanya menyalakan `PacketFlags::JUMP` (`0x80`) bila `self.jump_pulse == true`, bukan selama `is_jumping || (!on_ground && vel.1 < -20.0)`.
  * Menambahkan `consume_packet_flags(&mut self) -> PacketFlags` (mengambil flag lalu mereset `jump_pulse = false`) dan `to_action_packet_flags(&self) -> PacketFlags` (menghapus `PacketFlags::JUMP` tanpa mengonsumsi `jump_pulse`).
* **[`src/physics/engine.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/physics/engine.rs)**:
  * `step_with_modifiers` mereset `state.jump_pulse = false` sekali di awal sebelum loop sub-step (`MAX_SUB_STEP = 1/60`), menjaga pulse yang terpicu di sub-step tetap terbaca oleh pemanggil di akhir step.
  * Ground jump & air double-jump (`air_jumps_used < mods.max_air_jumps`) bersifat edge-triggered (`input.jump && !state.prev_jump_held`), dan bersama `TileCollisionKind::Trampoline` menjadi satu-satunya pemicu `state.jump_pulse = true`.
  * Variable hold-jump: selama `!input.jump && state.vel.1 < 0.0 && !state.trampoline`, gravitasi ditambah `self.config.jump_cut_decel` (`5000.0`) agar pelepasan tombol di tengah lompatan segera memutus kenaikan.
  * Menambahkan `PhysicsEngine::settle_on_ground(&self, state: &mut PhysicsState, world: &impl CollisionProvider) -> bool` yang memeriksa tile `Solid | Ice | Platform` dalam rentang `±2.5 px` dari telapak kaki dan langsung memposisikan kaki serta `on_ground = true`.

### 2.2 Item Effect Classifier, Malady, & State Server
* **[`src/physics/modifiers.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/physics/modifiers.rs)** (file baru):
  * `classify_item_physics(&ItemInfo) -> ItemPhysicsEffect`: memeriksa flag `items.dat`, `clothing_type`, `item_category`, `info`/deskripsi item untuk mendeteksi efek:
    * `Double Jump` (Wings maupun item kaki / slot lain), `High Jump` (`1.28x`), `Jetpack` (`air_thrust_accel` + `long_jump_speed_boost`), `Slow Fall` (`slow_fall_max_vy`), `Speedy` (10% per item, maks **3** stack melalui `speedy_stacks.min(3)`), `Punch Damage` (`8`), `Punch Range` (`+1..`), dan `Build Range` (`+1..`).
  * `parse_malady_event(text: &str)` mem-parse teks `OnTalkBubble` / `OnConsoleMessage` (`ChickenFeet`, `Brainworms`, `Gemcuts`, `Grumbleteeth`, `BrokenHeart`, atau `Some(None)` saat sembuh).
  * `resolve_character_modifiers(items_dat, equipped_ids, malady, server)` menggabungkan efek item di 9 slot `[hair, shirt, pants, feet, face, hand, back, mask, neck]`, ability bit dari server (`state_mod_flags | extra_mods_bits`: `0x02` double jump, `0x04` high jump, `0x08` speedy, `0x400` slow fall), serta malady, lalu meng-clamp `speed_multiplier` (`0.4..1.35`), `jump_multiplier` (`0.55..1.5`), dan reach (`2..10`).
* **[`src/player.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/player.rs) & [`src/bot_state.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/bot_state.rs)**:
  * `LocalPlayer` menyimpan `server_gravity`, `server_walk_speed`, `char_state_flags`, `extra_mods_bits`, `equipped_clothes: [u32; 9]`, `malady`, dan `physics_mods`.
  * `BotState` memisahkan `punch_reach`, `build_reach`, `reach_override: Option<u8>`, `action_reach`, serta `physics_mods`.

### 2.3 Integrasi Core Bot, Paket, & Event (`src/bot/core.rs`, `src/events.rs`, `src/grpc/service.rs`)
* **[`src/bot/core.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/bot/core.rs)**:
  * `extract_server_physics` memvalidasi pasangan `(gravity, walk_speed)` dari `GamePacketType::SetCharacterState` (`0x14`), ditambah handler `GamePacketType::SetExtraMods` (`on_set_extra_mods`), `OnSetClothing`, dan `OnTalkBubble` -> memanggil `recompute_physics_mods()`.
  * `reset_local_physics_at(x, y)` dipanggil di `OnSpawn`, `OnSetPos`, dan penutupan `walk()` untuk memanggil `settle_on_ground` bila `self.world` sudah terisi.
  * `tick_interactive` & `walk`: memicu kirim `GamePacketType::State` saat `self.local.physics.jump_pulse == true`, mengambil flag dengan `consume_packet_flags()`. `send_tile_action_at` memakai `to_action_packet_flags()` agar `PUNCH`/`PLACE` tidak pernah menyalakan `PacketFlags::JUMP`.
  * Pusat tile di `send_tile_action_at`, `send_tile_action`, dan `tick_interactive` diselaraskan ke `(pos_x + 10.0, pos_y + 15.0)`; target `walk(tile_x, tile_y)` menjadi `(tile_x * 32.0 + 6.0, tile_y * 32.0 + 2.0)`.
  * `record_tile_damage` melacak kerusakan blok berdasarkan `physics_mods.punch_damage` dan memancarkan `WsEvent::TileDamage`.
  * `extract_chat_display_message` menyaring paket `action|play_sfx` dari stream chat log.
* **[`src/events.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/events.rs) & [`src/grpc/service.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/grpc/service.rs)**:
  * `WsEvent::BotMove` menambah `on_ground: Option<bool>`.
  * Menambahkan `WsEvent::BotPhysicsMods { bot_id, mods }` dan `WsEvent::TileDamage { bot_id, x, y, damage, max_health }` beserta pemetaan ke gRPC `ConsoleEvent`.
* **[`src/protocol/variant.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/protocol/variant.rs)**: Menambahkan helper `Variant::as_vec3`.

---

## 3. Perubahan Frontend Web (`web/`)

* **[`web/src/components/game-canvas.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/components/game-canvas.tsx)**:
  * Menyelaraskan koordinat kaki render untuk bot utama & `curBot.players` ke `+ 10 / 32` (X) dan `+ 30 / 32` (Y), serta target kamera & `getBotCenterTile` ke `+ 10 / 32` dan `+ 15 / 32` (sinkron dengan `checkHitPlayer` berbasis `colrect 20×30`).
  * Mengonsumsi status `onGround` pada callback `subscribePos` agar interpolasi Y berhenti mengambang saat pendaratan.
  * Merender overlay retak tile (`TileDamage`) serta komposisi sprite/animasi karakter.
* **[`web/src/lib/gt-sprites.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/gt-sprites.ts)** (file baru):
  * Rig karakter PixiJS modular (`createArticulatedLeg`, `createGtCharacterRig`, `setPose`) dengan `shoeColor` menjangkau `y = 8.1`, `soleColor` di `y = 7.6..9.1`, `groundShadow`, serta kompensasi hip-drop `8.8 * (1 - Math.cos(swingRad))` agar ayunan kaki berjalan tidak mengangkat kaki pijakan dari permukaan tile.
* **[`web/src/lib/rttex.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/rttex.ts) & [`web/src/lib/texture-cache.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/texture-cache.ts)**:
  * Memperbaiki urutan pembacaan header `RTTEX` (`height` dibaca sebelum `width`).
  * Menambahkan `getCroppedItemIcon` (trim alpha + scaling proporsional terpusat pada kanvas 32×32), `getCroppedRegion`, dan `getFullTextureUrl`.
* **[`web/src/pages/GamePage.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/pages/GamePage.tsx), [`web/src/lib/store.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/store.tsx), [`web/src/lib/ws.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/ws.ts), [`web/src/lib/api.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/api.ts), [`web/src/lib/game-input.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/game-input.ts)**:
  * Integrasi `physics_mods`, lencana efek aktif di HUD, hotbar slot pintar (`1–2` Fist/Wrench, `3–8` item non-wearable), tab Backpack (`All` / `Blocks` / `Wearables`) + indikator wearable aktif, pemisahan reach native vs `reachOverride`, listener input keyboard capture-phase dengan `preventDefault()`, serta throttling re-render `BotMove` ke store UI sambil menjaga stream `posSubscribers` 50 Hz tetap mulus.

---

## 4. Panduan untuk Developer Fitur Berikutnya

1. **Menambah efek item/clothing atau ability bit baru:**
   * Tambahkan flag/komparasi di `classify_item_physics()` dan/atau mapping ability bit di `resolve_character_modifiers()` pada [`src/physics/modifiers.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/physics/modifiers.rs), lalu tambahkan label deskriptif ke `mods.active_effects` jika perlu tampil di HUD.
   * Pastikan test di `src/physics/modifiers.rs` dan `src/physics/tests.rs` ikut mencakup kombinasi dengan `items.dat` riil.
2. **Menambah state/flag baru pada `GamePacketType::State`:**
   * Hindari membaca kondisi durasi kontinu (seperti `vel.1 < 0`) untuk flag bertipe *event/SFX* (contoh `PacketFlags::JUMP`). Gunakan pola pulse one-shot di `PhysicsState` yang di-clear di awal `step_with_modifiers` dan dikonsumsi via `consume_packet_flags()`, sambil mengecualikannya di `to_action_packet_flags()`.
3. **Menjaga akurasi posisi & hitbox di fitur pathfinding/auto-farm baru:**
   * Selalu anggap `(pos_x, pos_y)` sebagai sudut kiri-atas `colrect|0|0|20|30` (pusat horizontal di `+10.0`, pusat vertikal di `+15.0`, lantai di `pos_y + 30.0`, posisi berdiri rata di tengah tile `(tx * 32 + 6, ty * 32 + 2)`).
   * Panggil `reset_local_physics_at` atau `settle_on_ground` setelah teleport/spawn agar tidak memicu false airborne state.
4. **Checklist Verifikasi & Build sebelum Merge/Release:**
   * Jalankan frontend build lebih dulu karena aset `dist/` di-embed ke binary Rust:
     ```powershell
     cd web; bun run build
     ```
   * Jalankan seluruh unit test & build release:
     ```powershell
     cargo test --no-fail-fast
     cargo build --release
     ```
   * Status verifikasi terakhir pada checkpoint ini:
     * `cd web; bun run build`: **Lulus** (`2576 modules transformed`, `972ms`).
     * `cargo test --no-fail-fast`: **82 passed, 0 failed, 0 ignored**.
     * `cargo build --release`: **Lulus** (`45.38s`, output `target/release/Mori.exe`).

---

## 5. Update Gameplay Native: Dialog, Trade, Wrench Priority, Aset & Perbaikan Visual

Lanjutan implementasi di cabang `feature/native-web-game` setelah checkpoint physics menambahkan paritas protokol & UI untuk dialog interaktif, trade, prioritas klik wrench, rendering aset dunia/cuaca, serta perbaikan bug visual modal.

### 5.1 Backend Rust (`src/bot/core.rs`, `src/events.rs`, `src/web.rs`, `src/bot_state.rs`, `src/grpc/service.rs`)
* **Parser Dialog Native & Command Interaksi ([`src/bot/core.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/bot/core.rs), [`src/events.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/events.rs)):**
  * `parse_quick_dialog` menghasilkan `WsDialog` terstruktur lengkap dengan `elements: Vec<DialogElement>` (`Label`, `Textbox`, `TextInput`, `Checkbox`, `Button`, `ItemPicker`, `Spacer`, `PlayerInfo`), `checkboxes: Vec<DialogCheckbox>`, `embed_data: Vec<DialogEmbed>`, serta `quick_exit`.
  * Menambahkan `BotCommand` / `CmdRequest` (`src/web.rs`): `WrenchSelf`, `Active { x, y }`, `Enter { pass }`, `TradeStart`, `TradeOfferItem`, `TradeAccept`, `TradeConfirm`, `TradeCancel`, dan `DismissDialog`.
  * Guard single-tap pada `BotCommand::HoldAction`: ketika `item == 32` (Wrench), `self.interactive.hold` dikosongkan sehingga tap wrench hanya dieksekusi satu kali lewat `pending_tap` tanpa pengulangan.
* **Event Dunia, Pakaian, Bubble, SFX, & Trade ([`src/events.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/events.rs), [`src/grpc/service.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/grpc/service.rs)):**
  * Menambahkan `TradeState` / `TradeSlot`, `WsEvent::{PlayerClothes, BotClothes, WeatherUpdate, TalkBubble, PlaySfx, TradeStart, TradeStatus, TradeEnd}`, serta metadata `WsTile.flags` & `WsTile.tile_type` pada `WorldLoaded` dan `TileUpdate` + `base_weather`/`current_weather`.
  * Menambahkan mapping semua `WsEvent` operasional baru pada `event_bot_id()` dan `event_to_proto()` -> `mori::ConsoleEvent` agar stream gRPC tetap kompatibel tanpa pemutusan `match` exhaustive.
* **CDN Proxy & Cache Disk Lokal ([`src/web.rs`](file:///C:/Users/Administrator/Desktop/botting/Mori/src/web.rs)):**
  * Handler `/growtopia-cdn/{*path}` (`growtopia_cdn`) membersihkan path (`sanitize_cdn_rel_path`), membaca/menyimpan file aset (`.png`, `.ogg`, `.wav`, dll.) di `cache/growtopia` (override lewat `MORI_CDN_CACHE_DIR`), dan mendukung fallback mirror lewat env `GROWTOPIA_CDN_URL` dan `GROWTOPIA_CDN_MIRROR`. Folder `cache/` diabaikan dari Git melalui `.gitignore`.

### 5.2 Frontend Web (`web/src/`)
* **Tokenisasi Warna GT & Perbaikan Modal Dialog ([`web/src/lib/gt-colors.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/gt-colors.ts), [`web/src/components/game-dialog-modal.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/components/game-dialog-modal.tsx)):**
  * Memisahkan `tokenizeGTColors(text)` (dipakai oleh komponen React `<GtText />` untuk merender warna GT sebagai JSX `<span>` tanpa membocorkan HTML mentah) dan mempertahankan `parseGTColors(text)` untuk konteks HTML.
  * Deduplikasi header dialog: label pertama di `elements` (atau baris pertama `body_text` pada mode fallback) yang identik dengan `dialog.title` diangkat ke `<DialogTitle>` beserta `<ItemIcon />`-nya dan tidak dirender dua kali di body.
  * Menghapus tombol close bawaan Radix yang ganda dengan `showCloseButton={false}` pada `<DialogContent>`, serta menambahkan `dismissedRef` + pembersihan optimistik `active_dialog: null` di `botsAtom` pada `handleDismiss`.
* **Trade Modal ([`web/src/components/trade-modal.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/components/trade-modal.tsx)):**
  * UI Trade live dua sisi dengan pencarian item Backpack, peringatan perubahan tawaran partner (`partnerModifiedWarning`), toggle lock/confirm, `showCloseButton={false}`, dan guard `cancelledRef` agar `trade_cancel` tidak terkirim berulang.
* **Canvas Prioritas Wrench & Fidelitas Tile/Cuaca ([`web/src/components/game-canvas.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/components/game-canvas.tsx), [`web/src/lib/tile-layer.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/tile-layer.ts), [`web/src/lib/texture-cache.ts`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/lib/texture-cache.ts), [`web/src/pages/GamePage.tsx`](file:///C:/Users/Administrator/Desktop/botting/Mori/web/src/pages/GamePage.tsx)):**
  * Aksi wrench mengirim command atomik `{ type: 'wrench', x, y }` dengan debounce `lastWrenchAtRef` (`300ms`), mengutamakan tile foreground interaktif sebelum player/self, mendukung `Shift + Click`/`R` untuk `wrench_self`, `Alt + Click` menembus player, dan `F`/Double-Click untuk `active(x, y)`.
  * Merender benih/pohon (`TileType::Seed` / `item_id % 2 === 1`) dengan komposit sprite batang + daun + tint warna + buah matang (`renderSeedTreeCanvas`), cuaca dunia dinamis, overlay Vending Machine/Display Block/Shelf, speech bubbles bertumpuk (`TalkBubble`), pakaian 9 slot, serta pemutar SFX dengan kontrol mute di `GamePage.tsx`.

### 5.3 Verifikasi Release Terbaru
* `cd web && npm run build` (`tsc -b && vite build`): **Lulus** (`2577 modules transformed`, output `dist/index.html` `947` bytes).
* `cargo test`: **84 passed, 0 failed, 0 ignored**.
* `cargo build --release`: **Lulus** (`59.30s`, output `target/release/Mori.exe` `25.209.307` bytes; `target/debug` dibersihkan).
