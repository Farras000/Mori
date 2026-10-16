"""Growtopia Place World Lock Bot Script via Mori gRPC.

Finds the Main Door (White Door, item id 6) in the world, navigates to a grounded
foothold within reach, clears any breakable block above the white door if needed,
and places a World Lock (item id 242) directly on top of the white door (door_x, door_y - 1).

Anti-cheat & Anti-ban safety:
- Single driver runlock: rejects duplicate scripts from stacking on the same bot.
- Strictly grounded walking via BFS pathfinder (never floats, never teleports).
- Verifies World Lock exists in bot inventory before making any moves.
- Settles before placing, turns to face target, verifies authoritative tile state.
- Graceful Ctrl+C shutdown with Mori halt.

Usage:
    python botting/place_lock.py [--bot-id 1] [--world <NAME>] [--lock-id 242]
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from typing import Dict, List, Mapping, Optional, Set, Tuple

import grpc

# ── sys.path bootstrap (repo root + generated stubs) ─────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, os.path.join(_ROOT, "examples")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from botting import navigator as nav  # noqa: E402
from botting import runlock  # noqa: E402
from botting import sweep  # noqa: E402
from botting.config import BotConfig, LOCK_IDS, load_dotenv  # noqa: E402
from botting.mori import BotNotFoundError, MoriClient, NoBotsError  # noqa: E402
from botting.physics import (  # noqa: E402
    is_solid_support,
    is_standable_grid,
    is_target_block,
    is_tile_passable,
    is_within_punch_range,
    plan_punch,
)
from botting.stop import clear_stop, request_stop, should_stop  # noqa: E402

Coord = Tuple[int, int]
Tile = Tuple[int, int]

WHITE_DOOR_ID = 6
WORLD_LOCK_ID = 242


def find_white_door(grid: Mapping[Coord, Tile]) -> Optional[Coord]:
    """Scans world snapshot for the white door (item id 6)."""
    for (x, y), (fg, _bg) in grid.items():
        if fg == WHITE_DOOR_ID:
            return x, y
    return None


def get_inventory_count(client: MoriClient, item_id: int) -> int:
    """Returns the total count of item_id in the bot's inventory."""
    try:
        inv = client.get_inventory()
    except Exception:
        return 0
    total = 0
    for slot in getattr(inv, "items", []):
        if getattr(slot, "item_id", 0) == item_id:
            total += getattr(slot, "amount", 0)
    return total


class PlaceLockRunner:
    """Orchestrates navigating to the white door and placing a World Lock above it."""

    def __init__(
        self,
        client: MoriClient,
        cfg: BotConfig,
        lock_id: int = WORLD_LOCK_ID,
        door_override: Optional[Coord] = None,
    ) -> None:
        self.client = client
        self.cfg = cfg
        self.lock_id = int(lock_id)
        self.door_override = door_override

        self.coll: Dict[int, int] = {}
        self.strength: Dict[int, int] = {}

        self.world_name = ""
        self.world_w = 100
        self.world_h = 60

        self.running = True
        self.started_at = time.time()

    def stop(self) -> None:
        self.running = False
        bot_id = getattr(self.client, "bot_id", None)
        if bot_id:
            request_stop(bot_id)
        self.client.stop_events()

    def log(self, msg: str) -> None:
        print(f"[PlaceLock] {msg}", flush=True)

    def _pos(self) -> Optional[Coord]:
        pos = self.client.pos_tile()
        if pos is None:
            try:
                return self.client.refresh_pos()
            except grpc.RpcError:
                return None
        return pos

    def load_world(self, retries: int = 3) -> bool:
        last_err = None
        for _ in range(retries):
            try:
                name, w, h = self.client.sync_world()
                last_err = None
                break
            except grpc.RpcError as e:
                last_err = e
                time.sleep(1.0)

        if last_err is not None:
            self.log(f"GetWorld failed: {last_err.code()} {last_err.details()}")
            return False

        self.world_name, self.world_w, self.world_h = name, w, h
        # Ensure item info for common items
        ids = {WHITE_DOOR_ID, self.lock_id, 2, 4, 8, 10, 14}
        for fg, bg in self.client.grid_snapshot().values():
            ids.add(fg)
            ids.add(bg)
        for item_id in sorted(ids):
            if not item_id or item_id in self.coll:
                continue
            try:
                info = self.client.get_item_info(item_id)
                self.coll[item_id] = int(info.collision_type)
                self.strength[item_id] = max(1, int(info.strength))
            except grpc.RpcError:
                pass
        self.log(f"world {name!r} {w}x{h} synced")
        return True

    def clear_target_tile(self, tx: int, ty: int) -> bool:
        """Punches tile (tx, ty) until it is free of foreground block."""
        place_s = self.cfg.place_s
        for _ in range(12):
            if not self.running or should_stop(self.client.bot_id):
                return False
            fg, bg = self.client.get_tile(tx, ty) or (0, 0)
            if fg == 0:
                return True
            if fg in self.cfg.protected_fg_ids:
                self.log(f"cannot clear target ({tx},{ty}): protected block id {fg}")
                return False

            pos = self._pos() or (tx, ty)
            dx, dy = tx - pos[0], ty - pos[1]
            if not is_within_punch_range(dx, dy):
                return False

            if dx != 0:
                try:
                    self.client.set_direction(facing_left=(dx < 0))
                except Exception:
                    pass

            hits = max(1, self.strength.get(fg, 4))
            for _ in range(hits):
                try:
                    self.client.hit(dx, dy)
                except grpc.RpcError:
                    return False

            timeout = hits * place_s + 0.8
            if self.client.wait_tile_cleared(tx, ty, lambda t: t[0] != 0, timeout):
                return True

        fg, _ = self.client.get_tile(tx, ty) or (0, 0)
        return fg == 0

    def pick_stand_foothold(self, target: Coord) -> Optional[Coord]:
        """Picks the closest grounded foothold within reach of target."""
        snap = self.client.grid_snapshot()
        bx, by = self._pos() or target

        # Check door tile and adjacent tiles first
        tx, ty = target
        door_tile = (tx, ty + 1)
        candidates: List[Coord] = [
            door_tile,
            (tx - 1, door_tile[1]),
            (tx + 1, door_tile[1]),
            (tx - 1, ty),
            (tx + 1, ty),
        ]
        # Also append standard stand candidates within reach
        candidates.extend(
            nav.stand_candidates(
                snap, self.coll, target[0], target[1], bx, by, self.world_w, self.world_h
            )
        )

        seen: Set[Coord] = set()
        for cand in candidates:
            if cand in seen:
                continue
            seen.add(cand)
            cx, cy = cand
            if not is_standable_grid(snap, self.coll, cx, cy, self.world_w, self.world_h):
                continue
            dx, dy = target[0] - cx, target[1] - cy
            if is_within_punch_range(dx, dy):
                return cand
        return None

    def run(self) -> int:
        clear_stop(self.client.bot_id)
        self.client.start_events()

        if not self.load_world():
            return 1

        # Check inventory for lock
        lock_count = get_inventory_count(self.client, self.lock_id)
        self.log(f"inventory has {lock_count} lock(s) of id {self.lock_id}")
        if lock_count < 1:
            self.log(
                f"error: bot does not have any lock of id {self.lock_id} in inventory — "
                "obtain a World Lock first!"
            )
            return 1

        # Locate white door
        door_coord = self.door_override or find_white_door(self.client.grid_snapshot())
        if door_coord is None:
            self.log("error: white door (item id 6) not found in the world!")
            return 1
        door_x, door_y = door_coord
        self.log(f"white door located at ({door_x}, {door_y})")

        target_x, target_y = door_x, door_y - 1
        if target_y < 0:
            self.log(f"error: white door is at top of world (y={door_y}), cannot place above it!")
            return 1
        self.log(f"target tile to place lock is ({target_x}, {target_y})")

        # Check if already locked
        cur_target = self.client.get_tile(target_x, target_y) or (0, 0)
        if cur_target[0] in LOCK_IDS:
            self.log(
                f"tile ({target_x}, {target_y}) is ALREADY locked (fg_item_id={cur_target[0]}) — "
                "world is already secured!"
            )
            return 0

        # Find best foothold to place from
        foothold = self.pick_stand_foothold((target_x, target_y))
        if foothold is None:
            self.log(f"error: no grounded foothold found within reach of ({target_x}, {target_y})")
            return 1

        self.log(f"navigating to foothold ({foothold[0]}, {foothold[1]}) ...")
        pos = self._pos()
        if pos != foothold:
            if not nav.walk_grounded(
                self.client,
                foothold,
                self.coll,
                self.world_w,
                self.world_h,
                self.cfg.walk_delay_ms,
            ):
                self.log(f"failed to walk to foothold ({foothold[0]}, {foothold[1]})")
                return 1

        # Settle to ensure grounded
        if not nav.settle(self.client, self.coll, self.world_h, self.cfg.walk_delay_ms):
            self.log("failed to settle on foothold")
            return 1

        cur_pos = self._pos()
        if cur_pos is None:
            self.log("lost bot position")
            return 1
        bx, by = cur_pos
        dx, dy = target_x - bx, target_y - by
        if not is_within_punch_range(dx, dy):
            self.log(f"bot at ({bx},{by}) is not within reach of target ({target_x},{target_y})")
            return 1

        # If target tile has breakable block (dirt, etc.), clear it first
        cur_target = self.client.get_tile(target_x, target_y) or (0, 0)
        if cur_target[0] != 0:
            self.log(f"target tile is occupied by block id {cur_target[0]} — clearing it first ...")
            if not self.clear_target_tile(target_x, target_y):
                self.log(f"failed to clear target tile ({target_x},{target_y})")
                return 1

        # Turn avatar to face target
        if dx != 0:
            try:
                self.client.set_direction(facing_left=(dx < 0))
            except Exception:
                pass
            time.sleep(0.05)

        # Place the lock!
        self.log(f"placing lock (id={self.lock_id}) at offset ({dx}, {dy}) ...")
        for attempt in range(1, 4):
            if not self.running or should_stop(self.client.bot_id):
                return 1
            try:
                self.client.place(dx, dy, self.lock_id)
            except grpc.RpcError as e:
                self.log(f"RPC Place failed: {e.code()} {e.details()}")
                time.sleep(0.5)
                continue

            # Wait and verify
            deadline = time.time() + 2.0
            while time.time() < deadline:
                t = self.client.get_tile(target_x, target_y)
                if t and t[0] == self.lock_id:
                    self.log(
                        f"SUCCESS! Placed World Lock (id={self.lock_id}) at "
                        f"({target_x}, {target_y}) directly above the white door!"
                    )
                    return 0
                time.sleep(0.15)
            self.log(f"attempt {attempt}: tile not updated yet, retrying ...")

        # Final check
        final_tile = self.client.get_tile(target_x, target_y) or (0, 0)
        if final_tile[0] == self.lock_id:
            self.log(f"SUCCESS! World Lock verified at ({target_x}, {target_y})")
            return 0

        self.log(
            f"failed to place lock at ({target_x}, {target_y}) — tile fg is {final_tile[0]}"
        )
        return 1


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Place a World Lock above the White Door via Mori gRPC"
    )
    p.add_argument("--host", type=str, help="Mori gRPC host (default: 127.0.0.1 or from .env)")
    p.add_argument("--port", type=int, help="Mori gRPC port (default: 50051 or from .env)")
    p.add_argument("--token", type=str, help="Mori gRPC auth token (default: from .env)")
    p.add_argument("--bot-id", type=int, help="Bot id to control (default: first in-game bot)")
    p.add_argument("--world", type=str, help="Optional: warp to this world first")
    p.add_argument("--lock-id", type=int, default=WORLD_LOCK_ID,
                   help="Lock item id to place (default: 242 World Lock)")
    p.add_argument("--door-x", type=int, help="Optional override: white door X coordinate")
    p.add_argument("--door-y", type=int, help="Optional override: white door Y coordinate")
    p.add_argument("--walk-delay", type=int, help="ms per tile step (default: 180)")
    p.add_argument("--punch-delay", type=int, help="ms per punch/place (default: 150)")
    p.add_argument("--takeover", action="store_true",
                   help="Take over the bot if another local instance holds it")
    return p


def main() -> None:
    load_dotenv()
    args = build_arg_parser().parse_args()
    cfg = BotConfig.from_env_and_args(args)

    print(f"[PlaceLock] connecting to Mori at {cfg.grpc_addr} ...")
    client = MoriClient(cfg.grpc_addr, cfg.token)
    try:
        client.connect()
        client.select_bot(cfg.bot_id)
    except NoBotsError as e:
        print(f"[PlaceLock] {e}", file=sys.stderr)
        sys.exit(1)
    except BotNotFoundError as e:
        print(f"[PlaceLock] {e}", file=sys.stderr)
        sys.exit(1)
    except grpc.RpcError as e:
        if e.code() == grpc.StatusCode.UNAUTHENTICATED:
            print(
                "[PlaceLock] server requires auth — set MORI_GRPC_TOKEN or pass --token",
                file=sys.stderr,
            )
        else:
            print(f"[PlaceLock] cannot reach Mori: {e.code()} {e.details()}", file=sys.stderr)
        sys.exit(1)

    # Single driver per bot: refuse to stack two local loops on one bot_id.
    lock_ok, lock_info = runlock.acquire(
        client.bot_id, script="place_lock", takeover=args.takeover
    )
    if not lock_ok:
        print(
            f"[PlaceLock] another local instance controls bot id {client.bot_id} "
            f"({lock_info}) — stop it first (botting/stop_all.py) or pass --takeover",
            file=sys.stderr,
        )
        client.close()
        sys.exit(1)

    if cfg.world:
        try:
            if not client.is_in_world(cfg.world):
                print(f"[PlaceLock] warping to {cfg.world!r} ...")
                client.warp(cfg.world, cfg.door)
                if not client.wait_world(cfg.world, 25.0):
                    print(f"[PlaceLock] warning: did not confirm arrival in {cfg.world!r}")
            time.sleep(1.0)
        except grpc.RpcError as e:
            print(f"[PlaceLock] warp failed: {e.code()} {e.details()}", file=sys.stderr)

    door_override = (args.door_x, args.door_y) if (args.door_x is not None and args.door_y is not None) else None
    runner = PlaceLockRunner(client, cfg, lock_id=args.lock_id, door_override=door_override)

    sigint_count = 0

    def _on_sigint(sig, frame):  # noqa: ANN001
        nonlocal sigint_count
        sigint_count += 1
        if sigint_count > 1:
            print("\n[PlaceLock] forced termination.", file=sys.stderr)
            runlock.release(client.bot_id)
            try:
                client.halt()
            except Exception:
                pass
            os._exit(130)

        print("\n[PlaceLock] stopping bot immediately ...", file=sys.stderr)
        runner.stop()
        try:
            client.halt()
        except Exception:
            pass
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGINT, _on_sigint)
    except ValueError:
        pass

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
