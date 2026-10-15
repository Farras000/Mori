# Service: trait and implementation

## Trait `mori.v1.Mori`

Defined in `proto/mori.proto:532`, codegen'd by tonic (`build.rs:1`) into the
`#[tonic::async_trait] pub trait Mori` server/client pair. The generated client
is `mori_client::MoriClient`, the server wrapper `mori_server::MoriServer`.
Every RPC in the proto becomes one async trait method returning
`Result<Response<R>, Status>`, plus the associated stream type for
`SubscribeEvents`:

```rust
type SubscribeEventsStream = ReceiverStream<Result<BotEvent, Status>>;
```

The smoke test exercises it as a real client in `src/grpc/mod.rs:69`.

## Struct `MoriService`

`src/grpc/service.rs:18`:

```rust
pub struct MoriService {
    manager: SharedManager, // Arc<Mutex<BotManager>>
    ws_tx: WsTx,            // broadcast::Sender<WsEvent>
}
```

Two private helpers do all fallible access, so every handler is a thin
validate → map → enqueue/select block:

- `send_cmd(bot_id, cmd)` (`src/grpc/service.rs:28`) — locks the manager,
  calls `BotManager::send_cmd` (`src/bot_manager.rs:140`), maps `false` to
  `Status::not_found`. Poisoned mutex → `INTERNAL`.
- `bot_state(bot_id)` (`src/grpc/service.rs:41`) — clones `BotState`
  (`src/bot_manager.rs:136`), missing → `NOT_FOUND`.
- `bot_username(bot_id)` (`src/grpc/service.rs:49`) — best-effort username for
  `GetBotState`/`GetLocal` fallback; empty string when the bot is gone.

Free functions:

- `bot_ref(&Option<BotRef>)` (`src/grpc/service.rs:58`) — every per-bot RPC
  funnels through this; `None` → `INVALID_ARGUMENT("missing bot ref")`.
- Converters (`src/grpc/service.rs:64`): `delays_to_proto`,
  `delays_from_proto`, `config_to_proto`, `info_to_proto`, `state_to_proto`,
  `tiles_to_proto` (flat tile vec → `x = i % width, y = i / width`; empty vec
  when `world_width == 0`), `item_to_proto` (`strength = block_health / 6`),
  `packet_from_proto` (casts `u32` proto fields down to `u8` game fields),
  `parse_proxy` (literal `host:port` parse, DNS fallback via `ToSocketAddrs`,
  empty user/pass → `None`).
- Event bridge (`src/grpc/service.rs:250`): `event_bot_id`, `ws_tile_to_proto`,
  `ws_object_to_proto`, `ws_item_to_proto`, `event_to_proto` — see `events.md`.

## `serve()`

`src/grpc/mod.rs:19`:

1. Parse `MORI_GRPC_ADDR` (default `0.0.0.0:50051`).
2. If `MORI_GRPC_TOKEN` is non-empty, wrap with `MoriServer::with_interceptor`
   comparing the full `authorization: Bearer <token>` header string; otherwise
   serve without auth and log the warning.
3. Spawned alongside `web::serve` from `main.rs:35` sharing one `BotManager`
   and one broadcast channel.

Tests in `src/grpc/mod.rs:65` (`grpc_smoke`) cover: empty `ListBots`, unknown
bot → `NOT_FOUND`, missing ref → `INVALID_ARGUMENT`, `items.dat` lookup +
search + miss, oversized `packet_type`, cancellable `SubscribeEvents`, and the
three auth cases (absent/wrong/right token).

## RPC reference

`Request → Response` with the `BotCommand` (or read path) each handler uses.
Unless noted, unknown `bot_id` → `NOT_FOUND`.

### Manager

| RPC | Input → Output | Handler behavior (`src/grpc/service.rs`) |
|---|---|---|
| `SpawnBot` | `SpawnBotRequest{username,password,proxy,has_proxy} → SpawnBotResponse{bot_id}` | `:477` Reject empty user/pass (`INVALID_ARGUMENT`); parse proxy only when `has_proxy` is true; `BotManager::spawn` (`src/bot_manager.rs:42`) |
| `SpawnLtokenBot` | `SpawnLtokenRequest{ltoken,proxy,has_proxy} → SpawnBotResponse` | `:499` Same, requires non-empty `ltoken`; `spawn_ltoken` (`src/bot_manager.rs:77`) |
| `StopBot` | `BotRef → Empty` | `:521` `BotManager::stop` (`src/bot_manager.rs:110`); `false` → `NOT_FOUND` |
| `ListBots` | `Empty → ListBotsResponse` | `:535` Snapshot `list()` (`src/bot_manager.rs:120`) → `info_to_proto` |
| `GetBotState` | `BotRef → BotState` | `:550` `state_to_proto`; falls back to manager username when `state.username` is empty (ltoken bots pre-`SetHasGrowID`) |
| `GetConfig` | `BotRef → BotConfig` | `:560` `config_to_proto` subset of state |

### World actions (all → `Empty`)

| RPC | Command enqueued |
|---|---|
| `Say{text}` | `BotCommand::Say` (`:571`) |
| `Warp{name,id}` | `BotCommand::Warp` (`:578`) |
| `LeaveWorld` | `BotCommand::LeaveWorld` (`:591`) |
| `Respawn` | `BotCommand::Respawn` (`:600`) |
| `Active{x,y}` (offsets) | `BotCommand::Active` (`:606`) |
| `Enter{pass,has_pass}` | `BotCommand::Enter { pass: has_pass.then(pass) }` (`:616`) |
| `AcceptAccess` | `BotCommand::AcceptAccess` (`:627`) |

### Tile / inventory (all → `Empty`)

| RPC | Command |
|---|---|
| `Place{x,y,item_id}` (offsets) | `BotCommand::Place { x, y, item }` (`:638`) |
| `Hit{x,y}` (offsets) | `BotCommand::Hit` (`:655`) |
| `Wrench{x,y}` (offsets) | `BotCommand::Wrench` (`:665`) |
| `WrenchPlayer{net_id}` | `BotCommand::WrenchPlayer` (`:675`) |
| `Wear{item_id}` / `Unwear{item_id}` | `BotCommand::Wear` / `Unwear` (`:685`) |
| `Drop/Trash/FastDrop/FastTrash{item_id,count}` | Matching `BotCommand` variant (`:702`) |
| `Buy{pack_id}` | `BotCommand::Buy` (`:766`) |

### Movement

| RPC | Behavior |
|---|---|
| `MoveRelative{x,y}` | `BotCommand::Move` (`:775`) — relative pixel/tile step (Lua `moveTo`) |
| `MoveTo{x,y}` | `BotCommand::MoveTo` (`:785`) — absolute tile walk, no pathfinding (Lua `moveTile`) |
| `WalkTo{x,y}` | `BotCommand::WalkTo{x: u32, y: u32}` (`:795`); negative → `INVALID_ARGUMENT` |
| `SetDirection{facing_left}` | `BotCommand::SetDirection` (`:814`) |
| `FindPath{x,y}` | `BotCommand::FindPath` (`:829`); negative → `INVALID_ARGUMENT` |

### Collection (fire-and-forget → `Empty`)

| RPC | Behavior |
|---|---|
| `Collect{range,interval_ms}` | `BotCommand::Collect` (`:848`); no count returned, unlike Lua |
| `CollectObject{oid,range}` | `BotCommand::CollectObject` (`:864`) |

### Connection / raw (all → `Empty`)

| RPC | Behavior |
|---|---|
| `Reconnect` / `Disconnect` | `BotCommand::Reconnect` / `Disconnect` (`:882`) |
| `SendPacket{packet_type,text}` | `BotCommand::SendPacket{ptype: u8}` (`:897`); `packet_type > 255` → `INVALID_ARGUMENT` |
| `SendRaw{packet}` | `BotCommand::SendRaw`; missing `packet` → `GameUpdatePacket::default()` (`:916`) |
| `SetMac{mac}` | `BotCommand::SetMac` (`:927`), no format validation |

### Settings (all → `Empty`)

Single-flag setters map 1:1 to `BotCommand::Set*` (`:939`–`:1007`):
`SetAutoCollect`, `SetIgnoreGems`, `SetIgnoreEssences`, `SetAutoLeaveOnMod`,
`SetAutoBan`, `SetCollectPathCheck`, `SetAutoReconnect`.

Numeric setters (`:1009`–`:1065`): `SetCollectInterval{ms}`,
`SetReconnectInterval{ms}`, `SetPlaceDelay{ms}`, `SetWalkDelay{ms}` pass
through unchecked; `SetCollectRange{value}` rejects `> 255`
(`INVALID_ARGUMENT`, narrowing `u64 → u8`).

- `SetDelays{delays}` (`:1067`): missing `delays` → `BotDelays::default()`
  (500/500 ms, 120/30/5/600 s — `src/bot_state.rs:103`).
- `SetCollectConfig{radius_tiles,blacklist}` (`:1078`): `radius_tiles > 255` →
  `INVALID_ARGUMENT`; blacklist entries clamped to `u16::MAX`.

### Scripts (→ `Empty`)

`RunScript{content}` → `BotCommand::RunScript` (`:1104`, same embedded Lua
runner as the web UI); `StopScript` → `BotCommand::StopScript` (`:1114`).

### Queries

| RPC | Notes |
|---|---|
| `GetWorld → WorldResponse` | `:1125` `NOT_FOUND` when `world_name` empty; tiles via `tiles_to_proto` — large payload, prefer `GetTile` in hot loops |
| `GetInventory → InventoryResponse` | `:1164` size+gems+stacks |
| `GetPlayers → PlayersResponse` | `:1186` full player list |
| `GetPlayer{net_id\|name} → PlayerInfo` | `:1207` case-insensitive name match; no key or miss → `NOT_FOUND` |
| `GetTile{x,y} → TileInfo` | `:1237` absolute coords; `world_width == 0` or out-of-range → `NOT_FOUND` |
| `GetObject{oid} → WorldObject` | `:1263` linear scan by `uid`; miss → `NOT_FOUND` |
| `GetItemInfo{id\|name} → ItemInfo` | `:1285` no key → `INVALID_ARGUMENT`; numeric-name strings resolve as IDs first; backed by shared `items.dat` (`src/bot_manager.rs:21`) |
| `ListItems{query,page,page_size} → ListItemsResponse` | `:1312` `page = max(1)`, `page_size` clamped `1..=200`; empty query = all; ID-exact or case-insensitive name substring |
| `GetLocal → LocalPlayer` | `:1356` `net_id` always 0; username fallback like `GetBotState` |
| `GetPing → PingResponse` | `:1376` ENet RTT snapshot |
| `IsInWorld{name,has_name} → BoolResponse` | `:1385` `has_name=false` = in any world; `true` = case-insensitive equality |
| `IsInTile{x,y} → BoolResponse` | `:1399` truncating `pos_x as u32 == x && pos_y as u32 == y` |

### Events

`SubscribeEvents(SubscribeRequest{bot_ids}) → stream BotEvent` (`:1413`) — see
`events.md`. Empty `bot_ids` = all bots; otherwise exact-ID filter.
