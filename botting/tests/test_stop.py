"""Tests for the force-stop path (stop signals + stop_all halt)."""

from __future__ import annotations

import unittest

from botting import stop as stopsig
from botting.clear_world import ClearWorldRunner
from botting.config import BotConfig
from botting.stop_all import halt_bot
from botting.tests.fake_mori import FakeMoriClient

DIRT, CAVE_BG, BEDROCK = 2, 14, 8


def make_runner(width, height, grid, spawn):
    fake = FakeMoriClient("TESTWORLD", width, height, grid, spawn=spawn)
    cfg = BotConfig(walk_delay_ms=1, punch_delay_ms=1)
    runner = ClearWorldRunner(fake, cfg)
    assert runner.load_world(), "load_world failed in test setup"
    return fake, runner


class StopSignalTests(unittest.TestCase):
    def tearDown(self):
        stopsig.clear_stop()
        stopsig.clear_stop(1)
        stopsig.clear_stop(2)

    def test_lifecycle(self):
        self.assertFalse(stopsig.should_stop())
        self.assertFalse(stopsig.should_stop(1))
        stopsig.request_stop(1)
        self.assertTrue(stopsig.should_stop(1))
        self.assertFalse(stopsig.should_stop(2))
        self.assertFalse(stopsig.should_stop())  # no global signal
        stopsig.clear_stop(1)
        self.assertFalse(stopsig.should_stop(1))

    def test_global_covers_every_bot(self):
        stopsig.request_stop()
        self.assertTrue(stopsig.should_stop())
        self.assertTrue(stopsig.should_stop(1))
        self.assertTrue(stopsig.should_stop(999))
        stopsig.clear_stop()
        self.assertFalse(stopsig.should_stop(1))

    def test_run_consumes_stale_signals(self):
        stopsig.request_stop()
        stopsig.request_stop(1)
        fake, runner = make_runner(10, 9, {}, spawn=(0, 0))
        rc = runner.run()  # empty world: nothing to clear
        self.assertEqual(rc, 0)
        self.assertFalse(stopsig.should_stop())
        self.assertFalse(stopsig.should_stop(1))

    def test_sweep_row_exits_when_stopped(self):
        grid = {(x, 4): (DIRT, CAVE_BG) for x in range(10)}
        for x in range(10):
            grid[(x, 5)] = (DIRT, CAVE_BG)
            grid[(x, 6)] = (BEDROCK, 0)
        fake, runner = make_runner(10, 9, grid, spawn=(0, 3))
        stopsig.request_stop()
        try:
            self.assertEqual(runner.sweep_row(4, 1), "stopped")
            self.assertEqual(runner.walk_grounded_to((5, 4)), False)
        finally:
            stopsig.clear_stop()


class HaltBotTests(unittest.TestCase):
    def tearDown(self):
        stopsig.clear_stop()
        stopsig.clear_stop(1)

    def test_halt_defaults(self):
        grid = {(0, 0): (0, 0)}
        fake = FakeMoriClient("TESTWORLD", 10, 9, grid, spawn=(3, 3))
        ok, rep = halt_bot(fake)
        self.assertTrue(ok, rep)
        self.assertTrue(fake.script_stopped)
        self.assertFalse(fake.left_world)
        self.assertFalse(fake.disconnected)
        self.assertFalse(fake.bot_stopped)
        self.assertEqual(fake.violations, [])
        self.assertTrue(stopsig.should_stop(1))

    def test_halt_escalation(self):
        grid = {(0, 0): (0, 0)}
        fake = FakeMoriClient("TESTWORLD", 10, 9, grid, spawn=(3, 3))
        ok, rep = halt_bot(fake, leave=True, disconnect=True, stop_bot=True)
        self.assertTrue(ok, rep)
        self.assertTrue(fake.script_stopped)
        self.assertTrue(fake.left_world)
        self.assertTrue(fake.disconnected)
        self.assertTrue(fake.bot_stopped)
        self.assertFalse(fake.is_in_world("TESTWORLD"))


if __name__ == "__main__":
    unittest.main()
