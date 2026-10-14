# Messages

> Prev: [events.md](./events.md) · Next: [errors.md](./errors.md) · Proto: `/docs/mori.proto`

## BotState

`{ status, username, mac, world_name, pos_x, pos_y, world_width, world_height, objects[], players[], inventory[], inventory_size, gems, console[], ping_ms, config }`

## WorldResponse

`{ name, width, height, tiles[{ x, y, fg_item_id, bg_item_id, flags, tile_type }], objects[{ uid, item_id, x, y, count }], players[{ net_id, name, pos_x, pos_y, country }] }`

`tile_type` is `Debug` string of Rust `TileType` (e.g. `"Basic"`, `"Door"`, `"Lock"`). For full flag/variant tables see dashboard WebSocket docs (`DOCS.md` `TileUpdate`).

## InvSlot / InventoryResponse

`InvSlot { item_id, amount, is_active, action_type }`; `InventoryResponse { size, gems, items[] }`.

## ItemInfo

`{ id, name, action_type, collision_type, clothing_type, rarity, grow_time, drop_chance, texture, texture_hash, texture_x, texture_y, seed_color, seed_overlay_color, strength }` where `strength = block_health / 6`.

## BotConfig / BotDelays

`BotConfig { auto_collect, collect_radius_tiles, collect_blacklist[], ignore_gems, ignore_essences, auto_leave_on_mod, auto_ban, collect_path_check, auto_reconnect, delays }`
`BotDelays { place_ms, walk_ms, twofa_secs, server_overload_secs, too_many_logins_secs, maintenance_secs }` — defaults `500, 500, 120, 30, 5, 600`.

## BotInfo / ListBotsResponse

`BotInfo { bot_id, username, status, world, pos_x, pos_y, gems, ping_ms }`.

## Coords

`pos_x/pos_y` floats are tile coords (pixels ÷ 32). Tile `x/y` uints are absolute except action offsets (see [overview.md](./overview.md)).
