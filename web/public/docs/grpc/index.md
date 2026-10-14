# Mori gRPC API — Index

> Agent entrypoint. Start here, then follow links per task.
> Raw markdown base: `/docs/grpc/` — every file below is fetchable as `.md` with no auth.
> Pretty HTML: `/docs/grpc` (same content, searchable).
> Proto schema: `/docs/mori.proto`

**Service:** `mori.v1.Mori` — `proto/mori.proto`
**Endpoint:** `localhost:50051` (override with `MORI_GRPC_ADDR`, e.g. `127.0.0.1:50051`)
**Auth:** if server started with `MORI_GRPC_TOKEN` set, every RPC must carry `authorization: Bearer <token>` metadata, else `UNAUTHENTICATED`. If unset, unauthenticated (warning logged).

## Files

- [overview.md](./overview.md) — mental model, reads vs writes, `bot_id`, offsets
- [quickstart.md](./quickstart.md) — protoc + Python copy-paste bootstrap
- [manager.md](./manager.md) — `SpawnBot`, `SpawnLtokenBot`, `StopBot`, `ListBots`, `GetBotState`, `GetConfig`
- [world-actions.md](./world-actions.md) — `Say`, `Warp`, `LeaveWorld`, `Respawn`, `Active`, `Enter`, `AcceptAccess`
- [tile-inventory.md](./tile-inventory.md) — `Place`, `Hit`, `Wrench`, `WrenchPlayer`, `Wear`, `Unwear`, `Drop`, `Trash`, `FastDrop`, `FastTrash`, `Buy`
- [movement.md](./movement.md) — `MoveRelative`, `MoveTo`, `WalkTo`, `SetDirection`, `FindPath`
- [collection.md](./collection.md) — `Collect`, `CollectObject`
- [connection-raw.md](./connection-raw.md) — `Reconnect`, `Disconnect`, `SendPacket`, `SendRaw`, `SetMac`
- [settings.md](./settings.md) — 14x `Set*` RPCs
- [scripts.md](./scripts.md) — `RunScript`, `StopScript` (embedded Lua)
- [queries.md](./queries.md) — `GetWorld`, `GetInventory`, `GetPlayers`, `GetPlayer`, `GetTile`, `GetObject`, `GetItemInfo`, `ListItems`, `GetLocal`, `GetPing`, `IsInWorld`, `IsInTile`
- [events.md](./events.md) — `SubscribeEvents` streaming (replaces Lua `listenEvents`)
- [messages.md](./messages.md) — `BotState`, `WorldResponse`, `ItemInfo`, `BotConfig`, `BotEvent` shapes
- [errors.md](./errors.md) — `NOT_FOUND`, `INVALID_ARGUMENT`, `UNAUTHENTICATED`, retries

## How to use as an agent

1. Fetch this index + [quickstart.md](./quickstart.md).
2. Fetch only the group file(s) needed for the task (e.g. movement → [movement.md](./movement.md)).
3. Fetch [messages.md](./messages.md) for response shapes, [errors.md](./errors.md) when a call fails.
4. Prefer queries `GetTile`/`GetObject` in hot loops over `GetWorld` (full tile list).
