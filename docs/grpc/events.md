# Events: `SubscribeEvents`

Replaces Lua `listenEvents` (`LUA.md:88`) for out-of-process clients. The only
server-streaming RPC (`proto/mori.proto:616`), implemented at
`src/grpc/service.rs:1413`.

## Wiring

```
game loop ── WsEvent ──► broadcast WsTx (cap 256, src/main.rs:33)
                                         ├──► web socket fan-out (src/web.rs:620)
                                         └──► gRPC SubscribeEvents ──► BotEvent stream
```

Each call does `ws_tx.subscribe()` then spawns a forwarder task over an
`mpsc::channel(256)` bridged with `ReceiverStream` (`src/grpc/service.rs:1418`).
The forwarder:

1. Applies the `bot_ids` filter — empty means **all bots**, otherwise only
   events whose `event_bot_id()` (`src/grpc/service.rs:250`) is in the list.
2. Maps with `event_to_proto()` (`src/grpc/service.rs:303`).
3. Ends when the client cancels (send fails) or the broadcast closes;
   `Lagged` (slow consumer) is skipped, never fatal.

No replay: only events emitted after `subscribe()` returns are delivered.
`BotAdded` for already-running bots is **not** synthesized — call `ListBots`
first, then subscribe.

## `BotEvent` catalog

`oneof event` (`proto/mori.proto:506`); every variant carries `bot_id`:

| Variant | Proto message | `WsEvent` source (`src/events.rs:31`) | Notes |
|---|---|---|---|
| `bot_added` | `BotInfo` (only `bot_id`+`username` set) | `BotAdded` | Empty username for ltoken spawns until `username` event |
| `bot_removed` | `BotRef` | `BotRemoved` | After `BotManager::stop` (`src/bot_manager.rs:110`) |
| `bot_status` | `BotStatusEvent{status}` | `BotStatus` | Same strings as REST/`BotInfo.status` |
| `bot_world` | `BotWorldEvent{world_name}` | `BotWorld` | Empty = left world |
| `bot_move` | `BotMoveEvent{x,y}` | `BotMove` | Tile coords |
| `bot_gems` | `BotGemsEvent{gems}` | `BotGems` | |
| `bot_ping` | `BotPingEvent{ping_ms}` | `BotPing` | Only on change |
| `player_spawn` | `PlayerSpawnEvent{net_id,name,country,x,y}` | `PlayerSpawn` | |
| `player_move` | `PlayerMoveEvent{net_id,x,y}` | `PlayerMove` | |
| `player_leave` | `PlayerLeaveEvent{net_id}` | `PlayerLeave` | |
| `world_loaded` | `WorldLoadedEvent{name,width,height,tiles: TileEvent[]}` | `WorldLoaded` | Full row-major tiles; heavy — one per world load |
| `tile_update` | `TileUpdateEvent{x,y,fg,bg}` | `TileUpdate` | No flags/`tile_type` (unlike `GetTile`) |
| `objects_update` | `ObjectsUpdateEvent{objects}` | `ObjectsUpdate` | Full replacement set, not a delta |
| `inventory_update` | `InventoryUpdateEvent{gems,inventory_size,items}` | `InventoryUpdate` | |
| `console` | `ConsoleEvent{message}` | `Console` | Chat + script output |
| `track_info` | `TrackInfoEvent{level,grow_id,install_date,global_playtime,awesomeness}` | `BotTrackInfo` | Once per login; only event exposing `TrackInfo` |
| `username` | `UsernameEvent{username}` | `BotUsername` | `SetHasGrowID` resolution for ltoken bots |
| `auto_collect` | `AutoCollectEvent{enabled}` | `BotAutoCollect` | |
| `delays` | `DelaysEvent{delays}` | `BotDelays` | Always the full object |

`TileEvent{bot_id,fg,bg,flags,tile_type}` is the `WsTile` projection
(`src/grpc/service.rs:274`); `tile_type` is the `Debug` string.

## Example

```python
for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):
    kind = ev.WhichOneof("event")
    if kind == "console":
        print(ev.console.message)
    elif kind == "world_loaded":
        print(f"world {ev.world_loaded.name} tiles={len(ev.world_loaded.tiles)}")
```

Filter with `bot_ids=[...]` for a subset, `bot_ids=[]` for everything.
Cancel by closing the stream (as in `src/grpc/mod.rs:173` and
`examples/python_grpc_bot.py:74`).
