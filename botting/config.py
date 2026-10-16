"""Configuration loader for Growtopia botting scripts.

Resolution order (first wins):
    CLI arguments  >  environment variables  >  .env file  >  defaults
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


# ── Growtopia item ids ────────────────────────────────────────────────────────
# Verified against items.dat (v24): block_health / 6 = punches needed with fist.

DEFAULT_TARGET_BLOCKS: Set[int] = {
    2,   # Dirt         (hp 18 -> 3 punches)
    4,   # Lava         (hp 24 -> 4 punches)
    10,  # Rock         (hp 60 -> 10 punches)
    14,  # Cave Background (bg, hp 18 -> 3 punches)
}

# Never punched. Included for documentation / reporting; the punch planner is
# whitelist-based, so anything outside DEFAULT_TARGET_BLOCKS is protected anyway.
PROTECTED_FG_IDS: Set[int] = {
    6,      # Main Door
    8,      # Bedrock
    20,     # Sign
    242,    # World Lock
    202,    # Small Lock
    204,    # Big Lock
    206,    # Huge Lock
    1796,   # Diamond Lock
    2408,   # Emerald Lock
    7188,   # Blue Gem Lock
    10410,  # Legendary Lock
    3760,   # Data Bedrock
    7372,   # Monochromatic Bedrock
}

LOCK_IDS: Set[int] = {202, 204, 206, 242, 1796, 2408, 7188, 10410}


@dataclass
class BotConfig:
    host: str = "127.0.0.1"
    grpc_port: int = 50051
    token: str = ""

    target_block_ids: Set[int] = field(default_factory=lambda: set(DEFAULT_TARGET_BLOCKS))
    protected_fg_ids: Set[int] = field(default_factory=lambda: set(PROTECTED_FG_IDS))

    # Pacing (mimics a real client; raising these = more conservative).
    walk_delay_ms: int = 180   # per tile step
    punch_delay_ms: int = 150  # per punch (hold-button rate)

    # Sweep options.
    start_edge: str = "auto"   # auto | left | right
    world: str = ""            # optional: warp to this world first
    door: str = ""             # optional door id for Warp

    # Safety / recovery.
    auto_collect: bool = False
    leave_on_mod: bool = True
    max_respawn: int = 4
    max_punch_rounds: int = 3
    max_hits_per_tile: int = 80

    bot_id: Optional[int] = None

    @property
    def grpc_addr(self) -> str:
        return f"{self.host}:{self.grpc_port}"

    @property
    def place_s(self) -> float:
        return max(self.punch_delay_ms, 60) / 1000.0

    @property
    def walk_timeout_s(self) -> float:
        return max(self.walk_delay_ms, 120) / 1000.0 + 1.0

    @classmethod
    def from_env_and_args(cls, args: Optional[argparse.Namespace] = None) -> "BotConfig":
        load_dotenv()

        env_addr = os.environ.get("MORI_GRPC_ADDR", "")
        host, grpc_port = "192.168.193.66", 50051
        if env_addr:
            if env_addr.count(":") >= 1:
                h, _, p = env_addr.rpartition(":")
                host = h if h and h != "0.0.0.0" else "127.0.0.1"
                try:
                    grpc_port = int(p)
                except ValueError:
                    pass
            else:
                host = env_addr
        else:
            # Aliases used by the repo .env
            host = os.environ.get("MORI_HOST", "127.0.0.1") or "127.0.0.1"
            if host == "0.0.0.0":
                host = "127.0.0.1"
            port_env = os.environ.get("MORI_GRPC_PORT", "50051")
            if port_env.isdigit():
                grpc_port = int(port_env)

        token = os.environ.get("MORI_GRPC_TOKEN", "")
        bot_id_env = os.environ.get("BOT_ID", "")
        bot_id = int(bot_id_env) if bot_id_env.isdigit() else None

        target_ids = set(DEFAULT_TARGET_BLOCKS)
        env_blocks = os.environ.get("TARGET_BLOCKS", "") or os.environ.get("TARGET_BLOCK_IDS", "")
        if env_blocks:
            parsed = _parse_id_list(env_blocks)
            if parsed:
                target_ids = parsed

        walk_delay = int(os.environ.get("WALK_DELAY_MS", "180"))
        punch_delay = int(os.environ.get("PUNCH_DELAY_MS", os.environ.get("PLACE_DELAY_MS", "150")))
        start_edge = os.environ.get("START_EDGE", "auto").lower()
        world = os.environ.get("WORLD", "")

        if args:
            if getattr(args, "host", None):
                host = args.host
            if getattr(args, "port", None):
                grpc_port = args.port
            if getattr(args, "token", None):
                token = args.token
            if getattr(args, "bot_id", None) is not None:
                bot_id = args.bot_id
            if getattr(args, "world", None):
                world = args.world
            if getattr(args, "start", None):
                start_edge = args.start.lower()
            if getattr(args, "walk_delay", None):
                walk_delay = args.walk_delay
            if getattr(args, "punch_delay", None):
                punch_delay = args.punch_delay
            if getattr(args, "blocks", None):
                parsed = _parse_id_list(args.blocks)
                if parsed:
                    target_ids = parsed

        if start_edge not in {"auto", "left", "right"}:
            start_edge = "auto"

        return cls(
            host=host,
            grpc_port=grpc_port,
            token=token,
            target_block_ids=target_ids,
            protected_fg_ids=set(PROTECTED_FG_IDS),
            walk_delay_ms=int(walk_delay),
            punch_delay_ms=int(punch_delay),
            start_edge=start_edge,
            world=world,
            door=os.environ.get("DOOR", ""),
            auto_collect=False if not args else bool(getattr(args, "collect", False)),
            leave_on_mod=True if not args else not bool(getattr(args, "no_leave_on_mod", False)),
            max_respawn=int(getattr(args, "max_respawn", None) or 4) if args else 4,
            bot_id=bot_id,
        )


def _parse_id_list(text: str) -> Set[int]:
    out: Set[int] = set()
    for part in text.replace(";", ",").split(","):
        part = part.strip()
        if part.isdigit():
            out.add(int(part))
    return out
