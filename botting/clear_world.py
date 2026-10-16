"""Growtopia Clear World botting script (Mori gRPC).

Layer-by-layer world clearing with strict anti-ban physics:

- starts at the nearest world edge and sweeps left->right (or reverse),
- the "top layer" is the topmost row that actually contains whitelist
  targets (the air above is empty by default): clearing always starts there,
- clears the topmost layer first, then the next one: layer transitions
  ("break 1 down", exactly one row) are ONLY allowed on a world edge column
  (x=0 or x=99) — never mid-row,
- when a row is blocked mid-way the bot walks back to the edge it entered the
  row from, descends there, and finishes the stranded tiles of the layer above
  with upward punches while the next layer's sweep passes underneath them,
- when a step walks into an existing gap (a pit left by an earlier pass) the
  bot drops through it, walks along the gap floor and climbs back onto the
  sweep row ahead — walking/falling/climbing only, never a punch, so no layer
  is ever opened outside x=0 / x=99,
- if both world edges are unreachable (e.g. the bot spawns at a white door
  above the top layer) the sweep starts from the top layer itself: the bot
  walks/falls/climbs onto row y0 when possible, otherwise it breaks its first
  row-y0 tile and drops in; that row is then swept in BOTH directions (two
  legs) and still finishes on a world edge, so every layer transition stays on
  an edge,
- when the sweep reaches the far edge it punches the tile below ("break 1
  down"), drops one row and sweeps back (serpentine / boustrophedon),
- punches in batches so the bot behaves like a client holding the punch
  button (server paces each punch by ``place_ms``),
- never teleports, never floats, never jumps more than one tile, never
  punches bedrock / world locks / doors / signs / checkpoints or any item
  outside the target whitelist (dirt, lava, rock, cave background),
- respawns automatically when stuck, then cleans up whatever is left with a
  general pass (only exposed tiles, keeping the layer order); the pass floods
  the footholds reachable from the bot once per round, so a bot trapped in a
  pocket is reported quickly instead of walking in circles.

Usage:
    python botting/clear_world.py [--bot-id 1] [--start auto|left|right]
        [--blocks 2,4,10,14] [--walk-delay 180] [--punch-delay 150]
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from typing import Dict, List, Optional, Set, Tuple

import grpc

# ── sys.path bootstrap (repo root + generated stubs) ─────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, os.path.join(_ROOT, "examples")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from botting import dropper  # noqa: E402
from botting import navigator as nav  # noqa: E402
from botting import runlock  # noqa: E402
from botting import sweep  # noqa: E402
from botting.config import BotConfig, LOCK_IDS  # noqa: E402
from botting.mori import BotNotFoundError, MoriClient, NoBotsError  # noqa: E402
from botting.physics import (  # noqa: E402
    DEFAULT_STRENGTH,
    PunchPlan,
    is_solid_support,
    is_standable_grid,
    is_target_block,
    is_tile_passable,
    is_within_punch_range,
    plan_punch,
)
from botting.stop import clear_stop, request_stop, should_stop  # noqa: E402
from botting.sweep import DescentKind, StepKind  # noqa: E402

Coord = Tuple[int, int]


class ClearWorldRunner:
    def __init__(self, client: MoriClient, cfg: BotConfig) -> None:
        self.client = client
        self.cfg = cfg
        self.targets: Set[int] = set(cfg.target_block_ids)

        self.coll: Dict[int, int] = {}      # item_id -> collision_type
        self.strength: Dict[int, int] = {}  # item_id -> punches needed

        self.world_name = ""
        self.world_w = 100
        self.world_h = 60

        self.running = True
        self.broken = 0
        self.respawns = 0
        self.blocked: Dict[Coord, str] = {}
        self.sweep_aborted = False
        self.started_at = time.time()
        # Resume attempts after stuck/disconnect (run loop re-enters the top
        # remaining row instead of abandoning the sweep for cleanup).
        self.sweep_resumes = 0
        # Anti-oscillation: how often each foothold was used as a walk target
        # (cleanup + row finishes). Stands hit repeatedly indicate ping-pong.
        self._stand_visits: Dict[Coord, int] = {}
        # Live floor cache: support tile -> (fg, timestamp). Short TTL so the
        # per-step grounded checks don't throttle the RPC plane (stale reads
        # are what let the bot stroll on air).
        self._floor_cache: Dict[Coord, Tuple[int, float]] = {}
        self._floor_cache_ttl = 1.5
        self._live_fail_streak = 0
        # Last position live-verified grounded (skips redundant re-checks
        # while the bot hasn't moved).
        self._grounded_verified: Optional[Tuple[Coord, float]] = None
        # Cleanup cross-round tabu: tiles failing this many rounds are
        # permanently blocked instead of retried forever.
        self._cleanup_fails: Dict[Coord, int] = {}
        # Current sweep direction (+1 right, -1 left): cleanup orders targets
        # layer-major in this direction so it never ping-pongs left<->right.
        self.last_direction = 1
        # Global progress watchdog: (broken, timestamp) of the last progress.
        # Sweeping without breaking anything for too long means confusion.
        self._watch_broken = 0
        self._watch_time = time.time()
        self._watch_timeout_s = 240.0

        # Column where the current row sweep was entered: an edge column
        # (0 or world_w-1) normally, or the bot's own column for the mid-world
        # start fallback. Blocked rows walk back to it before continuing.
        self.row_entry_edge: Optional[int] = None
        # How many directions the current row must be swept: 1 when it was
        # entered on a world edge, 2 when it was entered mid-world (both
        # halves must be cleared before the layer transition).
        self.row_legs_required = 1

        # White door drop handling.
        self.door_coord: Optional[Coord] = None
        self.drop_retry_at: float = 0.0
        self._active_blacklist: Set[int] = set()

    def stop(self) -> None:
        self.running = False
        bot_id = getattr(self.client, "bot_id", None)
        if bot_id:
            request_stop(bot_id)
        self.client.stop_events()

    # ── logging ───────────────────────────────────────────────────────────────

    def log(self, msg: str) -> None:
        print(f"[ClearWorld] {msg}", flush=True)

    # ── tile cache helpers ────────────────────────────────────────────────────

    def _snapshot(self) -> Dict[Coord, Tuple[int, int]]:
        return self.client.grid_snapshot()

    def _live_tile(self, x: int, y: int) -> Optional[Tuple[int, int]]:
        try:
            return self.client.get_tile(x, y)
        except grpc.RpcError:
            return None

    def _tile(self, x: int, y: int) -> Tuple[int, int]:
        """Cached tile; live-fetches once if the tile is missing from the cache."""
        t = self.client.grid_get(x, y)
        if t is None:
            t = self._live_tile(x, y)
        return t if t is not None else (0, 0)

    def _refresh(self, x: int, y: int) -> Tuple[int, int]:
        t = self._live_tile(x, y)
        if t is not None:
            return t
        return self._tile(x, y)

    def _plan(self, x: int, y: int) -> PunchPlan:
        fg, bg = self._refresh(x, y)
        return plan_punch(fg, bg, self.targets, self.strength, self.coll)

    def _is_target_tile(self, tile: Tuple[int, int]) -> bool:
        return is_target_block(tile, self.targets)

    def _prep_decision_tiles(self, tx: int, ty: int) -> None:
        """Refreshes the tiles used by ``decide_row_step`` for accuracy.

        Checks the event-stream cache first to avoid blocking synchronous RPCs.
        Missing tiles fall back to a live refresh.
        """
        if self.client.grid_get(tx, ty) is None:
            self._refresh(tx, ty)
        if self.client.grid_get(tx, ty + 1) is None:
            self._refresh(tx, ty + 1)
        if ty - 1 >= 0 and self.client.grid_get(tx, ty - 1) is None:
            self._refresh(tx, ty - 1)

    # ── setup ─────────────────────────────────────────────────────────────────

    def configure(self) -> None:
        c = self.client
        c.set_walk_delay(self.cfg.walk_delay_ms)
        c.set_place_delay(self.cfg.punch_delay_ms)
        c.set_auto_collect(self.cfg.auto_collect)
        if self.cfg.auto_collect:
            try:
                c.set_collect_interval(self.cfg.collect_interval_ms)
            except (grpc.RpcError, AttributeError):
                pass
        try:
            c.set_auto_reconnect(True)
        except grpc.RpcError:
            pass
        try:
            c.set_auto_leave_on_mod(self.cfg.leave_on_mod)
        except grpc.RpcError:
            pass
        self.log(
            f"pacing: walk {self.cfg.walk_delay_ms}ms/tile, punch {self.cfg.punch_delay_ms}ms "
            f"(batched, hold-button style)"
        )
        if self.cfg.auto_collect:
            self.log(
                f"auto-collect: ON (interval {self.cfg.collect_interval_ms}ms, "
                f"drop threshold {self.cfg.drop_threshold})"
            )
        else:
            self.log("auto-collect: OFF")

    def ensure_item_info(self, item_ids: Set[int]) -> None:
        need = {i for i in item_ids if i and i > 0} | self.targets
        missing: List[int] = []
        for item_id in sorted(need):
            if item_id in self.coll:
                continue
            try:
                info = self.client.get_item_info(item_id)
                self.coll[item_id] = int(info.collision_type)
                self.strength[item_id] = max(1, int(info.strength))
            except grpc.RpcError:
                missing.append(item_id)
        if missing:
            self.log(f"warning: GetItemInfo failed for {len(missing)} id(s); using fallbacks")

    def load_world(self, retries: int = 3) -> bool:
        last_err = None
        for attempt in range(retries):
            try:
                name, w, h = self.client.sync_world()
                last_err = None
                break
            except grpc.RpcError as e:
                last_err = e
                name, w, h = "", self.world_w, self.world_h
                time.sleep(1.0)
        if last_err is not None:
            if last_err.code() == grpc.StatusCode.NOT_FOUND:
                self.log("GetWorld: bot is not in a world — log the bot in or pass --world first")
            else:
                self.log(f"GetWorld failed: {last_err.code()} {last_err.details()}")
            return False
        if not name:
            self.log("bot is not in any world")
            return False

        self.world_name, self.world_w, self.world_h = name, w, h
        ids: Set[int] = set(self.targets)
        for fg, bg in self._snapshot().values():
            ids.add(fg)
            ids.add(bg)
        self.ensure_item_info(ids)
        self.door_coord = dropper.find_white_door(self._snapshot())
        door_info = f", white door at ({self.door_coord[0]},{self.door_coord[1]})" if self.door_coord else ""
        self.log(f"world {name!r} {w}x{h} synced ({len(self._snapshot())} tiles cached{door_info})")
        return True

    # ── movement ──────────────────────────────────────────────────────────────

    def _pos(self) -> Optional[Coord]:
        pos = self.client.pos_tile()
        if pos is None:
            try:
                pos = self.client.refresh_pos()
            except grpc.RpcError:
                return None
        return pos

    def _grounded(self, x: int, y: int) -> bool:
        if y + 1 >= self.world_h:
            return True
        return is_solid_support(self._tile(x, y + 1)[0], self.coll)

    def _support_fg_live(self, x: int, y: int) -> Optional[int]:
        """Live fg of a support tile, with a short TTL cache.

        Returns ``None`` only when the tile cannot be read at all (no cache
        either). Consecutive failures are counted: after 3 in a row the
        caller must assume the floor is gone (fail toward falling, never
        toward floating).
        """
        now = time.time()
        key = (x, y)
        hit = self._floor_cache.get(key)
        if hit is not None and now - hit[1] < self._floor_cache_ttl:
            return hit[0]
        if getattr(self.client, "events_active", False):
            cached = self.client.grid_get(x, y)
            if cached is not None:
                fg = cached[0]
                self._floor_cache[key] = (fg, now)
                return fg
        try:
            t = self.client.get_tile(x, y)
        except grpc.RpcError:
            t = None
        if t is None:
            self._live_fail_streak += 1
            if hit is not None and now - hit[1] < self._floor_cache_ttl:
                return hit[0]
            return None
        self._live_fail_streak = 0
        fg = t[0] if isinstance(t, tuple) else getattr(t, "fg_item_id", 0)
        self._floor_cache[key] = (fg, now)
        return fg

    def _mark_grounded_verified(self, x: int, y: int) -> None:
        self._grounded_verified = ((x, y), time.time())

    def _grounded_verified_recently(self, x: int, y: int) -> bool:
        v = self._grounded_verified
        return (
            v is not None
            and v[0] == (x, y)
            and time.time() - v[1] < self._floor_cache_ttl
        )

    def _grounded_live(self, x: int, y: int) -> bool:
        """Live support check: is there solid floor under (x, y) right now?

        Evidence-based: a live tile proving non-solid floor means floating.
        Repeated unreadable tiles (>=3 in a row) also count as floating —
        walking on an unverifiable floor is how the sky-glides happen.
        A single failed read falls back to the cache so one throttled RPC
        alone never strands the bot.
        """
        if y + 1 >= self.world_h:
            return True
        if self._grounded_verified_recently(x, y):
            return True
        fg = self._support_fg_live(x, y + 1)
        if fg is None:
            if self._live_fail_streak >= 3:
                return False
            return self._grounded(x, y)
        ok = is_solid_support(fg, self.coll)
        if ok:
            self._mark_grounded_verified(x, y)
        return ok

    def _watch_progress(self) -> bool:
        """Global no-progress watchdog. Returns False when the bot has been
        moving without breaking anything for too long (confusion loop)."""
        if self.broken != self._watch_broken:
            self._watch_broken = self.broken
            self._watch_time = time.time()
            return True
        if time.time() - self._watch_time > self._watch_timeout_s:
            self.log(
                f"no blocks broken for {self._watch_timeout_s:.0f}s while sweeping "
                "— stopping the sweep (confusion guard)"
            )
            return False
        return True

    def _manage_collect_blacklist(self) -> None:
        """Manages temporary collect blacklist so dropped piles near the white door
        are not immediately sucked up while the bot is nearby, but can be collected
        again when the bot is far away sweeping the world."""
        if not self.cfg.auto_collect:
            return
        pos = self._pos()
        if pos is None or self.door_coord is None:
            return
        dx, dy = self.door_coord
        bx, by = pos
        # If bot is within 5 tiles of white door, keep blacklist active
        is_near_door = abs(bx - dx) <= 5 and abs(by - dy) <= 5
        if not is_near_door and self._active_blacklist:
            try:
                self.client.set_collect_config(radius_tiles=3, blacklist=[])
                self._active_blacklist.clear()
            except (grpc.RpcError, AttributeError):
                pass

    def _execute_drop(self, item_id: int, count: int) -> bool:
        """Drops item_id using fast_drop with fallback to standard drop dialog."""
        old_cnt = self.client.inventory_amounts().get(item_id, count)
        try:
            self.client.fast_drop(item_id, count)
        except (grpc.RpcError, AttributeError) as e:
            self.log(f"fast_drop failed: {e}")
        if self.client.wait_inventory_change(item_id, old_cnt, timeout=0.25):
            return True
        try:
            self.client.drop(item_id, count)
            if self.client.wait_inventory_change(item_id, old_cnt, timeout=1.5):
                return True
        except (grpc.RpcError, AttributeError) as e:
            self.log(f"drop failed: {e}")
        return self.client.inventory_amounts().get(item_id, 0) != old_cnt

    def maybe_drop_trip(self, current_row: Optional[int] = None) -> Optional[str]:
        """Checks if any inventory item is maxed (>= drop_threshold) and executes
        a drop trip next to the white door.

        Returns:
            - None: no drop was needed or trip completed and bot returned to position.
            - "respawned": white door was unreachable on foot so bot respawned to door,
              dropped the items, and caller should resume sweep from the top remaining layer.
        """
        if not self.cfg.drop_enabled:
            return None
        if time.time() < self.drop_retry_at:
            return None
        if should_stop(self.client.bot_id):
            return None

        amounts = self.client.inventory_amounts()
        active_ids = self.client.inventory_active_ids()
        to_drop = dropper.maxed_items(
            amounts, active_ids, threshold=self.cfg.drop_threshold
        )
        if not to_drop:
            return None

        self.log(
            f"maxed item(s) in inventory: "
            f"{', '.join(f'id={item_id} ({cnt}x)' for item_id, cnt in to_drop)} — "
            f"initiating drop trip to white door"
        )

        if self.door_coord is None:
            self.door_coord = dropper.find_white_door(self._snapshot())
        if self.door_coord is None:
            self.log("white door (item id 6) not found — skipping drop trip")
            self.drop_retry_at = time.time() + 60.0
            return None

        pos = self._pos()
        if pos is None:
            return None
        bx, by = pos

        # Check if drop spot is reachable on foot from current position
        reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        spot = dropper.pick_drop_spot(
            self._snapshot(), self.coll, self.door_coord, self.world_w, self.world_h, reach, bx, by
        )

        if spot is not None:
            # Skenario 1: White door reachable on foot!
            drop_ids = [item_id for item_id, _ in to_drop]
            try:
                self.client.set_collect_config(radius_tiles=3, blacklist=drop_ids)
                self._active_blacklist.update(drop_ids)
            except (grpc.RpcError, AttributeError):
                pass

            self.log(f"walking to drop spot {spot.stand} beside white door")
            if not self.walk_grounded_to(spot.stand):
                self.log(f"failed to walk to drop spot {spot.stand} — aborting trip")
                self.drop_retry_at = time.time() + 10.0
                self.walk_grounded_to((bx, by))
                return None

            try:
                self.client.set_direction(facing_left=spot.facing_left)
            except Exception:
                pass
            time.sleep(0.05)

            for item_id, count in to_drop:
                if should_stop(self.client.bot_id):
                    break
                self.log(f"dropping {count}x item id {item_id} at {spot.item_tile}")
                self._execute_drop(item_id, count)
                time.sleep(0.15)

            # Walk back to original position
            self.log(f"returning to sweep position ({bx},{by})")
            if not self.walk_grounded_to((bx, by)):
                self.log(f"could not return to ({bx},{by}) — settling")
                self.settle()

            self._manage_collect_blacklist()
            return None

        # Skenario 2: White door NOT reachable on foot from current position!
        # Sesuai arahan user: "kalau gabisa ke white door, respawn aja lalu drop blocknya"
        self.log(
            "white door not reachable on foot — respawning to white door to drop maxed items"
        )
        drop_ids = [item_id for item_id, _ in to_drop]
        try:
            self.client.set_collect_config(radius_tiles=3, blacklist=drop_ids)
            self._active_blacklist.update(drop_ids)
        except (grpc.RpcError, AttributeError):
            pass

        try:
            self.client.respawn()
        except grpc.RpcError as e:
            self.log(f"respawn failed: {e}")
            self.drop_retry_at = time.time() + 10.0
            return None

        time.sleep(1.5)
        self.settle()
        self.load_world()

        new_pos = self._pos()
        if new_pos is not None:
            nbx, nby = new_pos
            reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
            spot = dropper.pick_drop_spot(
                self._snapshot(), self.coll, self.door_coord, self.world_w, self.world_h, reach, nbx, nby
            )
            if spot is None and self.door_coord is not None:
                dx, dy = self.door_coord
                # Check if clearing an adjacent target block can open a drop spot
                for cand_ix in (dx - 1, dx + 1):
                    if 0 <= cand_ix < self.world_w:
                        t = self._tile(cand_ix, dy)
                        if self._is_target_tile(t):
                            self.log(f"clearing block at ({cand_ix},{dy}) beside white door to make drop space")
                            self.clear_tile(cand_ix, dy)
                            spot = dropper.pick_drop_spot(
                                self._snapshot(), self.coll, self.door_coord, self.world_w, self.world_h, reach, nbx, nby
                            )
                            if spot is not None:
                                break

            if spot is not None:
                if (nbx, nby) != spot.stand:
                    self.walk_grounded_to(spot.stand)
                try:
                    self.client.set_direction(facing_left=spot.facing_left)
                except Exception:
                    pass
                time.sleep(0.05)

                for item_id, count in to_drop:
                    if should_stop(self.client.bot_id):
                        break
                    self.log(f"dropping {count}x item id {item_id} at {spot.item_tile}")
                    self._execute_drop(item_id, count)
                    time.sleep(0.15)
            else:
                self.log(f"warning: no valid drop spot found beside white door at {self.door_coord}")

        return "respawned"


    def settle(self) -> bool:
        return nav.settle(self.client, self.coll, self.world_h, self.cfg.walk_delay_ms)

    def advance_to(self, x: int, y: int, settle_after: bool = True, dwell: bool = True) -> bool:
        """One-tile-at-a-time step to a tile with arrival verification.

        Also accepts "stepped into an open pit and fell below": when the
        target tile has no floor, gravity drops the bot onto the first solid
        tile underneath — the settled outcome counts as a successful step.
        Facing is set before every horizontal step so the move renders as a
        walk cycle (not a glide).

        Anti-float: the bot must be grounded (live) where it stands before a
        flat step, and grounded where it lands afterwards. A floating arrival
        settles immediately; if it is still floating afterwards the step
        fails instead of letting the bot stroll on air.
        """
        if self._pos() == (x, y):
            return True
        pos = self._pos()
        if pos is not None and abs(x - pos[0]) + abs(y - pos[1]) > 1:
            # Long moves are always routed via the move-aware A* walker.
            return self.walk_grounded_to((x, y))
        for _ in range(2):
            cur = self._pos()
            if cur is not None and settle_after and not self._grounded_live(cur[0], cur[1]):
                self.log(f"floating at ({cur[0]},{cur[1]}) before step — settling first")
                self.settle()
                cur = self._pos()
                if cur is None:
                    return False
                if cur == (x, y):
                    return True
                if not self._grounded_live(cur[0], cur[1]):
                    return False
                if abs(x - cur[0]) + abs(y - cur[1]) > 1:
                    return self.walk_grounded_to((x, y))
                pos = cur
            # Pre-step floor check on the TARGET: when the tile below it is
            # proven blank, this step ends in a fall — step in and drop, with
            # no dwell-in-air. (Unknown/None stays optimistic; the arrival
            # check below still guards it.)
            gap_ahead = False
            if settle_after and y + 1 < self.world_h:
                tfg = self._support_fg_live(x, y + 1)
                gap_ahead = tfg is not None and not is_solid_support(tfg, self.coll)
                if gap_ahead:
                    self.log(f"gap ahead at ({x},{y}) — stepping in and dropping")
            try:
                if pos is not None and x != pos[0]:
                    try:
                        self.client.set_direction(facing_left=x < pos[0])
                    except Exception:
                        pass
                self.client.walk_to(x, y)
            except grpc.RpcError:
                return False

            deadline = time.time() + self.cfg.walk_timeout_s
            # Fast event-driven arrival check first (<1ms on BotMoveEvent)
            if not gap_ahead and self.client.wait_arrival(x, y, timeout=min(0.45, self.cfg.walk_timeout_s)):
                p: Optional[Coord] = (x, y)
            else:
                p = None

            while True:
                if p is None:
                    p = self._pos()
                    if p is None or p[0] != x or p[1] < y:
                        try:
                            p = self.client.refresh_pos()
                        except grpc.RpcError:
                            p = None
                if p is not None and p[0] == x and p[1] >= y:
                    floating = gap_ahead or not self._grounded_live(p[0], p[1])
                    if not floating:
                        if dwell and not getattr(self.client, "events_active", False):
                            try:
                                time.sleep(max(0, self.cfg.walk_delay_ms) / 1000.0)
                            except Exception:
                                pass
                        self._manage_collect_blacklist()
                        return True
                    if not settle_after:
                        return False
                    # Gap ahead or mid-air arrival (open pit / broken floor):
                    # let gravity finish the drop before continuing.
                    self.log(f"floating at ({p[0]},{p[1]}) after step — settling")
                    self.settle()
                    p2 = self._pos()
                    if p2 is not None and self._grounded_live(p2[0], p2[1]):
                        self.client.plant_footing()
                        self._manage_collect_blacklist()
                        return True
                    return False
                if time.time() >= deadline:
                    break
                p = None
                time.sleep(0.03)
            time.sleep(0.05)
        return False

    def walk_grounded_to(self, goal: Coord) -> bool:
        ok = nav.walk_grounded(
            self.client, goal, self.coll, self.world_w, self.world_h, self.cfg.walk_delay_ms
        )
        # Anti-oscillation accounting: a foothold requested over and over
        # (cleanup ping-pong between two targets) is reported instead of being
        # walked forever.
        try:
            n = self._stand_visits.get((goal[0], goal[1]), 0) + 1
            self._stand_visits[(goal[0], goal[1])] = n
            if n >= 4:
                self.log(
                    f"oscillation guard: foothold ({goal[0]},{goal[1]}) requested {n}x — "
                    "treating as blocked from now on"
                )
                self.blocked[(goal[0], goal[1])] = "oscillation guard"
        except Exception:
            pass
        return ok

    def _stand_blocked_by_oscillation(self, goal: Coord) -> bool:
        return self._stand_visits.get((goal[0], goal[1]), 0) >= 4

    def climb_to(self, x: int, y: int) -> bool:
        """One-tile diagonal auto-step up (walking onto a 1-tile-high bump).

        This is the vanilla Growtopia "step up" move used to walk over a
        protected 1-tile obstacle: the bot ends up on top of it. The caller
        must have verified the destination is a grounded foothold, so the bot
        never ends up floating. Facing is set first so the climb animates.
        """
        pos = self._pos()
        if pos is None:
            return False
        bx, by = pos
        if y != by - 1 or abs(x - bx) != 1:
            return False
        try:
            try:
                self.client.set_direction(facing_left=x < bx)
            except Exception:
                pass
            self.client.walk_to(x, y)
        except grpc.RpcError:
            return False
        if not self.client.wait_arrival(x, y, self.cfg.walk_timeout_s):
            return False
        if not getattr(self.client, "events_active", False):
            try:
                time.sleep(max(0, self.cfg.walk_delay_ms) / 1000.0)
            except Exception:
                pass
        if not self._grounded(x, y):
            self.settle()
        return True

    # ── punching ──────────────────────────────────────────────────────────────

    def _invalidate_floor_cache(self, tx: int, ty: int) -> None:
        """Drops cached floor/support knowledge affected by breaking (tx, ty).

        (tx, ty) itself may be someone's floor, and (tx, ty-1)'s verified
        grounded state relied on it. Without this the TTL cache would keep
        reporting solid floor under thin air right after a break.
        """
        self._floor_cache.pop((tx, ty), None)
        v = self._grounded_verified
        if v is not None and v[0] == (tx, ty - 1):
            self._grounded_verified = None

    def clear_tile(self, tx: int, ty: int) -> bool:
        """Clears a tile with batched punches (hold-button emulation).

        Returns True when the tile ends up free of target blocks. Sends the
        full fg+bg hit count in a single burst so the server paces every punch
        at ``place_ms`` with zero pause between foreground and background or
        before the next step.
        """
        place_s = self.cfg.place_s
        walk_s = max(0, self.cfg.walk_delay_ms) / 1000.0
        extra_wait = (walk_s + 0.65) if getattr(self.client, "events_active", False) else 0.25
        sent_total = 0

        for round_idx in range(self.cfg.max_punch_rounds):
            if not self.running or should_stop(self.client.bot_id):
                return False

            if round_idx == 0 and getattr(self.client, "events_active", False):
                cached = self.client.grid_get(tx, ty)
                if cached is not None:
                    fg, bg = cached
                else:
                    fg, bg = self._refresh(tx, ty)
            else:
                fg, bg = self._refresh(tx, ty)
            plan = plan_punch(fg, bg, self.targets, self.strength, self.coll)

            if plan.hits == 0:
                self._invalidate_floor_cache(tx, ty)
                return True  # nothing (left) to punch here
            if not plan.allowed:
                return False  # protected foreground in the way

            bx, by = self._pos() or (tx, ty)
            if not self._grounded_live(bx, by):
                self.settle()
                bx, by = self._pos() or (tx, ty)

            dx, dy = tx - bx, ty - by
            if not is_within_punch_range(dx, dy):
                return False

            if dx != 0:
                try:
                    self.client.set_direction(facing_left=(dx < 0))
                except Exception:
                    pass

            burst_hits = plan.hits
            if sent_total + burst_hits > self.cfg.max_hits_per_tile:
                burst_hits = max(0, self.cfg.max_hits_per_tile - sent_total)
                if burst_hits == 0:
                    return not self._is_target_tile(self._refresh(tx, ty))

            for _ in range(burst_hits):
                if not self.running or should_stop(self.client.bot_id):
                    return False
                try:
                    self.client.hit(dx, dy)
                except grpc.RpcError:
                    return False
                sent_total += 1

            burst_timeout = burst_hits * place_s + extra_wait
            if self.client.wait_tile_cleared(tx, ty, self._is_target_tile, burst_timeout):
                self.broken += 1
                self._invalidate_floor_cache(tx, ty)
                return True

            after_fg, after_bg = self._refresh(tx, ty)
            if not self._is_target_tile((after_fg, after_bg)):
                self.broken += 1
                self._invalidate_floor_cache(tx, ty)
                return True
            fg_hp = self.strength.get(fg, DEFAULT_STRENGTH.get(fg, 3)) if fg in self.targets else 0
            if (after_fg, after_bg) == (fg, bg) and (
                round_idx >= 1 or (fg_hp > 0 and burst_hits >= fg_hp + 2)
            ):
                # Tile took zero layer changes despite a full fg+bg burst or retry:
                # locked by a lock the bot does not own.
                return False

        return not self._is_target_tile(self._refresh(tx, ty))

    def descend_one(self) -> str:
        """Goes exactly one row down at the current column.

        Returns "ok" | "blocked" | "bottom" | "stuck".
        """
        pos = self._pos()
        if pos is None:
            return "stuck"
        bx, by = pos
        if by + 1 >= self.world_h:
            return "bottom"

        ty = by + 1
        self._refresh(bx, ty)
        dec = sweep.decide_descent(
            self._snapshot(), self.coll, self.targets, self.strength,
            self.world_w, self.world_h, bx, by,
        )

        if dec.kind is DescentKind.BOTTOM:
            return "bottom"
        if dec.kind is DescentKind.BLOCKED:
            self.note_blocked(bx, ty, dec.reason)
            return "blocked"
        if dec.kind is DescentKind.DIG:
            if not self.clear_tile(bx, ty):
                self.note_blocked(bx, ty, "dig punch failed")
                return "blocked"
            # Instant drop into the freshly opened tile below (vanilla gravity)
            try:
                self.client.walk_to(bx, ty)
            except grpc.RpcError:
                pass
            if self.client.wait_arrival(bx, ty, timeout=0.8):
                if not self._grounded_live(bx, ty):
                    self.settle()
                self.client.plant_footing()
                return "ok"

        if not self.advance_to(bx, ty):
            return "stuck"
        cur_pos = self._pos()
        if cur_pos is not None and not self._grounded_live(cur_pos[0], cur_pos[1]):
            self.settle()
        return "ok"


    # ── layer transitions (world-edge rule) ───────────────────────────────────

    def at_edge(self, x: int) -> bool:
        """True when x is a world edge column (x=0 or x=world_w-1)."""
        return sweep.is_edge_column(x, self.world_w)

    def descend_to_next_row(self) -> str:
        """The ONLY layer transition: "break 1 down" exactly one row.

        Rule: the descent is only allowed on a world edge column (x=0 or
        x=world_w-1). Every caller goes through here, so no code path can dig
        into the next layer mid-row by accident. If the bot is not on an edge
        (should not happen — blocked rows walk back first) it walks to an edge
        before descending. The layer gate refuses the descent while the
        current row still holds reachable targets (returns "row_busy").

        Returns "ok" | "blocked" | "bottom" | "stuck" | "row_busy".
        """
        pos = self._pos()
        if pos is None:
            return "stuck"

        if not self.at_edge(pos[0]):
            self.log(
                f"layer descent refused at x={pos[0]}: not a world edge — walking to an edge first"
            )
            first = sweep.nearest_edge_column(pos[0], self.world_w)
            second = self.world_w - 1 if first == 0 else 0
            for edge_x in (first, second):
                if edge_x == pos[0]:
                    continue
                if self.walk_grounded_to((edge_x, pos[1])):
                    pos = self._pos() or pos
                    break
            if pos is None or not self.at_edge(pos[0]):
                return "stuck"

        # Layer gate: never open layer N+1 while reachable, unjudged work
        # stands on layer N or any layer above it (y=0 is the top). Stranded /
        # already-judged tiles are fine — they are finished from below with
        # upward punches.
        complete, reachable = self.verify_layers_complete(pos[1])
        if not complete:
            xs = ", ".join(f"({x},{y})" for x, y in reachable[:8])
            more = f" (+{len(reachable) - 8} more)" if len(reachable) > 8 else ""
            self.log(
                f"layer descent refused at row {pos[1]}: {len(reachable)} reachable "
                f"target(s) left on this/upper layer, e.g. {xs}{more} — staying on this layer"
            )
            return "row_busy"

        return self.descend_one()

    def return_to_row_entry(self, row: int) -> bool:
        """Walks (grounded) back to the column where this row was entered.

        Normally that is the world edge the row was entered from; after a
        mid-world start it is the column the fallback started on.
        """
        edge_x = self.row_entry_edge
        pos = self._pos()
        if edge_x is None:
            edge_x = sweep.nearest_edge_column((pos or (0, row))[0], self.world_w)
        if pos == (edge_x, row):
            return True
        self.log(f"row {row}: walking back to entry x={edge_x}")
        return self.walk_grounded_to((edge_x, row))

    def _finish_row(self, row: int) -> str:
        """Ends a row sweep on a world edge (rule: descend only on x=0 / x=99).

        Returns "done" when the bot stands on a world edge, "stuck" when its
        position is unknown and "abort" when no world edge can be reached on
        foot (the caller falls back to the cleanup pass).
        """
        pos = self._pos()
        if pos is None:
            return "stuck"
        bx, by = pos
        if by != row:
            return "abort"
        if self.at_edge(bx):
            return "done"

        candidates: List[int] = []
        entry = self.row_entry_edge
        if entry is not None and self.at_edge(entry):
            candidates.append(entry)  # the tunnel back is always open
        candidates.append(sweep.nearest_edge_column(bx, self.world_w))
        candidates.append(0)
        candidates.append(self.world_w - 1)

        seen: Set[int] = set()
        for edge_x in candidates:
            if edge_x in seen or edge_x == bx:
                continue
            seen.add(edge_x)
            self.log(f"row {row}: walking to world edge x={edge_x} to finish the layer")
            if self.walk_grounded_to((edge_x, row)):
                return "done"
        self.log(f"row {row}: no world edge reachable — cannot finish this layer safely")
        return "abort"

    def note_blocked(self, x: int, y: int, reason: str) -> None:
        self.blocked[(x, y)] = reason
        self.log(f"blocked ({x},{y}): {reason}")

    def row_remaining_live(self, row: int) -> List[Coord]:
        """Live-verified whitelist targets still standing on ``row``.

        Snapshot candidates are re-checked with a live ``GetTile`` + punch
        plan so a stale cache can neither hide leftovers (the y=24 bug:
        descending while the layer still has work) nor invent them.
        """
        snap = self._snapshot()
        cands = [
            x for x in range(self.world_w)
            if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
        ]
        out: List[Coord] = []
        for x in cands:
            fg, bg = self._refresh(x, row)
            if plan_punch(fg, bg, self.targets, self.strength, self.coll).has_work:
                out.append((x, row))
        return out

    def verify_row_complete(self, row: int) -> Tuple[bool, List[Coord]]:
        """Layer gate: True only when ``row`` holds no more punchable target.

        Tiles the sweep already judged impassable this row (in ``self.blocked``
        via skip/blocked ruling — e.g. behind a 2-tall bedrock pillar) are
        stranded by design: they are finished from below with upward punches
        while a lower row passes underneath, so they must NOT block the
        descent. Only *unjudged* leftovers (columns the sweep never attempted —
        the y=24 bug: pit dip, stale cache, early leg finish) keep the bot on
        this layer. Reachability is checked so truly unreachable pockets don't
        pin the bot either.
        """
        remaining = self.row_remaining_live(row)
        if not remaining:
            return True, []
        fresh = [(x, y) for (x, y) in remaining if (x, y) not in self.blocked]
        if not fresh:
            return True, remaining
        try:
            reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        except Exception:
            reach = set()
        snap = self._snapshot()
        pos = self._pos() or (0, row)
        bx, by = pos
        reachable: List[Coord] = []
        for tx, ty in fresh:
            try:
                cands = nav.stand_candidates(snap, self.coll, tx, ty, bx, by, self.world_w, self.world_h)
            except Exception:
                cands = []
            if any(c in reach for c in cands):
                reachable.append((tx, ty))
        if reachable:
            return False, reachable
        return True, remaining

    def verify_layers_complete(self, row: int) -> Tuple[bool, List[Coord]]:
        """Extends the layer gate to every row above ``row`` (y=0 is the top).

        A pit dip can abandon an upper layer without marking it: the sweep
        continues on the lower row while reachable work still stands above.
        Descending further would open layer N+1 with layer N unfinished, so
        the descent is refused and the current row is re-swept (its roof clean
        finishes the stranded tiles from below with upward punches only).
        Snapshot pre-filters candidates; only those get a live re-check.
        """
        complete, reachable = self.verify_row_complete(row)
        if not complete:
            return complete, reachable
        snap = self._snapshot()
        cands: List[Coord] = []
        for y in range(max(0, row)):
            for x in range(self.world_w):
                if (x, y) in self.blocked:
                    continue
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, y).has_work:
                    cands.append((x, y))
        if not cands:
            return True, []
        if len(cands) > 80:
            # Too much work standing above to descend anyway — refuse without
            # burning hundreds of live GetTile calls (disconnect risk).
            return False, cands[:80]
        fresh: List[Coord] = []
        for x, y in cands:
            fg, bg = self._refresh(x, y)
            if plan_punch(fg, bg, self.targets, self.strength, self.coll).has_work:
                fresh.append((x, y))
        if not fresh:
            return True, []
        try:
            reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        except Exception:
            reach = set()
        pos = self._pos() or (0, row)
        bx, by = pos
        reachable_above: List[Coord] = []
        for tx, ty in fresh:
            try:
                stands = nav.stand_candidates(snap, self.coll, tx, ty, bx, by, self.world_w, self.world_h)
            except Exception:
                stands = []
            if any(c in reach for c in stands):
                reachable_above.append((tx, ty))
        if reachable_above:
            return False, reachable_above
        return True, fresh

    # ── sweep ─────────────────────────────────────────────────────────────────

    def skip_row_segment(self, row: int, x_from: int, direction: int, reason: str) -> int:
        """Marks the rest of the row (from x_from toward the edge) for cleanup."""
        snap = self._snapshot()
        n = 0
        x = x_from
        while 0 <= x < self.world_w:
            if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work:
                self.blocked[(x, row)] = reason
                n += 1
            x += direction
        if n:
            self.log(f"row {row}: leaving {n} target(s) behind ({reason}) — cleanup will retry")
        return n

    def sweep_row_remainder(self, row: int, x_from: int, direction: int) -> None:
        """Actively clears the rest of ``row`` toward the edge, in order.

        Same-direction pass over every remaining whitelist column from
        ``x_from`` to the edge (consistent order: ascending x when sweeping
        right, descending when sweeping left — never bouncing). Each column
        is approached with move-only routing and punched in place; the roof
        above it is finished first with upward punches. NOTHING below ``row``
        is ever punched here, so the edge-only layer rule holds. Columns that
        cannot be reached on foot stay marked for the from-below finish.
        """
        edge = self.world_w - 1 if direction > 0 else 0
        snap = self._snapshot()
        cols = [
            x for x in range(x_from, edge + direction, direction)
            if 0 <= x < self.world_w
            and sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
        ]
        if not cols:
            return
        self.log(
            f"row {row}: remainder pass over {len(cols)} column(s) "
            f"{'right' if direction > 0 else 'left'} "
            f"(x={cols[0]}..x={cols[-1]})"
        )
        try:
            reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        except Exception:
            reach = set()
        attempted = 0
        for cx in cols:
            if not self.running or should_stop(self.client.bot_id):
                break
            self._manage_collect_blacklist()
            if self.maybe_drop_trip(current_row=row) == "respawned":
                break
            fg, bg = self._refresh(cx, row)
            if not plan_punch(fg, bg, self.targets, self.strength, self.coll).has_work:
                self.blocked.pop((cx, row), None)
                continue
            if not sweep.is_exposed(
                self._snapshot(), self.coll, self.targets, self.strength,
                cx, row, self.world_h, blocked=self.blocked,
            ):
                self.note_blocked(cx, row, "target above — layer order")
                continue
            if attempted >= 40:
                self.blocked[(cx, row)] = "remainder pass budget reached"
                continue
            attempted += 1

            bx, by = self._pos() or (cx, row)
            cands = nav.stand_candidates(
                self._snapshot(), self.coll, cx, row, bx, by, self.world_w, self.world_h, direction=direction
            )
            cands = sorted(
                cands,
                key=lambda c: (
                    nav.stand_foothold_tier(c, cx, row, bx, by, direction=direction),
                    self._stand_visits.get(c, 0),
                    abs(c[0] - bx) + abs(c[1] - by),
                ),
            )
            stand = next((c for c in cands if c in reach), None)
            if stand is None:
                self.note_blocked(cx, row, "remainder unreachable on foot")
                continue
            if self._stand_blocked_by_oscillation(stand):
                self.blocked[(cx, row)] = "remainder stand overused"
                continue
            if (bx, by) != stand and not self.walk_grounded_to(stand):
                self.note_blocked(cx, row, "remainder unreachable")
                try:
                    reach = nav.reachable_footholds(
                        self.client, self.coll, self.world_w, self.world_h
                    ) or {(bx, by)}
                except Exception:
                    pass
                continue
            # Roof above first (upward only), then the row tile itself
            self._clear_roof(row, col=cx)
            if self.clear_tile(cx, row):
                self.blocked.pop((cx, row), None)
                cur_pos = self._pos()
                if cur_pos is not None and not self._grounded_live(cur_pos[0], cur_pos[1]):
                    self.settle()
            else:
                self.note_blocked(cx, row, "remainder punch failed")

    def _bypass(self, row: int, direction: int) -> str:
        """Walks over a run of 1-tile-high protected blocks, then resumes the row."""
        pos = self._pos()
        if pos is None:
            return "stuck"
        bx = pos[0]

        snap = self._snapshot()
        run: List[int] = []
        x = bx + direction
        while 0 <= x < self.world_w:
            fg, bg = self._tile(x, row)
            plan = plan_punch(fg, bg, self.targets, self.strength, self.coll)
            if plan.has_work or is_tile_passable(fg, self.coll):
                break  # resumable column reached
            run.append(x)
            x += direction
            if len(run) >= 8:
                break

        if not run:
            self.skip_row_segment(row, bx + direction, direction, "blocked ahead")
            return "blocked"

        for cx in run:
            if not self._is_standable(snap, cx, row - 1):
                self.note_blocked(run[0], row, "obstacle taller than 1 tile")
                self.skip_row_segment(row, run[0], direction, "obstacle too tall")
                return "blocked"

        self.log(f"bypass: stepping over {len(run)} protected tile(s) at row {row}")
        # The first move is the vanilla auto-step up onto the obstacle; the
        # rest of the run top is flat walking.
        if not self.climb_to(run[0], row - 1):
            return "stuck"
        for cx in run[1:]:
            if not self.advance_to(cx, row - 1):
                return "stuck"

        resume_x = run[-1] + direction
        if 0 <= resume_x < self.world_w and self._is_standable(snap, resume_x, row - 1):
            if not self.advance_to(resume_x, row - 1):
                return "stuck"

        # Re-enter the row being swept. This can only ever punch the CURRENT
        # layer (the bot stands one row above it) — never the next layer, so
        # it does not violate the edge-only descent rule.
        st = self.descend_one()
        if st == "ok":
            return "ok"
        if st == "stuck":
            return "stuck"

        # Could not re-enter the row (blocked / bottom below the bypass):
        # retrace over the obstacle run so the caller can walk back to the edge.
        if not self._retrace_to_row(row, direction):
            return "stuck"
        return "blocked"

    def _retrace_to_row(self, row: int, direction: int) -> bool:
        """Steps back over a bypassed obstacle run until back in row ``row``.

        Only walking/falling — never punches.
        """
        for _ in range(12):
            pos = self._pos()
            if pos is None:
                return False
            bx, by = pos
            if by == row:
                return True
            step = bx - direction
            if step < 0 or step >= self.world_w:
                return False
            if not self.advance_to(step, by):
                return False
            # advance_to settles automatically when the step lands in mid-air,
            # dropping the bot back into the row.
        pos = self._pos()
        return pos is not None and pos[1] == row

    def _clear_roof(self, row: int, col: Optional[int] = None) -> None:
        """Finishes leftovers of the layers above from below (upward punches).

        A blocked row segment (or anything the sweep had to skip) leaves
        targets in the rows above; when the sweep of a lower row passes under
        them, they are cleared with upward punches only — so each layer really
        finishes before the bot goes deeper. Never used to break downward.

        ``col`` (default: the bot's own column) allows finishing the ceiling
        above the column AHEAD before opening it, so a column is always opened
        top-down even after a degraded (mid-world) start.
        """
        pos = self._pos()
        if pos is None:
            return
        bx, by = pos
        if by < row:
            return
        cx = bx if col is None else col

        # Topmost first: within the 3-tile reach the highest leftover of the
        # column is finished before the one below it (layer order).
        for dy in (3, 2, 1):
            ty = by - dy
            if ty < 0 or ty >= row:
                continue
            if not is_within_punch_range(cx - bx, ty - by):
                continue
            for _ in range(3):
                if not sweep.plan_for(
                    self._snapshot(), self.coll, self.targets, self.strength, cx, ty
                ).has_work:
                    break
                plan = self._plan(cx, ty)  # live confirmation
                if not plan.has_work:
                    break
                if not self.clear_tile(cx, ty):
                    self.log(f"roof leftover at ({cx},{ty}) not clearable from below")
                    break
                self.blocked.pop((cx, ty), None)

    def _is_standable(self, snap: Dict[Coord, Tuple[int, int]], x: int, y: int) -> bool:
        return is_standable_grid(snap, self.coll, x, y, self.world_w, self.world_h)

    def _climb_back_to_row(self, row: int, direction: int) -> Optional[int]:
        """Walks back up onto the sweep row after dropping through a gap.

        Move-only (never punches): the bot crosses the pit / its own tunnel
        and climbs back onto row ``row`` at the nearest standing tile AHEAD
        in the sweep direction, so the sweep keeps making progress. Returns
        the reached column, or None when there is no way back up.
        """
        pos = self._pos()
        if pos is None:
            return None
        bx = pos[0]
        reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        best: Optional[int] = None
        best_d = 0
        for (x, y), d in reach.items():
            if y != row or not (0 <= x < self.world_w):
                continue
            if direction > 0 and x <= bx:
                continue
            if direction < 0 and x >= bx:
                continue
            if best is None or d < best_d:
                best, best_d = x, d
        if best is None:
            return None
        if (self._pos() or (0, 0)) == (best, row):
            return best
        if not self.walk_grounded_to((best, row)):
            return None
        return best

    def _climb_back_to_row_any(self, row: int) -> Optional[int]:
        """Walks back up onto row ``row`` at any reachable standing foothold."""
        pos = self._pos()
        if pos is None:
            return None
        reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        cands = [
            (x, d) for (x, y), d in reach.items()
            if y == row and 0 <= x < self.world_w
        ]
        if not cands:
            return None
        cands.sort(key=lambda t: t[1])
        for best, _d in cands:
            if (self._pos() or (0, 0)) == (best, row):
                return best
            if self.walk_grounded_to((best, row)):
                return best
        return None

    def _pre_clear_across_gap(self, bx: int, row: int, direction: int) -> None:
        """When the tile ahead (bx + direction, row) has no floor below it,
        pre-clears the far lip (bx + 2 * direction, row) while still standing
        on solid ground at (bx, row). This ensures the bot has an open ledge
        to climb back onto after stepping into the gap.
        """
        nx = bx + 2 * direction
        if not (0 <= nx < self.world_w):
            return
        self._prep_decision_tiles(nx, row)
        if not sweep.plan_for(
            self._snapshot(), self.coll, self.targets, self.strength, nx, row
        ).has_work:
            return
        if not sweep.is_exposed(
            self._snapshot(), self.coll, self.targets, self.strength,
            nx, row, self.world_h,
        ):
            self._clear_roof(row, col=nx)
        if sweep.is_exposed(
            self._snapshot(), self.coll, self.targets, self.strength,
            nx, row, self.world_h, blocked=self.blocked,
        ):
            if self.clear_tile(nx, row):
                self.blocked.pop((nx, row), None)

    def _open_row_lip_from_pit(self, row: int, direction: int) -> bool:
        """When the bot has dropped into a gap (by > row) and cannot climb back
        onto ``row`` because the exit ledge on ``row`` still holds target blocks,
        clears those ``row`` blocks (and roof above them) from within punch
        range. Never punches below ``row``.
        """
        pos = self._pos()
        if pos is None:
            return False
        bx, by = pos
        if by <= row:
            return False

        def _try_punch_lip(cur_x: int, cur_y: int) -> bool:
            did_open = False
            for step in (0, 1, 2, 3):
                cx = cur_x + step * direction
                if not (0 <= cx < self.world_w):
                    continue
                if not is_within_punch_range(cx - cur_x, row - cur_y):
                    continue
                self._prep_decision_tiles(cx, row)
                if not sweep.plan_for(
                    self._snapshot(), self.coll, self.targets, self.strength, cx, row
                ).has_work:
                    continue
                if not sweep.is_exposed(
                    self._snapshot(), self.coll, self.targets, self.strength,
                    cx, row, self.world_h,
                ):
                    self._clear_roof(row, col=cx)
                if sweep.is_exposed(
                    self._snapshot(), self.coll, self.targets, self.strength,
                    cx, row, self.world_h, blocked=self.blocked,
                ):
                    if self.clear_tile(cx, row):
                        self.blocked.pop((cx, row), None)
                        did_open = True
            return did_open

        if _try_punch_lip(bx, by):
            return True

        # If the pit is wider than punch reach, advance to the furthest
        # reachable pit foothold in the sweep direction and try again.
        reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        pit_cands = [
            (x, y) for (x, y) in reach
            if y > row and ((direction > 0 and x > bx) or (direction < 0 and x < bx))
        ]
        if not pit_cands:
            return False
        pit_cands.sort(key=lambda c: c[0] * direction, reverse=True)
        for cand in pit_cands[:2]:
            if self.walk_grounded_to(cand):
                nx, ny = self._pos() or cand
                if _try_punch_lip(nx, ny):
                    return True
                break
        return False

    def sweep_row(self, row: int, direction: int) -> str:
        """Sweeps one row, covering every reachable column before returning.

        A row entered on a world edge needs a single leg (sweep toward the far
        edge). A row entered mid-world (start fallback on the detected top
        layer) needs two legs — one per direction — so the whole row is
        cleared before the layer transition.

        When a step drops into an existing gap the bot walks through the gap
        and climbs back onto this row ahead (move-only); if the exit ledge on
        ``row`` still holds target blocks within punch range, it clears them
        upward and climbs back out.

        On an obstacle the bot NEVER breaks down there: if more legs are
        needed it walks back to the row entry and flips direction, otherwise
        the row is finished on a world edge (``_finish_row``) so the "break 1
        down" can happen on x=0 / x=world_w-1.

        Returns "done" (row finished, bot on a world edge, ready to descend),
        "stuck", "stopped" or "abort" (row could not be finished safely).
        """
        guard = 4 * self.world_w + 60
        steps = 0
        legs = 0
        required = max(1, self.row_legs_required)
        # Oscillation history: recent tiles + broken count at each visit.
        # A 2-tile ping-pong (e.g. 66 <-> 67) with zero progress ends the leg
        # instead of flipping direction forever.
        hist: List[Coord] = []
        hist_broken: List[int] = []

        while self.running:
            steps += 1
            if steps > guard:
                self.log("row sweep guard tripped")
                return "stuck"
            runlock.refresh(self.client.bot_id)
            if should_stop(self.client.bot_id):
                return "stopped"

            pos = self._pos()
            if pos is None:
                return "stuck"
            bx, by = pos

            trip_status = self.maybe_drop_trip(current_row=row)
            if trip_status == "respawned":
                return "respawned"
            pos = self._pos()
            if pos is None:
                return "stuck"
            bx, by = pos

            if not self._watch_progress():
                return "abort"
            hist.append((bx, by))
            hist_broken.append(self.broken)
            if len(hist) > 8:
                hist.pop(0)
                hist_broken.pop(0)
            if sweep.detect_oscillation(hist, hist_broken[0], hist_broken[-1]):
                cyc = sorted(set(hist[-6:]))
                self.log(
                    f"row {row}: sweep oscillation detected around "
                    f"{', '.join(f'({x},{y})' for x, y in cyc)} with no progress "
                    f"— ending the leg"
                )
                self.note_blocked(bx + direction, row, "sweep oscillation — no progress")
                self.skip_row_segment(row, bx + direction, direction, "sweep oscillation")
                legs += 1
                if legs >= required:
                    return self._finish_row(row)
                if not self.return_to_row_entry(row):
                    return "stuck"
                self.log(f"row {row}: leg {legs} done at x={(self._pos() or (bx, by))[0]} — flipping direction")
                direction = -direction
                hist.clear()
                hist_broken.clear()
                continue
            if by != row:
                if by < row:
                    return "stuck"
                # The step walked into an existing gap (a pit / cave pocket)
                # and gravity dropped the bot below the sweep row.
                col = self._climb_back_to_row(row, direction)
                if col is None and self._open_row_lip_from_pit(row, direction):
                    col = self._climb_back_to_row(row, direction)
                if col is None:
                    # Could not climb forward onto row in sweep direction.
                    # Try climbing back up to ANY reachable foothold on row.
                    any_col = self._climb_back_to_row_any(row)
                    if any_col is not None and legs + 1 < required:
                        self.log(
                            f"row {row}: gap at x={bx} cannot be crossed forward — "
                            f"climbed back up to x={any_col}, ending leg"
                        )
                        bx, by = any_col, row
                        legs += 1
                        direction = -direction
                        hist.clear()
                        hist_broken.clear()
                        continue
                    self.log(
                        f"row {row}: dropped to ({bx},{by}) with no way back up "
                        f"— continuing on row {by}"
                    )
                    self.settle()
                    pos = self._pos() or (bx, by)
                    bx, by = pos
                    row = by
                else:
                    self.log(f"row {row}: dipped through the gap — back on the row at x={col}")
                    bx, by = col, row

            # Clear target at bot's current standing tile if any (e.g. passable Cave BG)
            if sweep.plan_for(self._snapshot(), self.coll, self.targets, self.strength, bx, row).has_work:
                if sweep.is_exposed(
                    self._snapshot(), self.coll, self.targets, self.strength,
                    bx, row, self.world_h, blocked=self.blocked,
                ):
                    self.clear_tile(bx, row)

            # Finish leftovers of the layers above from below (upward punches).
            self._clear_roof(row)

            tx = bx + direction
            leg_over = False
            if tx < 0 or tx >= self.world_w:
                leg_over = True  # reached the world edge: leg complete
            else:
                self._prep_decision_tiles(tx, row)
                dec = sweep.decide_row_step(
                    self._snapshot(), self.coll, self.targets, self.strength,
                    self.world_w, self.world_h, bx, row, direction,
                )

                if dec.kind is StepKind.PUNCH_THEN_WALK:
                    # Clean forward-only break: face target and ensure grounded
                    if not self._grounded_live(bx, row):
                        self.settle()
                    try:
                        self.client.set_direction(facing_left=(direction < 0))
                    except Exception:
                        pass
                    # If target is not exposed (an obstacle above was bypassed), clear roof above tx first
                    if not sweep.is_exposed(
                        self._snapshot(), self.coll, self.targets, self.strength,
                        tx, row, self.world_h,
                    ):
                        self._clear_roof(row, col=tx)

                    if not sweep.is_exposed(
                        self._snapshot(), self.coll, self.targets, self.strength,
                        tx, row, self.world_h, blocked=self.blocked,
                    ):
                        self.note_blocked(tx, row, "target above — layer order")
                        self.sweep_row_remainder(row, tx, direction)
                        leg_over = True
                    elif not self.clear_tile(tx, row):
                        reason = self._plan(tx, row).reason
                        self.note_blocked(tx, row, f"punch failed ({reason})")
                        self.sweep_row_remainder(row, tx + direction, direction)
                        leg_over = True
                    else:
                        self.blocked.pop((tx, row), None)
                        if dec.needs_settle:
                            self._pre_clear_across_gap(bx, row, direction)
                        if not self.advance_to(tx, row, dwell=False):
                            return "stuck"
                        if dec.needs_settle:
                            # The tile ahead had no floor even before breaking:
                            # force gravity now instead of trusting arrival reads.
                            self.settle()
                elif dec.kind is StepKind.WALK:
                    if dec.needs_settle:
                        self._pre_clear_across_gap(bx, row, direction)
                    if not self.advance_to(tx, row):
                        return "stuck"
                    if dec.needs_settle:
                        self.settle()
                elif dec.kind is StepKind.BYPASS_OVER:
                    status = self._bypass(row, direction)
                    if status == "stuck":
                        return "stuck"
                    if status != "ok":
                        self.sweep_row_remainder(row, bx + direction, direction)
                        leg_over = True
                else:  # SKIP
                    self.note_blocked(tx, row, dec.reason)
                    self.sweep_row_remainder(row, tx + direction, direction)
                    leg_over = True

            if not leg_over:
                continue

            legs += 1
            if legs >= required:
                # Row finished: make sure the bot ends on a world edge so the
                # layer transition stays legal.
                return self._finish_row(row)
            if not self.return_to_row_entry(row):
                return "stuck"
            self.log(f"row {row}: leg {legs} done at x={(self._pos() or (bx, by))[0]} — flipping direction")
            direction = -direction

        return "stopped"

    def approach_surface(self, col: int, y0: int) -> bool:
        """Walks (grounded) to the surface tile directly above row ``y0``.

        The goal foothold is live-verified first: walking straight across to
        a goal that floats in reality (stale snapshot) is how white-door
        spawns end up gliding across the sky.
        """
        goal = (col, y0 - 1)
        if goal[1] < 0:
            return False
        try:
            live_ok = nav.standable_live(self.client, self.coll, goal[0], goal[1], self.world_h)
        except Exception:
            live_ok = False
        if not live_ok:
            self.log(f"start position (col {col}, row {goal[1]}) is not standable live — skipping edge")
            return False
        self.log(f"walking to start position (col {col}, row {goal[1]})")
        return self.walk_grounded_to(goal)

    def dig_in(self, y0: int) -> bool:
        """Descends from the surface into row ``y0`` — only on a world edge."""
        pos = self._pos()
        if pos is None or not self.at_edge(pos[0]):
            return False
        for _ in range(3):
            pos = self._pos()
            if pos is None:
                return False
            if pos[1] >= y0:
                return True
            d = self.descend_one()
            if d == "stuck":
                if not self.recover("stuck while digging in"):
                    return False
                continue
            if d in ("blocked", "bottom"):
                return False
        pos = self._pos()
        return pos is not None and pos[1] >= y0

    def enter_top_layer(self, y0: int) -> Optional[Coord]:
        """Brings the bot into the top target layer and returns the entry tile.

        Preferred route: walk to a world edge and dig in there (rule: layer
        transitions only on x=0 / x=world_w-1). When neither edge can be
        reached on foot — e.g. the bot spawned/stands at a white door embedded
        inside the terrain — it falls back to ``start_mid_world``.

        Returns the entry tile (column, row) with ``row_entry_edge`` and
        ``row_legs_required`` set, or None when the layer cannot be entered
        (the caller runs the cleanup pass instead).
        """
        edge = self.cfg.start_edge
        if edge == "auto":
            bx = (self._pos() or (0, 0))[0]
            edge = "left" if bx < self.world_w / 2 else "right"
        first = 0 if edge == "left" else self.world_w - 1
        second = self.world_w - 1 - first
        edges = (first,) if second == first else (first, second)

        for edge_x in edges:
            if not self.approach_surface(edge_x, y0):
                self.log(f"world edge x={edge_x} is not reachable by walking")
                continue
            if self.dig_in(y0):
                self.log(f"entered the top layer at world edge x={edge_x}, row {y0}")
                self.row_entry_edge = edge_x
                self.row_legs_required = 1
                return (edge_x, y0)
            self.log(f"cannot dig into the top layer at world edge x={edge_x}")

        self.log("top layer not enterable at either world edge — trying from the bot's position")
        entry = self.start_mid_world(y0)
        if entry is None:
            return None
        self.row_entry_edge = entry[0]
        self.row_legs_required = 2
        return entry

    def start_mid_world(self, y0: int) -> Optional[Coord]:
        """Fallback start: begin the sweep on the detected top layer (row y0).

        ``y0`` is the topmost row that actually contains whitelist targets
        (``find_top_row``) — the rows above are empty by default, so that is
        where breaking starts. When neither world edge is reachable the bot
        still starts *from row y0*: it first tries to reach a standing tile on
        that row with walk/fall/climb moves only (climbing back out of a pit
        through gaps that already exist); only when there is no route does it
        break the very first tile — always a row-y0 tile. Nothing below row y0
        is ever opened mid-world; the row is swept in both directions so it
        still finishes on a world edge.
        """
        pos = self._pos()
        if pos is None:
            return None
        bx, by = pos
        fg, _bg = self._tile(bx, by)
        if not is_tile_passable(fg, self.coll):
            self.log(f"mid-world start refused: bot tile ({bx},{by}) is blocked")
            return None

        self.log(f"mid-world start: top layer detected at row {y0} (topmost whitelist row)")

        # 1) Already standing on the top layer.
        if by == y0:
            return self._mid_world_entry(bx, by, y0)

        # 2) Walk/fall/climb (no breaking) onto the top layer — e.g. climb
        #    back out of a pit through gaps left by an earlier pass.
        col = self._walk_to_row(y0)
        if col is not None:
            self.log(f"mid-world start: reached the top layer on foot at x={col}")
            return self._mid_world_entry(col, y0, y0)

        # 3) No route on foot: break into the top layer. The first break is
        #    always a row-y0 tile (never a deeper row).
        if by < y0 - 1 and y0 - 1 >= 0:
            surf_col = self._walk_to_row(y0 - 1)
            if surf_col is not None:
                pos = self._pos() or (surf_col, y0 - 1)
                bx, by = pos
        if by == y0 - 1:
            if self._break_into_top_layer(y0):
                pos = self._pos() or (bx, y0)
                bx, by = pos
                if y0 <= by <= y0 + 2 and self._column_clear_above(bx, by):
                    return self._mid_world_entry(bx, by, y0)
            self.log("mid-world start refused: cannot enter the top layer from here")
            return None

        # 4) Already inside a shaft of the top layer (fell through earlier)?
        #    The sweep may start there: the roof clean still reaches every
        #    layer above, so each column is opened top-down.
        if y0 <= by <= y0 + 2 and self._column_clear_above(bx, by):
            return self._mid_world_entry(bx, by, y0)

        self.log(
            f"mid-world start refused: bot is at row {by}, top layer is row {y0} "
            "(only the top layer and rows it already fell through may be opened mid-world)"
        )
        return None

    def _walk_to_row(self, row: int) -> Optional[int]:
        """Walks (walk/fall/climb only) to the nearest standing tile on ``row``.

        Returns the reached column, or None when no tile of that row is
        reachable with the bot's current footing. Never punches. Each
        candidate foothold is live-verified (a snapshot foothold whose floor
        is gone in reality would start the sweep floating).
        """
        reach = nav.move_reach(self.client, self.coll, self.world_w, self.world_h)
        cands = sorted(
            ((x, d) for (x, y), d in reach.items() if y == row and 0 <= x < self.world_w),
            key=lambda t: t[1],
        )
        if not cands:
            return None
        for col, _d in cands:
            try:
                live_ok = nav.standable_live(self.client, self.coll, col, row, self.world_h)
            except Exception:
                continue
            if not live_ok:
                continue
            if (self._pos() or (0, 0)) == (col, row):
                return col
            if self.walk_grounded_to((col, row)):
                return col
        return None

    def _column_clear_above(self, x: int, y: int) -> bool:
        """True when nothing above (x, y) in the same column needs clearing."""
        snap = self._snapshot()
        for yy in range(y):
            if (x, yy) in self.blocked:
                continue
            if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, yy).has_work:
                self.log(f"mid-world start refused: ({x},{yy}) above the bot still needs clearing")
                return False
        return True

    def _mid_world_entry(self, col: int, row: int, y0: int) -> Coord:
        self.log(
            f"mid-world start: sweeping from ({col},{row}), top layer row {y0} (both directions)"
        )
        return (col, row)

    def _break_into_top_layer(self, y0: int) -> bool:
        """Opens one row-y0 tile and drops the bot into the top layer.

        Tries the tile straight below first (the first break is then a row-y0
        tile); when that is protected — e.g. bedrock under a white door — it
        opens the left/right neighbour tile of row y0 and steps into it
        instead. No deeper row is ever touched.
        """
        pos = self._pos()
        if pos is None:
            return False
        bx, by = pos
        if by != y0 - 1:
            return False

        below = self._refresh(bx, y0)
        if self._is_target_tile(below) or is_tile_passable(below[0], self.coll):
            self.log(f"mid-world start: entering the top layer at x={bx} (row {y0})")
            if self.descend_one() == "ok":
                return True

        for cx in (bx - 1, bx + 1):
            if not (0 <= cx < self.world_w):
                continue
            if not self._plan(cx, y0).has_work:
                continue
            self.log(f"mid-world start: breaking the top-layer tile ({cx},{y0})")
            if not self.clear_tile(cx, y0):
                continue
            # Step into the freshly opened tile; gravity drops the bot a row.
            if self.advance_to(cx, y0 - 1) and (self._pos() or (0, 0))[1] == y0:
                return True
        return False

    # ── recovery ──────────────────────────────────────────────────────────────

    def recover(self, reason: str) -> bool:
        if should_stop(self.client.bot_id):
            self.log("stop requested — not respawning")
            return False
        self.respawns += 1
        if self.respawns > self.cfg.max_respawn:
            self.log(f"respawn limit reached ({reason})")
            return False
        self.log(f"stuck: {reason} -> respawning ({self.respawns}/{self.cfg.max_respawn})")

        try:
            self.client.respawn()
        except grpc.RpcError as e:
            self.log(f"respawn RPC failed: {e}")

        time.sleep(2.0)
        deadline = time.time() + 15
        while self.running and time.time() < deadline:
            try:
                if self.client.is_in_world(self.world_name):
                    break
            except grpc.RpcError:
                pass
            time.sleep(0.5)

        self.settle()
        self.load_world()
        return True

    # ── cleanup pass ──────────────────────────────────────────────────────────

    def _remaining_targets(self) -> List[Coord]:
        snap = self._snapshot()
        out: List[Coord] = []
        for y in range(self.world_h):
            for x in range(self.world_w):
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, y).has_work:
                    out.append((x, y))
        return out

    def cleanup(self) -> None:
        left0 = self._remaining_targets()
        if not left0:
            self.log("cleanup: nothing left to clear")
            return

        self.log(f"cleanup pass: {len(left0)} target tile(s) left, routing with grounded BFS")
        rounds = 0
        no_progress = 0
        while self.running and rounds < 4:
            rounds += 1
            runlock.refresh(self.client.bot_id)
            if should_stop(self.client.bot_id):
                self.log("stop requested — ending cleanup")
                break
            snap = self._snapshot()
            # Layer-order rule: only exposed tiles (nothing left to clear in
            # the same column above them, ignoring already-blocked sky tiles)
            # may be picked up by the cleanup.
            left = [
                (x, y)
                for (x, y) in self._remaining_targets()
                if sweep.is_exposed(
                    snap, self.coll, self.targets, self.strength, x, y, self.world_h,
                    blocked=self.blocked,
                )
            ]
            if not left:
                break

            bx, by = self._pos() or (0, 0)
            # Layer-major order aligned with the sweep direction (top rows
            # first, then consistently left->right or right->left): nearest-
            # first Manhattan sorting made the bot ping-pong between
            # equidistant targets on opposite sides.
            d = self.last_direction if self.last_direction in (1, -1) else 1
            left.sort(key=lambda t: (t[1], t[0] * d))

            # One grounded flood fill per round: anything outside this set
            # cannot be walked to from the bot's current footing, so it is
            # reported instead of being BFS-probed tile by tile.
            reach = nav.reachable_footholds(self.client, self.coll, self.world_w, self.world_h)
            if not reach:
                reach = {(bx, by)}

            progress = 0
            attempted = 0
            unreachable: List[Coord] = []
            failed_this_round: Set[Coord] = set()

            for tx, ty in left:
                if not self.running or should_stop(self.client.bot_id):
                    break
                self._manage_collect_blacklist()
                self.maybe_drop_trip()
                if (tx, ty) in failed_this_round:
                    continue
                if self._cleanup_fails.get((tx, ty), 0) >= 2:
                    # Failed two full rounds already — permanently blocked
                    # instead of retried (and walked to) forever.
                    self.blocked[(tx, ty)] = "cleanup failed twice — giving up"
                    continue

                bx, by = self._pos() or (0, 0)
                dir_to_target = 1 if bx <= tx else -1
                cands = nav.stand_candidates(
                    self._snapshot(), self.coll, tx, ty, bx, by, self.world_w, self.world_h, direction=dir_to_target
                )
                if not cands:
                    self.note_blocked(tx, ty, "no standable neighbor in punch range")
                    continue
                cands = sorted(
                    cands,
                    key=lambda c: (
                        nav.stand_foothold_tier(c, tx, ty, bx, by, direction=dir_to_target),
                        self._stand_visits.get(c, 0),
                        abs(c[0] - bx) + abs(c[1] - by),
                    ),
                )
                stand = next((c for c in cands if c in reach), None)
                if stand is None:
                    unreachable.append((tx, ty))
                    self.blocked[(tx, ty)] = "not reachable on foot from the bot's position"
                    continue
                if self._stand_blocked_by_oscillation(stand):
                    self.blocked[(tx, ty)] = f"stand ({stand[0]},{stand[1]}) overused — oscillation guard"
                    failed_this_round.add((tx, ty))
                    self._cleanup_fails[(tx, ty)] = self._cleanup_fails.get((tx, ty), 0) + 1
                    continue

                if attempted >= 40:
                    self.blocked[(tx, ty)] = "cleanup pass budget reached"
                    continue
                attempted += 1

                plan = self._plan(tx, ty)  # live confirmation, reachable tiles only
                if plan.hits == 0:
                    continue
                if not plan.allowed:
                    self.note_blocked(tx, ty, plan.reason)
                    continue

                if (bx, by) != stand and not self.walk_grounded_to(stand):
                    unreachable.append((tx, ty))
                    self.blocked[(tx, ty)] = "unreachable"
                    failed_this_round.add((tx, ty))
                    self._cleanup_fails[(tx, ty)] = self._cleanup_fails.get((tx, ty), 0) + 1
                    # The reach set is stale once a walk fails mid-round:
                    # re-flood from the new position so the next target is
                    # judged from where the bot actually stands.
                    try:
                        reach = nav.reachable_footholds(self.client, self.coll, self.world_w, self.world_h) or {(bx, by)}
                    except Exception:
                        pass
                    continue

                if self.clear_tile(tx, ty):
                    progress += 1
                    self.blocked.pop((tx, ty), None)
                    self._cleanup_fails.pop((tx, ty), None)
                    cur_pos = self._pos()
                    if cur_pos is not None and not self._grounded_live(cur_pos[0], cur_pos[1]):
                        self.settle()
                else:
                    self.note_blocked(tx, ty, "punch failed")
                    failed_this_round.add((tx, ty))
                    self._cleanup_fails[(tx, ty)] = self._cleanup_fails.get((tx, ty), 0) + 1

            if progress == 0:
                no_progress += 1
                if unreachable:
                    sample = ", ".join(f"({x},{y})" for x, y in unreachable[:8])
                    more = f" (+{len(unreachable) - 8} more)" if len(unreachable) > 8 else ""
                    self.log(
                        f"cleanup round {rounds}: no progress — {len(unreachable)} exposed "
                        f"target(s) cannot be reached on foot from ({bx},{by}), "
                        f"e.g. {sample}{more}"
                    )
                else:
                    self.log(f"cleanup round {rounds}: no progress")
                if no_progress >= 2:
                    # A respawn drops the bot back at the same spawn point; if
                    # it is trapped there, retrying only burns respawns.
                    self.log("cleanup made no progress after a respawn — stopping cleanup")
                    break
                if not self.recover("cleanup made no progress"):
                    break
            else:
                no_progress = 0
                self.log(f"cleanup round {rounds}: cleared {progress} tile(s)")

    # ── reporting ─────────────────────────────────────────────────────────────

    def report(self) -> int:
        left = self._remaining_targets()
        elapsed = time.time() - self.started_at
        self.log("=" * 62)
        self.log(
            f"cleared: {self.broken} tile(s) | respawns: {self.respawns} | elapsed: {elapsed:.0f}s"
        )
        if not left:
            self.log("SUCCESS: world is clear of all target blocks")
            return 0
        self.log(f"remaining: {len(left)} target tile(s)")
        for (x, y) in left[:20]:
            self.log(f"  - ({x},{y}): {self.blocked.get((x, y), 'unreachable')}")
        if len(left) > 20:
            self.log(f"  ... and {len(left) - 20} more")
        return 2

    # ── main ──────────────────────────────────────────────────────────────────

    def _find_top_unblocked_row(self) -> Optional[int]:
        snap = self._snapshot()
        for y in range(self.world_h):
            for x in range(self.world_w):
                if (x, y) in self.blocked:
                    continue
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, y).has_work:
                    return y
        return None

    def _has_edge_supported_terrain_below(self, y0: int) -> bool:
        snap = self._snapshot()
        for y in range(max(1, y0 + 1), self.world_h):
            if not (self._grounded(0, y - 1) or self._grounded(self.world_w - 1, y - 1)):
                continue
            for x in range(self.world_w):
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, y).has_work:
                    return True
        return False

    def _find_and_enter_top_layer(self) -> Optional[Coord]:
        """Finds the topmost enterable target layer and enters it.

        When a world has sparse floating sky blocks above the main terrain
        (e.g. a 1-tile sky pillar at y=18..23 where neither world edge has
        ground support), ``enter_top_layer(y0)`` cannot enter at ``y0``. In
        that case this helper sweeps whatever sky targets on ``y0`` are
        reachable from the bot's footing, marks any unreachable sky leftovers
        as ``blocked`` (so they are cleared from below as the sweep passes
        under them), and advances to the next row until the main terrain
        surface is entered.
        """
        for _ in range(self.world_h):
            y0 = self._find_top_unblocked_row()
            if y0 is None:
                return None
            edge_supported = (
                y0 > 0
                and (self._grounded(0, y0 - 1) or self._grounded(self.world_w - 1, y0 - 1))
            )
            if edge_supported or not self._has_edge_supported_terrain_below(y0):
                entry = self.enter_top_layer(y0)
                if entry is not None:
                    return entry
                if edge_supported:
                    return None
            self.log(
                f"row {y0}: floating sky layer not enterable at edges — "
                f"clearing reachable sky targets and advancing to next row"
            )
            self.sweep_row_remainder(y0, 0, 1)
            snap = self._snapshot()
            for x in range(self.world_w):
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, y0).has_work:
                    self.blocked[(x, y0)] = "unreachable sky target"
        return None

    def resume_sweep(self, old_row: int) -> Optional[Tuple[int, int]]:
        """Re-enters the sweep after a stuck/disconnect recovery.

        Returns (row, direction) or None when the sweep cannot resume
        (nothing left, or no enterable layer — caller runs cleanup instead).
        Layer order is preserved by restarting at the topmost row that still
        holds whitelist targets, never at the old depth.
        """
        self.load_world()
        y0 = self._find_top_unblocked_row()
        if y0 is None:
            return None
        # Never resume below the topmost remaining work (never at the old
        # depth): after a respawn the bot is back at spawn (top), so
        # restarting at the topmost remaining row is both legal and cheapest.
        self.sweep_resumes += 1
        self.log(f"resuming sweep after recovery (attempt {self.sweep_resumes}) at topmost row {y0}")
        entry = self._find_and_enter_top_layer()
        if entry is None:
            return None
        row = entry[1]
        if self.row_legs_required == 2:
            snap = self._snapshot()
            left_targets = sum(
                1 for x in range(0, entry[0])
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
            )
            right_targets = sum(
                1 for x in range(entry[0] + 1, self.world_w)
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
            )
            if left_targets > 0 and right_targets == 0:
                direction = -1
            elif right_targets > 0 and left_targets == 0:
                direction = 1
            else:
                direction = 1 if sweep.nearest_edge_column(entry[0], self.world_w) == self.world_w - 1 else -1
        else:
            direction = 1 if entry[0] == 0 else -1
        self.log(
            f"resumed sweep at row {row} from x={entry[0]}, "
            f"direction {'right' if direction > 0 else 'left'}"
        )
        return row, direction

    def run(self) -> int:
        # One-shot stop signals are consumed on startup so a previous
        # stop_all.py run never kills a fresh session.
        clear_stop()
        try:
            clear_stop(self.client.bot_id)
        except Exception:
            pass
        self.configure()
        if not self.load_world():
            return 1
        # Take ownership of the driver seat: a server-side Lua script from an
        # older session would otherwise fight this loop for the same bot.
        try:
            self.client.stop_script()
        except Exception:
            pass
        runlock.refresh(self.client.bot_id)
        self.client.start_events()

        self.log("=" * 62)
        self.log(f"Growtopia Clear World — bot {self.client.username!r} (id {self.client.bot_id})")
        self.log(f"targets: {sorted(self.targets)} (dirt/lava/rock/cave bg by default)")
        self.log(f"protected: bedrock, locks {sorted(LOCK_IDS)}, doors, signs, checkpoints, trees")
        self.log(f"strategy: serpentine sweep, top layer first (descent only at x=0 / x={self.world_w - 1})")
        self.log("=" * 62)

        y0 = sweep.find_top_row(
            self._snapshot(), self.targets, self.world_w, self.world_h, self.strength, self.coll
        )
        if y0 is None:
            self.log("nothing to clear — no target blocks found")
            return 0

        # Enter the top layer (rule: layer transitions only on x=0 /
        # x=world_w-1). Prefers a world edge; when neither edge is reachable
        # (bot spawned inside the terrain, e.g. at a white door) the sweep
        # starts from the bot's own column and covers the row in two legs.
        entry = self._find_and_enter_top_layer()
        if entry is None:
            self.log("cannot start the sweep — running cleanup only")
            self.cleanup()
            return self.report()

        row = entry[1]
        if self.row_legs_required == 2:
            snap = self._snapshot()
            left_targets = sum(
                1 for x in range(0, entry[0])
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
            )
            right_targets = sum(
                1 for x in range(entry[0] + 1, self.world_w)
                if sweep.plan_for(snap, self.coll, self.targets, self.strength, x, row).has_work
            )
            if left_targets > 0 and right_targets == 0:
                direction = -1
            elif right_targets > 0 and left_targets == 0:
                direction = 1
            else:
                direction = 1 if sweep.nearest_edge_column(entry[0], self.world_w) == self.world_w - 1 else -1
        else:
            direction = 1 if entry[0] == 0 else -1  # away from the entry edge
        self.last_direction = direction
        self.log(
            f"starting sweep at row {row} from x={entry[0]}, "
            f"direction {'right' if direction > 0 else 'left'} "
            f"({self.row_legs_required} leg(s) per row)"
        )

        iterations = 0
        max_iterations = self.world_h + 8
        row_revisits: Dict[int, int] = {}
        max_resumes = max(1, self.cfg.max_respawn)
        while self.running and not self.sweep_aborted and iterations < max_iterations:
            iterations += 1
            runlock.refresh(self.client.bot_id)
            if should_stop(self.client.bot_id):
                self.log("stop requested — ending sweep")
                break
            try:
                status = self.sweep_row(row, direction)
                if status == "stopped":
                    break
                if status == "respawned":
                    resumed = self.resume_sweep(row)
                    if resumed is None:
                        break
                    row, direction = resumed
                    self.last_direction = direction
                    continue
                if status == "abort":
                    self.log("row could not be finished on a world edge — running the cleanup pass")
                    break
                if status == "stuck":
                    if not self.recover("stuck while sweeping row"):
                        break
                    if self.sweep_resumes >= max_resumes:
                        self.log("resume budget exhausted — running the cleanup pass")
                        break
                    resumed = self.resume_sweep(row)
                    if resumed is None:
                        break
                    row, direction = resumed
                    self.last_direction = direction
                    continue

                # "done": the row is finished and the bot stands on a world
                # edge. The next row sweeps away from that edge (serpentine).
                pos = self._pos()
                if pos is None or not self.at_edge(pos[0]):
                    self.log("row finished, but the bot is not on a world edge — running the cleanup pass")
                    break
                direction = 1 if pos[0] == 0 else -1
                self.last_direction = direction

                d = self.descend_to_next_row()  # rule: only at x=0 / x=world_w-1
                if d == "row_busy":
                    # Layer gate: the current row still holds reachable
                    # targets — stay on this layer and sweep it again instead
                    # of opening the row below. A single re-sweep only: the
                    # remainder pass inside sweep_row already covered what is
                    # reachable, anything left is for the from-below finish.
                    n = row_revisits.get(row, 0) + 1
                    row_revisits[row] = n
                    if n > 1:
                        self.log(f"row {row}: still busy after a re-sweep — running the cleanup pass")
                        break
                    self.log(f"row {row}: re-sweeping the same layer (attempt {n})")
                    # direction already points away from the current edge, so
                    # the next sweep_row covers the row back across.
                    continue
                row_revisits.pop(row, None)
                if d == "bottom":
                    self.log(f"sweep complete: reached the world bottom at row {row}")
                    break
                if d == "blocked":
                    self.log(f"sweep complete: unbreakable floor below row {row}")
                    break
                if d == "stuck":
                    if not self.recover("stuck while descending"):
                        break
                    if self.sweep_resumes >= max_resumes:
                        self.log("resume budget exhausted — running the cleanup pass")
                        break
                    resumed = self.resume_sweep(row)
                    if resumed is None:
                        break
                    row, direction = resumed
                    self.last_direction = direction
                    continue
            except grpc.RpcError as e:
                self.log(f"gRPC error during sweep: {e.code()} {e.details()}")
                if not self.recover("gRPC error"):
                    break
                if self.sweep_resumes >= max_resumes:
                    self.log("resume budget exhausted — running the cleanup pass")
                    break
                resumed = self.resume_sweep(row)
                if resumed is None:
                    break
                row, direction = resumed
                self.last_direction = direction
                continue

            pos = self._pos()
            if pos is not None and pos[1] > row:
                row = pos[1]
            else:
                row += 1
            if pos is not None:
                self.row_entry_edge = pos[0]
            self.row_legs_required = 1  # a descent always lands on an edge column
            if sweep.count_targets(
                self._snapshot(), self.targets, self.world_w, self.world_h, self.strength, self.coll
            ) == 0:
                self.log("all target blocks cleared by the main sweep")
                break

        if self.running:
            self.cleanup()
        return self.report()


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Growtopia Clear World bot via Mori gRPC")
    p.add_argument("--host", type=str, help="Mori gRPC host (default: MORI_GRPC_ADDR or 127.0.0.1)")
    p.add_argument("--port", type=int, help="Mori gRPC port (default: 50051)")
    p.add_argument("--token", type=str, help="Mori gRPC auth token (default: MORI_GRPC_TOKEN)")
    p.add_argument("--bot-id", type=int, help="Bot id to control (default: first in-game bot)")
    p.add_argument("--world", type=str, help="Optional: warp to this world before clearing")
    p.add_argument("--blocks", type=str, help="Comma separated target ids (default: 2,4,10,14)")
    p.add_argument("--start", choices=["auto", "left", "right"], help="Start edge (default: auto)")
    p.add_argument("--walk-delay", type=int, help="ms per tile step (default: 180)")
    p.add_argument("--punch-delay", type=int, help="ms per punch, hold-button rate (default: 150)")
    p.add_argument("--collect", action="store_true", help="Enable drop auto-collect (default: on)")
    p.add_argument("--no-collect", action="store_true", help="Disable drop auto-collect")
    p.add_argument("--collect-interval", type=int, help="ms between auto-collect ticks (default: 150)")
    p.add_argument("--drop-threshold", type=int, help="Inventory item count to trigger drop next to white door (default: 200)")
    p.add_argument("--no-drop", action="store_true", help="Disable auto-dropping maxed items next to white door")
    p.add_argument("--no-leave-on-mod", action="store_true", help="Do not auto-leave when a mod appears")
    p.add_argument("--takeover", action="store_true",
                   help="Take over the bot if another local instance holds it "
                        "(asks it to stop first, waits, then proceeds)")
    return p


def main() -> None:
    args = build_arg_parser().parse_args()
    cfg = BotConfig.from_env_and_args(args)

    print(f"[ClearWorld] connecting to Mori at {cfg.grpc_addr} ...")
    client = MoriClient(cfg.grpc_addr, cfg.token)
    try:
        client.connect()
        client.select_bot(cfg.bot_id)
    except NoBotsError as e:
        print(f"[ClearWorld] {e}", file=sys.stderr)
        sys.exit(1)
    except BotNotFoundError as e:
        print(f"[ClearWorld] {e}", file=sys.stderr)
        sys.exit(1)
    except grpc.RpcError as e:
        if e.code() == grpc.StatusCode.UNAUTHENTICATED:
            print(
                "[ClearWorld] server requires auth — set MORI_GRPC_TOKEN or pass --token",
                file=sys.stderr,
            )
        else:
            print(f"[ClearWorld] cannot reach Mori: {e.code()} {e.details()}", file=sys.stderr)
        sys.exit(1)

    # Single driver per bot: refuse to stack two local loops on one bot_id.
    lock_ok, lock_info = runlock.acquire(
        client.bot_id, script="clear_world", takeover=args.takeover
    )
    if not lock_ok:
        print(
            f"[ClearWorld] another local instance controls bot id {client.bot_id} "
            f"({lock_info}) — stop it first (botting/stop_all.py) or pass --takeover",
            file=sys.stderr,
        )
        client.close()
        sys.exit(1)

    if cfg.world:
        try:
            if not client.is_in_world(cfg.world):
                print(f"[ClearWorld] warping to {cfg.world!r} ...")
                client.warp(cfg.world, cfg.door)
                if not client.wait_world(cfg.world, 25.0):
                    print(f"[ClearWorld] warning: did not confirm arrival in {cfg.world!r}")
            time.sleep(1.0)
        except grpc.RpcError as e:
            print(f"[ClearWorld] warp failed: {e.code()} {e.details()}", file=sys.stderr)

    runner = ClearWorldRunner(client, cfg)

    if not cfg.world:
        try:
            if not client.is_in_world():
                print(
                    "[ClearWorld] bot is not in a world — log it in first or pass --world <NAME>",
                    file=sys.stderr,
                )
                runlock.release(client.bot_id)
                client.close()
                sys.exit(1)
        except grpc.RpcError:
            pass

    sigint_count = 0

    def _on_sigint(sig, frame):  # noqa: ANN001
        nonlocal sigint_count
        sigint_count += 1
        if sigint_count > 1:
            print("\n[ClearWorld] forced termination.", file=sys.stderr)
            runlock.release(client.bot_id)
            try:
                client.halt()
            except Exception:
                pass
            os._exit(130)

        print("\n[ClearWorld] stopping bot immediately ...", file=sys.stderr)
        runner.stop()
        try:
            client.halt()
        except Exception:
            pass
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGINT, _on_sigint)
    except ValueError:
        pass  # not in the main thread

    try:
        rc = runner.run()
    except KeyboardInterrupt:
        rc = 130
    finally:
        runlock.release(client.bot_id)
        try:
            client.halt()
        except Exception:
            pass
        client.close()

    sys.exit(rc)


if __name__ == "__main__":
    main()
