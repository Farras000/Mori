#!/usr/bin/env python3
"""Mori gRPC example client (Python).

Replaces embedded Lua scripting for out-of-process automation.

Setup:
    pip install grpcio grpcio-tools   # stubs generate automatically on first run

Run:
    MORI_GRPC_TOKEN=<token> python examples/python_grpc_bot.py
"""

import os
import sys
import time

import grpc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import grpc_bootstrap as gen

pb, rpc = gen.pb, gen.rpc


def channel():
    try:
        from botting.config import load_dotenv
        load_dotenv()
    except Exception:
        pass
    addr = os.environ.get("MORI_GRPC_ADDR", "").strip()
    if not addr:
        h = os.environ.get("MORI_HOST", "").strip()
        p = os.environ.get("MORI_GRPC_PORT", "").strip()
        if h and p:
            addr = f"{h}:{p}"
        elif h:
            addr = h
    if not addr:
        raise ValueError("Kredensial MORI_GRPC_ADDR (atau MORI_HOST) wajib diset di .env tanpa fallback.")

    token = os.environ.get("MORI_GRPC_TOKEN", "").strip()
    if not token:
        raise ValueError("Kredensial MORI_GRPC_TOKEN wajib diset di .env tanpa fallback.")

    metadata = [("authorization", f"Bearer {token}")]
    ch = grpc.insecure_channel(addr)
    return ch, metadata


def main() -> None:
    ch, md = channel()
    stub = rpc.MoriStub(ch)

    # Manager: list bots
    bots = stub.ListBots(pb.Empty(), metadata=md)
    print(f"bots: {len(bots.bots)}")
    for b in bots.bots:
        print(f"  id={b.bot_id} user={b.username} status={b.status} world={b.world}")

    if not bots.bots:
        print("no bots running — spawn one via the web UI or SpawnBot first")
        return

    bot = pb.BotRef(bot_id=bots.bots[0].bot_id)

    # Queries
    state = stub.GetBotState(bot, metadata=md)
    print(f"state: {state.username} in '{state.world_name}' @ ({state.pos_x:.1f}, {state.pos_y:.1f})")
    print(f"ping={state.ping_ms}ms gems={state.gems}")

    inv = stub.GetInventory(bot, metadata=md)
    print(f"inventory: {len(inv.items)} stacks, size={inv.size}")

    try:
        world = stub.GetWorld(bot, metadata=md)
        print(f"world: {world.name} {world.width}x{world.height} "
              f"tiles={len(world.tiles)} objects={len(world.objects)} players={len(world.players)}")
    except grpc.RpcError as e:
        print(f"GetWorld: {e.code()} {e.details()}")

    # Actions
    stub.Say(pb.SayRequest(bot=bot, text="Hello from Python!"), metadata=md)
    print("said hello")

    # Events (streaming replaces Lua listenEvents)
    print("listening for events for 10s...")
    deadline = time.time() + 10
    try:
        for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):
            print(f"event: {ev.WhichOneof('event')}")
            if time.time() > deadline:
                break
    except grpc.RpcError as e:
        print(f"events ended: {e.code()} {e.details()}")


if __name__ == "__main__":
    main()
