# Mori gRPC API

External control plane for bots, mirroring the in-process Lua API (`LUA.md`).
Reads come from the shared `BotState` snapshot; writes go through the
`BotCommand` queue — the same queue the web UI uses.

| | |
|---|---|
| Proto | `proto/mori.proto:1` (`package mori.v1`, service `Mori`) |
| Codegen | `build.rs:1` → `tonic_build::compile_protos`, included via `tonic::include_proto!("mori.v1")` in `src/grpc/mod.rs:1` |
| Service impl | `src/grpc/service.rs:18` (`MoriService`), trait impl at `src/grpc/service.rs:474` |
| Server bootstrap | `src/grpc/mod.rs:19` (`serve()`), spawned in `src/main.rs:35` |
| Backing state | `src/bot_manager.rs:18` (`BotManager`), `src/bot_state.rs:117` (`BotState`), `src/bot_state.rs:194` (`BotCommand`) |
| Events source | `src/events.rs:31` (`WsEvent`, broadcast `WsTx`) |
| RPC count | 65 (64 unary + 1 server-streaming `SubscribeEvents`) |

## Transport and auth

- Default endpoint `0.0.0.0:50051`, override with `MORI_GRPC_ADDR` (`src/grpc/mod.rs:20`).
- If `MORI_GRPC_TOKEN` is set, every call must carry `authorization: Bearer <token>`
  metadata or it fails with `UNAUTHENTICATED` (`src/grpc/mod.rs:27`).
  If unset, server runs unauthenticated and logs a warning.
- `MoriService::new(manager, ws_tx)` shares `Arc<Mutex<BotManager>>` with the web
  server — no separate state (`src/grpc/service.rs:23`, `src/main.rs:33`).

```bash
MORI_GRPC_ADDR=127.0.0.1:50051 MORI_GRPC_TOKEN=secret ./target/release/Mori
```

## Quickstart

Python (`examples/python_grpc_bot.py:1`, stub bootstrap `examples/grpc_bootstrap.py:1`):

```bash
pip install grpcio grpcio-tools
MORI_GRPC_TOKEN=secret python examples/python_grpc_bot.py
```

```python
import os, sys
sys.path.insert(0, "examples")
import grpc_bootstrap as gen
import grpc
pb, rpc = gen.pb, gen.rpc

ch = grpc.insecure_channel(os.environ.get("MORI_GRPC_ADDR", "localhost:50051"))
md = [("authorization", f"Bearer {os.environ['MORI_GRPC_TOKEN']}")]
stub = rpc.MoriStub(ch)
bots = stub.ListBots(pb.Empty(), metadata=md)
bot = pb.BotRef(bot_id=bots.bots[0].bot_id)
stub.Say(pb.SayRequest(bot=bot, text="Hello!"), metadata=md)
for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):
    print(ev.WhichOneof("event"))
```

`grpcurl` (no codegen):

```bash
grpcurl -plaintext -H "authorization: Bearer $MORI_GRPC_TOKEN" \
  localhost:50051 mori.v1.Mori/ListBots
```

## Coordinate convention

`place` / `hit` / `wrench` / `active` `x`/`y` are **offsets relative to the bot's
current tile**, exactly like Lua (`proto/mori.proto:12`). `MoveTo` is absolute,
`MoveRelative` is relative, `WalkTo`/`FindPath` take absolute non-negative tile
coords (negative → `INVALID_ARGUMENT`, `src/grpc/service.rs:795`).

## Reads vs writes

- Reads (`Get*`, `List*`, `IsIn*`) clone the `BotState` snapshot under lock
  (`src/grpc/service.rs:41`). They never touch the game connection.
- Writes enqueue a `BotCommand` via `BotManager::send_cmd` (`src/bot_manager.rs:140`)
  through `MoriService::send_cmd` (`src/grpc/service.rs:28`). Unknown `bot_id`
  → `NOT_FOUND`. Missing `bot` ref → `INVALID_ARGUMENT` (`bot_ref`,
  `src/grpc/service.rs:58`).
- `Collect` is fire-and-forget over gRPC; unlike Lua it returns no count
  (`proto/mori.proto:570`).

## Error model

| gRPC code | When |
|---|---|
| `UNAUTHENTICATED` | Bad/missing bearer token (interceptor only, `src/grpc/mod.rs:36`) |
| `NOT_FOUND` | Unknown `bot_id`, `GetWorld` with no world, `GetTile` out of bounds, `GetPlayer`/`GetObject`/`GetItemInfo` miss, `StopBot` on removed bot |
| `INVALID_ARGUMENT` | Missing `bot` ref, empty `username`/`password`/`ltoken`, bad proxy host, `packet_type > 255`, `WalkTo`/`FindPath` negative coords, `SetCollectRange > 255`, `SetCollectConfig.radius_tiles > 255`, missing `GetItemInfo` key |
| `INTERNAL` | `BotManager` mutex poisoned (all lock sites) |

## File map

| Doc | Contents |
|---|---|
| `service.md` | Trait `Mori`, `MoriService` internals, `serve()`, per-RPC reference with `BotCommand` mapping and validation |
| `messages.md` | Every request/response/state message, field semantics, `has_*` quirks, clamping rules |
| `events.md` | `SubscribeEvents` semantics, `BotEvent` catalog, `WsEvent` → proto mapping, filtering and backpressure |
