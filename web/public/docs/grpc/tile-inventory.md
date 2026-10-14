# Tile / inventory

> Prev: [world-actions.md](./world-actions.md) · Next: [movement.md](./movement.md)

`Place`/`Hit`/`Wrench` `x`/`y` are **offsets from bot tile** (Lua parity). All return `Empty`.

| RPC | Request | Notes |
|-----|---------|-------|
| `Place` | `{ bot, x, y, item_id }` | place block at offset |
| `Hit` | `{ bot, x, y }` | punch |
| `Wrench` | `{ bot, x, y }` | wrench tile |
| `WrenchPlayer` | `{ bot, net_id }` | wrench player by net ID (see `GetPlayers` in [queries.md](./queries.md)) |
| `Wear` / `Unwear` | `{ bot, item_id }` | equip / unequip |
| `Drop` / `Trash` | `{ bot, item_id, count }` | drop to world / delete |
| `FastDrop` / `FastTrash` | `{ bot, item_id, count }` | skip normal delay |
| `Buy` | `{ bot, pack_id }` | e.g. `small_lock` |

```python
stub.Place(pb.PlaceRequest(bot=bot, x=1, y=0, item_id=2), metadata=md)
stub.Hit(pb.TileActionRequest(bot=bot, x=1, y=0), metadata=md)
stub.Drop(pb.InventoryActionRequest(bot=bot, item_id=242, count=1), metadata=md)
```
