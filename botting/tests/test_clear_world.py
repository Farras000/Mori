"""End-to-end tests for ``ClearWorldRunner`` against an in-memory fake bot.

Covers the world-edge layer rule: the bot must clear the top layer first and
may only "break 1 down" (punch into the next layer) on a world edge column
(x=0 or x=world_w-1), never mid-row.

The fake client applies real hit counts, records every punch and flags rule
violations (punching protected items, teleport walking, walking into solids),
so these tests verify both the sweep behaviour and the anti-ban constraints.
"""

from __future__ import annotations

import contextlib
import io
import unittest

from botting import sweep
from botting.clear_world import ClearWorldRunner
from botting.config import BotConfig
from botting.tests.fake_mori import FakeMoriClient

DIRT, CAVE_BG, BEDROCK, WORLD_LOCK = 2, 14, 8, 242


def build_world(width, height, fill_rows, floor_row=None, patches=None):
    grid = {}
    for y in fill_rows:
        for x in range(width):
            grid[(x, y)] = (DIRT, CAVE_BG)
    if floor_row is not None:
        for x in range(width):
            grid[(x, floor_row)] = (BEDROCK, 0)
    for (x, y), tile in (patches or {}).items():
        grid[(x, y)] = tile
    return grid


class ClearWorldFakeTests(unittest.TestCase):
    maxDiff = None

    # ── helpers ───────────────────────────────────────────────────────────────

    def run_world(self, width, height, grid, spawn):
        fake = FakeMoriClient("TESTWORLD", width, height, grid, spawn=spawn)
        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = ClearWorldRunner(fake, cfg)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = runner.run()
        return fake, runner, cfg, rc, out.getvalue()

    def assert_world_cleared(self, fake, runner, log=""):
        """No tile is left that the planner would still punch (has_work)."""
        snap = fake.grid_snapshot()
        width, height = fake.world_size
        left = [
            (x, y)
            for y in range(height)
            for x in range(width)
            if sweep.plan_for(snap, runner.coll, runner.targets, runner.strength, x, y).has_work
        ]
        self.assertEqual(left, [], f"leftover work tiles: {left}\n{log}")

    def assert_first_target_punch_per_row_at_edge(self, fake, cfg, width, log=""):
        """The first time a layer receives a punch it must be on a world edge.

        This is the test's formalisation of "dilarang break layer kedua ...
        baru boleh break ke bawah di x ke 0 atau 99": a layer may only be
        opened (first punch into it) on a world edge column.
        """
        first: dict = {}
        for (bx, by, tx, ty, fg, bg) in fake.punches:
            if fg in cfg.target_block_ids or bg in cfg.target_block_ids:
                first.setdefault(ty, (tx, bx, by))
        for ty, (tx, bx, by) in sorted(first.items()):
            self.assertIn(
                tx,
                (0, width - 1),
                f"row {ty} was first opened at x={tx} (bot at ({bx},{by})) — "
                f"not a world edge\n{log}",
            )

    def assert_no_protected_punches(self, fake, log=""):
        self.assertEqual(fake.violations, [], f"rule violations: {fake.violations}\n{log}")

    # ── tests ─────────────────────────────────────────────────────────────────

    def test_flat_world_clears_layers_top_first_with_edge_descents_only(self):
        width, height = 10, 9
        grid = build_world(width, height, range(4, 7), floor_row=7)
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(4, 3))

        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)
        self.assert_first_target_punch_per_row_at_edge(fake, cfg, width, log)

        # In a flat world every downward dig (punching the tile directly below
        # the bot's tile) is a layer transition: dig-in + 2 descents, all on a
        # world edge column. (Punches are batched, so dedupe the dig groups.)
        down_digs = {
            (bx, by, tx, ty)
            for (bx, by, tx, ty, fg, bg) in fake.punches
            if ty == by + 1 and tx == bx and (fg in cfg.target_block_ids or bg in cfg.target_block_ids)
        }
        self.assertEqual(len(down_digs), 3, f"unexpected downward digs: {sorted(down_digs)}\n{log}")
        for (bx, by, tx, ty) in sorted(down_digs):
            self.assertIn(tx, (0, width - 1), f"break-down at x={tx} (row {ty}) is not on an edge\n{log}")

    def test_two_tall_pillar_walks_back_and_finishes_upper_layer_from_below(self):
        width, height = 10, 9
        grid = build_world(
            width,
            height,
            range(4, 7),
            floor_row=7,
            patches={(6, 4): (BEDROCK, 0), (6, 5): (BEDROCK, 0)},
        )
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(2, 3))

        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)
        self.assert_first_target_punch_per_row_at_edge(fake, cfg, width, log)

        # The pillar itself is untouched.
        self.assertEqual(fake.tile(6, 4), (BEDROCK, 0), log)
        self.assertEqual(fake.tile(6, 5), (BEDROCK, 0), log)

        # Row 5 behind the pillar had to be skipped; it must be finished from
        # below with upward punches while the row-6 sweep passes underneath it.
        roof_up = [
            (bx, by, tx, ty)
            for (bx, by, tx, ty, fg, bg) in fake.punches
            if ty == 5 and ty < by
        ]
        self.assertTrue(roof_up, f"expected upward punches to finish the skipped row-5 segment\n{log}")

    def test_world_lock_run_is_bypassed_and_never_punched(self):
        width, height = 10, 9
        grid = build_world(
            width,
            height,
            range(4, 7),
            floor_row=7,
            patches={(6, 4): (WORLD_LOCK, CAVE_BG), (7, 4): (WORLD_LOCK, CAVE_BG)},
        )
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(4, 3))

        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)
        self.assert_first_target_punch_per_row_at_edge(fake, cfg, width, log)

        # The two locks (and the background behind them) stay untouched; the
        # planner never counts them as work, so the world still reports clean.
        self.assertEqual(fake.tile(6, 4), (WORLD_LOCK, CAVE_BG), log)
        self.assertEqual(fake.tile(7, 4), (WORLD_LOCK, CAVE_BG), log)

    def test_three_tall_pillar_leftovers_finished_from_two_rows_below(self):
        width, height = 10, 10
        grid = build_world(
            width,
            height,
            range(4, 9),
            floor_row=9,
            patches={(6, 4): (BEDROCK, 0), (6, 5): (BEDROCK, 0), (6, 6): (BEDROCK, 0)},
        )
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(2, 3))

        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)
        self.assert_first_target_punch_per_row_at_edge(fake, cfg, width, log)

        # Rows 5 and 6 behind the pillar are unreachable directly: the row-5
        # remainder pass breaks what it can reach in sweep order (column 5,
        # via a vanilla 2-away punch), the rest is finished from below with
        # upward punches while lower rows pass underneath.
        self.assertEqual(fake.tile(6, 4), (BEDROCK, 0), log)
        self.assertEqual(fake.tile(6, 6), (BEDROCK, 0), log)
        self.assertIn("remainder pass", log)
        up_one = {(tx, ty) for (bx, by, tx, ty, fg, bg) in fake.punches if by - ty == 1}
        up_two = {(tx, ty) for (bx, by, tx, ty, fg, bg) in fake.punches if by - ty == 2}
        same_row = {(tx, ty) for (bx, by, tx, ty, fg, bg) in fake.punches if by == ty}
        for x in range(5):
            self.assertIn((x, 6), up_one, log)
            self.assertIn((x, 5), up_two, log)
        # Column 5 (nearest the pillar) is handled by the remainder passes on
        # its own row, top-down: (5,5) before (5,6).
        self.assertIn((5, 5), same_row, log)
        self.assertIn((5, 6), same_row, log)
        order: dict = {}
        for i, (bx, by, tx, ty, fg, bg) in enumerate(fake.punches):
            order.setdefault((tx, ty), i)
        self.assertLess(order[(5, 5)], order[(5, 6)], f"column 5 must open top-down\n{log}")

    def test_remainder_pass_clears_row_in_sweep_order(self):
        """The remainder pass breaks every leftover column of its row in
        sweep order (here: right-to-left, strictly descending x) — actively
        approaching each column on foot instead of abandoning the segment.
        Row 4 is clear air, row 5 holds dirt on x=0..5, row 6 is the floor.
        """
        width, height = 10, 9
        grid = {}
        for x in range(width):
            grid[(x, 6)] = (DIRT, CAVE_BG)
            grid[(x, 7)] = (BEDROCK, 0)
        for x in range(6):
            grid[(x, 5)] = (DIRT, CAVE_BG)
        fake2 = FakeMoriClient("TESTWORLD", width, height, grid, spawn=(9, 5))
        cfg2 = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner2 = ClearWorldRunner(fake2, cfg2)
        self.assertTrue(runner2.load_world())
        runner2.sweep_row_remainder(5, 8, -1)

        self.assert_no_protected_punches(fake2, "")
        for x in range(6):
            self.assertEqual(fake2.tile(x, 5), (0, 0), f"column {x} not cleared")
        row5 = [(tx, i) for i, (bx, by, tx, ty, fg, bg) in enumerate(fake2.punches)
                if ty == 5 and fg in cfg2.target_block_ids]
        first_idx: dict = {}
        for tx, i in row5:
            first_idx.setdefault(tx, i)
        xs = sorted(first_idx, key=lambda x: first_idx[x])
        self.assertEqual(xs, [5, 4, 3, 2, 1, 0], f"row-5 punch order: {xs}")

    def test_mid_world_start_when_spawn_is_embedded_in_top_layer(self):
        """Bot spawns on a passable tile inside the top layer (white door case).

        The door tile is capped by bedrock above its neighbours, so neither
        world edge can be reached (not even with the fall/climb move graph).
        The sweep then starts from the bot's own column and covers the top row
        in two legs (left half, walk back, right half). The layer order still
        holds: the whole top row is cleared before any layer transition, and
        every "break 1 down" happens on a world edge column.
        """
        width, height = 12, 9
        grid = build_world(width, height, range(4, 7), floor_row=7)
        grid[(5, 4)] = (0, 0)  # door-like passable tile embedded in the top layer
        grid[(4, 3)] = (BEDROCK, 0)  # caps: no walking/climbing out of the door
        grid[(6, 3)] = (BEDROCK, 0)
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(5, 4))

        self.assertIn("mid-world start", log)
        self.assertNotIn("entered the top layer at world edge", log)
        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)

        # Every downward dig is a layer transition and must be on a world edge.
        down_digs = {
            (bx, by, tx, ty)
            for (bx, by, tx, ty, fg, bg) in fake.punches
            if ty == by + 1 and tx == bx and (fg in cfg.target_block_ids or bg in cfg.target_block_ids)
        }
        self.assertEqual(len(down_digs), 2, f"unexpected downward digs: {sorted(down_digs)}\n{log}")
        for (bx, by, tx, ty) in sorted(down_digs):
            self.assertIn(tx, (0, width - 1), f"break-down at x={tx} (row {ty}) is not on an edge\n{log}")

        # Both halves of the top row were swept, and the door tile itself was
        # never punched.
        row4 = {(tx, ty) for (bx, by, tx, ty, fg, bg) in fake.punches if ty == 4}
        self.assertIn((4, 4), row4, log)
        self.assertIn((6, 4), row4, log)
        self.assertEqual([p for p in fake.punches if (p[2], p[3]) == (5, 4)], [], log)

        # Layer order: every punch of the top row happened before the first
        # punch of the row below it.
        idx_row4 = [i for i, p in enumerate(fake.punches) if p[3] == 4]
        idx_row5 = [i for i, p in enumerate(fake.punches) if p[3] == 5]
        self.assertLess(max(idx_row4), min(idx_row5), f"layer order broken\n{log}")

    def test_door_on_bedrock_pillar_crosses_pit_and_clears_world(self):
        """Live RUKOALICANTE shape: door on a bedrock pillar above the top layer.

        The bot stands in a door tile one row above the top layer; the tile
        below is bedrock and the columns beside it are a 2-deep pit left over
        from an earlier pass, so plain walking reaches nothing. The bot must
        still get going: it drops into the pit and climbs back onto the top
        row through the gaps (walk/fall/climb only), and while sweeping that
        row it crosses the same pit the same way. No descent may happen
        outside a world edge and the bedrock/door are never punched.
        """
        width, height = 12, 10
        grid = build_world(width, height, range(4, 7), floor_row=7)
        grid[(5, 3)] = (6, 0)       # door tile the bot stands in (passable, protected)
        grid[(5, 4)] = (BEDROCK, 0)  # bedrock right below the door
        grid[(4, 4)] = (0, 0)
        grid[(6, 4)] = (0, 0)
        grid[(4, 5)] = (0, 0)
        grid[(5, 5)] = (0, 0)
        grid[(6, 5)] = (0, 0)
        grid[(3, 4)] = (0, 0)       # pit shoulders already opened by the earlier pass
        grid[(7, 4)] = (0, 0)
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(5, 3))

        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)
        self.assert_first_target_punch_per_row_at_edge(fake, cfg, width, log)

        # The bot walked out of the well through the pit (fall + climb) to the
        # world edge, dug in there, and while sweeping the top row it dipped
        # through the pit again and climbed back out ahead of it.
        self.assertIn("entered the top layer at world edge x=0", log)
        self.assertIn("dipped through the gap", log)

        # Only layer transitions may dig downward, and only on a world edge.
        down_digs = {
            (bx, by, tx, ty)
            for (bx, by, tx, ty, fg, bg) in fake.punches
            if ty == by + 1 and tx == bx and (fg in cfg.target_block_ids or bg in cfg.target_block_ids)
        }
        self.assertEqual(3, len(down_digs), f"unexpected downward digs: {sorted(down_digs)}\n{log}")
        for (bx, by, tx, ty) in sorted(down_digs):
            self.assertIn(tx, (0, width - 1), f"break-down at x={tx} (row {ty}) is not on an edge\n{log}")

        # The door and the bedrock pillar were never touched.
        self.assertEqual(fake.tile(5, 3), (6, 0), log)
        self.assertEqual(fake.tile(5, 4), (BEDROCK, 0), log)

    def test_trapped_bot_cleanup_reports_without_respawn_loop(self):
        """Bot sealed inside the terrain: cleanup reports instead of looping.

        Reachability is flooded once per round, so no walk is attempted from
        unreachable stands; after one respawn puts the bot back at the same
        (still trapped) spawn, the cleanup stops instead of burning every
        respawn, and the leftovers are reported per tile.
        """
        width, height = 10, 9
        grid = build_world(width, height, range(4, 7), floor_row=7)
        grid[(3, 6)] = (0, 0)  # passable pocket tile sealed by dirt and bedrock
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(3, 6))

        self.assertEqual(rc, 2, log)  # leftovers stay, but they are reported
        self.assert_no_protected_punches(fake, log)
        self.assertLessEqual(fake.respawns, 1, f"cleanup must not burn respawns\n{log}")
        self.assertEqual(log.count("cleanup round"), 2, f"expected one respawn retry\n{log}")
        self.assertIn("cannot be reached on foot", log)
        self.assertNotIn("blocked (", log)  # no per-tile log flood
        self.assertIn("remaining:", log)

    def test_mid_world_start_from_shaft_bottom_clears_everything_top_down(self):
        """Live RUKOALICANTE shape: door + fallen-through shaft in the top layer.

        The bot stands two rows below the top layer at the bottom of its own
        shaft (rows y0..y0+2 of one column are clear), with both world edges
        unreachable. The fallback starts the sweep from the shaft bottom: the
        row is swept in both directions, every column's ceiling is finished
        first (upward punches), and the only "break 1 down" digs are the two
        layer descents on the world edges.
        """
        width, height = 12, 10
        grid = build_world(width, height, range(4, 9), floor_row=9)
        for y in (4, 5, 6):
            grid[(5, y)] = (0, 0)  # door tile + the shaft the bot fell through
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(5, 6))

        self.assertIn("mid-world start: sweeping from (5,6)", log)
        self.assertEqual(rc, 0, log)
        self.assert_no_protected_punches(fake, log)
        self.assertEqual(fake.respawns, 0, log)
        self.assert_world_cleared(fake, runner, log)

        # The only downward digs are the layer descents, both on a world edge.
        down_digs = {
            (bx, by, tx, ty)
            for (bx, by, tx, ty, fg, bg) in fake.punches
            if ty == by + 1 and tx == bx and (fg in cfg.target_block_ids or bg in cfg.target_block_ids)
        }
        self.assertEqual(len(down_digs), 2, f"unexpected downward digs: {sorted(down_digs)}\n{log}")
        for (bx, by, tx, ty) in sorted(down_digs):
            self.assertIn(tx, (0, width - 1), f"break-down at x={tx} (row {ty}) is not on an edge\n{log}")

        # The layers above the shaft were finished from inside it: the door
        # column was never punched sideways, and the shaft walls were opened
        # top-down (that is what the ahead roof-clean is for).
        self.assertEqual([p for p in fake.punches if (p[2], p[3]) == (5, 4)], [], log)
        first_punch: dict = {}
        for (bx, by, tx, ty, fg, bg) in fake.punches:
            if fg in cfg.target_block_ids or bg in cfg.target_block_ids:
                first_punch.setdefault(tx, ty)
        # Row 4 of every column was cleared from the shaft: its first row-4
        # punch happened before that column's row-5 punch.
        order: dict = {}
        for i, (bx, by, tx, ty, fg, bg) in enumerate(fake.punches):
            if not (fg in cfg.target_block_ids or bg in cfg.target_block_ids):
                continue
            order.setdefault((tx, ty), i)
        for x in range(width):
            for hi, lo in ((4, 5), (5, 6)):
                if (x, hi) in order and (x, lo) in order:
                    self.assertLess(
                        order[(x, hi)], order[(x, lo)],
                        f"column {x}: row {lo} was opened before row {hi}\n{log}",
                    )

    def test_mid_world_start_refused_when_bot_is_below_the_top_layer(self):
        """A bot far below the top layer must not open any layer mid-world.

        Starting mid-world is only legal for the top layer and the rows the
        bot already fell through (roof-clean reach is 3 rows); anything deeper
        would open layer N+1 while layer N (above) is still standing, which is
        exactly what the layer rule forbids. Here the bot sits in a clear shaft
        4 rows under the top layer: the fallback must refuse, and nothing may
        be punched at all.
        """
        width, height = 10, 10
        grid = build_world(width, height, range(4, 9), floor_row=9)
        for y in range(4, 8):
            grid[(3, y)] = (0, 0)  # clear shaft: the bot fell to row 7
        fake, runner, cfg, rc, log = self.run_world(width, height, grid, spawn=(3, 7))

        self.assertIn("mid-world start refused: bot is at row 7", log)
        self.assertNotIn("starting sweep", log)
        self.assertEqual(rc, 2, log)
        self.assert_no_protected_punches(fake, log)
        self.assertLessEqual(fake.respawns, 1, f"cleanup must not burn respawns\n{log}")

        # The top layer is untouched: the cleanup could only dig down the
        # shaft, it never opened the top layer from the side mid-world.
        for x in range(width):
            if x == 3:
                continue
            self.assertEqual(fake.tile(x, 4), (DIRT, CAVE_BG), log)


if __name__ == "__main__":
    unittest.main()
