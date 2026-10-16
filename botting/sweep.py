"""Pure serpentine (boustrophedon) clear-world planner.

No I/O, no gRPC: given a tile grid snapshot + collision map, this module
decides *what the bot should do next* while sweeping a world layer by layer,
top to bottom:

    row y0:      dig in at the edge, sweep to the far edge, break 1 down
    row y0+1:    sweep back (serpentine), break 1 down again
    ...

Obstacles (bedrock, world locks, doors, signs, trees — anything not in the
target whitelist) are never punched: the planner either walks over a 1-tile
high obstacle column (vanilla auto-step) or marks the rest of the row segment
as blocked, to be handled by the cleanup pass afterwards.

Rule: a layer transition ("break 1 down") is only allowed on a world edge
column — x=0 or x=world_w-1 (see ``is_edge_column``). The executor enforces
this; ``is_exposed`` keeps the cleanup pass in layer order.

The executor (``clear_world.py``) performs the actual RPC calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import List, Mapping, Optional, Set, Tuple

from botting.physics import (
    PunchPlan,
    grid_fg,
    grid_tile,
    is_solid_support,
    is_standable_grid,
    is_tile_passable,
    plan_punch,
)

Tile = Tuple[int, int]


class StepKind(str, Enum):
    PUNCH_THEN_WALK = "punch_then_walk"  # clear the tile ahead, then step in
    WALK = "walk"                        # tile ahead is already clear
    BYPASS_OVER = "bypass_over"          # walk over a 1-tile obstacle column
    SKIP = "skip"                        # cannot pass at this row


@dataclass(frozen=True)
class StepDecision:
    kind: StepKind
    tx: int
    ty: int
    hits: int = 0
    needs_settle: bool = False
    reason: str = ""


class DescentKind(str, Enum):
    DIG = "dig"            # punch the tile below, then drop into it
    STEP_DOWN = "step_down"  # tile below is already enterable
    BLOCKED = "blocked"    # unbreakable/protected tile below (world bottom)
    BOTTOM = "bottom"      # below the world


@dataclass(frozen=True)
class DescentDecision:
    kind: DescentKind
    tx: int
    ty: int
    hits: int = 0
    needs_settle: bool = False
    reason: str = ""


def _support(grid: Mapping[Tuple[int, int], Tile], coll: Mapping[int, int], x: int, y: int, h: int) -> bool:
    if y >= h:
        return True
    return is_solid_support(grid_fg(grid, x, y), coll)


def plan_for(grid: Mapping[Tuple[int, int], Tile], coll: Mapping[int, int], targets: Set[int], strength: Mapping[int, int], x: int, y: int) -> PunchPlan:
    fg, bg = grid_tile(grid, x, y)
    return plan_punch(fg, bg, targets, strength, coll)


def find_top_row(
    grid: Mapping[Tuple[int, int], Tile],
    targets: Set[int],
    world_w: int,
    world_h: int,
    strength: Optional[Mapping[int, int]] = None,
    coll: Optional[Mapping[int, int]] = None,
) -> Optional[int]:
    """Smallest y containing a punchable target tile (None if world is clear)."""
    for y in range(world_h):
        for x in range(world_w):
            if plan_for(grid, coll or {}, targets, strength or {}, x, y).has_work:
                return y
    return None


def is_edge_column(x: int, world_w: int) -> bool:
    """True when ``x`` is a world edge column (x=0 or x=world_w-1).

    Layer transitions ("break 1 down") are only allowed on these columns.
    """
    return x == 0 or x == world_w - 1


def nearest_edge_column(x: int, world_w: int) -> int:
    """Returns the closer world edge column for ``x`` (deterministic on ties)."""
    return 0 if x < (world_w - 1) / 2 else world_w - 1


def detect_oscillation(hist: List[Tuple[int, int]], broken_first: int, broken_last: int) -> bool:
    """True when the recent position history shows ping-pong without progress.

    ``hist`` is the tail of visited tiles (oldest first, at least 6 entries
    expected). A 2-tile cycle (e.g. 66 <-> 67) with no block broken since the
    oldest entry means the sweep is walking in place: the caller should stop
    flipping direction and finish the leg instead.
    """
    if broken_last != broken_first:
        return False
    if len(hist) < 6:
        return False
    return len(set(hist[-6:])) <= 2


def is_exposed(
    grid: Mapping[Tuple[int, int], Tile],
    coll: Mapping[int, int],
    targets: Set[int],
    strength: Mapping[int, int],
    x: int,
    y: int,
    world_h: int,
    blocked: Optional[Mapping[Tuple[int, int], str]] = None,
) -> bool:
    """True when (x, y) has punch work and no remaining target above it.

    Used by the cleanup pass to respect the layer order: an upper layer is
    always cleared before the layer below it, so a tile may only be picked for
    cleanup when nothing in the same column above it still needs clearing
    (ignoring floating sky targets in ``blocked`` that are out of upward punch
    reach).
    """
    if not plan_for(grid, coll, targets, strength, x, y).has_work:
        return False
    for yy in range(max(0, y)):
        if blocked is not None and blocked.get((x, yy)) == "unreachable sky target":
            continue
        if plan_for(grid, coll, targets, strength, x, yy).has_work:
            return False
    return True


def choose_start_column(
    grid: Mapping[Tuple[int, int], Tile],
    targets: Set[int],
    world_w: int,
    y: int,
    strength: Optional[Mapping[int, int]] = None,
    coll: Optional[Mapping[int, int]] = None,
    edge: str = "left",
) -> Optional[int]:
    """Nearest punchable target column on row ``y`` to the given world edge."""
    if edge == "right":
        for x in range(world_w - 1, -1, -1):
            if plan_for(grid, coll or {}, targets, strength or {}, x, y).has_work:
                return x
        return None
    for x in range(world_w):
        if plan_for(grid, coll or {}, targets, strength or {}, x, y).has_work:
            return x
    return None


def count_targets(
    grid: Mapping[Tuple[int, int], Tile],
    targets: Set[int],
    world_w: int,
    world_h: int,
    strength: Optional[Mapping[int, int]] = None,
    coll: Optional[Mapping[int, int]] = None,
) -> int:
    """Number of punchable target tiles remaining in the world."""
    n = 0
    for y in range(world_h):
        for x in range(world_w):
            if plan_for(grid, coll or {}, targets, strength or {}, x, y).has_work:
                n += 1
    return n


def row_target_columns(
    grid: Mapping[Tuple[int, int], Tile],
    targets: Set[int],
    world_w: int,
    y: int,
    strength: Optional[Mapping[int, int]] = None,
    coll: Optional[Mapping[int, int]] = None,
) -> List[int]:
    """Columns on row ``y`` that still contain a punchable target."""
    return [
        x
        for x in range(world_w)
        if plan_for(grid, coll or {}, targets, strength or {}, x, y).has_work
    ]


def decide_row_step(
    grid: Mapping[Tuple[int, int], Tile],
    coll: Mapping[int, int],
    targets: Set[int],
    strength: Mapping[int, int],
    world_w: int,
    world_h: int,
    bx: int,
    by: int,
    direction: int,
) -> StepDecision:
    """Decides what to do about the tile ahead, one column in ``direction``.

    Rules:
    - target fg/bg (or bg behind an empty fg)  -> punch it, then step in;
    - clear tile                               -> step in;
    - passable non-target (door, sign, ...)    -> step through (never punched);
    - solid non-target (bedrock, lock, tree)   -> step over if 1-tile high,
      otherwise skip the rest of the row segment.
    """
    tx = bx + direction
    ty = by
    if tx < 0 or tx >= world_w:
        return StepDecision(StepKind.SKIP, tx, ty, reason="world_edge")

    fg, bg = grid_tile(grid, tx, ty)
    plan = plan_punch(fg, bg, targets, strength, coll)
    support = _support(grid, coll, tx, ty + 1, world_h)

    if plan.has_work:
        return StepDecision(
            StepKind.PUNCH_THEN_WALK, tx, ty, hits=plan.hits,
            needs_settle=not support, reason=plan.reason,
        )

    if is_tile_passable(fg, coll):
        # Already clear, or a protected pass-through item (door/sign/...):
        # walk in without punching. A background target behind a protected
        # foreground is left for reporting / cleanup.
        return StepDecision(StepKind.WALK, tx, ty, needs_settle=not support, reason=plan.reason)

    # Solid, non-whitelisted block: never punch. Try to walk over it.
    above_ok = ty - 1 >= 0 and is_standable_grid(grid, coll, tx, ty - 1, world_w, world_h)
    if above_ok:
        return StepDecision(StepKind.BYPASS_OVER, tx, ty, reason=plan.reason)

    return StepDecision(StepKind.SKIP, tx, ty, reason=plan.reason)


def decide_descent(
    grid: Mapping[Tuple[int, int], Tile],
    coll: Mapping[int, int],
    targets: Set[int],
    strength: Mapping[int, int],
    world_w: int,
    world_h: int,
    bx: int,
    by: int,
) -> DescentDecision:
    """Decides how to go one row down at the current column."""
    ty = by + 1
    if ty >= world_h:
        return DescentDecision(DescentKind.BOTTOM, bx, ty)

    fg, bg = grid_tile(grid, bx, ty)
    plan = plan_punch(fg, bg, targets, strength, coll)
    if plan.has_work:
        return DescentDecision(DescentKind.DIG, bx, ty, hits=plan.hits, reason=plan.reason)

    if fg == 0 or is_tile_passable(fg, coll):
        support = _support(grid, coll, bx, ty + 1, world_h)
        return DescentDecision(
            DescentKind.STEP_DOWN, bx, ty, needs_settle=not support, reason=plan.reason
        )

    # Solid, non-whitelisted (bedrock, lock, ...): the sweep is at its floor.
    return DescentDecision(DescentKind.BLOCKED, bx, ty, reason=plan.reason)
