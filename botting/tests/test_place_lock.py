"""Unit tests for PlaceLockRunner against FakeMoriClient."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from botting.config import BotConfig
from botting.place_lock import PlaceLockRunner, find_white_door
from botting.tests.fake_mori import FakeMoriClient

WHITE_DOOR = 6
WORLD_LOCK = 242
DIRT = 2


class TestPlaceLock(unittest.TestCase):
    def setUp(self):
        # Default test platform: y=20 has white door at (5, 20), dirt ground at y=21
        self.grid = {}
        for x in range(10):
            self.grid[(x, 20)] = (0, 0)
            self.grid[(x, 21)] = (DIRT, 0)
        self.grid[(5, 20)] = (WHITE_DOOR, 0)

    def test_find_white_door(self):
        door = find_white_door(self.grid)
        self.assertEqual(door, (5, 20))

    def test_find_white_door_none(self):
        door = find_white_door({(0, 0): (2, 0)})
        self.assertIsNone(door)

    def test_place_lock_success(self):
        fake = FakeMoriClient("TESTWORLD", 10, 25, self.grid, spawn=(0, 20))
        fake._inventory_items = {WORLD_LOCK: 1}

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = PlaceLockRunner(fake, cfg, lock_id=WORLD_LOCK)

        rc = runner.run()
        self.assertEqual(rc, 0)
        self.assertEqual(fake.tile(5, 19), (WORLD_LOCK, 0), "World lock must be placed at (5, 19)")
        self.assertEqual(fake.violations, [], "must not violate any movement or placement rules")

    def test_place_lock_already_placed(self):
        # Target tile (5, 19) already has a world lock
        self.grid[(5, 19)] = (WORLD_LOCK, 0)
        fake = FakeMoriClient("TESTWORLD", 10, 25, self.grid, spawn=(0, 20))
        fake._inventory_items = {WORLD_LOCK: 1}

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = PlaceLockRunner(fake, cfg, lock_id=WORLD_LOCK)

        rc = runner.run()
        self.assertEqual(rc, 0, "Already placed lock should exit with success")
        self.assertEqual(fake.tile(5, 19), (WORLD_LOCK, 0))

    def test_place_lock_clears_dirt_obstacle_above_door(self):
        # (5, 19) is occupied by a dirt block
        self.grid[(5, 19)] = (DIRT, 0)
        fake = FakeMoriClient("TESTWORLD", 10, 25, self.grid, spawn=(0, 20))
        fake._inventory_items = {WORLD_LOCK: 1}

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = PlaceLockRunner(fake, cfg, lock_id=WORLD_LOCK)

        rc = runner.run()
        self.assertEqual(rc, 0)
        self.assertEqual(fake.tile(5, 19), (WORLD_LOCK, 0), "Dirt was cleared and lock placed")
        self.assertEqual(fake.violations, [])

    def test_place_lock_no_lock_in_inventory(self):
        fake = FakeMoriClient("TESTWORLD", 10, 25, self.grid, spawn=(0, 20))
        fake._inventory_items = {2: 100}  # Dirt only, no world lock

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = PlaceLockRunner(fake, cfg, lock_id=WORLD_LOCK)

        rc = runner.run()
        self.assertEqual(rc, 1, "Must exit with error if no lock in inventory")
        self.assertEqual(fake.tile(5, 19), (0, 0))

    def test_place_lock_no_white_door_found(self):
        # Grid without white door
        grid = {(x, 21): (DIRT, 0) for x in range(10)}
        fake = FakeMoriClient("TESTWORLD", 10, 25, grid, spawn=(0, 20))
        fake._inventory_items = {WORLD_LOCK: 1}

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = PlaceLockRunner(fake, cfg, lock_id=WORLD_LOCK)

        rc = runner.run()
        self.assertEqual(rc, 1, "Must exit with error if no white door found")


if __name__ == "__main__":
    unittest.main()
