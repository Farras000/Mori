# Overview

> Prev: [index.md](./index.md) · Next: [quickstart.md](./quickstart.md) · Proto: `/docs/mori.proto`

Mirrors the in-process Lua API (`LUA.md`). Reads come from shared `BotState` snapshot; writes go through the same `BotCommand` queue the web UI uses.

- **Endpoint:** `localhost:50051`, override `MORI_GRPC_ADDR=127.0.0.1:50051`
- **Schema:** `proto/mori.proto`, service `mori.v1.Mori`
- **Auth:** `MORI_GRPC_TOKEN=secret ./target/release/Mori`, then metadata `authorization: Bearer secret` on every call.

## Core concepts

- `BotRef { bot_id }` — every per-bot RPC takes this wrapper. Missing wrapper → `INVALID_ARGUMENT`. Unknown id → `NOT_FOUND`.
- **Offsets:** `Place`/`Hit`/`Wrench`/`Active` `x`/`y` are offsets relative to bot's current tile, exactly like Lua. `WalkTo`/`FindPath`/`IsInTile` use absolute tile coords. `MoveRelative`/`MoveTo` use pixel/float positions (see [movement.md](./movement.md)).
- **Fire-and-forget writes:** most action RPCs return `Empty`. Poll queries or [events.md](./events.md) to confirm effect.
- **Heavy reads:** `GetWorld` returns full tile list. Poll `GetTile`/`GetObject` for hot loops (see [queries.md](./queries.md)).

## RPC groups

| Group | File |
|-------|------|
| Manager | [manager.md](./manager.md) |
| World actions | [world-actions.md](./world-actions.md) |
| Tile / inventory | [tile-inventory.md](./tile-inventory.md) |
| Movement | [movement.md](./movement.md) |
| Collection | [collection.md](./collection.md) |
| Connection / raw | [connection-raw.md](./connection-raw.md) |
| Settings | [settings.md](./settings.md) |
| Scripts | [scripts.md](./scripts.md) |
| Queries | [queries.md](./queries.md) |
| Events | [events.md](./events.md) |
