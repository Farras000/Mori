"""In-memory fake of :class:`botting.mori.MoriClient` for tests (no gRPC).

Implements just the surface used by ``ClearWorldRunner`` / ``navigator``:
tile reads, position, walking, real hit-count punching, respawn and the small
blocking waiters. Everything is instantaneous and single-threaded.

The fake also records the run so tests can assert on behaviour:

- ``punches``: one entry per punch ``(bx, by, tx, ty, fg_before, bg_before)``
  (bot tile, punched tile, and the tile state *before* the punch),
- ``breaks``: tiles that were actually emptied,
- ``violations``: rule breaches (punching an unbreakable/protected item,
  walking more than one tile at a time, walking into a solid tile),
- ``respawns``: number of Respawn calls.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Dict, Iterable, List, Optional, Set, Tuple

from botting.mori import MoriClient
from botting.physics import is_solid_support, is_tile_passable

Tile = Tuple[int, int]

# item id -> (collision_type, punches needed); mirrors the live server data.
ITEM_INFO: Dict[int, Tuple[int, int]] = {
    0: (0, 0),
    2: (1, 3),     # Dirt
    4: (1, 4),     # Lava
    6: (0, 5),     # Main Door
    8: (1, 4),     # Bedrock
    10: (1, 10),   # Rock
    14: (0, 3),    # Cave Background
    20: (0, 5),    # Sign
    242: (1, 42),  # World Lock
}

# Items that can never be broken (punching them is a violation).
UNBREAKABLE = {6, 8, 20, 242, 202, 204, 206, 1796, 2408, 7188, 10410, 3760, 7372}

UNKNOWN_ITEM: Tuple[int, int] = (1, 4)  # fallback for ids missing from ITEM_INFO


class FakeMoriClient(MoriClient):
    """Fully in-memory Mori bot over a small rectangular world."""

    def __init__(
        self,
        world_name: str,
        width: int,
        height: int,
        grid: Dict[Tile, Tile],
        spawn: Tile = (0, 0),
    ) -> None:
        super().__init__(addr="fake", token="", verbose=False)
        self.bot_id = 1
        self.username = "fake"
        self._world_w = int(width)
        self._world_h = int(height)
        self._world_name = world_name

        full: Dict[Tile, Tile] = {}
        for y in range(self._world_h):
            for x in range(self._world_w):
                full[(x, y)] = tuple(grid.get((x, y), (0, 0)))  # type: ignore[assignment]
        self._grid = full
        self._pos = (float(spawn[0]), float(spawn[1]))
        self.spawn = (int(spawn[0]), int(spawn[1]))

        self.punches: List[Tuple[int, int, int, int, int, int]] = []
        self.breaks: List[Tile] = []
        self.walks: List[Tuple[int, int]] = []
        self.violations: List[str] = []
        self.respawns = 0
        self.script_stopped = False
        self.left_world = False
        self.disconnected = False
        self.bot_stopped = False
        self._dmg: Dict[Tile, int] = {}

        self.drops: List[Tuple[int, int, Tuple[float, float], Optional[bool]]] = []
        self.collect_interval: int = 500
        self.collect_range: int = 3
        self.collect_blacklist: List[int] = []
        self.facing_left: Optional[bool] = None

    # ── settings / lifecycle (no-ops) ─────────────────────────────────────────

    def connect(self) -> None:  # pragma: no cover - never used in tests
        raise AssertionError("FakeMoriClient never connects")

    def set_walk_delay(self, ms: int) -> None:
        self.delays["walk_ms"] = int(ms)

    def set_place_delay(self, ms: int) -> None:
        self.delays["place_ms"] = int(ms)

    def set_auto_collect(self, enabled: bool) -> None: ...

    def set_auto_reconnect(self, enabled: bool) -> None: ...

    def set_auto_leave_on_mod(self, enabled: bool) -> None: ...

    def set_direction(self, facing_left: bool) -> None:
        self.facing_left = bool(facing_left)
        self._facing_left = bool(facing_left)

    def set_collect_interval(self, ms: int) -> None:
        self.collect_interval = int(ms)

    def set_collect_range(self, tiles: int) -> None:
        self.collect_range = int(tiles)

    def set_collect_config(self, radius_tiles: int, blacklist: Iterable[int]) -> None:
        self.collect_range = int(radius_tiles)
        self.collect_blacklist = list(blacklist)

    def fast_drop(self, item_id: int, count: int) -> None:
        self.drops.append((int(item_id), int(count), self._pos or (0, 0), self.facing_left))
        cur = self._inventory.get(int(item_id), 0)
        self._inventory[int(item_id)] = max(0, cur - int(count))

    def drop(self, item_id: int, count: int) -> None:
        self.drops.append((int(item_id), int(count), self._pos or (0, 0), self.facing_left))
        cur = self._inventory.get(int(item_id), 0)
        self._inventory[int(item_id)] = max(0, cur - int(count))

    def inventory_amounts(self) -> Dict[int, int]:
        return dict(self._inventory)

    def inventory_active_ids(self) -> Set[int]:
        return set(self._inventory_active)

    def wait_inventory_change(self, item_id: int, old_amount: int, timeout: float = 1.5) -> bool:
        return self._inventory.get(int(item_id), 0) != old_amount

    def start_events(self) -> None: ...

    def stop_events(self) -> None: ...

    def close(self) -> None: ...

    def warp(self, name: str, door_id: str = "") -> None: ...

    def say(self, text: str) -> None: ...

    # ── halt actions (recorded for stop-script tests) ───────────────────────

    def stop_script(self) -> None:
        self.script_stopped = True

    def leave_world(self) -> None:
        self.left_world = True
        self._world_name = ""

    def disconnect(self) -> None:
        self.disconnected = True

    def stop_bot(self) -> None:
        self.bot_stopped = True

    # ── reads ─────────────────────────────────────────────────────────────────

    def sync_world(self) -> Tuple[str, int, int]:
        self._world_gen += 1
        return self._world_name, self._world_w, self._world_h

    def get_tile(self, x: int, y: int) -> Optional[Tile]:
        return self._grid.get((int(x), int(y)), (0, 0))

    def get_item_info(self, item_id: int):
        coll, strength = ITEM_INFO.get(int(item_id), UNKNOWN_ITEM)
        return SimpleNamespace(
            id=int(item_id), name=f"item{item_id}", collision_type=coll, strength=strength
        )

    def get_local(self):
        return SimpleNamespace(pos_x=self._pos[0], pos_y=self._pos[1])

    def is_in_tile(self, x: int, y: int) -> bool:
        return self.pos_tile() == (int(x), int(y))

    def is_in_world(self, name: str = "") -> bool:
        return (not name) or name.lower() == self._world_name.lower()

    # ── actions ───────────────────────────────────────────────────────────────

    def walk_to(self, x: int, y: int) -> None:
        x, y = int(x), int(y)
        pos = self.pos_tile() or (0, 0)
        bx, by = pos
        dx, dy = x - bx, y - by
        if (x, y) != (bx, by):
            orthogonal = abs(dx) + abs(dy) == 1
            climb = dy == -1 and abs(dx) == 1  # vanilla auto-step up one tile
            if not (orthogonal or climb):
                self.violations.append(f"teleport_walk ({bx},{by})->({x},{y})")
            if climb and not self.is_foothold(x, y):
                self.violations.append(f"climb_without_foothold ({x},{y})")
        fg, _bg = self._grid.get((x, y), (0, 0))
        if not is_tile_passable(fg, self.coll_map):
            self.violations.append(f"walk_into_solid ({x},{y}) fg={fg}")
        self._pos = (float(x), float(y))
        self.walks.append((x, y))

    def move_to(self, x: int, y: int) -> None:
        self.walk_to(x, y)

    @property
    def coll_map(self) -> Dict[int, int]:
        return {item_id: info[0] for item_id, info in ITEM_INFO.items()}

    def is_foothold(self, x: int, y: int) -> bool:
        """Body passable + solid support below (anti-float)."""
        if not (0 <= x < self._world_w and 0 <= y < self._world_h):
            return False
        fg, _bg = self._grid.get((x, y), (0, 0))
        if not is_tile_passable(fg, self.coll_map):
            return False
        if y + 1 >= self._world_h:
            return True
        below_fg, _b = self._grid.get((x, y + 1), (0, 0))
        return is_solid_support(below_fg, self.coll_map)

    def wait_arrival(self, x: int, y: int, timeout: float = 1.5) -> bool:
        return self.pos_tile() == (int(x), int(y))

    def hit(self, dx: int, dy: int) -> None:
        bx, by = self.pos_tile() or (0, 0)
        tx, ty = bx + int(dx), by + int(dy)
        fg, bg = self._grid.get((tx, ty), (0, 0))
        self.punches.append((bx, by, tx, ty, fg, bg))

        if fg != 0:
            if fg in UNBREAKABLE:
                self.violations.append(f"punch_unbreakable ({tx},{ty}) fg={fg}")
                return
            self._apply_damage(tx, ty, fg, bg)
        elif bg != 0:
            if bg in UNBREAKABLE:
                self.violations.append(f"punch_unbreakable ({tx},{ty}) bg={bg}")
                return
            self._apply_damage(tx, ty, bg, 0)

    def _apply_damage(self, tx: int, ty: int, item_id: int, rest: int) -> None:
        _coll, strength = ITEM_INFO.get(item_id, UNKNOWN_ITEM)
        dmg = self._dmg.get((tx, ty), 0) + 1
        if dmg >= strength:
            self._grid[(tx, ty)] = (0, int(rest)) if rest else (0, 0)
            self._dmg[(tx, ty)] = 0
            self.breaks.append((tx, ty))
        else:
            self._dmg[(tx, ty)] = dmg

    def place(self, dx: int, dy: int, item_id: int) -> None:
        bx, by = self.pos_tile() or (0, 0)
        tx, ty = bx + int(dx), by + int(dy)
        fg, bg = self._grid.get((tx, ty), (0, 0))
        if fg != 0:
            self.violations.append(f"place_on_occupied ({tx},{ty}) fg={fg}")
            return
        self._grid[(tx, ty)] = (int(item_id), bg)

    def get_inventory(self):
        items = []
        inv = getattr(self, "_inventory_items", {242: 1})
        for item_id, count in inv.items():
            items.append(SimpleNamespace(item_id=item_id, amount=count, is_active=False, action_type=0))
        return SimpleNamespace(size=len(items), gems=0, items=items)

    def wait_tile_cleared(self, x: int, y: int, is_target, timeout: float = 2.0) -> bool:
        return not is_target(self._grid.get((int(x), int(y)), (0, 0)))

    def respawn(self) -> None:
        self.respawns += 1
        self._pos = (float(self.spawn[0]), float(self.spawn[1]))

    # ── helpers for tests ─────────────────────────────────────────────────────

    def tile(self, x: int, y: int) -> Tile:
        return self._grid.get((int(x), int(y)), (0, 0))

    def tiles(self) -> Dict[Tile, Tile]:
        return dict(self._grid)

    def remaining_targets(self, targets: Iterable[int]) -> Dict[Tile, Tile]:
        target_set: Set[int] = {int(t) for t in targets}
        return {
            pos: tile
            for pos, tile in self._grid.items()
            if tile[0] in target_set or tile[1] in target_set
        }
