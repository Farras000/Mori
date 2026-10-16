"""Dropper helpers for Growtopia botting scripts.

Pure, testable logic for:
- locating the white door (Main Door, item id 6),
- identifying maxed inventory items (count >= 200) that can be dropped,
- choosing a valid drop spot beside the white door where the item lands at
  (door_x +/- 1, door_y) and the bot stands at (door_x +/- 2, door_y) facing the door.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Set, Tuple

from botting.config import LOCK_IDS, PROTECTED_FG_IDS
from botting.physics import is_standable_grid, is_tile_passable

Coord = Tuple[int, int]
Tile = Tuple[int, int]

WHITE_DOOR_ID = 6

# Items that must NEVER be dropped under any circumstance:
# 18 = Fist, 32 = Wrench, 112 = Gems, locks, and protected fixtures.
PROTECTED_DROP_IDS: Set[int] = (
    {18, 32, 112} | set(LOCK_IDS) | set(PROTECTED_FG_IDS)
)


@dataclass(frozen=True)
class DropSpot:
    stand: Coord       # tile where the bot stands (door_x +/- 2, door_y)
    item_tile: Coord   # tile where the item lands (door_x +/- 1, door_y)
    facing_left: bool  # facing direction toward the door


def find_white_door(grid: Mapping[Coord, Tile]) -> Optional[Coord]:
    """Scans world snapshot for the white door (item id 6)."""
    for (x, y), (fg, _bg) in grid.items():
        if fg == WHITE_DOOR_ID:
            return x, y
    return None


def maxed_items(
    amounts: Mapping[int, int],
    active_ids: Set[int],
    threshold: int = 200,
    protected: Optional[Set[int]] = None,
) -> List[Tuple[int, int]]:
    """Returns [(item_id, count)] for items with count >= threshold.

    Excludes protected items (fist, wrench, locks, gems) and currently worn items.
    """
    prot = PROTECTED_DROP_IDS if protected is None else protected
    out: List[Tuple[int, int]] = []
    for item_id, count in sorted(amounts.items()):
        if count < threshold:
            continue
        if item_id in prot:
            continue
        if item_id in active_ids:
            continue
        out.append((item_id, count))
    return out


def pick_drop_spot(
    grid: Mapping[Coord, Tile],
    coll: Mapping[int, int],
    door: Coord,
    world_w: int,
    world_h: int,
    reach: Set[Coord],
    bx: int,
    by: int,
) -> Optional[DropSpot]:
    """Selects a standable, reachable drop spot beside the white door.

    Candidate configurations:
    1. Stand at dx - 2, item at dx - 1, face right (facing_left=False)
    2. Stand at dx + 2, item at dx + 1, face left (facing_left=True)
    3. Stand at dx - 1, item at dx - 2, face left (facing_left=True)
    4. Stand at dx + 1, item at dx + 2, face right (facing_left=False)
    5. Stand at dx,     item at dx - 1, face left (facing_left=True)
    6. Stand at dx,     item at dx + 1, face right (facing_left=False)

    Prefers candidate whose stand tile is closest to bot's current position (bx, by).
    """
    dx, dy = door

    cands_far = [
        DropSpot(stand=(dx - 2, dy), item_tile=(dx - 1, dy), facing_left=False),
        DropSpot(stand=(dx + 2, dy), item_tile=(dx + 1, dy), facing_left=True),
    ]
    cands_close = [
        DropSpot(stand=(dx, dy),     item_tile=(dx - 1, dy), facing_left=True),
        DropSpot(stand=(dx, dy),     item_tile=(dx + 1, dy), facing_left=False),
        DropSpot(stand=(dx - 1, dy), item_tile=(dx - 2, dy), facing_left=True),
        DropSpot(stand=(dx + 1, dy), item_tile=(dx + 2, dy), facing_left=False),
    ]

    cands_far.sort(key=lambda s: abs(s.stand[0] - bx) + abs(s.stand[1] - by))
    cands_close.sort(key=lambda s: abs(s.stand[0] - bx) + abs(s.stand[1] - by))

    # If bot is already at the door (spawn), prefer standing at door to drop immediately;
    # otherwise prefer standing 2 tiles away facing door.
    cands = (cands_close + cands_far) if (bx, by) == (dx, dy) else (cands_far + cands_close)


    for spot in cands:
        sx, sy = spot.stand
        ix, iy = spot.item_tile

        # Boundary checks
        if not (0 <= sx < world_w and 0 <= sy < world_h):
            continue
        if not (0 <= ix < world_w and 0 <= iy < world_h):
            continue

        # Item tile must be passable so dropped item can land
        item_fg, _ = grid.get(spot.item_tile, (0, 0))
        if not is_tile_passable(item_fg, coll):
            continue

        # Stand tile must be standable (passable body + solid support)
        if not is_standable_grid(grid, coll, sx, sy, world_w, world_h):
            continue

        # Stand tile must be reachable from bot's current foothold (or bot is already standing on it)
        if spot.stand != (bx, by) and spot.stand not in reach:
            continue

        return spot

    return None

