# Queries

> Prev: [scripts.md](./scripts.md) · Next: [events.md](./events.md) · Shapes: [messages.md](./messages.md)

| RPC | Request | Returns | Notes |
|-----|---------|---------|-------|
| `GetWorld` | `BotRef` | `WorldResponse { name, width, height, tiles[], objects[], players[] }` | `NOT_FOUND` if not in world. Heavy — avoid hot-loop polling |
| `GetInventory` | `BotRef` | `{ size, gems, items[{ item_id, amount, is_active, action_type }] }` | — |
| `GetPlayers` | `BotRef` | `{ players[{ net_id, name, pos_x, pos_y, country }] }` | — |
| `GetPlayer` | `{ bot, net_id }` or `{ bot, name }` | `PlayerInfo` | case-insensitive name; `NOT_FOUND` if absent |
| `GetTile` | `{ bot, x, y }` | `TileInfo { x, y, fg_item_id, bg_item_id, flags, tile_type }` | absolute tiles; OOB → `NOT_FOUND` |
| `GetObject` | `{ bot, oid }` | `WorldObject { uid, item_id, x, y, count }` | `NOT_FOUND` if absent |
| `GetItemInfo` | `{ id }` or `{ name }` | `ItemInfo` | numeric string also resolves as id; else `INVALID_ARGUMENT`/`NOT_FOUND` |
| `ListItems` | `{ query, page≥1, page_size 1-200 }` | `{ items[], total, page, page_size }` | substring case-insensitive or exact id |
| `GetLocal` | `BotRef` | `{ net_id, username, pos_x, pos_y, mac }` | local player |
| `GetPing` | `BotRef` | `{ ping_ms }` | — |
| `IsInWorld` | `{ bot, name, has_name }` | `{ value }` | `has_name=false` → any world; true → case-insensitive compare |
| `IsInTile` | `{ bot, x, y }` | `{ value }` | absolute tile compare |

```python
tile = stub.GetTile(pb.GetTileRequest(bot=bot, x=50, y=30), metadata=md)
info = stub.GetItemInfo(pb.GetItemInfoRequest(id=242), metadata=md)  # world lock
items = stub.ListItems(pb.ListItemsRequest(query="world lock", page=1, page_size=10), metadata=md)
```
