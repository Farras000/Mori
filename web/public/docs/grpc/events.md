# Events (streaming)

> Prev: [queries.md](./queries.md) · Next: [messages.md](./messages.md)

`rpc SubscribeEvents(SubscribeRequest { bot_ids }) returns (stream BotEvent)`

- `bot_ids=[]` → all bots; non-empty → filter.
- Replaces Lua `listenEvents`. Server buffers 256; lagged messages skipped (`Lagged` → continue).
- Cancel by dropping stream / deadline.

```python
for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):
    kind = ev.WhichOneof("event")
    print(kind, ev)
```

`BotEvent.event` oneof:

`bot_added(BotInfo)`, `bot_removed(BotRef)`, `bot_status{bot_id,status}`, `bot_world{bot_id,world_name}`, `bot_move{bot_id,x,y}`, `bot_gems{bot_id,gems}`, `bot_ping{bot_id,ping_ms}`, `player_spawn{bot_id,net_id,name,country,x,y}`, `player_move{bot_id,net_id,x,y}`, `player_leave{bot_id,net_id}`, `world_loaded{bot_id,name,width,height,tiles[]}`, `tile_update{bot_id,x,y,fg,bg}`, `objects_update{bot_id,objects[]}`, `inventory_update{bot_id,gems,inventory_size,items[]}`, `console{bot_id,message}`, `track_info{bot_id,level,grow_id,install_date,global_playtime,awesomeness}`, `username{bot_id,username}`, `auto_collect{bot_id,enabled}`, `delays{bot_id,delays}`

Status strings: `connecting|connected|in_game|disconnected|two_factor_auth|server_overloaded|too_many_logins|update_required|maintenance` (see [errors.md](./errors.md)).
