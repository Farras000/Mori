"""Unit tests for grounded BFS pathfinding and foothold selection."""

import unittest
from botting.navigator import bfs_grounded_path, pick_stand


class TestNavigator(unittest.TestCase):
    def setUp(self):
        self.coll_map = {
            0: 0,   # Air
            2: 1,   # Dirt
            8: 1,   # Bedrock
            10: 1,  # Rock
        }

    def test_bfs_grounded_connected_path(self):
        # Create a continuous platform:
        # Row 20: Air for x=0..5
        # Row 21: Dirt for x=0..5
        grid = {}
        for x in range(6):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (2, 0)

        path = bfs_grounded_path(grid, self.coll_map, (0, 20), (5, 20), 100, 60)
        self.assertIsNotNone(path)
        self.assertEqual(len(path), 6)
        self.assertEqual(path[0], (0, 20))
        self.assertEqual(path[-1], (5, 20))

    def test_bfs_grounded_chasm_blocks_floating(self):
        # Create two islands separated by a gap of air:
        # Island 1: x=0..2 grounded at y=20 (dirt at y=21)
        # Chasm: x=3 has air at y=21!
        # Island 2: x=4..5 grounded at y=20 (dirt at y=21)
        grid = {}
        for x in [0, 1, 2, 4, 5]:
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (2, 0)
        # Gap at x=3: air below!
        grid[(3, 20)] = (0, 0)
        grid[(3, 21)] = (0, 0)

        # Path from (0, 20) to (5, 20) MUST FAIL because stepping on (3, 20) would be floating in air!
        path = bfs_grounded_path(grid, self.coll_map, (0, 20), (5, 20), 100, 60)
        self.assertIsNone(path, "Bot must never be allowed to pathfind across open air!")

    def test_pick_stand(self):
        # Target block at (10, 20)
        # Standable footholds at (9, 19) and (11, 19) (dirt at row 20)
        grid = {
            (10, 20): (2, 0),  # Target block
            (9, 19): (0, 0),
            (9, 20): (2, 0),   # Ground for (9, 19)
            (11, 19): (0, 0),
            (11, 20): (2, 0),  # Ground for (11, 19)
        }

        # Bot is at (8, 19)
        stand = pick_stand(grid, self.coll_map, 10, 20, 8, 19, 100, 60)
        self.assertIsNotNone(stand)
        self.assertEqual(stand, (9, 19))  # Closest foothold to bot at (8, 19)


if __name__ == "__main__":
    unittest.main()
