"""Unit tests for the pure serpentine sweep planner (botting/sweep.py)."""

import unittest

from botting.sweep import (
    DescentKind,
    StepKind,
    choose_start_column,
    count_targets,
    decide_descent,
    decide_row_step,
    find_top_row,
    is_edge_column,
    is_exposed,
    nearest_edge_column,
    row_target_columns,
)

TARGETS = {2, 4, 10, 14}  # dirt, lava, rock, cave background
STRENGTH = {2: 3, 4: 4, 10: 10, 14: 3}
COLL = {
    0: 0,    # air
    2: 1,    # dirt
    4: 1,    # lava
    6: 0,    # main door
    8: 1,    # bedrock
    10: 1,   # rock
    14: 0,   # cave background
    20: 0,   # sign
    242: 1,  # world lock
}
W, H = 8, 10


def fill(grid, y0, y1, x0=0, x1=None, fg=2, bg=14):
    x1 = W if x1 is None else x1
    for y in range(y0, y1):
        for x in range(x0, x1):
            grid[(x, y)] = (fg, bg)


class TestSweepPlanner(unittest.TestCase):
    def test_find_top_row(self):
        grid = {}
        fill(grid, 4, H)
        self.assertEqual(find_top_row(grid, TARGETS, W, H, STRENGTH, COLL), 4)

        # Bumpy surface: one column starts higher.
        grid[(2, 3)] = (2, 14)
        self.assertEqual(find_top_row(grid, TARGETS, W, H, STRENGTH, COLL), 3)

    def test_find_top_row_none_when_clean(self):
        grid = {}
        fill(grid, 4, H, fg=8, bg=0)  # bedrock everywhere, nothing punchable
        self.assertIsNone(find_top_row(grid, TARGETS, W, H, STRENGTH, COLL))

    def test_choose_start_column(self):
        grid = {}
        fill(grid, 4, H)
        grid[(0, 4)] = (0, 0)   # leftmost column already clear
        grid[(W - 1, 4)] = (0, 0)

        self.assertEqual(choose_start_column(grid, TARGETS, W, 4, STRENGTH, COLL, "left"), 1)
        self.assertEqual(choose_start_column(grid, TARGETS, W, 4, STRENGTH, COLL, "right"), W - 2)

    def test_row_step_punch_dirt_and_bg(self):
        grid = {}
        fill(grid, 4, H)
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.PUNCH_THEN_WALK)
        self.assertEqual((dec.tx, dec.ty), (4, 4))
        self.assertEqual(dec.hits, 3 + 3)  # dirt (3) + cave background (3)
        self.assertFalse(dec.needs_settle)

    def test_row_step_punch_bg_only(self):
        grid = {(4, 4): (0, 14), (4, 5): (2, 14)}
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.PUNCH_THEN_WALK)
        self.assertEqual(dec.hits, 3)
        self.assertFalse(dec.needs_settle)

    def test_row_step_walk_when_clear(self):
        grid = {(4, 4): (0, 0), (4, 5): (2, 14)}
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.WALK)
        self.assertFalse(dec.needs_settle)

    def test_row_step_walk_and_fall_when_unsupported(self):
        grid = {(4, 4): (0, 0), (4, 5): (0, 0)}
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.WALK)
        self.assertTrue(dec.needs_settle)

    def test_row_step_bedrock_is_never_punched(self):
        grid = {}
        fill(grid, 4, H)
        grid[(4, 4)] = (8, 0)   # bedrock column ahead
        grid[(4, 3)] = (0, 0)   # air above it -> bypass possible

        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.BYPASS_OVER)
        self.assertTrue(dec.reason.startswith("fg_protected"))

    def test_row_step_tall_obstacle_skips(self):
        grid = {}
        fill(grid, 4, H)
        grid[(4, 4)] = (8, 0)
        grid[(4, 3)] = (8, 0)  # 2-tile tall bedrock -> cannot step over

        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.SKIP)

    def test_row_step_world_lock_is_never_punched(self):
        grid = {}
        fill(grid, 4, H)
        grid[(4, 4)] = (242, 14)  # world lock with cave bg behind it
        grid[(4, 3)] = (0, 0)

        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIsNot(dec.kind, StepKind.PUNCH_THEN_WALK)
        self.assertIsNot(dec.kind, StepKind.WALK)
        self.assertTrue(dec.reason.startswith("fg_protected"))

    def test_row_step_sign_walks_through(self):
        grid = {(4, 4): (20, 0), (4, 5): (2, 14)}
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4, +1)
        self.assertIs(dec.kind, StepKind.WALK)  # passable, never punched

    def test_row_step_world_edge(self):
        dec = decide_row_step({}, COLL, TARGETS, STRENGTH, W, H, W - 1, 4, +1)
        self.assertIs(dec.kind, StepKind.SKIP)
        self.assertEqual(dec.reason, "world_edge")

    def test_descent_dig(self):
        grid = {(3, 5): (2, 14), (3, 6): (2, 14)}
        dec = decide_descent(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4)
        self.assertIs(dec.kind, DescentKind.DIG)
        self.assertEqual(dec.hits, 6)

    def test_descent_step_down_supported(self):
        grid = {(3, 5): (0, 0), (3, 6): (2, 14)}
        dec = decide_descent(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4)
        self.assertIs(dec.kind, DescentKind.STEP_DOWN)
        self.assertFalse(dec.needs_settle)

    def test_descent_falls_when_unsupported(self):
        grid = {(3, 5): (0, 0), (3, 6): (0, 0)}
        dec = decide_descent(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4)
        self.assertIs(dec.kind, DescentKind.STEP_DOWN)
        self.assertTrue(dec.needs_settle)

    def test_descent_blocked_by_bedrock(self):
        grid = {(3, 5): (8, 0)}
        dec = decide_descent(grid, COLL, TARGETS, STRENGTH, W, H, 3, 4)
        self.assertIs(dec.kind, DescentKind.BLOCKED)

    def test_descent_bottom_of_world(self):
        dec = decide_descent({}, COLL, TARGETS, STRENGTH, W, H, 3, H - 1)
        self.assertIs(dec.kind, DescentKind.BOTTOM)

    def test_flat_fill_serpentine_model(self):
        """Models a full row sweep: punch every column, then dig down at the edge."""
        grid = {}
        fill(grid, 4, H)

        x = 0
        cleared = 0
        while True:
            dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, x, 4, +1)
            if dec.kind is StepKind.SKIP:
                break
            self.assertIs(dec.kind, StepKind.PUNCH_THEN_WALK)
            grid[(x + 1, 4)] = (0, 0)  # punched clear
            cleared += 1
            x += 1

        self.assertEqual(cleared, W - 1)
        self.assertEqual(x, W - 1)

        dec = decide_descent(grid, COLL, TARGETS, STRENGTH, W, H, x, 4)
        self.assertIs(dec.kind, DescentKind.DIG)

        # Digging clears (x, 5); the next row sweep starts there, going left.
        grid[(x, 5)] = (0, 0)
        dec = decide_row_step(grid, COLL, TARGETS, STRENGTH, W, H, x, 5, -1)
        self.assertIs(dec.kind, StepKind.PUNCH_THEN_WALK)
        self.assertEqual(dec.tx, x - 1)

    def test_edge_columns(self):
        self.assertTrue(is_edge_column(0, W))
        self.assertTrue(is_edge_column(W - 1, W))
        self.assertFalse(is_edge_column(1, W))
        self.assertFalse(is_edge_column(W - 2, W))

    def test_nearest_edge_column(self):
        self.assertEqual(nearest_edge_column(0, W), 0)
        self.assertEqual(nearest_edge_column(1, W), 0)
        self.assertEqual(nearest_edge_column(W // 2 - 1, W), 0)
        self.assertEqual(nearest_edge_column(W - 2, W), W - 1)
        self.assertEqual(nearest_edge_column(W - 1, W), W - 1)

    def test_is_exposed_requires_nothing_clearable_above(self):
        grid = {}
        fill(grid, 4, 6)

        self.assertTrue(is_exposed(grid, COLL, TARGETS, STRENGTH, 3, 4, H))
        self.assertFalse(is_exposed(grid, COLL, TARGETS, STRENGTH, 3, 5, H))
        # No work at all -> not a cleanup candidate.
        self.assertFalse(is_exposed(grid, COLL, TARGETS, STRENGTH, 3, 3, H))

        # A protected block above (bedrock) is never punchable, so it does not
        # hold the target below it back from the cleanup pass.
        grid2 = {(5, 4): (2, 14), (5, 3): (8, 0)}
        self.assertTrue(is_exposed(grid2, COLL, TARGETS, STRENGTH, 5, 4, H))

        # Once the top tile is cleared the one below becomes exposed.
        grid3 = {(5, 3): (0, 0), (5, 4): (2, 14)}
        self.assertTrue(is_exposed(grid3, COLL, TARGETS, STRENGTH, 5, 4, H))

    def test_count_targets_and_row_columns(self):
        grid = {}
        fill(grid, 4, 6)
        self.assertEqual(count_targets(grid, TARGETS, W, H, STRENGTH, COLL), 2 * W)
        self.assertEqual(row_target_columns(grid, TARGETS, W, 4, STRENGTH, COLL), list(range(W)))

        grid[(0, 4)] = (0, 0)
        self.assertEqual(count_targets(grid, TARGETS, W, H, STRENGTH, COLL), 2 * W - 1)
        self.assertEqual(row_target_columns(grid, TARGETS, W, 4, STRENGTH, COLL), list(range(1, W)))


if __name__ == "__main__":
    unittest.main()
