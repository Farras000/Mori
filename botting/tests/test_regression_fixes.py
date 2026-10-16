"""Regression tests for the clear-world fixes (walk animation, layer gate, resume).

- Layer gate: a fresh reachable leftover on the sweep row (or any row above)
  refuses the edge descent with "row_busy"; tiles the sweep already judged
  impassable (in ``runner.blocked``) stay stranded and do NOT block it.
- Resume: after a stuck/disconnect the sweep restarts at the topmost row that
  still holds targets, never at the old depth.
- Walk animation: every horizontal step sets facing first (no sideways glide).
"""

from __future__ import annotations

import unittest

from botting import navigator as nav
from botting import sweep
from botting.clear_world import ClearWorldRunner
from botting.config import BotConfig
from botting.tests.fake_mori import FakeMoriClient

DIRT, CAVE_BG, BEDROCK = 2, 14, 8


def make_runner(width, height, grid, spawn):
    fake = FakeMoriClient("TESTWORLD", width, height, grid, spawn=spawn)
    cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
    runner = ClearWorldRunner(fake, cfg)
    assert runner.load_world(), "load_world failed in test setup"
    return fake, runner


class RecordingFake(FakeMoriClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.facings = []

    def set_direction(self, facing_left: bool) -> None:
        self.facings.append(bool(facing_left))


class LayerGateTests(unittest.TestCase):
    def test_fresh_reachable_leftover_blocks_descent(self):
        # Row 4 almost clear: only (5,4) dirt left. Row 5 full dirt (floor).
        # Bot stands on the left edge (0,4). y=0 is the top.
        width, height = 10, 9
        grid = {}
        for x in range(width):
            grid[(x, 5)] = (DIRT, CAVE_BG)
            grid[(x, 6)] = (DIRT, CAVE_BG)
        for x in range(width):
            grid[(x, 7)] = (BEDROCK, 0)
        grid[(5, 4)] = (DIRT, CAVE_BG)
        fake, runner = make_runner(width, height, grid, spawn=(0, 4))

        complete, reachable = runner.verify_row_complete(4)
        self.assertFalse(complete, "fresh leftover must keep the bot on this layer")
        self.assertIn((5, 4), reachable)

        d = runner.descend_to_next_row()
        self.assertEqual(d, "row_busy")

    def test_stranded_tiles_do_not_block_descent(self):
        width, height = 10, 9
        grid = {}
        for x in range(width):
            grid[(x, 5)] = (DIRT, CAVE_BG)
            grid[(x, 6)] = (DIRT, CAVE_BG)
        for x in range(width):
            grid[(x, 7)] = (BEDROCK, 0)
        grid[(5, 4)] = (DIRT, CAVE_BG)
        fake, runner = make_runner(width, height, grid, spawn=(0, 4))

        # Simulate the sweep's ruling: this column was attempted and judged
        # impassable (e.g. behind a tall pillar) -> stranded, finished from below.
        runner.blocked[(5, 4)] = "blocked ahead"
        complete, _ = runner.verify_row_complete(4)
        self.assertTrue(complete, "stranded tiles must not pin the bot")

    def test_upper_layer_leftover_blocks_descent(self):
        # Current row 5 is fully clear, but row 4 (above) still has a fresh
        # reachable target: descending from row 5 must be refused.
        width, height = 10, 9
        grid = {}
        for x in range(width):
            grid[(x, 5)] = (0, 0)
            grid[(x, 6)] = (DIRT, CAVE_BG)
        for x in range(width):
            grid[(x, 7)] = (BEDROCK, 0)
        grid[(5, 4)] = (DIRT, CAVE_BG)
        # Standable row-5: body air, support is row-6 dirt.
        fake, runner = make_runner(width, height, grid, spawn=(0, 5))

        complete, reachable = runner.verify_layers_complete(5)
        self.assertFalse(complete)
        self.assertIn((5, 4), reachable)


class ResumeTests(unittest.TestCase):
    def test_resume_restarts_at_topmost_row(self):
        width, height = 10, 9
        grid = {}
        for y in (4, 5, 6):
            for x in range(width):
                grid[(x, y)] = (DIRT, CAVE_BG)
        for x in range(width):
            grid[(x, 7)] = (BEDROCK, 0)
        fake, runner = make_runner(width, height, grid, spawn=(4, 3))

        resumed = runner.resume_sweep(old_row=6)
        self.assertIsNotNone(resumed, "resume must re-enter when work remains")
        row, _direction = resumed
        self.assertEqual(row, 4, "resume must restart at the topmost remaining row (y=0 is top)")


class WalkAnimationTests(unittest.TestCase):
    def _air_world(self, spawn):
        grid = {}
        for x in range(6):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (DIRT, 0)
        fake = RecordingFake("TESTWORLD", 6, 25, grid, spawn=spawn)
        return fake

    def test_step_one_sets_facing_right(self):
        fake = self._air_world(spawn=(1, 20))
        coll = fake.coll_map
        self.assertTrue(nav.step_one(fake, (1, 20), (2, 20), walk_ms=1))
        self.assertIn(False, fake.facings, "moving right must face right (facing_left=False)")

    def test_step_one_sets_facing_left(self):
        fake = self._air_world(spawn=(2, 20))
        self.assertTrue(nav.step_one(fake, (2, 20), (1, 20), walk_ms=1))
        self.assertIn(True, fake.facings, "moving left must face left (facing_left=True)")


class AntiFloatTests(unittest.TestCase):
    def test_advance_settles_before_stepping_instead_of_floating(self):
        # Bot spawns floating at (2,20): support (2,21) is air, floor at y=22.
        # The step to (3,20) (solid floor at (3,21)) must settle first, then
        # route — never glide sideways on air.
        grid = {}
        for x in range(6):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (DIRT, 0)
            grid[(x, 22)] = (DIRT, 0)
        grid[(2, 21)] = (0, 0)  # hole under the bot -> floating
        fake, runner = make_runner(6, 25, grid, spawn=(2, 20))

        self.assertTrue(runner.advance_to(3, 20))
        self.assertEqual(fake.violations, [])
        pos = fake.pos_tile()
        self.assertIsNotNone(pos)
        self.assertTrue(
            runner._grounded_live(pos[0], pos[1]),
            f"bot must end grounded, ended at {pos}",
        )

    def test_walk_refuses_stale_snapshot_solid(self):
        # Snapshot claims row 20 is clear air; live it holds solid dirt at
        # (3,20). The walker must stop instead of stepping into the wall.
        grid = {}
        for x in range(7):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (DIRT, 0)
        grid[(3, 20)] = (DIRT, 0)  # live wall

        class StaleFake(FakeMoriClient):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.stale = dict(self._grid)
                for x in range(7):
                    self.stale[(x, 20)] = (0, 0)  # stale: row looks clear

            def grid_snapshot(self):
                return dict(self.stale)

        fake = StaleFake("TESTWORLD", 7, 25, grid, spawn=(1, 20))
        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = ClearWorldRunner(fake, cfg)
        assert runner.load_world()

        self.assertFalse(runner.walk_grounded_to((4, 20)))
        self.assertEqual(fake.violations, [], "must not step into the live wall")
        self.assertNotEqual(fake.pos_tile(), (3, 20), "must never enter the solid tile")

    def test_gap_ahead_steps_in_and_drops(self):
        # Bot grounded at (2,20); ahead (3,20) is air with no floor (pit down
        # to dirt at y=22). The step must drop into the pit and end grounded
        # — never glide over it.
        grid = {}
        for x in range(6):
            grid[(x, 20)] = (0, 0)
            grid[(x, 21)] = (DIRT, 0)
            grid[(x, 22)] = (DIRT, 0)
        grid[(3, 20)] = (0, 0)
        grid[(3, 21)] = (0, 0)  # blank below -> pit
        fake, runner = make_runner(6, 25, grid, spawn=(2, 20))

        self.assertTrue(runner.advance_to(3, 20))
        self.assertEqual(fake.violations, [])
        pos = fake.pos_tile()
        self.assertIsNotNone(pos)
        self.assertTrue(
            runner._grounded_live(pos[0], pos[1]),
            f"bot must end grounded, ended at {pos}",
        )
        self.assertGreaterEqual(pos[1], 20)

    def test_approach_refuses_floating_goal(self):
        # Goal (0,4) has no floor ((0,5) is air): the edge approach must
        # refuse instead of gliding across the sky to it.
        width, height = 10, 9
        grid = {}
        for y in (5, 6):
            for x in range(width):
                grid[(x, y)] = (DIRT, CAVE_BG)
        for x in range(width):
            grid[(x, 7)] = (BEDROCK, 0)
        grid[(0, 5)] = (0, 0)  # no floor under the goal
        fake, runner = make_runner(width, height, grid, spawn=(5, 3))

        # goal is (0,4): support (0,5) is air -> refused. A floored neighbour
        # column is accepted instead.
        self.assertFalse(runner.approach_surface(0, 5))
        self.assertTrue(runner.approach_surface(1, 5))


class OscillationTests(unittest.TestCase):
    def test_detect_oscillation_two_tile_cycle(self):
        hist = [(66, 23), (67, 23)] * 3
        self.assertTrue(sweep.detect_oscillation(hist, 10, 10))

    def test_no_oscillation_when_progress(self):
        hist = [(66, 23), (67, 23)] * 3
        self.assertFalse(sweep.detect_oscillation(hist, 10, 11))

    def test_no_oscillation_when_moving(self):
        hist = [(60, 23), (61, 23), (62, 23), (63, 23), (64, 23), (65, 23)]
        self.assertFalse(sweep.detect_oscillation(hist, 10, 10))

    def test_no_oscillation_short_history(self):
        self.assertFalse(sweep.detect_oscillation([(66, 23), (67, 23)], 10, 10))


class CleanupBehaviorTests(unittest.TestCase):
    def _row_world(self, width=20):
        grid = {(x, 4): (DIRT, CAVE_BG) for x in range(width)}
        for x in range(width):
            grid[(x, 5)] = (8, 0)  # bedrock floor
        return grid

    def _punch_order(self, fake):
        first_idx: dict = {}
        for i, (bx, by, tx, ty, fg, bg) in enumerate(fake.punches):
            if ty == 4:
                first_idx.setdefault(tx, i)
        return [x for x in sorted(first_idx, key=lambda x: first_idx[x])]

    def test_cleanup_follows_sweep_direction(self):
        # Two runs over the same row: last_direction=-1 must clear x
        # descending, +1 ascending — no Manhattan ping-pong.
        for direction, expected in ((1, list(range(20))), (-1, list(range(19, -1, -1)))):
            grid = self._row_world()
            fake, runner = make_runner(20, 9, grid, spawn=(10, 3))
            runner.last_direction = direction
            runner.cleanup()
            self.assertEqual(fake.violations, [])
            self.assertEqual(
                self._punch_order(fake), expected,
                f"direction {direction}: cleanup must follow the sweep order",
            )

    def test_cleanup_gives_up_after_two_failed_rounds(self):
        # A tile failing twice is never walked to again: no endless retries.
        grid = self._row_world()
        fake, runner = make_runner(20, 9, grid, spawn=(10, 3))
        runner._cleanup_fails[(5, 4)] = 2
        n_punches_before = len(fake.punches)
        runner.cleanup()
        after = [p for p in fake.punches[n_punches_before:] if (p[2], p[3]) == (5, 4)]
        self.assertEqual(after, [], "twice-failed tile must not be punched again")
        self.assertEqual(
            runner.blocked.get((5, 4)), "cleanup failed twice — giving up"
        )
        # Everything else still gets cleared.
        rest = {(x, 4) for x in range(20) if x != 5}
        remaining = set(fake.remaining_targets(runner.targets))
        self.assertTrue(
            rest.isdisjoint({pos for pos in remaining if pos[1] == 4}),
            "other columns must still be cleared",
        )


class CavePocketAndSkyTests(unittest.TestCase):
    def test_cave_pocket_below_row_clears_across_and_continues_row(self):
        # Row 4 is full dirt+bg (x=0..9). Row 5 is dirt+bg EXCEPT (4,5) which
        # is a natural cave pocket (fg=0, bg=CAVE_BG). Row 6 is bedrock floor.
        # Previously, stepping into (4,4) dropped the bot into (4,5) while
        # (5,4) still held solid dirt, abandoning x=5..9 on row 4.
        width, height = 10, 8
        grid = {}
        for x in range(width):
            grid[(x, 4)] = (DIRT, CAVE_BG)
            grid[(x, 5)] = (DIRT, CAVE_BG)
            grid[(x, 6)] = (BEDROCK, 0)
        grid[(4, 5)] = (0, CAVE_BG)  # cave pocket below row 4 at x=4

        fake, runner = make_runner(width, height, grid, spawn=(2, 3))
        rc = runner.run()

        self.assertEqual(rc, 0)
        self.assertEqual(fake.violations, [])
        self.assertEqual(fake.remaining_targets(runner.targets), {})

    def test_floating_sky_block_does_not_abort_sweep_or_poison_column(self):
        # Main terrain is rows 5..6 (bedrock at row 7), plus an unreachable
        # floating sky block at (3, 0). The runner must not abort the main
        # sweep or leave column 3 of rows 5..6 uncleared.
        width, height = 10, 9
        grid = {}
        for x in range(width):
            grid[(x, 5)] = (DIRT, CAVE_BG)
            grid[(x, 6)] = (DIRT, CAVE_BG)
            grid[(x, 7)] = (BEDROCK, 0)
        grid[(3, 0)] = (DIRT, 0)  # unreachable floating sky block

        fake, runner = make_runner(width, height, grid, spawn=(2, 4))
        rc = runner.run()

        self.assertEqual(fake.violations, [])
        # All main terrain tiles on rows 5 and 6 (including column 3!) are cleared
        for y in (5, 6):
            for x in range(width):
                self.assertEqual(
                    fake.tile(x, y), (0, 0), f"terrain tile ({x},{y}) must be cleared"
                )
        # Only the unreachable sky block (3, 0) remains
        self.assertEqual(fake.remaining_targets(runner.targets), {(3, 0): (DIRT, 0)})
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
