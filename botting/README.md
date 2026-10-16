# Mori Botting — Growtopia Clear World

Automated **Clear World** script for Growtopia driven by Mori's gRPC control plane.

The bot clears a world **layer by layer, top to bottom**, starting from a world edge and
sweeping **left ↔ right (serpentine)**. It mimics a real client: tile-by-tile
movement, no teleporting, no floating, no jumping more than one tile, and batched punches
that look like a held punch button.

**Layer rule:** the top layer is always cleared first, and a **"break 1 down" into the
next layer is only allowed on a world edge column (`x = 0` or `x = 99`)** — never
mid-row. When a row gets blocked mid-way, the bot walks back to the edge it entered the
row from, breaks down there, and finishes the stranded tiles of the layer above with
upward punches while the next layer's sweep passes underneath them.

**Trapped spawns (doors / pits next to the top layer):** the "top layer" is the topmost
row that actually contains whitelist targets (the air above is empty by default) and
clearing always starts there. If neither world edge can be reached by plain walking — e.g.
the bot spawns at a White Door sitting on bedrock above the top layer, with a pit beside it
— the bot first tries to reach a standing tile on that row with **walk/fall/climb moves
only** (climbing back out of the pit through gaps that already exist, exactly like a real
client). Only when there is no route at all does it break its first tile: always a tile of
the detected top layer. That row is then swept in **both directions** (walk back to the
entry after the first half) and still finishes on a world edge, so every layer descent
stays legal. Each column is still opened top-down: before opening a tile, the leftovers of
the rows above it (up to 3, the punch reach) are finished with upward punches first.

**Pits during the sweep:** when a sweep step walks into an existing gap and gravity drops
the bot below the sweep row, it walks through the gap floor and climbs back onto the same
row at the nearest standing tile *ahead* in the sweep direction — walking/falling/climbing
only, never a punch, so no layer is opened mid-row. Only if there is no way back up does
the sweep continue on the row gravity chose.

---

## Layout

| File | Purpose |
| --- | --- |
| `mori.py` | Reusable gRPC client: connect/token, bot selection, action RPCs, event pump (`tile_update`, `bot_move`, `bot_world`, `bot_status`) with a live tile-grid + position cache, and blocking waiters (`wait_arrival`, `wait_tile_cleared`, `wait_world`). |
| `physics.py` | Item rules and validation: collision/strength tables, `plan_punch()` whitelist punch planner, anti-float standability, punch reach. Pure functions. |
| `sweep.py` | Pure serpentine planner: top-row detection, start column, per-tile row decision (punch / walk / bypass / skip), per-column descent decision (dig / step down / blocked / bottom), world-edge helpers (`is_edge_column`, `nearest_edge_column`) and `is_exposed` for cleanup layer order. Unit-tested, no I/O. |
| `navigator.py` | Move-graph movement: BFS over standable footholds with vanilla moves (level walk, one-tile climb, fall into existing gaps), single-tile `step_one`/`step_climb`/`step_fall`, gravity `settle`, `escape_embedded`, `move_reach`/`reachable_footholds` for cleanup, `pick_stand`/`stand_candidates` for approach tiles. |
| `clear_world.py` | Orchestrator + CLI: sweep loop, batched punches with verification, obstacle bypass, edge-only layer descents (`descend_to_next_row`), walk-back + roof cleanup for blocked rows, pit crossing (fall through + climb back onto the row), top-layer start fallback for trapped spawns, stuck → respawn recovery, final cleanup pass (exposed + reachable tiles only), and a report. Checks stop signals every loop so `stop_all.py` halts it. |
| `config.py` | CLI/env configuration (`BotConfig`) with `.env` support. |
| `stop.py` | Local stop-signal helpers (`request_stop` / `clear_stop` / `should_stop`, one-shot files under `botting/.stop/`). |
| `stop_all.py` | Force-stop CLI: `StopScript` + auto-collect off + movement halt per bot, local stop signals, opt-in `--leave` / `--disconnect` / `--stop-bot`. |
| `tests/` | `unittest` suites for physics/punch rules, navigator BFS, the sweep planner, plus `fake_mori.py` and end-to-end tests that run the whole clear-world loop against an in-memory bot. |

## Safety rules (anti-ban)

- **Whitelist punching only.** `Dirt (2)`, `Lava (4)`, `Rock (10)`, `Cave Background (14)`
  by default. A punch is only allowed when the foreground tile is empty or whitelisted, so
  bedrock, World Locks (`242` and every other lock), Main Door, signs, checkpoints, trees
  and any unknown item are **never** interacted with — even when a target background hides
  behind them.
- **Layer order (world-edge descent).** The topmost layer — the topmost row that actually
  contains whitelist targets — is fully swept first. A layer transition ("break 1 down",
  exactly one row) only happens on a world edge column (`x = 0` / `x = world_w-1`) —
  `descend_to_next_row()` is the single chokepoint enforcing it. Entering the top layer
  (`dig_in`) is edge-only too; if neither edge is reachable the bot starts from row `y0`
  itself (walking/falling/climbing onto it through existing gaps, or breaking its first
  row-`y0` tile) and covers the row in both directions before the first descent — otherwise
  the script skips the main sweep and only runs the cleanup pass.
- **Pits are crossed, never mined.** A gap in the sweep row (left by an earlier pass) is
  traversed with walk/fall/climb moves only: the bot drops through, walks the gap floor and
  climbs back onto the same row ahead of the pit. No block outside the whitelist is ever
  touched while navigating.
- **Blocked rows walk back.** If the sweep cannot continue (obstacle too tall, punch fails),
  the bot marks the rest of the row, walks back to the edge it entered the row from and
  breaks down there. The stranded tiles are then finished from **below** with upward
  punches while a lower row's sweep passes under them.
- **Anti-teleport.** Every move is a single adjacent step via `WalkTo`, verified with
  `IsInTile`; default pacing is 180 ms/tile.
- **Anti-float.** The bot only steps into tiles that are passable *and* supported by a
  solid block below (or the world floor). After breaking the floor it drops immediately;
  if it ever ends up floating it settles tile-by-tile.
- **No big jumps.** Bypass over a blocked 1-tile column is the vanilla 1-tile auto-step
  (`climb_to`); nothing taller is ever climbed or punched.
- **Natural punching.** Punches are sent in batches equal to the exact remaining
  `fg + bg` hit estimate (server paces each by `place_ms`, default 150 ms), verified via
  `tile_update` events / `GetTile`, retried a few times, then reported as blocked.
- **Stuck → Respawn.** No movement progress → `Respawn` + world resync, capped by
  `--max-respawn` (default 4). Drop auto-collect is **off**.
- `SetAutoReconnect(true)` and `SetAutoLeaveOnMod(true)` are enabled on start.

## Target blocks

| Block | ID | Punches (fist) |
| --- | --- | --- |
| Dirt | `2` | 3 |
| Lava | `4` | 4 |
| Rock | `10` | 10 |
| Cave Background | `14` | 3 |

Hit counts are read live from `GetItemInfo.strength` (falls back to built-in defaults).

---

## Setup

```bash
pip install -r botting/requirements.txt   # grpcio, grpcio-tools, protobuf
```

`.env` in the repo root (all optional):

```env
MORI_GRPC_ADDR=127.0.0.1:50051      # or MORI_HOST + MORI_GRPC_PORT
MORI_GRPC_TOKEN=your_token_here
TARGET_BLOCK_IDS=2,4,10,14          # or TARGET_BLOCKS
WALK_DELAY_MS=180
PUNCH_DELAY_MS=150                  # PLACE_DELAY_MS is accepted too
START_EDGE=auto                     # auto | left | right
WORLD=MYWORLD                       # optional auto-warp
```

gRPC stubs are auto-generated into `examples/` on first import (via `examples/grpc_bootstrap.py`).

## Running

```bash
# attach to the first in-game bot, auto-pick the nearest world edge
python botting/clear_world.py

# specific bot + world, start from the right edge
python botting/clear_world.py --bot-id 1 --world MYWORLD --start right

# custom pacing and target list
python botting/clear_world.py --walk-delay 200 --punch-delay 180 --blocks 2,4,10,14

# tighter/looser recovery
python botting/clear_world.py --max-respawn 6
```

All flags: `--host --port --token --bot-id --world --blocks --start {auto,left,right}
--walk-delay --punch-delay --max-respawn --collect --no-leave-on-mod`.

Exit codes: `0` fully cleared, `1` setup problem (no bot / cannot reach server /
not in a world), `2` finished with remaining tiles (world bottom, unbreakable floors or
unreachable leftovers — each listed in the final report).

### Force stop

```bash
# halt every bot: lua script off, auto-collect off, movement frozen,
# plus local stop signals so running clear_world.py loops exit
python botting/stop_all.py

# one bot only, and also leave the world
python botting/stop_all.py --bot-id 1 --leave

# escalate: disconnect (stays offline) or remove the bot entirely
python botting/stop_all.py --disconnect
python botting/stop_all.py --bot-id 1 --stop-bot
```

### Place World Lock above White Door (`place_lock.py`)

Places a World Lock (item id 242) directly on top of the world's White Door (`door_x`, `door_y - 1`).

```bash
# place World Lock on the first in-game bot
python botting/place_lock.py

# specify bot id, world, or custom lock id (e.g. Small Lock 202)
python botting/place_lock.py --bot-id 1 --world MYWORLD --lock-id 242
```

1. Verifies that the bot has a World Lock in its inventory.
2. Locates the White Door (item id 6) in the world.
3. Checks if the tile directly above the door already has a lock.
4. If occupied by a breakable block (e.g. dirt), clears it first.
5. Walks grounded to the door and places the World Lock directly on top.

Exit codes: `0` all halted, `1` connection/selection problem, `2` partial failure.

### What the run does

1. Attach to the bot, apply pacing settings, fetch the world once (`GetWorld`), load item
   rules (`GetItemInfo`), and subscribe to events.
2. Find the **top layer** (`find_top_row`: the topmost row with a whitelist target — the air
   above it is empty by default), walk/fall/climb to a **world edge**, on top of that layer
   (the other edge is tried if this one is unreachable; gaps left by earlier passes are
   crossed by dropping through and climbing out).
3. Dig in at the edge (punch the tile below), then sweep the row to the far edge —
   clearing each tile's foreground *and* background before stepping in. Pits left in the row
   are crossed with fall + climb moves (never punches).
4. At the far edge: punch below ("break 1 down"), drop a row, sweep back. Repeat until the
   world bottom / an unbreakable floor is reached.
5. A 1-tile-high protected obstacle in the row is bypassed by the vanilla 1-tile step-up
   and the row resumes after it. A taller obstacle ends the row: the bot leaves the
   remaining segment marked, walks back to the row's entry edge, breaks down there, and
   the leftovers above are finished with upward punches while the next row's sweep passes
   underneath them.
6. Finally a **cleanup pass** retries whatever remains, anywhere it can stand within punch
   range (including hitting upward from below), using the move graph — but only tiles that
   are **exposed** (nothing left to clear above them in the same column), keeping the layer
   order intact. Reachability is flooded once per round, so a bot trapped in a pocket
   reports its leftovers instead of walking in circles or burning respawns.
7. Prints a report: tiles cleared, respawns, elapsed time, and any remaining tiles with
   reasons.

## Tests

```bash
python -m unittest discover -s botting/tests -p "test_*.py" -v
```

Covers punch whitelisting, hit estimates, anti-float/standability, grounded BFS and the
walk/fall/climb move graph (pit crossing, 1-tile ledge climb, fall landings), stand
selection, and the serpentine planner (row sweep, descent, obstacle bypass/skip,
edge/bottom handling, edge columns, exposure for cleanup).

`tests/test_clear_world.py` additionally runs the full clear-world loop end-to-end
against `tests/fake_mori.py` (an in-memory Mori client with real hit counts) and asserts
the anti-ban rules on the recorded punch log: no protected item is ever punched, no
teleport moves, and **each layer's first punch happens on a world edge column** — plus the
walk-back / upward roof-cleanup behaviour for a 2-tile pillar, the world-lock bypass, the
top-layer start for a sealed bot (cleared top-down, descents still edge-only), the
live-RUKOALICANTE shape (a door on bedrock above the top layer with a pit beside it: the
bot drops in, climbs out, digs in at the edge, and crosses the same pit mid-sweep), and
the trapped-cleanup report path.
