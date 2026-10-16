"""Unit tests for auto-collect and white door drop functionality."""

from __future__ import annotations

import argparse
import unittest
from typing import Dict, Tuple

from botting.clear_world import ClearWorldRunner
from botting.config import BotConfig
from botting.dropper import (
    DropSpot,
    PROTECTED_DROP_IDS,
    WHITE_DOOR_ID,
    find_white_door,
    maxed_items,
    pick_drop_spot,
)
from botting.tests.fake_mori import FakeMoriClient

Tile = Tuple[int, int]


class TestDropperPure(unittest.TestCase):
    """Tests for pure logic in dropper.py (no network / client dependencies)."""

    def test_find_white_door(self) -> None:
        grid: Dict[Tuple[int, int], Tile] = {
            (0, 0): (0, 0),
            (5, 10): (WHITE_DOOR_ID, 0),
            (5, 11): (8, 0),
        }
        self.assertEqual(find_white_door(grid), (5, 10))
        self.assertIsNone(find_white_door({(0, 0): (2, 0)}))

    def test_maxed_items_filters_properly(self) -> None:
        amounts = {
            2: 200,    # Dirt -> should be dropped
            4: 199,    # Lava -> below threshold
            10: 250,   # Rock -> should be dropped
            18: 200,   # Fist -> protected
            32: 200,   # Wrench -> protected
            112: 500,  # Gems -> protected
            242: 200,  # World Lock -> protected
            48: 200,   # Pickaxe -> worn / active
        }
        active_ids = {48}
        items = maxed_items(amounts, active_ids, threshold=200)
        self.assertEqual(items, [(2, 200), (10, 250)])

    def test_pick_drop_spot_prefers_closer_side(self) -> None:
        # Door at (10, 4).
        # Row 4 is empty air, row 5 is solid ground (id=8 bedrock).
        grid: Dict[Tuple[int, int], Tile] = {}
        coll = {0: 0, 8: 1}
        for x in range(20):
            grid[(x, 4)] = (0, 0)
            grid[(x, 5)] = (8, 0)
        grid[(10, 4)] = (WHITE_DOOR_ID, 0)

        reach = {(x, 4) for x in range(20)}

        # Bot is at x=6 (left of door). Left stand is x=8, right stand is x=12.
        spot = pick_drop_spot(grid, coll, (10, 4), 20, 10, reach, bx=6, by=4)
        self.assertIsNotNone(spot)
        self.assertEqual(spot.stand, (8, 4))
        self.assertEqual(spot.item_tile, (9, 4))
        self.assertFalse(spot.facing_left)  # faces right toward door

        # Bot is at x=15 (right of door). Closer stand is x=12.
        spot_right = pick_drop_spot(grid, coll, (10, 4), 20, 10, reach, bx=15, by=4)
        self.assertIsNotNone(spot_right)
        self.assertEqual(spot_right.stand, (12, 4))
        self.assertEqual(spot_right.item_tile, (11, 4))
        self.assertTrue(spot_right.facing_left)  # faces left toward door

    def test_pick_drop_spot_skips_blocked_side(self) -> None:
        # Door at (10, 4). Left side has a solid wall at (9, 4).
        grid: Dict[Tuple[int, int], Tile] = {}
        coll = {0: 0, 8: 1}
        for x in range(20):
            grid[(x, 4)] = (0, 0)
            grid[(x, 5)] = (8, 0)
        grid[(10, 4)] = (WHITE_DOOR_ID, 0)
        grid[(9, 4)] = (8, 0)  # Bedrock blocking left drop tile

        reach = {(x, 4) for x in range(20) if x != 9}
        spot = pick_drop_spot(grid, coll, (10, 4), 20, 10, reach, bx=5, by=4)
        self.assertIsNotNone(spot)
        # Even though bot is at x=5, left side is blocked so right side (12, 4) is selected
        self.assertEqual(spot.stand, (12, 4))
        self.assertEqual(spot.item_tile, (11, 4))
        self.assertTrue(spot.facing_left)

    def test_maxed_items_strict_200_seeds_and_blocks(self) -> None:
        amounts = {
            2: 200,   # Dirt: exactly 200 -> drop
            3: 200,   # Dirt Seed: exactly 200 -> drop
            4: 199,   # Lava: < 200 -> keep
            11: 50,   # Rock Seed: < 200 -> keep
            14: 200,  # Cave BG: 200 -> drop
            15: 199,  # Cave BG Seed: < 200 -> keep
        }
        active_ids = set()
        to_drop = maxed_items(amounts, active_ids, threshold=200)
        self.assertEqual(to_drop, [(2, 200), (3, 200), (14, 200)])

    def test_pick_drop_spot_at_door_when_far_spots_blocked(self) -> None:
        # Door at (10, 4). Both dx-2=(8, 4) and dx+2=(12, 4) are blocked by bedrock!
        # But dx-1=(9, 4) is open air.
        grid: Dict[Tuple[int, int], Tile] = {}
        coll = {0: 0, 8: 1}
        for x in range(20):
            grid[(x, 4)] = (0, 0)
            grid[(x, 5)] = (8, 0)
        grid[(10, 4)] = (WHITE_DOOR_ID, 0)
        grid[(8, 4)] = (8, 0)   # Blocked dx - 2
        grid[(12, 4)] = (8, 0)  # Blocked dx + 2

        reach = {(9, 4), (10, 4), (11, 4)}
        # Bot stands at spawn (10, 4)
        spot = pick_drop_spot(grid, coll, (10, 4), 20, 10, reach, bx=10, by=4)
        self.assertIsNotNone(spot)
        # Bot stands right at the door (10, 4) and drops at (9, 4) facing left
        self.assertEqual(spot.stand, (10, 4))
        self.assertEqual(spot.item_tile, (9, 4))
        self.assertTrue(spot.facing_left)



class TestDropTripFlow(unittest.TestCase):
    """Tests for ClearWorldRunner drop trip execution with FakeMoriClient."""

    def test_drop_trip_walks_drops_and_returns(self) -> None:
        # Flat world: row 4 is air with white door at (10, 4), row 5 is solid bedrock
        grid: Dict[Tuple[int, int], Tile] = {}
        for y in range(8):
            for x in range(20):
                grid[(x, y)] = (0, 0)
        for x in range(20):
            grid[(x, 5)] = (8, 0)
        grid[(10, 4)] = (WHITE_DOOR_ID, 0)

        # Bot starts at (15, 4)
        client = FakeMoriClient("TEST", 20, 8, grid, spawn=(10, 4))
        client._pos = (15.0, 4.0)
        client._inventory = {2: 200, 10: 50}

        cfg = BotConfig(
            target_block_ids={2, 4, 10, 14},
            walk_delay_ms=1,
            punch_delay_ms=1,
            drop_threshold=200,
            drop_enabled=True,
            auto_collect=True,
        )
        runner = ClearWorldRunner(client, cfg)
        runner.load_world()

        status = runner.maybe_drop_trip(current_row=4)
        self.assertIsNone(status)  # returned normally on foot

        # Bot should have walked to (12, 4), dropped 200 dirt, and walked back to (15, 4)
        self.assertEqual(client._pos, (15.0, 4.0))
        self.assertEqual(len(client.drops), 1)
        dropped_id, dropped_cnt, drop_pos, drop_facing = client.drops[0]
        self.assertEqual(dropped_id, 2)
        self.assertEqual(dropped_cnt, 200)
        self.assertEqual(drop_pos, (12.0, 4.0))
        self.assertTrue(drop_facing)  # facing left toward (10, 4)
        # Inventory now has 0 dirt
        self.assertEqual(client._inventory.get(2, 0), 0)

    def test_drop_trip_respawns_when_door_unreachable(self) -> None:
        # World where bot is at (18, 4) separated from door (2, 4) by bedrock wall at x=10
        grid: Dict[Tuple[int, int], Tile] = {}
        for y in range(8):
            for x in range(20):
                grid[(x, y)] = (0, 0)
        for x in range(20):
            grid[(x, 5)] = (8, 0)
        grid[(2, 4)] = (WHITE_DOOR_ID, 0)
        for y in range(5):
            grid[(10, y)] = (8, 0)  # bedrock wall separating bot from door

        client = FakeMoriClient("TEST", 20, 8, grid, spawn=(2, 4))
        client._pos = (18.0, 4.0)
        client._inventory = {2: 200}

        cfg = BotConfig(
            target_block_ids={2, 4, 10, 14},
            walk_delay_ms=1,
            punch_delay_ms=1,
            drop_threshold=200,
            drop_enabled=True,
        )
        runner = ClearWorldRunner(client, cfg)
        runner.load_world()

        status = runner.maybe_drop_trip(current_row=4)
        self.assertEqual(status, "respawned")
        # Bot called respawn and dropped at the door
        self.assertGreater(client.respawns, 0)
        self.assertEqual(len(client.drops), 1)
        self.assertEqual(client.drops[0][0], 2)
        self.assertEqual(client.drops[0][1], 200)

    def test_proximity_blacklist_management(self) -> None:
        grid: Dict[Tuple[int, int], Tile] = {(x, 5): (8, 0) for x in range(30)}
        grid[(5, 4)] = (WHITE_DOOR_ID, 0)
        client = FakeMoriClient("TEST", 30, 8, grid, spawn=(5, 4))
        client._pos = (5.0, 4.0)

        cfg = BotConfig(auto_collect=True)
        runner = ClearWorldRunner(client, cfg)
        runner.load_world()

        # Add item 2 to active blacklist
        runner._active_blacklist.add(2)

        # While within 5 tiles of door (pos=(7, 4)), blacklist stays
        client._pos = (7.0, 4.0)
        runner._manage_collect_blacklist()
        self.assertIn(2, runner._active_blacklist)

        # When moving far away (> 5 tiles, pos=(15, 4)), blacklist is cleared
        client._pos = (15.0, 4.0)
        runner._manage_collect_blacklist()
        self.assertEqual(len(runner._active_blacklist), 0)
        self.assertEqual(client.collect_blacklist, [])

    def test_drop_trip_falls_back_to_standard_drop(self) -> None:
        grid: Dict[Tuple[int, int], Tile] = {(x, 5): (8, 0) for x in range(20)}
        grid[(10, 4)] = (WHITE_DOOR_ID, 0)

        class RejectFastDropClient(FakeMoriClient):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.standard_drop_called = False

            def fast_drop(self, item_id: int, count: int) -> None:
                # Do nothing: simulates server ignoring fast_drop without dialog
                pass

            def drop(self, item_id: int, count: int) -> None:
                self.standard_drop_called = True
                super().drop(item_id, count)

        client = RejectFastDropClient("TEST", 20, 8, grid, spawn=(10, 4))
        client._pos = (15.0, 4.0)
        client._inventory = {2: 200}

        cfg = BotConfig(
            target_block_ids={2, 4, 10, 14},
            walk_delay_ms=1,
            punch_delay_ms=1,
            drop_threshold=200,
            drop_enabled=True,
            auto_collect=True,
        )
        runner = ClearWorldRunner(client, cfg)
        runner.load_world()

        status = runner.maybe_drop_trip(current_row=4)
        self.assertIsNone(status)
        self.assertTrue(client.standard_drop_called, "must fall back to standard client.drop()")
        self.assertEqual(client._inventory.get(2, 0), 0)



class TestConfigFlags(unittest.TestCase):
    """Tests for auto_collect and drop CLI configuration flags."""

    def test_default_config_enables_auto_collect(self) -> None:
        parser = argparse.ArgumentParser()
        parser.add_argument("--collect", action="store_true")
        parser.add_argument("--no-collect", action="store_true")
        parser.add_argument("--collect-interval", type=int)
        parser.add_argument("--drop-threshold", type=int)
        parser.add_argument("--no-drop", action="store_true")

        args = parser.parse_args([])
        cfg = BotConfig.from_env_and_args(args)
        self.assertTrue(cfg.auto_collect)
        self.assertEqual(cfg.collect_interval_ms, 150)
        self.assertEqual(cfg.drop_threshold, 200)
        self.assertTrue(cfg.drop_enabled)

    def test_no_collect_flag_disables_auto_collect(self) -> None:
        parser = argparse.ArgumentParser()
        parser.add_argument("--collect", action="store_true")
        parser.add_argument("--no-collect", action="store_true")
        parser.add_argument("--collect-interval", type=int)
        parser.add_argument("--drop-threshold", type=int)
        parser.add_argument("--no-drop", action="store_true")

        args = parser.parse_args(["--no-collect", "--collect-interval", "200", "--drop-threshold", "50", "--no-drop"])
        cfg = BotConfig.from_env_and_args(args)
        self.assertFalse(cfg.auto_collect)
        self.assertEqual(cfg.collect_interval_ms, 200)
        self.assertEqual(cfg.drop_threshold, 50)
        self.assertFalse(cfg.drop_enabled)


if __name__ == "__main__":
    unittest.main()
