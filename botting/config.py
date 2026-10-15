"""Configuration loader and environment manager for Growtopia clear world botting.

Reads settings from .env file, environment variables, or CLI arguments.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from typing import Optional, Set


def load_dotenv(path: Optional[str] = None) -> None:
    """Minimal, robust .env parser without external dependencies."""
    candidates = []
    if path:
        candidates.append(path)
    else:
        # Check current working directory, script directory, and repo root
        cwd = os.getcwd()
        candidates.append(os.path.join(cwd, ".env"))
        here = os.path.dirname(os.path.abspath(__file__))
        candidates.append(os.path.join(here, ".env"))
        root = os.path.dirname(here)
        candidates.append(os.path.join(root, ".env"))

    for p in candidates:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if line.startswith("export "):
                            line = line[len("export "):].strip()
                        if "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip('"').strip("'")
                            if k and k not in os.environ:
                                os.environ[k] = v
                break
            except Exception as e:
                print(f"[config] Warning loading .env from {p}: {e}", file=sys.stderr)


# Growtopia item IDs
DEFAULT_TARGET_BLOCKS: Set[int] = {
    2,   # Dirt (Foreground)
    4,   # Lava (Foreground)
    10,  # Rock (Foreground)
    14,  # Cave Background (Background)
}

# Protected blocks that should NEVER be hit or destroyed
PROTECTED_FG_IDS: Set[int] = {
    6,      # Main Door (World entrance/spawn)
    8,      # Bedrock (Unbreakable)
    20,     # Sign
    242,    # World Lock
    202,    # Small Lock
    204,    # Big Lock
    206,    # Huge Lock
    1796,   # Diamond Lock
    2408,   # Blue Gem Lock
    7188,   # Robotic Lock
    10410,  # Royal Lock
}

LOCK_IDS: Set[int] = {
    202, 204, 206, 242, 1796, 2408, 7188, 10410
}


@dataclass
class BotConfig:
    host: str = "127.0.0.1"
    grpc_port: int = 50051
    control_port: int = 3000
    token: str = ""
    target_block_ids: Set[int] = field(default_factory=lambda: set(DEFAULT_TARGET_BLOCKS))
    protected_fg_ids: Set[int] = field(default_factory=lambda: set(PROTECTED_FG_IDS))
    place_delay_ms: int = 180
    walk_delay_ms: int = 200
    bot_id: Optional[int] = None
    max_hits_per_block: int = 60
    max_attempts: int = 5

    @property
    def grpc_addr(self) -> str:
        return f"{self.host}:{self.grpc_port}"

    @classmethod
    def from_env_and_args(cls, args: Optional[argparse.Namespace] = None) -> BotConfig:
        load_dotenv()

        # Parse MORI_GRPC_ADDR if set
        env_addr = os.environ.get("MORI_GRPC_ADDR", "")
        host = "127.0.0.1"
        grpc_port = 50051

        if env_addr:
            if ":" in env_addr:
                parts = env_addr.split(":", 1)
                host = parts[0] if parts[0] and parts[0] != "0.0.0.0" else "127.0.0.1"
                try:
                    grpc_port = int(parts[1])
                except ValueError:
                    pass
            else:
                host = env_addr

        token = os.environ.get("MORI_GRPC_TOKEN", "")
        bot_id_env = os.environ.get("BOT_ID", None)
        bot_id = int(bot_id_env) if bot_id_env and bot_id_env.isdigit() else None

        target_ids = set(DEFAULT_TARGET_BLOCKS)
        env_blocks = os.environ.get("TARGET_BLOCKS", "")
        if env_blocks:
            parsed = set()
            for part in env_blocks.replace(";", ",").split(","):
                part = part.strip()
                if part.isdigit():
                    parsed.add(int(part))
            if parsed:
                target_ids = parsed

        walk_delay = int(os.environ.get("WALK_DELAY_MS", "200"))
        place_delay = int(os.environ.get("PLACE_DELAY_MS", "180"))

        if args:
            if getattr(args, "host", None):
                host = args.host
            if getattr(args, "port", None):
                grpc_port = args.port
            if getattr(args, "token", None):
                token = args.token
            if getattr(args, "bot_id", None) is not None:
                bot_id = args.bot_id
            if getattr(args, "walk_delay", None):
                walk_delay = args.walk_delay
            if getattr(args, "punch_delay", None):
                place_delay = args.punch_delay
            if getattr(args, "blocks", None):
                parsed = set()
                for part in args.blocks.replace(";", ",").split(","):
                    part = part.strip()
                    if part.isdigit():
                        parsed.add(int(part))
                if parsed:
                    target_ids = parsed

        return cls(
            host=host,
            grpc_port=grpc_port,
            token=token,
            target_block_ids=target_ids,
            protected_fg_ids=set(PROTECTED_FG_IDS),
            place_delay_ms=place_delay,
            walk_delay_ms=walk_delay,
            bot_id=bot_id,
        )
