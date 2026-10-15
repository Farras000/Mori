"""Grounded navigation and physics-safe movement for Growtopia bots.

Prevents anti-cheat bans by strictly stepping tile-by-tile over grounded
footholds, enforcing realistic foot speed delays (~200ms per step),
and simulating gravity settlement when floating.
"""

from __future__ import annotations

import math
import os
import sys
import time
from collections import deque
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import grpc

# Add repo root and examples dir to sys.path
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
_EXAMPLES_DIR = os.path.join(_ROOT, "examples")
if _EXAMPLES_DIR not in sys.path:
    sys.path.insert(0, _EXAMPLES_DIR)

import grpc_bootstrap as gen
pb, rpc = gen.pb, gen.rpc

from botting.physics import (
    is_solid_support,
    is_standable_grid,
    is_tile_passable,
    is_within_punch_range,
)


def server_pos_tiles(stub: rpc.MoriStub, bot: pb.BotRef, md: Sequence[Tuple[str, str]]) -> Tuple[float, int, int]:
    """Queries bot's true position from the server.

    Returns (float_x, tile_x, tile_y).
    """
    try:
        local = stub.GetLocal(bot, metadata=md)
        return local.pos_x, int(round(local.pos_x)), int(round(local.pos_y))
    except grpc.RpcError:
        # Fallback to GetBotState if GetLocal fails
        state = stub.GetBotState(bot, metadata=md)
        return state.pos_x, int(round(state.pos_x)), int(round(state.pos_y))


def get_tile_safe(stub: rpc.MoriStub, bot: pb.BotRef, md: Sequence[Tuple[str, str]], x: int, y: int) -> Optional[Any]:
    """Safely retrieves a single tile from Mori without raising RpcError on OOB."""
    try:
        return stub.GetTile(pb.GetTileRequest(bot=bot, x=x, y=y), metadata=md)
    except grpc.RpcError:
        return None


def live_is_solid(
    stub: rpc.MoriStub,
    bot: pb.BotRef,
    md: Sequence[Tuple[str, str]],
    x: int,
    y: int,
    coll: Mapping[int, int],
) -> Optional[bool]:
    """Queries live tile at (x, y) and checks if it provides solid ground support."""
    t = get_tile_safe(stub, bot, md, x, y)
    if t is None:
        return None
    if t.fg_item_id == 0:
        return False
    return is_solid_support(t.fg_item_id, coll)


def step_one(
    stub: rpc.MoriStub,
    bot: pb.BotRef,
    md: Sequence[Tuple[str, str]],
    frm: Tuple[int, int],
    to: Tuple[int, int],
    walk_ms: int = 200,
) -> bool:
    """Takes exactly ONE step to an adjacent tile (|dx| + |dy| == 1).

    Issues WalkTo and verifies server position update to prevent teleport desync.
    """
    fx, fy = frm
    tx, ty = to

    # Enforce strictly adjacent move
    if abs(tx - fx) + abs(ty - fy) != 1:
        return False
    if tx < 0 or ty < 0:
        return False

    try:
        stub.WalkTo(pb.MoveToRequest(bot=bot, x=tx, y=ty), metadata=md)
    except grpc.RpcError:
        return False

    # Wait for the legit walk delay
    time.sleep(max(walk_ms / 1000.0, 0.15))

    try:
        _, bx, by = server_pos_tiles(stub, bot, md)
        return (bx, by) == (tx, ty)
    except grpc.RpcError:
        return False


def escape_embedded(
    stub: rpc.MoriStub,
    bot: pb.BotRef,
    md: Sequence[Tuple[str, str]],
    coll: Mapping[int, int],
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    world_w: int,
    world_h: int,
    walk_ms: int = 200,
    tries: int = 4,
) -> bool:
    """Escapes if the bot gets embedded inside a solid block."""
    for _ in range(tries):
        _, bx, by = server_pos_tiles(stub, bot, md)
        if not live_is_solid(stub, bot, md, bx, by, coll):
            return True  # Body tile is clear!

        # Try jumping up out of block, or moving sideways
        routes = [(bx, by - 1), (bx - 1, by), (bx + 1, by), (bx, by + 1)]
        for tx, ty in routes:
            if tx < 0 or ty < 0 or tx >= world_w or ty >= world_h:
                continue
            if step_one(stub, bot, md, (bx, by), (tx, ty), walk_ms):
                if not live_is_solid(stub, bot, md, tx, ty, coll):
                    return True

    _, bx, by = server_pos_tiles(stub, bot, md)
    return not live_is_solid(stub, bot, md, bx, by, coll)


def settle(
    stub: rpc.MoriStub,
    bot: pb.BotRef,
    md: Sequence[Tuple[str, str]],
    coll: Mapping[int, int],
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    world_w: int,
    world_h: int,
    walk_ms: int = 200,
    max_fall: int = 40,
) -> bool:
    """Simulates gravity settlement.

    If the bot is floating in mid-air (tile below is air/empty), steps
    downward tile-by-tile until solid ground is reached.
    """
    for _ in range(max_fall):
        _, bx, by = server_pos_tiles(stub, bot, md)

        # Check if embedded in block first
        if live_is_solid(stub, bot, md, bx, by, coll):
            up = get_tile_safe(stub, bot, md, bx, by - 1)
            if up and up.fg_item_id == 0:
                if step_one(stub, bot, md, (bx, by), (bx, by - 1), walk_ms):
                    continue
            if not escape_embedded(stub, bot, md, coll, grid, world_w, world_h, walk_ms):
                return False
            continue

        # Check ground below
        below = live_is_solid(stub, bot, md, bx, by + 1, coll)
        if below is True or by + 1 >= world_h:
            return True  # Safely grounded!

        # Fall down one tile
        if not step_one(stub, bot, md, (bx, by), (bx, by + 1), walk_ms):
            return False

    return False


def bfs_grounded_path(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    start: Tuple[int, int],
    goal: Tuple[int, int],
    world_w: int,
    world_h: int,
    limit: int = 2048,
) -> Optional[List[Tuple[int, int]]]:
    """Finds a sequence of adjacent footholds strictly connecting start to goal.

    Every single intermediate node MUST be a standable foothold.
    This guarantees the bot never routes through open air!
    """
    if start == goal:
        return [start]

    if not is_standable_grid(grid, coll, goal[0], goal[1], world_w, world_h):
        return None

    q: deque[Tuple[int, int]] = deque([start])
    prev: Dict[Tuple[int, int], Optional[Tuple[int, int]]] = {start: None}
    seen: Set[Tuple[int, int]] = {start}

    directions = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    while q and len(seen) < limit:
        cur = q.popleft()
        cx, cy = cur

        for dx, dy in directions:
            nxt = (cx + dx, cy + dy)
            if nxt in seen:
                continue

            if not is_standable_grid(grid, coll, nxt[0], nxt[1], world_w, world_h):
                continue

            seen.add(nxt)
            prev[nxt] = cur

            if nxt == goal:
                # Reconstruct path
                path = [nxt]
                while prev[path[-1]] is not None:
                    path.append(prev[path[-1]])  # type: ignore
                return path[::-1]

            q.append(nxt)

    return None


def walk_grounded(
    stub: rpc.MoriStub,
    bot: pb.BotRef,
    md: Sequence[Tuple[str, str]],
    goal: Tuple[int, int],
    coll: Mapping[int, int],
    grid: Dict[Tuple[int, int], Tuple[int, int]],
    world_w: int,
    world_h: int,
    walk_ms: int = 200,
) -> bool:
    """Walks safely across grounded footholds to goal."""
    settle(stub, bot, md, coll, grid, world_w, world_h, walk_ms)
    _, bx, by = server_pos_tiles(stub, bot, md)

    if (bx, by) == goal:
        return True

    # Ensure current standing position is valid in grid
    if not is_standable_grid(grid, coll, bx, by, world_w, world_h):
        for dy in (0, 1):
            t = get_tile_safe(stub, bot, md, bx, by + dy)
            if t is not None:
                grid[(bx, by + dy)] = (t.fg_item_id, t.bg_item_id)
        if not is_standable_grid(grid, coll, bx, by, world_w, world_h):
            if not escape_embedded(stub, bot, md, coll, grid, world_w, world_h, walk_ms):
                return False

    for _ in range(256):
        _, cx, cy = server_pos_tiles(stub, bot, md)
        if (cx, cy) == goal:
            return True

        path = bfs_grounded_path(grid, coll, (cx, cy), goal, world_w, world_h)
        if not path or len(path) < 2:
            return False

        nxt = path[1]
        if not step_one(stub, bot, md, (cx, cy), nxt, walk_ms):
            return False

        settle(stub, bot, md, coll, grid, world_w, world_h, walk_ms)

    return False


def pick_stand(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    tx: int,
    ty: int,
    bx: int,
    by: int,
    world_w: int,
    world_h: int,
) -> Optional[Tuple[int, int]]:
    """Selects the best standable foothold within safe punch reach of (tx, ty).

    Sorts candidates by proximity to current bot position (bx, by) to minimize walking.
    """
    candidates: List[Tuple[int, int]] = []

    # Priority 1: Stand directly on top of the block (tx, ty - 1)
    candidates.append((tx, ty - 1))

    # Priority 2: Stand adjacent horizontally or diagonally
    offsets = [
        (-1, 0), (1, 0), (0, 1),
        (-1, -1), (1, -1), (-1, 1), (1, 1),
        (-2, 0), (2, 0), (0, -2),
        (-2, -1), (2, -1), (-1, -2), (1, -2),
    ]
    for dx, dy in offsets:
        candidates.append((tx + dx, ty + dy))

    # Sort candidates by distance from bot
    candidates = sorted(candidates, key=lambda p: abs(p[0] - bx) + abs(p[1] - by))

    for sx, sy in candidates:
        if not is_standable_grid(grid, coll, sx, sy, world_w, world_h):
            continue
        dx = tx - sx
        dy = ty - sy
        if not is_within_punch_range(dx, dy):
            continue
        return sx, sy

    return None
