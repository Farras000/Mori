"""Unit tests for botting physics validation and obstacle protection."""

import unittest
from botting.config import DEFAULT_TARGET_BLOCKS, LOCK_IDS, PROTECTED_FG_IDS
from botting.physics import (
    is_solid_support,
    is_standable_grid,
    is_target_block,
    is_tile_passable,
    is_unbreakable_obstacle,
    is_within_punch_range,
    plan_punch,
    relative_offset,
)


class TestPhysics(unittest.TestCase):
    def setUp(self):
        # Collision map: 0=air, 1=solid, 2=platform
        self.coll_map = {
            0: 0,
            2: 1,    # Dirt
            4: 1,    # Lava
            6: 0,    # Door
            8: 1,    # Bedrock
            10: 1,   # Rock
            14: 0,   # Cave BG
            242: 1,  # World Lock
        }

    def test_solid_support(self):
        # Air (0) and Main Door (6) must NEVER provide solid ground support
        self.assertFalse(is_solid_support(0, self.coll_map))
        self.assertFalse(is_solid_support(6, self.coll_map))

        # Dirt (2), Rock (10), Bedrock (8), and World Lock (242) provide solid support
        self.assertTrue(is_solid_support(2, self.coll_map))
        self.assertTrue(is_solid_support(10, self.coll_map))
        self.assertTrue(is_solid_support(8, self.coll_map))
        self.assertTrue(is_solid_support(242, self.coll_map))

    def test_tile_passable(self):
        # Air and door are passable
        self.assertTrue(is_tile_passable(0, self.coll_map))
        self.assertTrue(is_tile_passable(6, self.coll_map))

        # Solid blocks are not passable (bot cannot occupy same tile)
        self.assertFalse(is_tile_passable(2, self.coll_map))
        self.assertFalse(is_tile_passable(8, self.coll_map))

    def test_anti_float_foothold(self):
        # Create a small grid:
        # Row 10: Air at (5, 10)
        # Row 11: Dirt at (5, 11) -> (5, 10) should be standable!
        grid = {
            (5, 10): (0, 0),
            (5, 11): (2, 0),
        }
        self.assertTrue(is_standable_grid(grid, self.coll_map, 5, 10, 100, 60))

        # Mid-air floating tile:
        # Row 5: Air at (5, 5)
        # Row 6: Air at (5, 6) -> (5, 5) must NOT be standable (floating in air!)
        grid_floating = {
            (5, 5): (0, 0),
            (5, 6): (0, 0),
        }
        self.assertFalse(is_standable_grid(grid_floating, self.coll_map, 5, 5, 100, 60))

        # Bottom of the world (Y=59) is grounded
        grid_bottom = {
            (5, 59): (0, 0),
        }
        self.assertTrue(is_standable_grid(grid_bottom, self.coll_map, 5, 59, 100, 60))

    def test_punch_range(self):
        # Direct adjacent: range 1
        self.assertTrue(is_within_punch_range(1, 0))
        self.assertTrue(is_within_punch_range(0, 1))
        self.assertTrue(is_within_punch_range(-1, 0))
        self.assertTrue(is_within_punch_range(0, -1))

        # Diagonal adjacent: dx=1, dy=1 (diag=2 <= 3)
        self.assertTrue(is_within_punch_range(1, 1))

        # Max vanilla range: 2 tiles horizontally/vertically (diag <= 3)
        self.assertTrue(is_within_punch_range(2, 0))
        self.assertTrue(is_within_punch_range(0, 2))
        self.assertTrue(is_within_punch_range(2, 1))

        # Vanilla illegal reach (> 2 tiles or corner diag > 3)
        self.assertFalse(is_within_punch_range(3, 0))
        self.assertFalse(is_within_punch_range(0, 3))
        self.assertFalse(is_within_punch_range(2, 2))

        # Extended range allowed when explicit parameters given (e.g. Rayman)
        self.assertTrue(is_within_punch_range(3, 0, max_range=3, max_diag=4))
        self.assertTrue(is_within_punch_range(0, 3, max_range=3, max_diag=4))
        self.assertTrue(is_within_punch_range(2, 2, max_range=3, max_diag=4))

        # Impossible range > 3 or diag > 4 (would trigger server anomaly detection)
        self.assertFalse(is_within_punch_range(4, 0, max_range=3, max_diag=4))
        self.assertFalse(is_within_punch_range(0, 4, max_range=3, max_diag=4))

        # Standing in exact same tile: rejected
        self.assertFalse(is_within_punch_range(0, 0))

    def test_obstacle_protection(self):
        # Bedrock (8), World Lock (242), and Door (6) must be protected
        self.assertTrue(is_unbreakable_obstacle(8, PROTECTED_FG_IDS))
        self.assertTrue(is_unbreakable_obstacle(242, PROTECTED_FG_IDS))
        self.assertTrue(is_unbreakable_obstacle(6, PROTECTED_FG_IDS))

        # Normal target blocks are not protected
        self.assertFalse(is_unbreakable_obstacle(2, PROTECTED_FG_IDS))
        self.assertFalse(is_unbreakable_obstacle(4, PROTECTED_FG_IDS))
        self.assertFalse(is_unbreakable_obstacle(10, PROTECTED_FG_IDS))

    def test_target_block_detection(self):
        # Foreground dirt
        self.assertTrue(is_target_block((2, 0), DEFAULT_TARGET_BLOCKS))
        # Foreground rock
        self.assertTrue(is_target_block((10, 0), DEFAULT_TARGET_BLOCKS))
        # Background cave bg
        self.assertTrue(is_target_block((0, 14), DEFAULT_TARGET_BLOCKS))

        # World lock or Bedrock is NOT a target block
        self.assertFalse(is_target_block((242, 0), DEFAULT_TARGET_BLOCKS))
        self.assertFalse(is_target_block((8, 0), DEFAULT_TARGET_BLOCKS))


class TestPunchPlanning(unittest.TestCase):
    """Whitelist punch rules: only dirt/lava/rock/cave-bg are ever punched."""

    strength = {2: 3, 4: 4, 10: 10, 14: 3}

    def test_dirt_and_bg_hits(self):
        plan = plan_punch(2, 14, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertTrue(plan.allowed)
        self.assertEqual(plan.hits, 6)  # dirt 3 + cave bg 3

    def test_bg_only_hits(self):
        plan = plan_punch(0, 14, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertTrue(plan.allowed)
        self.assertEqual(plan.hits, 3)

    def test_rock_hits(self):
        plan = plan_punch(10, 0, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertTrue(plan.allowed)
        self.assertEqual(plan.hits, 10)

    def test_world_lock_never_punched(self):
        plan = plan_punch(242, 14, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertFalse(plan.allowed)
        self.assertFalse(plan.has_work)
        self.assertTrue(plan.reason.startswith("fg_protected"))

    def test_bedrock_never_punched(self):
        plan = plan_punch(8, 14, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertFalse(plan.allowed)

    def test_sign_never_punched(self):
        plan = plan_punch(20, 14, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertFalse(plan.allowed)
        self.assertTrue(plan.reason.startswith("fg_protected"))

    def test_clear_tile_has_no_work(self):
        plan = plan_punch(0, 0, DEFAULT_TARGET_BLOCKS, self.strength)
        self.assertFalse(plan.allowed)
        self.assertEqual(plan.hits, 0)
        self.assertEqual(plan.reason, "no_target")

    def test_default_strength_fallback(self):
        plan = plan_punch(2, 14, DEFAULT_TARGET_BLOCKS, strength_map={})
        self.assertEqual(plan.hits, 6)  # falls back to DEFAULT_STRENGTH (3 + 3)


if __name__ == "__main__":
    unittest.main()
