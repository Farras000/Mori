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
