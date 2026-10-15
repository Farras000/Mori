"""Physics validation and coordinate calculations for Growtopia movement and block breaking.

Enforces:
1. Anti-float: The bot must always be supported by solid ground beneath its feet.
2. Anti-teleport: Movement must occur tile-by-tile with natural walking delays.
3. Target filtering: Only targeted blocks (e.g. dirt, rock, lava, cave bg) are broken.
4. Obstacle preservation: Bedrock, World Locks, doors, and protected items are never hit.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Set, Tuple

# Standard foreground items that do not block movement and do not support standing
NON_SOLID_FG: Set[int] = {
    0,   # Air / empty
    6,   # Main Door
    18,  # Checkpoint
    20,  # Sign
    28,  # Mushroom
    32,  # Daisy
}

# Known solid items in vanilla Growtopia if items.dat collision info is unavailable
KNOWN_SOLID_FG: Set[int] = {
    1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 242, 202, 204, 206
}


def is_solid_support(fg_item_id: int, collision_map: Optional[Mapping[int, int]] = None) -> bool:
    """Returns True if the foreground block provides solid footing underneath the bot's feet.

    Foothold definition: solid block (collision_type 1), platform (collision_type 2),
    or locked/permission solid block. Air (0) and pass-through items (6, 18, 20, 28, 32)
    are NOT solid support.
    """
    if fg_item_id in NON_SOLID_FG:
        return False

    if collision_map is not None:
        # collision_type 0: none/air, 1: solid, 2: platform, 3/10/11: lock/door/entrance
        ct = collision_map.get(fg_item_id, 0)
        return ct in {1, 2, 3, 10, 11}

    # Fallback to known solid list if collision map is omitted
    return fg_item_id in KNOWN_SOLID_FG or fg_item_id > 0


def is_tile_passable(
    fg_item_id: int,
    collision_map: Optional[Mapping[int, int]] = None,
    is_downward: bool = False,
) -> bool:
    """Returns True if a bot can occupy the tile (x, y).

    Tile must be air or passable object. Platforms are passable horizontally and
    upwards, but block downward passage.
    """
    if fg_item_id in {0, 6, 18, 20, 28, 32}:
        return True

    if collision_map is not None:
        ct = collision_map.get(fg_item_id, 0)
        if ct == 0:
            return True
        if ct == 2:
            # Platform: passable unless stepping straight down into it
            return not is_downward
        return False

    return False


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
       (or bottom of world).
    """
    if x < 0 or y < 0 or x >= world_w or y >= world_h:
        return False

    cur_tile = grid.get((x, y), (0, 0))
    cur_fg = cur_tile[0] if isinstance(cur_tile, tuple) else getattr(cur_tile, "fg_item_id", 0)

    if not is_tile_passable(cur_fg, collision_map):
        return False

    # Bottom boundary of the world is grounded
    if y + 1 >= world_h:
        return True

    below_tile = grid.get((x, y + 1), (0, 0))
    below_fg = below_tile[0] if isinstance(below_tile, tuple) else getattr(below_tile, "fg_item_id", 0)

    return is_solid_support(below_fg, collision_map)


def is_target_block(tile: Any, target_ids: Set[int]) -> bool:
    """Returns True if the tile contains a foreground OR background target block."""
    if not tile:
        return False

    if isinstance(tile, tuple):
        fg, bg = tile[0], tile[1]
    else:
        fg = getattr(tile, "fg_item_id", 0)
        bg = getattr(tile, "bg_item_id", 0)

    return fg in target_ids or bg in target_ids


def is_unbreakable_obstacle(fg_id: int, protected_ids: Set[int]) -> bool:
    """Returns True if the block is protected (Bedrock, World Lock, Door, Sign, etc.)."""
    return fg_id in protected_ids


def relative_offset(from_x: int, from_y: int, to_x: int, to_y: int) -> Tuple[int, int]:
    """Calculates relative offset (dx, dy) from bot tile to target tile."""
    return to_x - from_x, to_y - from_y


def is_within_punch_range(dx: int, dy: int, max_range: int = 3, max_diag: int = 4) -> bool:
    """Enforces Growtopia vanilla punch range:

    - Horizontal distance <= 3 tiles
    - Vertical distance <= 3 tiles
    - Manhattan diagonal distance <= 4 tiles
    - Not standing directly inside the block being punched (dx!=0 or dy!=0)
    """
    if dx == 0 and dy == 0:
        return False
    return abs(dx) <= max_range and abs(dy) <= max_range and (abs(dx) + abs(dy) <= max_diag)
