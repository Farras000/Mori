# Manager

> Prev: [quickstart.md](./quickstart.md) · Next: [world-actions.md](./world-actions.md) · See: [messages.md](./messages.md), [errors.md](./errors.md)

## SpawnBot

`rpc SpawnBot(SpawnBotRequest) returns (SpawnBotResponse)`

```proto
message SpawnBotRequest { string username = 1; string password = 2; ProxyConfig proxy = 3; bool has_proxy = 4; }
message ProxyConfig { string host = 1; uint32 port = 2; string username = 3; string password = 4; }
```

- `username` + `password` required, else `INVALID_ARGUMENT`.
- Proxy: set `has_proxy=true` + `proxy.host/port`; `username/password` optional SOCKS5 creds. Invalid host → `INVALID_ARGUMENT`.
- Returns `{ bot_id }`. Bot starts `connecting`; watch [events.md](./events.md) `bot_status`.

```python
stub.SpawnBot(pb.SpawnBotRequest(username="growid", password="pass"), metadata=md)
stub.SpawnBot(pb.SpawnBotRequest(username="u", password="p", proxy=pb.ProxyConfig(host="127.0.0.1", port=1080), has_proxy=True), metadata=md)
```

## SpawnLtokenBot

`rpc SpawnLtokenBot(SpawnLtokenRequest) returns (SpawnBotResponse)`

- `ltoken` required (`token|rid|mac|wk`). Validated immediately — bad token stops without retry.
- Same proxy fields as `SpawnBot`.

## StopBot

`rpc StopBot(BotRef) returns (Empty)` — unknown id → `NOT_FOUND`.

## ListBots

`rpc ListBots(Empty) returns (ListBotsResponse)` — `{ bots: [{ bot_id, username, status, world, pos_x, pos_y, gems, ping_ms }] }`.

## GetBotState

`rpc GetBotState(BotRef) returns (BotState)` — full snapshot: status, world, pos, tiles summary, objects, players, inventory, gems, console, ping, config. See [messages.md](./messages.md).

## GetConfig

`rpc GetConfig(BotRef) returns (BotConfig)` — `auto_collect`, `collect_radius_tiles`, `collect_blacklist`, `ignore_gems/essences`, `auto_leave_on_mod`, `auto_ban`, `collect_path_check`, `auto_reconnect`, `delays`.
