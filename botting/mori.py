"""Thin, reusable gRPC client for the Mori Growtopia bot server.

Wraps the generated stubs (auto-generated into `examples/` on first use) with:

- connection + auth metadata handling,
- bot selection,
- fire-and-forget action RPCs (hit / walk / warp / respawn / settings),
- a background ``SubscribeEvents`` pump that keeps a live tile grid cache
  (``tile_update``), the bot position (``bot_move``) and the world name
  (``bot_world``) in sync,
- small blocking helpers used by the scripts (wait for arrival, wait for a
  tile to be cleared, ...).

Everything is thread-safe: the event pump runs in a daemon thread and shares
state behind a single condition variable.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Dict, List, Optional, Sequence, Tuple

import grpc

# ── Make the auto-generated stubs importable from anywhere ────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_EXAMPLES = os.path.join(_ROOT, "examples")
for _p in (_EXAMPLES, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import grpc_bootstrap as gen  # noqa: E402

pb, rpc = gen.pb, gen.rpc

Tile = Tuple[int, int]  # (fg_item_id, bg_item_id)

# Bot statuses considered usable for automation.
READY_STATUSES = {"in_game"}
BAD_STATUSES = {"update_required"}


class MoriError(RuntimeError):
    """Base error for Mori client failures."""


class NoBotsError(MoriError):
    """Raised when the server has no bots to attach to."""


class BotNotFoundError(MoriError):
    """Raised when a requested bot id does not exist."""


class MoriClient:
    """Small stateful client for one Mori bot."""

    def __init__(
        self,
        addr: str = "localhost:50051",
        token: str = "",
        verbose: bool = True,
    ) -> None:
        self.addr = addr
        self.token = (token or "").strip()
        self.verbose = verbose

        self.channel: Optional[grpc.Channel] = None
        self.stub: Optional[rpc.MoriStub] = None
        self.metadata: List[Tuple[str, str]] = (
            [("authorization", f"Bearer {self.token}")] if self.token else []
        )

        self.bot_ref: Optional[pb.BotRef] = None
        self.bot_id: int = 0
        self.username: str = ""

        # Shared state (guarded by self._lock / self._cond).
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._grid: Dict[Tuple[int, int], Tile] = {}
        self._world_name: str = ""
        self._world_w: int = 100
        self._world_h: int = 60
        self._pos: Optional[Tuple[float, float]] = None
        self._status: str = ""
        self._world_gen: int = 0  # bumped whenever the world changes

        self._stop = threading.Event()
        self._events_thread: Optional[threading.Thread] = None

        self.delays = {"walk_ms": 500, "place_ms": 500}

    # ── logging ───────────────────────────────────────────────────────────────

    def log(self, msg: str) -> None:
        if self.verbose:
            print(f"[Mori] {msg}")

    # ── connection ────────────────────────────────────────────────────────────

    def connect(self) -> None:
        self.channel = grpc.insecure_channel(self.addr)
        self.stub = rpc.MoriStub(self.channel)
        # Force an early RPC so auth/connection problems surface immediately.
        self.list_bots()

    def halt(self) -> None:
        """Immediately freezes the bot in-place and stops script/movement."""
        self.stop_events()
        if self.stub is None:
            return
        try:
            self.stop_script()
        except Exception:
            pass
        try:
            self.set_auto_collect(False)
        except Exception:
            pass
        pos = self.pos_tile()
        if pos is not None:
            try:
                self.walk_to(pos[0], pos[1])
            except Exception:
                pass

    def close(self) -> None:
        try:
            self.halt()
        except Exception:
            pass
        self.stop_events()
        if self.channel is not None:
            try:
                self.channel.close()
            except Exception:
                pass
            self.channel = None

    # ── manager ───────────────────────────────────────────────────────────────

    def list_bots(self) -> Sequence[pb.BotInfo]:
        assert self.stub is not None, "connect() first"
        resp = self.stub.ListBots(pb.Empty(), metadata=self.metadata)
        return resp.bots

    def select_bot(self, bot_id: Optional[int] = None) -> pb.BotInfo:
        """Selects (and stores) the bot to control.

        With ``bot_id=None`` the first in-game bot is preferred, else the first
        bot in the list.
        """
        bots = self.list_bots()
        if not bots:
            raise NoBotsError("no bots running — spawn one via the web UI or SpawnBot first")

        chosen: Optional[pb.BotInfo] = None
        if bot_id is not None:
            for b in bots:
                if b.bot_id == bot_id:
                    chosen = b
                    break
            if chosen is None:
                raise BotNotFoundError(f"bot id {bot_id} not found (running: {[b.bot_id for b in bots]})")
        else:
            for b in bots:
                if b.status in READY_STATUSES and b.world:
                    chosen = b
                    break
            if chosen is None:
                for b in bots:
                    if b.status in READY_STATUSES:
                        chosen = b
                        break
            if chosen is None:
                chosen = bots[0]

        self.bot_id = chosen.bot_id
        self.username = chosen.username
        self.bot_ref = pb.BotRef(bot_id=chosen.bot_id)
        self._status = chosen.status
        self._world_name = chosen.world
        with self._lock:
            self._pos = (chosen.pos_x, chosen.pos_y)

        self.log(
            f"bot id={chosen.bot_id} user={chosen.username!r} "
            f"status={chosen.status!r} world={chosen.world!r} "
            f"pos=({chosen.pos_x:.1f},{chosen.pos_y:.1f})"
        )
        return chosen

    def get_state(self):
        return self.stub.GetBotState(self.bot_ref, metadata=self.metadata)

    # ── settings ──────────────────────────────────────────────────────────────

    def set_walk_delay(self, ms: int) -> None:
        self.stub.SetWalkDelay(
            pb.SetUintRequest(bot=self.bot_ref, value=int(ms)), metadata=self.metadata
        )
        self.delays["walk_ms"] = int(ms)

    def set_place_delay(self, ms: int) -> None:
        self.stub.SetPlaceDelay(
            pb.SetUintRequest(bot=self.bot_ref, value=int(ms)), metadata=self.metadata
        )
        self.delays["place_ms"] = int(ms)

    def set_auto_collect(self, enabled: bool) -> None:
        self.stub.SetAutoCollect(
            pb.SetBoolRequest(bot=self.bot_ref, enabled=bool(enabled)), metadata=self.metadata
        )

    def set_auto_reconnect(self, enabled: bool) -> None:
        self.stub.SetAutoReconnect(
            pb.SetBoolRequest(bot=self.bot_ref, enabled=bool(enabled)), metadata=self.metadata
        )

    def set_auto_leave_on_mod(self, enabled: bool) -> None:
        self.stub.SetAutoLeaveOnMod(
            pb.SetBoolRequest(bot=self.bot_ref, enabled=bool(enabled)), metadata=self.metadata
        )

    # ── queries ───────────────────────────────────────────────────────────────

    def get_world(self):
        return self.stub.GetWorld(self.bot_ref, metadata=self.metadata)

    def get_tile(self, x: int, y: int) -> Optional[Tile]:
        """Live tile read; returns None for out-of-bounds / unknown tiles."""
        try:
            t = self.stub.GetTile(
                pb.GetTileRequest(bot=self.bot_ref, x=int(x), y=int(y)), metadata=self.metadata
            )
        except grpc.RpcError as e:
            if e.code() == grpc.StatusCode.NOT_FOUND:
                return None
            raise
        tile = (t.fg_item_id, t.bg_item_id)
        with self._lock:
            self._grid[(int(x), int(y))] = tile
        return tile

    def get_item_info(self, item_id: int):
        return self.stub.GetItemInfo(pb.GetItemInfoRequest(id=int(item_id)), metadata=self.metadata)

    def get_local(self):
        return self.stub.GetLocal(self.bot_ref, metadata=self.metadata)

    def get_inventory(self):
        """Fetches the bot's inventory (InvSlot items with item_id, amount)."""
        return self.stub.GetInventory(self.bot_ref, metadata=self.metadata)

    def is_in_world(self, name: str = "") -> bool:
        req = (
            pb.IsInWorldRequest(bot=self.bot_ref, name=name, has_name=True)
            if name
            else pb.IsInWorldRequest(bot=self.bot_ref, has_name=False)
        )
        return bool(self.stub.IsInWorld(req, metadata=self.metadata).value)

    def is_in_tile(self, x: int, y: int) -> bool:
        return bool(
            self.stub.IsInTile(
                pb.IsInTileRequest(bot=self.bot_ref, x=int(x), y=int(y)), metadata=self.metadata
            ).value
        )

    # ── actions (fire-and-forget) ─────────────────────────────────────────────

    def hit(self, dx: int, dy: int) -> None:
        """One punch at tile offset (dx, dy) from the bot's current tile.

        The server paces consecutive punches by ``place_ms``; sending several
        of these back-to-back emulates holding the punch button.
        """
        self.stub.Hit(pb.TileActionRequest(bot=self.bot_ref, x=int(dx), y=int(dy)), metadata=self.metadata)

    def place(self, dx: int, dy: int, item_id: int) -> None:
        """Places an item at offset (dx, dy) from the bot's current tile."""
        self.stub.Place(
            pb.PlaceRequest(
                bot=self.bot_ref, x=int(dx), y=int(dy), item_id=int(item_id)
            ),
            metadata=self.metadata,
        )

    def walk_to(self, x: int, y: int) -> None:
        self.stub.WalkTo(pb.MoveToRequest(bot=self.bot_ref, x=int(x), y=int(y)), metadata=self.metadata)

    def move_to(self, x: int, y: int) -> None:
        """Direct single-tile move without pathfinding."""
        self.stub.MoveTo(pb.MoveToRequest(bot=self.bot_ref, x=int(x), y=int(y)), metadata=self.metadata)

    def plant_footing(self) -> None:
        """Sends a standing state packet with +2.0px vector_y offset to eliminate visual floating."""
        if self.stub is None or self.bot_ref is None:
            return
        pos = self.pos_tile()
        if pos is None:
            return
        try:
            pkt = pb.GameUpdatePacket(
                type=0,
                vec_x=float(pos[0] * 32),
                vec_y=float(pos[1] * 32 + 2),
                flags=0x20,
            )
            self.stub.SendRaw(pb.SendRawRequest(bot=self.bot_ref, packet=pkt), metadata=self.metadata)
        except Exception:
            pass

    def set_direction(self, facing_left: bool) -> None:
        self.stub.SetDirection(
            pb.SetDirectionRequest(bot=self.bot_ref, facing_left=bool(facing_left)), metadata=self.metadata
        )

    def respawn(self) -> None:
        self.stub.Respawn(self.bot_ref, metadata=self.metadata)

    def warp(self, name: str, door_id: str = "") -> None:
        self.stub.Warp(
            pb.WarpRequest(bot=self.bot_ref, name=name, id=door_id), metadata=self.metadata
        )

    def say(self, text: str) -> None:
        self.stub.Say(pb.SayRequest(bot=self.bot_ref, text=text), metadata=self.metadata)

    def stop_script(self) -> None:
        """Stops the bot's embedded Lua script; no-op when none is running."""
        self.stub.StopScript(self.bot_ref, metadata=self.metadata)

    def leave_world(self) -> None:
        self.stub.LeaveWorld(self.bot_ref, metadata=self.metadata)

    def disconnect(self) -> None:
        """Manual disconnect; stays offline until Reconnect (auto_reconnect
        only covers unexpected drops)."""
        self.stub.Disconnect(self.bot_ref, metadata=self.metadata)

    def stop_bot(self) -> None:
        """Stops (removes) the bot process."""
        self.stub.StopBot(self.bot_ref, metadata=self.metadata)

    # ── world cache ───────────────────────────────────────────────────────────

    def sync_world(self) -> Tuple[str, int, int]:
        """Pulls a full world snapshot (GetWorld) into the local tile cache."""
        world = self.get_world()
        with self._lock:
            self._grid = {(t.x, t.y): (t.fg_item_id, t.bg_item_id) for t in world.tiles}
            self._world_name = world.name
            self._world_w = world.width or self._world_w
            self._world_h = world.height or self._world_h
            self._world_gen += 1
            self._cond.notify_all()
        return world.name, self._world_w, self._world_h

    def grid_get(self, x: int, y: int) -> Optional[Tile]:
        with self._lock:
            t = self._grid.get((int(x), int(y)))
        return t if isinstance(t, tuple) else None

    def grid_snapshot(self) -> Dict[Tuple[int, int], Tile]:
        with self._lock:
            return dict(self._grid)

    def grid_put(self, x: int, y: int, tile: Tile) -> None:
        with self._lock:
            self._grid[(int(x), int(y))] = (int(tile[0]), int(tile[1]))

    @property
    def world_name(self) -> str:
        with self._lock:
            return self._world_name

    @property
    def world_size(self) -> Tuple[int, int]:
        with self._lock:
            return self._world_w, self._world_h

    @property
    def world_gen(self) -> int:
        with self._lock:
            return self._world_gen

    @property
    def status(self) -> str:
        with self._lock:
            return self._status

    def pos_tile(self) -> Optional[Tuple[int, int]]:
        with self._lock:
            pos = self._pos
        if pos is None:
            return None
        return int(round(pos[0])), int(round(pos[1]))

    def refresh_pos(self) -> Tuple[int, int]:
        """Authoritative position refresh via GetLocal; returns tile coords."""
        local = self.get_local()
        with self._lock:
            self._pos = (local.pos_x, local.pos_y)
        return int(round(local.pos_x)), int(round(local.pos_y))

    # ── waiting helpers ───────────────────────────────────────────────────────

    def wait_arrival(self, x: int, y: int, timeout: float = 1.5) -> bool:
        """Waits until the bot's authoritative position reaches tile (x, y)."""
        deadline = time.time() + max(0.1, timeout)
        while True:
            if self._stop.is_set():
                return False
            try:
                if self.is_in_tile(x, y):
                    with self._lock:
                        self._pos = (float(x), float(y))
                    return True
            except grpc.RpcError:
                pass
            if time.time() >= deadline:
                return False
            time.sleep(0.08)

    def wait_tile_cleared(self, x: int, y: int, is_target, timeout: float = 2.0) -> bool:
        """Waits until tile (x, y) no longer contains a target, or timeout.

        Uses the event-fed cache first and falls back to live GetTile polling.
        """
        deadline = time.time() + max(0.1, timeout)
        while True:
            if self._stop.is_set():
                return False
            t = self.grid_get(x, y)
            if t is not None and not is_target(t):
                return True
            try:
                lt = self.get_tile(x, y)
            except grpc.RpcError:
                lt = None
            if lt is not None and not is_target(lt):
                return True
            if time.time() >= deadline:
                return False
            time.sleep(0.10)

    def wait_world(self, name: str, timeout: float = 20.0) -> bool:
        deadline = time.time() + max(0.5, timeout)
        while time.time() < deadline:
            if self._stop.is_set():
                return False
            if self.world_name and self.world_name.lower() == name.lower():
                return True
            try:
                if self.is_in_world(name):
                    with self._lock:
                        self._world_name = name
                        self._world_gen += 1
                    return True
            except grpc.RpcError:
                pass
            time.sleep(0.3)
        return False

    # ── events ────────────────────────────────────────────────────────────────

    def start_events(self) -> None:
        if self._events_thread is not None and self._events_thread.is_alive():
            return
        self._stop.clear()
        self._events_thread = threading.Thread(
            target=self._event_loop, name="mori-events", daemon=True
        )
        self._events_thread.start()

    def stop_events(self) -> None:
        self._stop.set()
        with self._cond:
            self._cond.notify_all()

    def _event_loop(self) -> None:
        assert self.stub is not None, "connect() first"
        while not self._stop.is_set():
            try:
                stream = self.stub.SubscribeEvents(
                    pb.SubscribeRequest(bot_ids=[self.bot_id]), metadata=self.metadata
                )
                for ev in stream:
                    if self._stop.is_set():
                        break
                    self._dispatch(ev)
            except grpc.RpcError:
                pass
            except Exception:
                pass
            if not self._stop.is_set():
                time.sleep(0.5)

    def _dispatch(self, ev) -> None:
        which = ev.WhichOneof("event")
        if which == "tile_update":
            tu = ev.tile_update
            with self._cond:
                self._grid[(tu.x, tu.y)] = (tu.fg, tu.bg)
                self._cond.notify_all()
        elif which == "bot_move":
            bm = ev.bot_move
            with self._cond:
                self._pos = (bm.x, bm.y)
                self._cond.notify_all()
        elif which == "bot_world":
            with self._cond:
                self._world_name = ev.bot_world.world_name
                self._world_gen += 1
                self._cond.notify_all()
        elif which == "bot_status":
            with self._cond:
                self._status = ev.bot_status.status
                self._cond.notify_all()
        elif which == "world_loaded":
            wl = ev.world_loaded
            with self._cond:
                self._world_name = wl.name
                if wl.width:
                    self._world_w = wl.width
                if wl.height:
                    self._world_h = wl.height
                self._world_gen += 1
                self._cond.notify_all()
