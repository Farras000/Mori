# Quickstart (Python)

> Prev: [overview.md](./overview.md) · Next: [manager.md](./manager.md) · Full example: `examples/python_grpc_bot.py`

```bash
pip install grpcio grpcio-tools
python -m grpc_tools.protoc -I proto --python_out=examples --grpc_python_out=examples proto/mori.proto
MORI_GRPC_TOKEN=secret python examples/python_grpc_bot.py
```

Or auto-generate on first run via `examples/grpc_bootstrap.py`:

```python
import os, sys, grpc
sys.path.insert(0, "examples")
import grpc_bootstrap as gen
pb, rpc = gen.pb, gen.rpc

addr = os.environ.get("MORI_GRPC_ADDR", "localhost:50051")
token = os.environ.get("MORI_GRPC_TOKEN", "")
md = [("authorization", f"Bearer {token}")] if token else []
ch = grpc.insecure_channel(addr)
stub = rpc.MoriStub(ch)

# list
bots = stub.ListBots(pb.Empty(), metadata=md)
print(len(bots.bots))
bot = pb.BotRef(bot_id=bots.bots[0].bot_id)

# query + action
state = stub.GetBotState(bot, metadata=md)
print(state.username, state.world_name, state.pos_x, state.pos_y)
stub.Say(pb.SayRequest(bot=bot, text="Hello from Python!"), metadata=md)

# events (server-streaming, replaces Lua listenEvents)
for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):
    print(ev.WhichOneof("event"))
```

Notes:
- `MORI_GRPC_ADDR` defaults to `localhost:50051`.
- Pass `metadata=md` on every call when `MORI_GRPC_TOKEN` is set, else `UNAUTHENTICATED` (see [errors.md](./errors.md)).
- Other languages: any `protoc` plugin works against `proto/mori.proto` (`/docs/mori.proto`).
