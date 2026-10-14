# Collection

> Prev: [movement.md](./movement.md) · Next: [connection-raw.md](./connection-raw.md)

Fire-and-forget over gRPC; count not returned (Lua returns count, gRPC does not). Returns `Empty`.

- `Collect(CollectRequest { bot, range, interval_ms })` — collect nearby drops within `range` pixels ticking every `interval_ms`.
- `CollectObject(CollectObjectRequest { bot, oid, range })` — collect single `oid` if within `range` pixels. Get `oid` from `GetWorld`/`GetObject` (see [queries.md](./queries.md)).

```python
stub.Collect(pb.CollectRequest(bot=bot, range=100.0, interval_ms=500), metadata=md)
stub.CollectObject(pb.CollectObjectRequest(bot=bot, oid=12, range=100.0), metadata=md)
```

Tune via [settings.md](./settings.md) `SetCollectConfig` / `SetAutoCollect`. Confirm via [events.md](./events.md) `inventory_update` / `objects_update`.
