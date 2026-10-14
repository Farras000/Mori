# Scripts (embedded Lua)

> Prev: [settings.md](./settings.md) · Next: [queries.md](./queries.md) · Lua ref: dashboard Docs tab / `LUA.md`

Same runner as in-process Lua, one script per bot at a time.

- `RunScript({ bot, content })` — `content` is Lua 5.4 source (`getBot()`, `listenEvents()`, …). Replaces any running script.
- `StopScript(BotRef)` — stops current script; no-op if none.

```python
stub.RunScript(pb.RunScriptRequest(bot=bot, content="say('hi from lua')"), metadata=md)
stub.StopScript(bot, metadata=md)
```

Prefer native RPCs for single actions; use `RunScript` for loops / event handlers that need `listenEvents` semantics without streaming (compare [events.md](./events.md)).
