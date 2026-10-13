#!/usr/bin/env python3
"""Say hello via gRPC with text from input().

Setup:
    pip install grpcio grpcio-tools   # stubs generate automatically on first run

Run:
    MORI_GRPC_TOKEN=<token> python examples/say_interactive.py
"""

import os
import sys

import grpc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import grpc_bootstrap as gen

pb, rpc = gen.pb, gen.rpc


def main() -> None:
    addr = os.environ.get("MORI_GRPC_ADDR", "localhost:50051")
    token = os.environ.get("MORI_GRPC_TOKEN", "")
    metadata = [("authorization", f"Bearer {token}")] if token else []

    stub = rpc.MoriStub(grpc.insecure_channel(addr))

    bots = stub.ListBots(pb.Empty(), metadata=metadata)
    if not bots.bots:
        print("no bots running")
        return
    for b in bots.bots:
        print(f"  id={b.bot_id} user={b.username} world={b.world}")

    raw = input("bot id: ").strip()
    bot = pb.BotRef(bot_id=int(raw))

    text = input("message [hello world]: ").strip() or "hello world"
    stub.Say(pb.SayRequest(bot=bot, text=text), metadata=metadata)
    print(f"sent: {text}")


if __name__ == "__main__":
    main()
