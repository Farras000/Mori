"""Grounded navigation and physics-safe movement for Growtopia bots.

Prevents anti-cheat bans by strictly stepping tile-by-tile over grounded
footholds, enforcing realistic foot speed delays (~180ms per step), and
simulating gravity settlement when floating.

Movement follows the vanilla client model: level walking, one-tile auto-step
("climb") onto a foothold, and walking off an edge or into an open gap so
gravity lands the bot on the first foothold below (falls are never breaches —
the bot only ever crosses holes that already exist). ``bfs_move_path`` and
``move_reach`` route with all three move kinds, which is what lets the bot
walk out of a pit it fell into without breaking anything.

All RPC-touching helpers take a ``MoriClient``. The pure grid helpers
(``bfs_grounded_path``, ``bfs_move_path``, ``pick_stand``,
``is_standable_grid``) stay free of network access so they remain
unit-testable.
"""

from __future__ import annotations

import heapq
import time
from collections import deque
from typing import Dict, Iterator, List, Mapping, Optional, Set, Tuple

import grpc

from botting.mori import MoriClient
from botting.physics import (
    grid_fg,
    grid_tile,
    is_solid_support,
    is_standable_grid,
    is_tile_passable,
    is_within_punch_range,
)
from botting.stop import should_stop as _should_stop

Coord = Tuple[int, int]


def get_tile_safe(client: MoriClient, x: int, y: int) -> Optional[Tuple[int, int]]:
    """Live tile read that never raises on out-of-bounds tiles."""
    try:
        return client.get_tile(x, y)
    except grpc.RpcError:
        return client.grid_get(x, y)


def live_is_solid(client: MoriClient, x: int, y: int, coll: Mapping[int, int]) -> Optional[bool]:
    """Live check whether tile (x, y) provides solid ground support."""
    t = get_tile_safe(client, x, y)
    if t is None:
        return None
    if t[0] == 0:
        return False
    return is_solid_support(t[0], coll)


def server_pos_tiles(client: MoriClient) -> Coord:
    """Authoritative bot position as tile coordinates."""
    return client.refresh_pos()


def face_for_step(client: MoriClient, dx: int) -> None:
    """Mirrors a vanilla client: set facing before every horizontal step.

    Without this the avatar slides sideways with a frozen sprite ("meluncur").
    Purely visual on the server — failures are ignored so fakes stay fast.
    """
    if dx == 0:
        return
    try:
        client.set_direction(facing_left=dx < 0)
    except Exception:
        pass


def pace_step(walk_ms: int = 180) -> None:
    """Client-side dwell so one WalkTo renders as one walk cycle.

    The server also paces by ``walk_ms``; this sleep keeps the script from
    queueing the next step while the animation is still playing (which reads
    as gliding). Capped tiny for unit tests (walk_ms=1).
    """
    try:
        time.sleep(max(0, int(walk_ms)) / 1000.0)
    except Exception:
        pass


def step_one(client: MoriClient, frm: Coord, to: Coord, walk_ms: int = 180) -> bool:
    """Takes exactly ONE step to an adjacent tile (|dx| + |dy| == 1).

    Issues single-tile MoveTo (via walk_to) and verifies the server position
    update so the script never runs ahead of the bot (no teleport desync).
    """
    fx, fy = frm
    tx, ty = to

    if abs(tx - fx) + abs(ty - fy) != 1:
        return False
    if tx < 0 or ty < 0:
        return False

    face_for_step(client, tx - fx)
    try:
        client.walk_to(tx, ty)
    except grpc.RpcError:
        return False

    timeout = max(walk_ms / 1000.0, 0.15) + 0.9
    ok = client.wait_arrival(tx, ty, timeout=timeout)
    if ok and not getattr(client, "events_active", False):
        pace_step(walk_ms)
    return ok


def run_horizontal(
    client: MoriClient,
    frm: Coord,
    to: Coord,
    coll: Mapping[int, int],
    world_w: int,
    world_h: int,
    walk_ms: int = 180,
) -> bool:
    """Runs continuously in a straight horizontal line on solid ground.

    Verifies the entire horizontal segment is passable and grounded up front,
    then steps tile-by-tile using direct single-tile moves (never invoking
    server-side A* pathfinding).
    """
    fx, fy = frm
    tx, ty = to
    if fy != ty or fx == tx:
        return False

    direction = 1 if tx > fx else -1
    # Verify every intermediate step is passable and has solid ground below (live)
    for x in range(fx + direction, tx + direction, direction):
        body = get_tile_safe(client, x, fy)
        if body is None or not is_tile_passable(body[0], coll):
            return False
        if not standable_live(client, coll, x, fy, world_h):
            return False

    cur_x = fx
    for x in range(fx + direction, tx + direction, direction):
        if _should_stop(getattr(client, "bot_id", None)):
            return False
        if not step_one(client, (cur_x, fy), (x, fy), walk_ms=walk_ms):
            return False
        cur_x = x
    return True


def standable_live(client: MoriClient, coll: Mapping[int, int], x: int, y: int, world_h: int) -> bool:
    """Grounded-standability check against live tile data."""
    body = get_tile_safe(client, x, y)
    if body is None:
        return False
    if not is_tile_passable(body[0], coll):
        return False
    if y + 1 >= world_h:
        return True
    below = live_is_solid(client, x, y + 1, coll)
    return bool(below)


def settle(client: MoriClient, coll: Mapping[int, int], world_h: int, walk_ms: int = 180, max_fall: int = 60) -> bool:
    """Lets gravity settle the bot down onto the nearest solid tile below it.

    If the bot is embedded in a solid tile it tries to escape; if it floats in
    mid-air it falls directly down to the nearest solid foothold in column bx
    in one natural gravity descent instead of hovering tile-by-tile.
    """
    for _ in range(4):
        if _should_stop(getattr(client, "bot_id", None)):
            return False
        bx, by = server_pos_tiles(client)

        # Embedded in a block? Escape first.
        if live_is_solid(client, bx, by, coll):
            if escape_embedded(client, coll, world_h, walk_ms):
                continue
            return False

        if by + 1 >= world_h:
            client.plant_footing()
            return True
        below = live_is_solid(client, bx, by + 1, coll)
        if below is True:
            client.plant_footing()
            return True
        if below is None:
            # Cannot verify tile below (RPC error / OOB): never fall blind
            return False

        # Scan downward along column bx to find the landing foothold
        landing_y = by
        limit_y = min(world_h, by + max_fall + 1)
        for y in range(by + 1, limit_y):
            t = get_tile_safe(client, bx, y)
            if t is None or not is_tile_passable(t[0], coll, is_downward=True):
                break
            landing_y = y
            if y + 1 >= world_h:
                break
            solid_under = live_is_solid(client, bx, y + 1, coll)
            if solid_under is True:
                break

        if landing_y == by:
            client.plant_footing()
            return True

        # Descend strictly 1 tile at a time to prevent server anticheat rubberbanding / teleportation
        for ny in range(by + 1, landing_y + 1):
            try:
                client.walk_to(bx, ny)
            except grpc.RpcError:
                return False
            # Fast event-driven arrival check per tile
            timeout = max(walk_ms / 1000.0, 0.05) + 0.1
            if not client.wait_arrival(bx, ny, timeout=timeout):
                cur_x, cur_y = server_pos_tiles(client)
                if (cur_x, cur_y) == (bx, ny - 1):
                    return False  # genuinely stuck on this step
                break

        cur_x, cur_y = server_pos_tiles(client)
        if cur_y + 1 >= world_h or live_is_solid(client, cur_x, cur_y + 1, coll) is True:
            client.plant_footing()
            return True

    client.plant_footing()
    return True


def step_climb(
    client: MoriClient,
    frm: Coord,
    to: Coord,
    walk_ms: int = 180,
) -> bool:
    """Vanilla one-tile auto-step up: a diagonal step onto a foothold.

    The caller has already verified that ``to`` is a grounded foothold, so
    the step can never leave the bot floating. Facing is set first so the
    climb renders as a walk cycle instead of a sideways glide.
    """
    fx, fy = frm
    tx, ty = to
    if ty != fy - 1 or abs(tx - fx) != 1:
        return False
    if tx < 0 or ty < 0:
        return False
    face_for_step(client, tx - fx)
    try:
        client.walk_to(tx, ty)
    except grpc.RpcError:
        return False

    timeout = max(walk_ms / 1000.0, 0.15) + 0.9
    ok = client.wait_arrival(tx, ty, timeout=timeout)
    if ok and not getattr(client, "events_active", False):
        pace_step(walk_ms)
    return ok


def step_fall(
    client: MoriClient,
    coll: Mapping[int, int],
    world_h: int,
    frm: Coord,
    to: Coord,
    walk_ms: int = 180,
) -> bool:
    """Steps sideways into an existing gap and falls to the foothold ``to``.

    Accepts both outcomes of the walk-off: the bot may be reported at the gap
    edge first or the server may already be dropping it; ``settle`` finishes
    the fall either way. Returns True only when the bot ends on ``to``.
    """
    fx, fy = frm
    tx, ty = to
    if abs(tx - fx) != 1 or ty <= fy:
        return False
    face_for_step(client, tx - fx)
    try:
        client.walk_to(tx, fy)
    except grpc.RpcError:
        return False

    timeout = max(walk_ms / 1000.0, 0.15) + 0.9
    deadline = time.time() + timeout
    while time.time() < deadline:
        bx, by = server_pos_tiles(client)
        if bx == tx and by >= fy:
            break
        time.sleep(0.03)

    if not settle(client, coll, world_h, walk_ms):
        return False
    bx, by = server_pos_tiles(client)
    return (bx, by) == (tx, ty)


def verify_step_live(
    client: MoriClient,
    coll: Mapping[int, int],
    world_h: int,
    frm: Coord,
    nxt: Coord,
) -> bool:
    """Live re-checks one planned step before executing it.

    The pathfinder plans on a snapshot that may be stale (or sparse: missing
    tiles read as air). A step is only executed when live ``GetTile`` confirms
    it: walk/climb targets must be passable AND standable (with headroom above
    the bot for climbs), fall landings must be standable with the whole fall
    column passable downward (mirroring ``fall_landing``). ``None`` (OOB /
    unknown) fails closed — the caller replans instead of stepping into the
    unknown.
    """
    fx, fy = frm
    tx, ty = nxt
    dx, dy = tx - fx, ty - fy

    if dy == 0 and abs(dx) == 1:
        body = get_tile_safe(client, tx, ty)
        if body is None or not is_tile_passable(body[0], coll):
            return False
        return standable_live(client, coll, tx, ty, world_h)

    if dy == -1 and abs(dx) == 1:
        if fy - 1 >= 0:
            head = get_tile_safe(client, fx, fy - 1)
            if head is not None and not is_tile_passable(head[0], coll):
                return False
        body = get_tile_safe(client, tx, ty)
        if body is None or not is_tile_passable(body[0], coll):
            return False
        return standable_live(client, coll, tx, ty, world_h)

    if dy > 0 and abs(dx) == 1:
        if not standable_live(client, coll, tx, ty, world_h):
            return False
        for yy in range(fy, ty):
            t = get_tile_safe(client, tx, yy)
            if t is None or not is_tile_passable(t[0], coll, is_downward=True):
                return False
        return True

    return False


def escape_embedded(client: MoriClient, coll: Mapping[int, int], world_h: int, walk_ms: int = 180, tries: int = 4) -> bool:
    """Escapes if the bot gets embedded inside a solid block."""
    for _ in range(tries):
        if _should_stop(getattr(client, "bot_id", None)):
            return False
        bx, by = server_pos_tiles(client)
        if not live_is_solid(client, bx, by, coll):
            return True  # Body tile is clear.

        routes = [(bx, by - 1), (bx - 1, by), (bx + 1, by), (bx, by + 1)]
        for tx, ty in routes:
            if tx < 0 or ty < 0 or ty >= world_h:
                continue
            if live_is_solid(client, tx, ty, coll) is not False:
                continue
            if step_one(client, (bx, by), (tx, ty), walk_ms):
                if not live_is_solid(client, tx, ty, coll):
                    return True

    bx, by = server_pos_tiles(client)
    return not live_is_solid(client, bx, by, coll)


def bfs_grounded_path(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    start: Coord,
    goal: Coord,
    world_w: int,
    world_h: int,
    limit: int = 4096,
) -> Optional[List[Coord]]:
    """Finds a sequence of adjacent footholds strictly connecting start to goal.

    Every intermediate node MUST be a standable foothold, so the bot never
    routes through open air.
    """
    if start == goal:
        return [start]

    if not is_standable_grid(grid, coll, goal[0], goal[1], world_w, world_h):
        return None

    q: deque = deque([start])
    prev: Dict[Coord, Optional[Coord]] = {start: None}
    seen: Set[Coord] = {start}
    directions = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    while q and len(seen) < limit:
        cx, cy = q.popleft()
        for dx, dy in directions:
            nxt = (cx + dx, cy + dy)
            if nxt in seen:
                continue
            if not is_standable_grid(grid, coll, nxt[0], nxt[1], world_w, world_h):
                continue
            seen.add(nxt)
            prev[nxt] = (cx, cy)
            if nxt == goal:
                path = [nxt]
                while prev[path[-1]] is not None:
                    path.append(prev[path[-1]])  # type: ignore[arg-type]
                return path[::-1]
            q.append(nxt)

    return None


def fall_landing(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    x: int,
    y: int,
    world_w: int,
    world_h: int,
    max_fall: int = 48,
) -> Optional[Coord]:
    """First foothold a bot lands on after stepping sideways into (x, y).

    Scans the column downward: every tile on the way must be passable
    (downward movement is blocked by platforms) and the landing must be
    standable. Returns None when the column has no valid landing.
    """
    ly = y
    for _ in range(max_fall):
        if ly >= world_h:
            return None
        if is_standable_grid(grid, coll, x, ly, world_w, world_h):
            return (x, ly)
        if not is_tile_passable(grid_fg(grid, x, ly), coll, is_downward=True):
            return None
        ly += 1
    return None


def move_neighbors(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    x: int,
    y: int,
    world_w: int,
    world_h: int,
) -> Iterator[Coord]:
    """Every foothold reachable from (x, y) with one vanilla move.

    - climb:  diagonal auto-step up onto a foothold (its support below is the
              1-tile wall being stepped over, and the tile above (x, y) must be
              passable so the bot does not clip through a ceiling),
    - walk:   level step onto a foothold,
    - fall:   step sideways into an open gap, gravity lands the bot on the
              first foothold below. Never used to break anything.
    """
    y_up = y - 1
    head_ok = y_up < 0 or is_tile_passable(grid_fg(grid, x, y_up), coll)
    for dx in (-1, 1):
        nx = x + dx
        if nx < 0 or nx >= world_w:
            continue

        if y_up >= 0 and head_ok and is_standable_grid(grid, coll, nx, y_up, world_w, world_h):
            yield (nx, y_up)

        fg, _bg = grid_tile(grid, nx, y)
        if not is_tile_passable(fg, coll):
            continue
        if is_standable_grid(grid, coll, nx, y, world_w, world_h):
            yield (nx, y)
        else:
            land = fall_landing(grid, coll, nx, y, world_w, world_h)
            if land is not None:
                yield land


def astar_move_path(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    start: Coord,
    goal: Coord,
    world_w: int,
    world_h: int,
    limit: int = 4096,
) -> Optional[List[Coord]]:
    """Weighted A* pathfinder over physics-verified footholds.

    Prefers flat horizontal walking (cost 1.0) over 1-tile climbs (1.2) and
    gravity drops (1.1 + 0.25 * dy), with a tiny penalty (+0.05) for direction
    reversals so the bot takes smooth, human-like paths instead of zig-zagging
    or dropping into unnecessary pits.
    """
    if start == goal:
        return [start]

    if not is_standable_grid(grid, coll, goal[0], goal[1], world_w, world_h):
        return None

    gx, gy = goal

    def heuristic(x: int, y: int) -> float:
        return abs(gx - x) + abs(gy - y) * 1.15

    g_score: Dict[Coord, float] = {start: 0.0}
    prev: Dict[Coord, Optional[Coord]] = {start: None}
    prev_dir: Dict[Coord, int] = {start: 0}
    tie = 0
    open_heap: List[Tuple[float, int, Coord]] = [(heuristic(start[0], start[1]), tie, start)]

    while open_heap and len(g_score) < limit:
        _f, _t, cur = heapq.heappop(open_heap)
        if cur == goal:
            path = [cur]
            while prev[path[-1]] is not None:
                path.append(prev[path[-1]])  # type: ignore[arg-type]
            return path[::-1]

        cx, cy = cur
        cur_g = g_score[cur]
        last_dx = prev_dir.get(cur, 0)

        for nxt in move_neighbors(grid, coll, cx, cy, world_w, world_h):
            nx, ny = nxt
            dx = nx - cx
            dy = ny - cy
            if dy == 0:
                step_cost = 1.0
            elif dy == -1:
                step_cost = 1.20
            else:
                step_cost = 1.10 + 0.25 * dy

            if last_dx != 0 and dx * last_dx < 0:
                step_cost += 0.05

            tentative_g = cur_g + step_cost
            if tentative_g + 1e-9 < g_score.get(nxt, float("inf")):
                g_score[nxt] = tentative_g
                prev[nxt] = cur
                prev_dir[nxt] = dx
                tie += 1
                f_score = tentative_g + heuristic(nx, ny)
                heapq.heappush(open_heap, (f_score, tie, nxt))

    return None


def bfs_move_path(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    start: Coord,
    goal: Coord,
    world_w: int,
    world_h: int,
    limit: int = 4096,
) -> Optional[List[Coord]]:
    """Finds an optimal physics-safe route of footholds connecting start to goal.

    Delegates to ``astar_move_path`` over ``move_neighbors`` (level walk,
    1-tile climb, fall through an existing gap).
    """
    return astar_move_path(grid, coll, start, goal, world_w, world_h, limit=limit)


def move_reach(
    client: MoriClient,
    coll: Mapping[int, int],
    world_w: int,
    world_h: int,
    limit: int = 4096,
) -> Dict[Coord, int]:
    """BFS distances to every foothold reachable from the bot's position.

    Same move graph as ``bfs_move_path``, so pits are crossed with falls and
    1-tile climbs. Useful to pick the nearest re-entry point back onto a row.
    """
    if not settle(client, coll, world_h):
        return {}

    grid = client.grid_snapshot()
    start = server_pos_tiles(client)

    dist: Dict[Coord, int] = {start: 0}
    q: deque = deque([start])
    while q and len(dist) < limit:
        cur = q.popleft()
        d = dist[cur]
        for nxt in move_neighbors(grid, coll, cur[0], cur[1], world_w, world_h):
            if nxt in dist:
                continue
            dist[nxt] = d + 1
            q.append(nxt)
    return dist


def walk_grounded(
    client: MoriClient,
    goal: Coord,
    coll: Mapping[int, int],
    world_w: int,
    world_h: int,
    walk_ms: int = 180,
) -> bool:
    """Moves to ``goal`` like a real client, tile-by-tile: levelled walking,
    one-tile auto-steps up and falls through existing gaps. Never punches."""
    if not settle(client, coll, world_h, walk_ms):
        return False

    stale_retries = 0
    for _ in range(768):
        if _should_stop(getattr(client, "bot_id", None)):
            return False
        bx, by = server_pos_tiles(client)
        if (bx, by) == goal:
            return True

        grid = client.grid_snapshot()
        path = bfs_move_path(grid, coll, (bx, by), goal, world_w, world_h)
        if not path or len(path) < 2:
            # Refresh the tiles immediately around the bot once, then retry.
            refreshed = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if client.grid_get(bx + dx, by + dy) is None:
                        t = get_tile_safe(client, bx + dx, by + dy)
                        if t is not None:
                            refreshed = True
            grid = client.grid_snapshot()
            path = bfs_move_path(grid, coll, (bx, by), goal, world_w, world_h)
            if not refreshed or not path or len(path) < 2:
                return False

        nxt = path[1]
        if not verify_step_live(client, coll, world_h, (bx, by), nxt):
            # Snapshot said "go", live tiles disagree (stale cache, sparse
            # grid, or the floor is gone): GetTile calls above already
            # refreshed the cache, so just replan instead of stepping blind.
            stale_retries += 1
            if stale_retries > 6:
                return False
            continue
        stale_retries = 0
        dx = nxt[0] - bx
        dy = nxt[1] - by
        if dy == 0 and abs(dx) == 1:
            step_dir = dx
            run_idx = 1
            while run_idx + 1 < len(path):
                cand = path[run_idx + 1]
                if cand[1] == by and cand[0] == path[run_idx][0] + step_dir:
                    run_idx += 1
                else:
                    break
            if run_idx > 1:
                moved = run_horizontal(
                    client, (bx, by), path[run_idx], coll, world_w, world_h, walk_ms
                )
            else:
                moved = step_one(client, (bx, by), nxt, walk_ms)
        elif dy == -1 and abs(dx) == 1:
            moved = step_climb(client, (bx, by), nxt, walk_ms)
        elif dy > 0 and abs(dx) == 1:
            moved = step_fall(client, coll, world_h, (bx, by), nxt, walk_ms)
        else:
            return False

        if not moved:
            # A step can end somewhere unexpected (e.g. the fall landed one
            # tile off); keep going as long as the bot actually moved.
            ax, ay = server_pos_tiles(client)
            if (ax, ay) == (bx, by):
                return False
            continue

        if not settle(client, coll, world_h, walk_ms):
            return False

    return False


def stand_foothold_tier(
    p: Coord,
    tx: int,
    ty: int,
    bx: int,
    by: int,
    direction: Optional[int] = None,
) -> int:
    """Classifies a candidate foothold into priority tiers.

    Tier 0 (Front same-row): 1 tile in front of the target on the same row.
    Tier 1 (Front reach same-row): 2 tiles in front of the target on the same row.
    Tier 2 (Other same-row): Any other foothold on the same row (sy == ty).
    Tier 3 (From below): Standing below the target (sy > ty, upward punch).
    Tier 4 (From above - diagonal): Standing above the target (sy < ty, downward diagonal punch).
    Tier 5 (On top): Standing directly on the target block (tx, ty - 1).
    """
    sx, sy = p
    if sy == ty:
        eff_dir = direction if direction is not None and direction != 0 else (1 if bx <= tx else -1)
        if eff_dir > 0:
            if sx == tx - 1:
                return 0
            if sx == tx - 2:
                return 1
            return 2
        else:
            if sx == tx + 1:
                return 0
            if sx == tx + 2:
                return 1
            return 2
    if sy > ty:
        return 3
    if p == (tx, ty - 1):
        return 5
    return 4


def stand_candidates(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    tx: int,
    ty: int,
    bx: int,
    by: int,
    world_w: int,
    world_h: int,
    direction: Optional[int] = None,
) -> List[Coord]:
    """All standable footholds within punch reach of (tx, ty), lateral/horizontal first.

    Guarantees same-row footholds (sy == ty) are prioritized over breaking from
    above (sy < ty), matching the natural front-facing punch behavior.
    """
    candidates: List[Coord] = []

    # Lateral same-row footholds first
    candidates.extend([(tx - 1, ty), (tx + 1, ty)])
    candidates.append((tx, ty - 1))

    offsets = [
        (0, 1),
        (-1, -1), (1, -1), (-1, 1), (1, 1),
        (-2, 0), (2, 0), (0, -2),
        (-2, -1), (2, -1), (-1, -2), (1, -2),
    ]
    for dx, dy in offsets:
        candidates.append((tx + dx, ty + dy))

    # Deduplicate while preserving order
    seen: Set[Coord] = set()
    dedup: List[Coord] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            dedup.append(c)

    dedup.sort(
        key=lambda p: (
            stand_foothold_tier(p, tx, ty, bx, by, direction),
            abs(p[0] - bx) + abs(p[1] - by),
        )
    )

    out: List[Coord] = []
    for sx, sy in dedup:
        if not is_standable_grid(grid, coll, sx, sy, world_w, world_h):
            continue
        dx = tx - sx
        dy = ty - sy
        if not is_within_punch_range(dx, dy):
            continue
        out.append((sx, sy))

    return out


def pick_stand(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    coll: Mapping[int, int],
    tx: int,
    ty: int,
    bx: int,
    by: int,
    world_w: int,
    world_h: int,
    direction: Optional[int] = None,
) -> Optional[Coord]:
    """Selects the best standable foothold within punch reach of (tx, ty)."""
    cands = stand_candidates(grid, coll, tx, ty, bx, by, world_w, world_h, direction=direction)
    return cands[0] if cands else None


def reachable_footholds(
    client: MoriClient,
    coll: Mapping[int, int],
    world_w: int,
    world_h: int,
    limit: int = 4096,
) -> Set[Coord]:
    """Flood-fills every foothold the bot can reach from here.

    Uses the same move graph as ``walk_grounded`` (level walks, one-tile
    climbs and falls through existing gaps), so anything outside the returned
    set cannot be reached with the bot's current footing — e.g. while it is
    trapped in a sealed pocket inside the terrain.
    """
    return set(move_reach(client, coll, world_w, world_h, limit))


def count_grid_targets(
    grid: Mapping[Tuple[int, int], Tuple[int, int]],
    targets: Set[int],
    x0: int = 0,
    y0: int = 0,
    x1: Optional[int] = None,
    y1: Optional[int] = None,
) -> int:
    """Counts tiles inside the given window that still contain a target."""
    n = 0
    for (x, y) in grid.keys():
        if x < x0 or y < y0:
            continue
        if x1 is not None and x >= x1:
            continue
        if y1 is not None and y >= y1:
            continue
        fg, bg = grid[(x, y)]
        if fg in targets or bg in targets:
            n += 1
    return n
