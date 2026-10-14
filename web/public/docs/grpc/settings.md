# Settings

> Prev: [connection-raw.md](./connection-raw.md) · Next: [scripts.md](./scripts.md) · See [events.md](./events.md) `delays` / `auto_collect`

Booleans take `SetBoolRequest { bot, enabled }`:

`SetAutoCollect`, `SetIgnoreGems`, `SetIgnoreEssences`, `SetAutoLeaveOnMod`, `SetAutoBan`, `SetCollectPathCheck`, `SetAutoReconnect`

Uint64 take `SetUintRequest { bot, value }`:

- `SetCollectInterval { ms }`, `SetReconnectInterval { ms }`, `SetPlaceDelay { ms }`, `SetWalkDelay { ms }`
- `SetCollectRange { value 0-255 }` — tiles 1–5 typical; >255 → `INVALID_ARGUMENT`

Structs:

- `SetDelays({ bot, delays: { place_ms, walk_ms, twofa_secs, server_overload_secs, too_many_logins_secs, maintenance_secs } })` — defaults `500, 500, 120, 30, 5, 600`.
- `SetCollectConfig({ bot, radius_tiles 0-255, blacklist: [item_ids] })` — `radius_tiles` >255 → `INVALID_ARGUMENT`; blacklist ids clamped to `u16`.

Changes emit [events.md](./events.md) `delays` (full object) and `auto_collect`.
