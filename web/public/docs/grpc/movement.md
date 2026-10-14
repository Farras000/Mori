# Movement

> Prev: [tile-inventory.md](./tile-inventory.md) · Next: [collection.md](./collection.md)

| RPC | Coords | Notes |
|-----|--------|-------|
| `MoveRelative(MoveRequest { bot, x, y })` | pixel/float, relative | direct move |
| `MoveTo(MoveToRequest { bot, x, y })` | pixel/float, absolute | direct move |
| `WalkTo(MoveToRequest)` | tile ints, absolute, ≥0 | pathfind step; negative → `INVALID_ARGUMENT` |
| `FindPath(MoveToRequest)` | tile ints, absolute, ≥0 | non-blocking pathfind start |
| `SetDirection({ bot, facing_left })` | — | facing only |

```python
stub.MoveTo(pb.MoveToRequest(bot=bot, x=160, y=320), metadata=md)
stub.WalkTo(pb.MoveToRequest(bot=bot, x=50, y=30), metadata=md)
```

Poll [queries.md](./queries.md) `IsInTile` or [events.md](./events.md) `bot_move` to confirm arrival. Delays `walk_ms` tune step pacing (see [settings.md](./settings.md)).
