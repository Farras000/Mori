# Connection / raw

> Prev: [collection.md](./collection.md) · Next: [settings.md](./settings.md)

- `Reconnect(BotRef)` — clears manual-disconnect latch; reconnects immediately if offline, else disconnect-then-reconnect.
- `Disconnect(BotRef)` — manual disconnect; stays offline until `Reconnect` (`auto_reconnect` only covers unexpected drops).
- `SendPacket({ bot, packet_type, text })` — `packet_type` must fit `u8`, else `INVALID_ARGUMENT`.
- `SendRaw({ bot, packet })` — `GameUpdatePacket { type, object_type, count1, count2, netid, item, flags, float_var, int_data, vec_x, vec_y, vec2_x, vec2_y, particle_rotation, int_x, int_y }`. Missing `packet` → default (no-op).
- `SetMac({ bot, mac })` — sets MAC `XX:XX:XX:XX:XX:XX`.

```python
stub.SendPacket(pb.SendPacketRequest(bot=bot, packet_type=2, text="action|input\n|text|hi"), metadata=md)
stub.SendRaw(pb.SendRawRequest(bot=bot, packet=pb.GameUpdatePacket(type=0)), metadata=md)
```
