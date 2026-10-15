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

        # Diagonal adjacent: dx=1, dy=1 (diag=2 <= 4)
        self.assertTrue(is_within_punch_range(1, 1))

        # Max range 3 tiles horizontally/vertically
        self.assertTrue(is_within_punch_range(3, 0))
        self.assertTrue(is_within_punch_range(0, 3))
        self.assertTrue(is_within_punch_range(2, 2))  # diag=4 <= 4

        # Impossible range > 3 or diag > 4 (would trigger server anomaly detection)
        self.assertFalse(is_within_punch_range(4, 0))
        self.assertFalse(is_within_punch_range(0, 4))
        self.assertFalse(is_within_punch_range(3, 2))  # diag=5 > 4
        self.assertFalse(is_within_punch_range(3, 3))  # diag=6 > 4

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


if __name__ == "__main__":
    unittest.main()
