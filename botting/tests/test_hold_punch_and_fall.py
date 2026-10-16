"""Tests for smooth hold-punch movement, horizontal breaking, and anti-float footing."""

import unittest
from unittest.mock import MagicMock

from botting import navigator as nav
from botting.clear_world import ClearWorldRunner
from botting.config import BotConfig
from botting.mori import MoriClient


class StandCandidatesPriorityTests(unittest.TestCase):
    def test_stand_candidates_prioritizes_horizontal_footholds(self):
        """Lateral same-row footholds (tx - 1, ty) and (tx + 1, ty) must come

        BEFORE standing directly on top (tx, ty - 1). This ensures the bot stands
        beside the block and punches horizontally forward instead of destroying
        its own floor.
        """
        # Grid: row 10 has air except target block at (5, 10)
        # Row 11 has solid dirt floor everywhere
        grid = {}
        world_w, world_h = 20, 20
        coll = {2: 1}  # dirt collision type 1 = solid

        for x in range(world_w):
            grid[(x, 11)] = (2, 0)  # solid floor at row 11
            grid[(x, 10)] = (0, 0)  # air at row 10
            grid[(x, 9)] = (0, 0)   # air at row 9

        # Target block at (5, 10)
        grid[(5, 10)] = (2, 14)

        # Bot is at (4, 10) approaching from the left
        cands = nav.stand_candidates(grid, coll, tx=5, ty=10, bx=4, by=10, world_w=world_w, world_h=world_h)

        # (4, 10) is a lateral same-row foothold
        self.assertIn((4, 10), cands)
        # (6, 10) is a lateral same-row foothold
        self.assertIn((6, 10), cands)

        # Lateral footholds must appear BEFORE standing directly on top (5, 9)
        idx_lateral_left = cands.index((4, 10))
        idx_lateral_right = cands.index((6, 10))
        if (5, 9) in cands:
            idx_top = cands.index((5, 9))
            self.assertLess(idx_lateral_left, idx_top, "Lateral foothold (4, 10) must be ranked ahead of (5, 9)")
            self.assertLess(idx_lateral_right, idx_top, "Lateral foothold (6, 10) must be ranked ahead of (5, 9)")

    def test_stand_candidates_top_only_when_lateral_blocked(self):
        """When lateral footholds are blocked by unbreakable obstacles,

        standing on top (tx, ty - 1) is used as a fallback.
        """
        grid = {}
        world_w, world_h = 20, 20
        coll = {2: 1, 8: 1}  # 8 = bedrock solid

        for x in range(world_w):
            grid[(x, 11)] = (2, 0)  # solid floor at row 11
            grid[(x, 10)] = (0, 0)
            grid[(x, 9)] = (0, 0)

        # Bedrock at (4, 10) and (6, 10) blocks lateral standing
        grid[(4, 10)] = (8, 0)
        grid[(6, 10)] = (8, 0)
        # Target at (5, 10)
        grid[(5, 10)] = (2, 14)

        cands = nav.stand_candidates(grid, coll, tx=5, ty=10, bx=5, by=8, world_w=world_w, world_h=world_h)
        # (5, 9) must be selected as fallback
        self.assertIn((5, 9), cands)

    def test_stand_candidates_ranks_same_row_front_even_when_bot_is_above(self):
        """When bot is at y=33 and target is at (45, 34), same-row in-front foothold
        at (44, 34) must rank ahead of standing above at (43, 33) or (45, 33).
        """
        grid = {}
        world_w, world_h = 60, 60
        coll = {2: 1}  # dirt solid
        for x in range(world_w):
            grid[(x, 35)] = (2, 0)  # solid floor at y=35
        # row 34 has air at 44, target at 45
        grid[(44, 34)] = (0, 0)
        grid[(45, 34)] = (2, 14)  # target block
        grid[(43, 34)] = (2, 0)   # solid floor for (43, 33)
        grid[(43, 33)] = (0, 0)   # air foothold above

        # Bot is at (43, 33) - above the target row
        cands = nav.stand_candidates(grid, coll, tx=45, ty=34, bx=43, by=33, world_w=world_w, world_h=world_h, direction=1)
        self.assertIn((44, 34), cands)
        # (44, 34) is on the same row, in front of the target: MUST be ranked first!
        self.assertEqual(cands[0], (44, 34), "Same-row front foothold must be preferred over footholds above the target")

    def test_stand_candidates_direction_priority(self):
        """Sweeping left-to-right (dir=1) prefers (tx - 1, ty).
        Sweeping right-to-left (dir=-1) prefers (tx + 1, ty).
        """
        grid = {}
        world_w, world_h = 60, 60
        coll = {2: 1}
        for x in range(world_w):
            grid[(x, 35)] = (2, 0)
            grid[(x, 34)] = (0, 0)
        grid[(45, 34)] = (2, 14)  # target block

        # Sweep right: approaching (45, 34) from left
        cands_right = nav.stand_candidates(grid, coll, tx=45, ty=34, bx=40, by=34, world_w=world_w, world_h=world_h, direction=1)
        self.assertEqual(cands_right[0], (44, 34), "Left-to-right sweep must stand at (44, 34) in front of block")

        # Sweep left: approaching (45, 34) from right
        cands_left = nav.stand_candidates(grid, coll, tx=45, ty=34, bx=50, by=34, world_w=world_w, world_h=world_h, direction=-1)
        self.assertEqual(cands_left[0], (46, 34), "Right-to-left sweep must stand at (46, 34) in front of block")


class SettleDirectDropTests(unittest.TestCase):
    def test_settle_drops_step_by_step_to_landing_floor(self):
        """When the bot floats over an open shaft (e.g. at y=5 with floor at y=8),
        settle must step tile-by-tile down (no teleport) and plant footing once solid ground is reached.
        """
        client = MagicMock(spec=MoriClient)
        pos = [5, 5]
        def mock_refresh():
            return tuple(pos)
        def mock_walk(x, y):
            pos[0], pos[1] = x, y

        client.refresh_pos.side_effect = mock_refresh
        client.walk_to.side_effect = mock_walk
        # Floor is at y=8
        def mock_get_tile(x, y):
            if y == 8:
                return (2, 0)  # solid dirt floor
            return (0, 0)  # air
        client.get_tile.side_effect = mock_get_tile
        client.wait_arrival.return_value = True

        coll = {2: 1}
        ok = nav.settle(client, coll, world_h=20, walk_ms=180)

        self.assertTrue(ok)
        self.assertEqual(pos, [5, 7])
        client.plant_footing.assert_called()


class PlantFootingTests(unittest.TestCase):
    def test_plant_footing_sends_raw_state_with_offset(self):
        """plant_footing sends GameUpdatePacket with vec_y = pos[1] * 32 + 2 and STANDING flag."""
        import grpc_bootstrap as gen
        pb = gen.pb
        client = MoriClient("localhost:50051", "token", verbose=False)
        client.stub = MagicMock()
        client.bot_ref = pb.BotRef(bot_id=1)
        client.bot_id = 1
        client._pos = (10.0, 20.0)

        client.plant_footing()

        client.stub.SendRaw.assert_called_once()
        call_args = client.stub.SendRaw.call_args[0][0]
        self.assertEqual(call_args.packet.vec_x, 10.0 * 32.0)
        self.assertEqual(call_args.packet.vec_y, 20.0 * 32.0 + 2.0)
        self.assertEqual(call_args.packet.flags, 0x20)


class ClearTileContinuousStreamingTests(unittest.TestCase):
    def test_clear_tile_streams_fg_and_bg_seamlessly(self):
        """When tile has both fg (Dirt) and bg (Cave BG), clear_tile sends punches
        for fg, detects fg break, and continues immediately into bg punches.
        """
        import grpc_bootstrap as gen
        pb = gen.pb
        client = MagicMock(spec=MoriClient)
        client.bot_id = 1
        client.bot_ref = pb.BotRef(bot_id=1)
        client.pos_tile.return_value = (5, 10)
        client.refresh_pos.return_value = (5, 10)

        # Simulation: first returns Dirt + Cave BG, then after hits returns Cave BG only, then cleared
        state = {"fg": 2, "bg": 14, "hits": 0}
        def mock_hit(dx, dy):
            state["hits"] += 1
            if state["hits"] >= 3:
                state["fg"] = 0
            if state["hits"] >= 6:
                state["bg"] = 0

        client.hit.side_effect = mock_hit
        client.grid_get.side_effect = lambda x, y: (state["fg"], state["bg"])
        client.get_tile.side_effect = lambda x, y: (state["fg"], state["bg"])
        client.wait_tile_cleared.side_effect = lambda x, y, is_tgt, to: (state["fg"] == 0 and state["bg"] == 0)

        cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
        runner = ClearWorldRunner(client, cfg)
        runner.targets = {2, 14}
        runner.coll = {2: 1}
        runner.strength = {2: 3, 14: 3}
        runner.world_w = 20
        runner.world_h = 20

        ok = runner.clear_tile(6, 10)

        self.assertTrue(ok)
        self.assertEqual(state["hits"], 6)
        self.assertEqual(state["fg"], 0)
        self.assertEqual(state["bg"], 0)


if __name__ == "__main__":
    unittest.main()
