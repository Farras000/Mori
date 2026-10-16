"""Unit tests for grounded BFS pathfinding, move-graph routing and foothold selection."""

import unittest
from botting.navigator import (
    bfs_grounded_path,
    bfs_move_path,
    fall_landing,
    move_reach,
    pick_stand,
    run_horizontal,
    settle,
    walk_grounded,
)
from botting.tests.fake_mori import FakeMoriClient


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

    # ── move graph (walk / fall / climb) ──────────────────────────────────────

    def build_pit_grid(self):
        """Top layer (row 21) with a live-RUKOALICANTE-shaped pit at x=3..5:
        1-deep shoulders at x=3 and x=5, 2-deep middle at x=4.
        """
        grid = {}
        for x in range(7):
            for y in range(21, 24):
                grid[(x, y)] = (2, 0)
            grid[(x, 20)] = (0, 0)
        grid[(3, 21)] = (0, 0)
        grid[(5, 21)] = (0, 0)
        grid[(4, 21)] = (0, 0)
        grid[(4, 22)] = (0, 0)
        return grid

    def test_move_bfs_crosses_pit_where_grounded_bfs_cannot(self):
        grid = self.build_pit_grid()

        # Plain walking can never cross: the (3,20) step has no floor.
        self.assertIsNone(
            bfs_grounded_path(grid, self.coll_map, (2, 20), (6, 20), 100, 60)
        )

        path = bfs_move_path(grid, self.coll_map, (2, 20), (6, 20), 100, 60)
        self.assertIsNotNone(path, "the pit must be crossable with fall + climb")
        # Drop into the 1-deep shoulder, fall again into the 2-deep middle,
        # then climb back out shoulder by shoulder — exactly the live shape.
        self.assertEqual(
            path, [(2, 20), (3, 21), (4, 22), (5, 21), (6, 20)]
        )

    def test_fall_landing_scans_down_the_column(self):
        grid = self.build_pit_grid()
        self.assertEqual(fall_landing(grid, self.coll_map, 4, 20, 100, 60), (4, 22))
        self.assertEqual(fall_landing(grid, self.coll_map, 5, 20, 100, 60), (5, 21))
        # Solid ground: the tile itself is standable.
        self.assertEqual(fall_landing(grid, self.coll_map, 0, 20, 100, 60), (0, 20))

    def test_move_bfs_climbs_a_one_tile_ledge(self):
        grid = {}
        for x in range(5):
            grid[(x, 22)] = (2, 0)
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (0, 0)
        grid[(2, 21)] = (2, 0)  # 1-tile-high ledge: its top row is 20
        grid[(3, 21)] = (2, 0)

        # (2, 20) is a foothold on the ledge but not orthogonally adjacent to
        # (1, 21): only the vanilla auto-step up can make the connection.
        self.assertIsNone(bfs_grounded_path(grid, self.coll_map, (1, 21), (2, 20), 100, 60))
        self.assertEqual(
            bfs_move_path(grid, self.coll_map, (1, 21), (2, 20), 100, 60),
            [(1, 21), (2, 20)],
        )

    def test_move_reach_uses_falls_and_climbs(self):
        grid = self.build_pit_grid()
        fake = FakeMoriClient("TESTWORLD", 7, 25, grid, spawn=(1, 20))
        reach = move_reach(fake, fake.coll_map, 7, 25)
        # Walk left along the top row, and reach the pit floor via fall+climb.
        self.assertIn((0, 20), reach)
        self.assertIn((2, 20), reach)
        self.assertIn((4, 22), reach)
        self.assertIn((6, 20), reach)

    def test_run_horizontal_smooth_stride(self):
        # Continuous platform at y=20 with dirt at y=21
        grid = {}
        for x in range(10):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (2, 0)
        fake = FakeMoriClient("TESTWORLD", 10, 25, grid, spawn=(0, 20))

        # Run 5 tiles to the right in a single continuous stride
        ok = run_horizontal(fake, (0, 20), (5, 20), self.coll_map, 10, 25, walk_ms=1)
        self.assertTrue(ok)
        self.assertEqual(fake.pos_tile(), (5, 20))
        self.assertEqual(fake.violations, [], "must not violate any movement rules during horizontal run")

    def test_run_horizontal_refuses_chasm(self):
        # Gap at x=3: air below
        grid = {}
        for x in [0, 1, 2, 4, 5]:
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (2, 0)
        grid[(3, 20)] = (0, 0)
        grid[(3, 21)] = (0, 0)
        fake = FakeMoriClient("TESTWORLD", 10, 25, grid, spawn=(0, 20))

        # Run across chasm must refuse
        ok = run_horizontal(fake, (0, 20), (5, 20), self.coll_map, 10, 25, walk_ms=1)
        self.assertFalse(ok)
        self.assertEqual(fake.pos_tile(), (0, 20), "bot must not have moved into the chasm")

    def test_move_bfs_refuses_climb_when_ceiling_blocks_headroom(self):
        # Bot at (1, 21), 1-tile ledge at (2, 21) so target foothold is (2, 20).
        # Put solid bedrock directly above the bot at (1, 20): diagonal climb
        # from (1, 21) to (2, 20) must be blocked by the ceiling.
        grid = {}
        for x in range(5):
            grid[(x, 22)] = (2, 0)
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (0, 0)
        grid[(2, 21)] = (2, 0)
        grid[(3, 21)] = (2, 0)
        grid[(1, 20)] = (8, 0)  # solid ceiling above (1, 21)

        self.assertIsNone(
            bfs_move_path(grid, self.coll_map, (1, 21), (2, 20), 100, 60),
            "must not climb diagonally through a solid ceiling directly overhead",
        )

    def test_settle_drops_directly_through_open_air(self):
        # 10 layers of open air from y=5 to y=14.
        # Bedrock at y=16, so standable foothold is (5, 15).
        grid = {}
        for y in range(5, 16):
            grid[(5, y)] = (0, 0)
        grid[(5, 16)] = (8, 0)  # Solid bedrock floor below y=15

        fake = FakeMoriClient("TESTWORLD", 10, 25, grid, spawn=(5, 5))
        # Bot starts floating at (5, 5)
        ok = settle(fake, self.coll_map, 25, walk_ms=1)
        self.assertTrue(ok)
        self.assertEqual(fake.pos_tile(), (5, 15), "bot must land on solid foothold (5, 15)")
        self.assertEqual(fake.violations, [], "must not violate rules during gravity fall")
        # Every step in walks must be strictly single-tile (no teleports)
        expected_steps = [(5, y) for y in range(6, 16)]
        self.assertTrue(all(step in fake.walks for step in expected_steps), "must visit each tile during descent")

    def test_fake_mori_catches_multi_tile_teleport(self):
        grid = {(5, 5): (0, 0), (5, 10): (0, 0)}
        fake = FakeMoriClient("TESTWORLD", 10, 25, grid, spawn=(5, 5))
        fake.walk_to(5, 10)  # Multi-tile jump down
        self.assertIn("teleport_walk (5,5)->(5,10)", fake.violations)



if __name__ == "__main__":
    unittest.main()
