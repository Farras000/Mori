"""Growtopia Clear World Botting Script.

Automates clearing a Growtopia world layer-by-layer using Mori gRPC:
- Connects to Mori at specified host and port (reads .env by default).
- Implements safe holding punch mechanic with natural delays (~180ms).
- Strictly obeys Growtopia physics: never teleports, never floats in mid-air.
- Protects bedrock (8), world locks (242), other locks, and main doors (6).
- Clears from top to bottom (layer-by-layer) so the bot always stands on solid footholds.
- Handles stuck situations by automatically respawning to the world door and resuming.
- Automatically collects dropped gems and seeds within reach.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Set, Tuple

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

from botting.config import BotConfig, LOCK_IDS, PROTECTED_FG_IDS
from botting.navigator import (
    get_tile_safe,
    pick_stand,
    server_pos_tiles,
    settle,
    walk_grounded,
)
from botting.physics import (
    is_target_block,
    is_unbreakable_obstacle,
    is_within_punch_range,
    relative_offset,
)


class ClearWorldBot:
    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.channel: Optional[grpc.Channel] = None
        self.stub: Optional[rpc.MoriStub] = None
        self.metadata: List[Tuple[str, str]] = []
        self.bot_ref: Optional[pb.BotRef] = None
        self.bot_id: int = 0
        self.username: str = ""
        self.world_name: str = ""
        self.world_width: int = 100
        self.world_height: int = 60

        # Tile grid: (x, y) -> (fg_item_id, bg_item_id)
        self.grid: Dict[Tuple[int, int], Tuple[int, int]] = {}
        self.grid_lock = threading.Lock()

        # Item info cache: item_id -> collision_type
        self.collision_map: Dict[int, int] = {}
        # Item info cache: item_id -> strength (hits needed)
        self.strength_map: Dict[int, int] = {}

        self.cur_x: int = 0
        self.cur_y: int = 0
        self.running: bool = True
        self.total_broken: int = 0
        self.attempts: Dict[Tuple[int, int], int] = {}
        self.skipped: Set[Tuple[int, int]] = set()

    def connect(self) -> bool:
        """Connects to the Mori gRPC server and selects a bot."""
        addr = self.config.grpc_addr
        print(f"[ClearWorld] Connecting to Mori gRPC at {addr}...")

        if self.config.token:
            self.metadata = [("authorization", f"Bearer {self.config.token.strip()}")]
        else:
            self.metadata = []

        self.channel = grpc.insecure_channel(addr)
        self.stub = rpc.MoriStub(self.channel)

        try:
            bots_resp = self.stub.ListBots(pb.Empty(), metadata=self.metadata)
        except grpc.RpcError as e:
            if e.code() == grpc.StatusCode.UNAUTHENTICATED:
                print(
                    "[ClearWorld] Error: Server requires authentication. "
                    "Set MORI_GRPC_TOKEN in .env or pass --token.",
                    file=sys.stderr,
                )
            else:
                print(f"[ClearWorld] Failed to connect to Mori gRPC: {e.code()} - {e.details()}", file=sys.stderr)
            return False

        if not bots_resp.bots:
            print("[ClearWorld] No bots running in Mori. Spawn a bot first via web UI or SpawnBot RPC.", file=sys.stderr)
            return False

        chosen_bot = None
        if self.config.bot_id is not None:
            for b in bots_resp.bots:
                if b.bot_id == self.config.bot_id:
                    chosen_bot = b
                    break
            if not chosen_bot:
                print(f"[ClearWorld] Bot ID {self.config.bot_id} not found among running bots.", file=sys.stderr)
                return False
        else:
            # Pick first in-game bot, or first bot
            for b in bots_resp.bots:
                if b.status == "in_game" and b.world:
                    chosen_bot = b
                    break
            if not chosen_bot:
                chosen_bot = bots_resp.bots[0]

        self.bot_id = chosen_bot.bot_id
        self.username = chosen_bot.username
        self.bot_ref = pb.BotRef(bot_id=self.bot_id)

        print(f"[ClearWorld] Selected bot: ID={self.bot_id} ({self.username}) in world='{chosen_bot.world}'")

        # Configure server movement and place delays
        try:
            self.stub.SetWalkDelay(
                pb.SetUintRequest(bot=self.bot_ref, value=self.config.walk_delay_ms),
                metadata=self.metadata,
            )
            self.stub.SetPlaceDelay(
                pb.SetUintRequest(bot=self.bot_ref, value=self.config.place_delay_ms),
                metadata=self.metadata,
            )
        except grpc.RpcError as e:
            print(f"[ClearWorld] Warning setting delays: {e.details()}")

        return True

    def prefetch_item_info(self, item_ids: Sequence[int]) -> None:
        """Prefetches collision types and strength for item IDs."""
        for item_id in set(item_ids):
            if item_id in self.collision_map:
                continue
            try:
                info = self.stub.GetItemInfo(pb.GetItemInfoRequest(id=item_id), metadata=self.metadata)
                self.collision_map[item_id] = info.collision_type
                self.strength_map[item_id] = max(info.strength, 1)
            except grpc.RpcError:
                # Default values for standard items
                if item_id in {2, 4, 14}:
                    self.collision_map[item_id] = 1 if item_id != 14 else 0
                    self.strength_map[item_id] = 3
                elif item_id == 10:
                    self.collision_map[item_id] = 1
                    self.strength_map[item_id] = 8
                elif item_id == 8:
                    self.collision_map[item_id] = 1
                    self.strength_map[item_id] = 999

    def sync_world(self) -> bool:
        """Loads complete world snapshot and populates the local grid cache."""
        try:
            state = self.stub.GetBotState(self.bot_ref, metadata=self.metadata)
            self.world_name = state.world_name
            self.cur_x = int(round(state.pos_x))
            self.cur_y = int(round(state.pos_y))

            if not self.world_name:
                print("[ClearWorld] Bot is not currently in any world!", file=sys.stderr)
                return False

            world = self.stub.GetWorld(self.bot_ref, metadata=self.metadata)
            self.world_width = world.width
            self.world_height = world.height

            with self.grid_lock:
                self.grid.clear()
                item_ids_to_fetch = set()
                for t in world.tiles:
                    self.grid[(t.x, t.y)] = (t.fg_item_id, t.bg_item_id)
                    if t.fg_item_id > 0:
                        item_ids_to_fetch.add(t.fg_item_id)
                    if t.bg_item_id > 0:
                        item_ids_to_fetch.add(t.bg_item_id)

            # Ensure essential blocks are prefetched
            item_ids_to_fetch.update(self.config.target_block_ids)
            item_ids_to_fetch.update(self.config.protected_fg_ids)
            self.prefetch_item_info(list(item_ids_to_fetch))

            print(
                f"[ClearWorld] World '{self.world_name}' synced ({self.world_width}x{self.world_height}). "
                f"Bot at ({self.cur_x}, {self.cur_y})."
            )
            return True
        except grpc.RpcError as e:
            print(f"[ClearWorld] Failed to sync world: {e.code()} - {e.details()}", file=sys.stderr)
            return False

    def start_event_listener(self) -> None:
        """Starts a background daemon thread to stream real-time world events."""
        def _listener() -> None:
            while self.running:
                try:
                    for ev in self.stub.SubscribeEvents(
                        pb.SubscribeRequest(bot_ids=[self.bot_id]),
                        metadata=self.metadata,
                    ):
                        if not self.running:
                            break
                        which = ev.WhichOneof("event")
                        if which == "tile_update":
                            tu = ev.tile_update
                            with self.grid_lock:
                                self.grid[(tu.x, tu.y)] = (tu.fg, tu.bg)
                        elif which == "bot_move":
                            bm = ev.bot_move
                            self.cur_x = int(round(bm.x))
                            self.cur_y = int(round(bm.y))
                except Exception:
                    time.sleep(1.0)

        t = threading.Thread(target=_listener, daemon=True)
        t.start()

    def set_facing(self, face_left: bool) -> None:
        """Sets bot direction facing."""
        try:
            self.stub.SetDirection(
                pb.SetDirectionRequest(bot=self.bot_ref, facing_left=face_left),
                metadata=self.metadata,
            )
        except grpc.RpcError:
            pass

    def break_tile(self, tx: int, ty: int) -> bool:
        """Hits a target tile until both foreground and background targets are cleared.

        Respects vanilla punch range and natural punch delay.
        """
        _, bx, by = server_pos_tiles(self.stub, self.bot_ref, self.metadata)
        dx, dy = relative_offset(bx, by, tx, ty)

        if not is_within_punch_range(dx, dy):
            return False

        # Set facing direction
        if dx != 0:
            self.set_facing(dx < 0)

        # Estimate hits needed
        with self.grid_lock:
            cur_fg, cur_bg = self.grid.get((tx, ty), (0, 0))

        # Check if foreground is unbreakable/protected
        if is_unbreakable_obstacle(cur_fg, self.config.protected_fg_ids):
            return False

        strength = 4
        if cur_fg in self.strength_map:
            strength = self.strength_map[cur_fg]
        elif cur_bg in self.strength_map:
            strength = self.strength_map[cur_bg]

        # Calculate hits limit
        max_hits = min(max(strength * 2, 8), self.config.max_hits_per_block)
        req = pb.TileActionRequest(bot=self.bot_ref, x=dx, y=dy)
        step_delay = max(self.config.place_delay_ms / 1000.0, 0.15)

        for _ in range(max_hits):
            if not self.running:
                return False

            # Verify if still in range
            _, cur_bx, cur_by = server_pos_tiles(self.stub, self.bot_ref, self.metadata)
            cur_dx, cur_dy = relative_offset(cur_bx, cur_by, tx, ty)
            if not is_within_punch_range(cur_dx, cur_dy):
                return False

            if cur_dx != dx or cur_dy != dy:
                dx, dy = cur_dx, cur_dy
                req = pb.TileActionRequest(bot=self.bot_ref, x=dx, y=dy)

            try:
                self.stub.Hit(req, metadata=self.metadata)
            except grpc.RpcError:
                pass

            time.sleep(step_delay)

            # Check tile state
            t = get_tile_safe(self.stub, self.bot_ref, self.metadata, tx, ty)
            if t is not None:
                with self.grid_lock:
                    self.grid[(tx, ty)] = (t.fg_item_id, t.bg_item_id)
                if not is_target_block(t, self.config.target_block_ids):
                    self.total_broken += 1
                    return True

        # Final check
        t = get_tile_safe(self.stub, self.bot_ref, self.metadata, tx, ty)
        if t is not None:
            with self.grid_lock:
                self.grid[(tx, ty)] = (t.fg_item_id, t.bg_item_id)
            cleared = not is_target_block(t, self.config.target_block_ids)
            if cleared:
                self.total_broken += 1
            return cleared

        return False

    def respawn_and_sync(self) -> bool:
        """Executes Respawn when stuck and re-synchronizes world state."""
        print("[ClearWorld] Executing Respawn to world spawn door...")
        try:
            self.stub.Respawn(self.bot_ref, metadata=self.metadata)
        except grpc.RpcError as e:
            print(f"[ClearWorld] Respawn call failed: {e.details()}")

        time.sleep(2.0)
        return self.sync_world()

    def find_topmost_target_layer(self) -> Optional[int]:
        """Finds the smallest Y (topmost layer) that contains breakable target blocks."""
        with self.grid_lock:
            for y in range(self.world_height):
                for x in range(self.world_width):
                    tile = self.grid.get((x, y))
                    if not tile:
                        continue
                    fg, bg = tile
                    if is_unbreakable_obstacle(fg, self.config.protected_fg_ids):
                        continue
                    if (x, y) in self.skipped:
                        continue
                    if fg in self.config.target_block_ids or bg in self.config.target_block_ids:
                        return y
        return None

    def get_layer_targets(self, y: int) -> List[Tuple[int, int]]:
        """Returns all breakable target block coordinates on layer Y."""
        targets = []
        with self.grid_lock:
            for x in range(self.world_width):
                tile = self.grid.get((x, y))
                if not tile:
                    continue
                fg, bg = tile
                if is_unbreakable_obstacle(fg, self.config.protected_fg_ids):
                    continue
                if (x, y) in self.skipped:
                    continue
                if fg in self.config.target_block_ids or bg in self.config.target_block_ids:
                    targets.append((x, y))
        return targets

    def count_remaining_target_blocks(self) -> int:
        """Counts total breakable target blocks remaining in world."""
        count = 0
        with self.grid_lock:
            for (x, y), (fg, bg) in self.grid.items():
                if is_unbreakable_obstacle(fg, self.config.protected_fg_ids):
                    continue
                if (x, y) in self.skipped:
                    continue
                if fg in self.config.target_block_ids or bg in self.config.target_block_ids:
                    count += 1
        return count

    def collect_drops(self) -> None:
        """Collects dropped items (seeds, gems) within safe range."""
        try:
            self.stub.Collect(
                pb.CollectRequest(bot=self.bot_ref, range=3.0, interval_ms=100),
                metadata=self.metadata,
            )
        except grpc.RpcError:
            pass

    def run_clear_world(self) -> None:
        """Main loop: clears world strictly top-to-bottom layer-by-layer."""
        print("\n=================================================================")
        print("  Growtopia Clear World Botting Script (Physics & Anti-Cheat Safe)")
        print(f"  Target Blocks : {sorted(self.config.target_block_ids)}")
        print(f"  Protected FG  : Bedrock(8), World Lock(242), Door(6), etc.")
        print("  Strategy      : Strictly Top-to-Bottom Layer Clearing")
        print("=================================================================\n")

        if not self.sync_world():
            return

        self.start_event_listener()
        consecutive_stuck_cycles = 0

        while self.running:
            top_y = self.find_topmost_target_layer()
            if top_y is None:
                # Check if there are skipped blocks or everything is truly clear
                remaining = self.count_remaining_target_blocks()
                if remaining == 0:
                    print(
                        f"\n[ClearWorld] SUCCESS! World '{self.world_name}' is fully cleared! "
                        f"Total blocks broken: {self.total_broken}."
                    )
                    break
                else:
                    print(
                        f"\n[ClearWorld] Notice: {len(self.skipped)} tiles were skipped (unreachable/blocked). "
                        "Re-checking unreachable tiles after respawn..."
                    )
                    self.skipped.clear()
                    self.respawn_and_sync()
                    continue

            remaining_world = self.count_remaining_target_blocks()
            targets_on_layer = self.get_layer_targets(top_y)

            print(
                f"\n[ClearWorld] Topmost Layer: Y={top_y} | "
                f"Remaining on layer: {len(targets_on_layer)} | "
                f"Total remaining: {remaining_world} | Total broken: {self.total_broken}"
            )

            # Settle bot first
            settle(
                self.stub,
                self.bot_ref,
                self.metadata,
                self.collision_map,
                self.grid,
                self.world_width,
                self.world_height,
                self.config.walk_delay_ms,
            )

            cleared_any_on_layer = False

            # Sort targets by distance to bot
            _, bx, by = server_pos_tiles(self.stub, self.bot_ref, self.metadata)
            targets_on_layer.sort(key=lambda t: abs(t[0] - bx) + abs(t[1] - by))

            for tx, ty in targets_on_layer:
                if not self.running:
                    break

                # Double check if tile was cleared concurrently
                with self.grid_lock:
                    tile = self.grid.get((tx, ty))
                    if not tile or not is_target_block(tile, self.config.target_block_ids):
                        continue

                # Find valid standable foothold within safe punch reach
                stand = pick_stand(
                    self.grid,
                    self.collision_map,
                    tx,
                    ty,
                    bx,
                    by,
                    self.world_width,
                    self.world_height,
                )

                if not stand:
                    self.attempts[(tx, ty)] = self.attempts.get((tx, ty), 0) + 1
                    if self.attempts[(tx, ty)] >= self.config.max_attempts:
                        print(f"[ClearWorld] Tile ({tx}, {ty}) has no standable foothold in punch reach. Skipping.")
                        self.skipped.add((tx, ty))
                    continue

                # Walk to standable foothold
                if (bx, by) != stand:
                    walk_ok = walk_grounded(
                        self.stub,
                        self.bot_ref,
                        self.metadata,
                        stand,
                        self.collision_map,
                        self.grid,
                        self.world_width,
                        self.world_height,
                        self.config.walk_delay_ms,
                    )
                    if not walk_ok:
                        self.attempts[(tx, ty)] = self.attempts.get((tx, ty), 0) + 1
                        if self.attempts[(tx, ty)] >= self.config.max_attempts:
                            print(f"[ClearWorld] Path to tile ({tx}, {ty}) blocked by obstacles. Skipping.")
                            self.skipped.add((tx, ty))
                        continue

                # Now within punch range, break the tile
                print(f"[ClearWorld] Breaking target at ({tx}, {ty}) from ({stand[0]}, {stand[1]})...")
                broken = self.break_tile(tx, ty)
                if broken:
                    cleared_any_on_layer = True
                    consecutive_stuck_cycles = 0
                    # Collect drops every 5 broken blocks
                    if self.total_broken % 5 == 0:
                        self.collect_drops()
                else:
                    self.attempts[(tx, ty)] = self.attempts.get((tx, ty), 0) + 1
                    if self.attempts[(tx, ty)] >= self.config.max_attempts:
                        print(f"[ClearWorld] Failed to break ({tx}, {ty}) after max attempts. Skipping.")
                        self.skipped.add((tx, ty))

                # Update bot position for next iteration
                _, bx, by = server_pos_tiles(self.stub, self.bot_ref, self.metadata)

            # If no target could be cleared on this layer, detect if bot is stuck
            if not cleared_any_on_layer:
                consecutive_stuck_cycles += 1
                if consecutive_stuck_cycles >= 2:
                    print(
                        f"[ClearWorld] Stuck warning: Unable to clear targets on layer Y={top_y}. "
                        "Triggering auto-respawn recovery..."
                    )
                    self.respawn_and_sync()
                    consecutive_stuck_cycles = 0
            else:
                consecutive_stuck_cycles = 0

            time.sleep(0.05)


def main() -> None:
    parser = argparse.ArgumentParser(description="Growtopia Clear World Botting Script via Mori gRPC")
    parser.add_argument("--host", type=str, help="Mori gRPC host (default: 127.0.0.1 or from .env)")
    parser.add_argument("--port", type=int, help="Mori gRPC port (default: 50051 or from .env)")
    parser.add_argument("--token", type=str, help="Mori gRPC auth token (default: from .env)")
    parser.add_argument("--bot-id", type=int, help="Bot ID to control (default: first available)")
    parser.add_argument("--blocks", type=str, help="Comma-separated block IDs to clear (default: 2,4,10,14)")
    parser.add_argument("--walk-delay", type=int, help="Delay in ms per tile step (default: 200)")
    parser.add_argument("--punch-delay", type=int, help="Delay in ms per punch (default: 180)")

    args = parser.parse_args()
    config = BotConfig.from_env_and_args(args)

    bot = ClearWorldBot(config)

    def _handle_sigint(sig, frame):
        print("\n[ClearWorld] Stopping script gracefully...")
        bot.running = False
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_sigint)

    if not bot.connect():
        sys.exit(1)

    try:
        bot.run_clear_world()
    except KeyboardInterrupt:
        print(f"\n[ClearWorld] Stopped by user. Total blocks broken: {bot.total_broken}.")
    except grpc.RpcError as e:
        print(f"\n[ClearWorld] gRPC Error: {e.code()} - {e.details()}", file=sys.stderr)


if __name__ == "__main__":
    main()
