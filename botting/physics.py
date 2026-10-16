"""Physics validation, item rules and coordinate helpers for Growtopia botting.

Enforces:
1. Anti-float: the bot may only occupy a tile that is passable AND supported
   by a solid block directly below (or the bottom of the world).
2. Anti-teleport: movement happens one adjacent tile at a time.
3. Target filtering: only whitelisted blocks (dirt / lava / rock / cave bg)
   are ever punched. Everything else is treated as a world obstacle.
4. Obstacle preservation: bedrock, world locks, doors, signs, checkpoints and
   any other non-whitelisted item is never punched (never even touched).

The punch rule is deliberately *whitelist based*: a punch is only allowed when
the foreground tile is empty or whitelisted. A world lock / sign / door /
checkpoint in front of a background target therefore blocks that background
tile instead of being interacted with.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Set, Tuple

# ── Fallback tables (used only when live item info is unavailable) ────────────

# Standard foreground items that do not block movement and do not support standing.
NON_SOLID_FG: Set[int] = {
    0,   # Air / empty
    6,   # Main Door
    18,  # Fist (dropped item visual)
    20,  # Sign
    28,  # Mushroom
    32,  # Daisy
}

# Known solid items in vanilla Growtopia when items.dat collision info is unavailable.
KNOWN_SOLID_FG: Set[int] = {
    1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 242, 202, 204, 206
}

# Collision types (items.dat) that provide solid ground support.
SOLID_SUPPORT_TYPES: frozenset = frozenset({1, 2, 3, 10, 11})

# Punch hits needed when GetItemInfo is unavailable (block_health / 6).
DEFAULT_STRENGTH: dict = {
    2: 3,     # Dirt (18 / 6)
    4: 4,     # Lava (24 / 6)
    10: 10,   # Rock (60 / 6)
    14: 3,    # Cave Background (18 / 6)
    16: 2,    # Grass
    104: 3,   # Rock Background
    3564: 3,  # Cave Dirt
}


def grid_tile(grid: Mapping[Tuple[int, int], Tuple[int, int]], x: int, y: int) -> Tuple[int, int]:
    """Returns the cached (fg, bg) for a tile; missing tiles are treated as air."""
    t = grid.get((x, y))
    if isinstance(t, tuple):
        return t
    if t is None:
        return (0, 0)
    return (getattr(t, "fg_item_id", 0), getattr(t, "bg_item_id", 0))


def grid_fg(grid: Mapping[Tuple[int, int], Tuple[int, int]], x: int, y: int) -> int:
    return grid_tile(grid, x, y)[0]


def is_solid_support(fg_item_id: int, collision_map: Optional[Mapping[int, int]] = None) -> bool:
    """True if the foreground item provides solid footing for a tile above it."""
    if fg_item_id == 0:
        return False

    if collision_map is not None:
        ct = collision_map.get(fg_item_id)
        if ct is None:
            # Unknown item: assume solid unless it is a known pass-through item.
            return fg_item_id not in NON_SOLID_FG
        return ct in SOLID_SUPPORT_TYPES

    return fg_item_id in KNOWN_SOLID_FG or (
        fg_item_id > 0 and fg_item_id not in NON_SOLID_FG
    )


def is_tile_passable(
    fg_item_id: int,
    collision_map: Optional[Mapping[int, int]] = None,
    is_downward: bool = False,
) -> bool:
    """True if a bot body can occupy the tile (air / pass-through item).

    Platforms (collision_type 2) are passable horizontally and upwards but
    block straight downward movement.
    """
    if fg_item_id == 0:
        return True

    if collision_map is not None:
        ct = collision_map.get(fg_item_id)
        if ct is None:
            return fg_item_id in NON_SOLID_FG
        if ct == 0:
            return True
        if ct == 2:
            return not is_downward
        return False

    return fg_item_id in NON_SOLID_FG


def is_standable_grid(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    collision_map: Mapping[int, int],
    x: int,
    y: int,
    world_w: int = 100,
    world_h: int = 60,
) -> bool:
    """Checks whether the bot can stand safely at (x, y) without floating.

    ANTI-FLOAT RULE:
    1. The tile (x, y) must be inside world boundaries.
    2. The tile (x, y) must be passable (bot's body space is air/empty).
    3. The tile directly below (x, y + 1) must be solid ground support
       (or the world floor).
    """
    if x < 0 or y < 0 or x >= world_w or y >= world_h:
        return False

    cur_fg = grid_fg(grid, x, y)
    if not is_tile_passable(cur_fg, collision_map):
        return False

    # Bottom boundary of the world is grounded.
    if y + 1 >= world_h:
        return True

    return is_solid_support(grid_fg(grid, x, y + 1), collision_map)


def is_target_block(tile: Any, target_ids: Set[int]) -> bool:
    """True if the tile contains a foreground OR background target block."""
    if not tile:
        return False

    if isinstance(tile, tuple):
        fg, bg = tile[0], tile[1]
    else:
        fg = getattr(tile, "fg_item_id", 0)
        bg = getattr(tile, "bg_item_id", 0)

    return fg in target_ids or bg in target_ids


def is_unbreakable_obstacle(fg_id: int, protected_ids: Set[int]) -> bool:
    """True if the block is protected (bedrock, world lock, door, sign, ...)."""
    return fg_id in protected_ids


# ── Punch planning ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PunchPlan:
    """Result of evaluating whether/how a tile may be punched.

    allowed: the tile may be punched at all (fg is empty or whitelisted).
    hits:    estimated punch count to fully clear fg + bg targets.
    reason:  why punching is disallowed, when it is.
    """

    allowed: bool
    hits: int
    reason: str

    @property
    def has_work(self) -> bool:
        return self.allowed and self.hits > 0


def plan_punch(
    fg: int,
    bg: int,
    target_ids: Set[int],
    strength_map: Optional[Mapping[int, int]] = None,
    collision_map: Optional[Mapping[int, int]] = None,
) -> PunchPlan:
    """Decides whether a tile can be punched and how many hits it needs.

    Whitelist rule: punching is only allowed when the foreground is empty or
    whitelisted. This guarantees world locks, doors, signs, checkpoints,
    bedrock, trees, etc. are never interacted with, even when the background
    behind them is a target.
    """
    if fg != 0 and fg not in target_ids:
        return PunchPlan(False, 0, f"fg_protected:{fg}")

    strength_map = strength_map or {}
    hits = 0
    if fg in target_ids:
        hits += max(1, strength_map.get(fg, DEFAULT_STRENGTH.get(fg, 2)))
    if bg in target_ids:
        hits += max(1, strength_map.get(bg, DEFAULT_STRENGTH.get(bg, 2)))

    if hits == 0:
        return PunchPlan(False, 0, "no_target")
    return PunchPlan(True, hits, "ok")


def relative_offset(from_x: int, from_y: int, to_x: int, to_y: int) -> Tuple[int, int]:
    """Relative offset (dx, dy) from the bot tile to a target tile."""
    return to_x - from_x, to_y - from_y


def is_within_punch_range(dx: int, dy: int, max_range: int = 3, max_diag: int = 4) -> bool:
    """Vanilla-ish punch reach:

    - |dx| <= 3 and |dy| <= 3 tiles
    - Manhattan distance <= 4
    - Standing inside the target tile is rejected.
    """
    if dx == 0 and dy == 0:
        return False
    return abs(dx) <= max_range and abs(dy) <= max_range and (abs(dx) + abs(dy) <= max_diag)
