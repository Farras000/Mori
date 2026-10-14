# World actions

> Prev: [manager.md](./manager.md) · Next: [tile-inventory.md](./tile-inventory.md)

All return `Empty`. Unknown `bot_id` → `NOT_FOUND`.

## Say

`rpc Say(SayRequest) returns (Empty)` — `{ bot, text }`. Chat message.

```python
stub.Say(pb.SayRequest(bot=bot, text="hello"), metadata=md)
```

## Warp

`rpc Warp(WarpRequest) returns (Empty)` — `{ bot, name, id }`. `id` = door ID, default `""` (main door).

```python
stub.Warp(pb.WarpRequest(bot=bot, name="START", id=""), metadata=md)
```

## LeaveWorld / Respawn / AcceptAccess

- `LeaveWorld(BotRef)`, `Respawn(BotRef)`, `AcceptAccess(BotRef)`
- `AcceptAccess` wrenches nearest player and confirms both dialogs in sequence.

## Active

`rpc Active(TileActionRequest) returns (Empty)` — `{ bot, x, y }` where `x`/`y` are **offsets from bot tile** (like Lua).

## Enter

`rpc Enter(EnterRequest) returns (Empty)` — `{ bot, pass, has_pass }`. `has_pass=true` + `pass` to enter locked door.
