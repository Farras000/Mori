"""Force-stop everything the bot(s) are doing (Mori gRPC).

Server side, per bot: stops the embedded Lua script (``StopScript``),
disables drop auto-collect, and halts movement by walking to the bot's own
tile. Locally running Python loops (e.g. ``clear_world.py``) exit gracefully
via stop-signal files (see ``botting/stop.py``) checked every iteration.

Opt-in escalation: ``--leave`` (leave the world), ``--disconnect`` (stay
offline until reconnect), ``--stop-bot`` (remove the bot process).

Usage:
    python botting/stop_all.py [--bot-id 1] [--leave] [--disconnect] [--stop-bot]

    Without ``--bot-id`` every bot is targeted.
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import signal as sigmod
import subprocess
import sys
import time
from typing import List, Tuple

import grpc

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, os.path.join(_ROOT, "examples")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from botting import runlock  # noqa: E402
from botting import stop as stopsig  # noqa: E402
from botting.config import load_dotenv  # noqa: E402
from botting.mori import BotNotFoundError, MoriClient, NoBotsError  # noqa: E402


def halt_bot(
    client: MoriClient,
    leave: bool = False,
    disconnect: bool = False,
    stop_bot: bool = False,
) -> Tuple[bool, List[str]]:
    """Halts one bot. Returns (ok, report lines). Never raises."""
    rep: List[str] = []
    ok = True
    name = f"id={client.bot_id} user={client.username!r}"

    def _fail(what: str, e: Exception) -> None:
        nonlocal ok
        ok = False
        rep.append(f"[{name}] {what} FAILED: {e}")

    try:
        client.stop_script()
        rep.append(f"[{name}] lua script stopped")
    except Exception as e:  # noqa: BLE001
        _fail("stop_script", e)

    try:
        client.set_auto_collect(False)
        rep.append(f"[{name}] auto-collect off")
    except Exception as e:  # noqa: BLE001
        _fail("set_auto_collect", e)

    try:
        x, y = client.refresh_pos()
        client.walk_to(x, y)
        rep.append(f"[{name}] movement halted at ({x},{y})")
    except Exception as e:  # noqa: BLE001
        _fail("movement halt", e)

    if leave:
        try:
            if client.is_in_world():
                client.leave_world()
                rep.append(f"[{name}] left the world")
            else:
                rep.append(f"[{name}] not in a world — nothing to leave")
        except Exception as e:  # noqa: BLE001
            _fail("leave_world", e)

    if disconnect:
        try:
            client.disconnect()
            rep.append(f"[{name}] disconnected (stays offline until reconnect)")
        except Exception as e:  # noqa: BLE001
            _fail("disconnect", e)

    if stop_bot:
        try:
            client.stop_bot()
            rep.append(f"[{name}] bot stopped")
        except Exception as e:  # noqa: BLE001
            _fail("stop_bot", e)

    # Always signal locally running loops for this bot.
    try:
        stopsig.request_stop(client.bot_id)
        rep.append(f"[{name}] local stop signal written")
    except Exception as e:  # noqa: BLE001
        _fail("local stop signal", e)

    return ok, rep


def _is_botting_cmd(cmd: str) -> bool:
    c = (cmd or "").lower()
    known = ("clear_world.py", "stop_all.py", "break_by_id.py", "place_lock.py")
    return any(k in c for k in known) or ("botting" in c and ".py" in c)


def parse_cim_csv(text: str) -> List[Tuple[int, str]]:
    """Parses PowerShell ConvertTo-Csv output (ProcessId,CommandLine)."""
    out: List[Tuple[int, str]] = []
    try:
        rows = list(csv.DictReader(io.StringIO(text or "")))
    except Exception:
        return out
    for r in rows:
        try:
            pid = int((r.get("ProcessId") or "").strip())
        except (TypeError, ValueError):
            continue
        out.append((pid, r.get("CommandLine") or ""))
    return out


def parse_ps_output(text: str) -> List[Tuple[int, str]]:
    """Parses `ps -eo pid,args` output."""
    out: List[Tuple[int, str]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("pid"):
            continue
        pid_s, _, cmd = line.partition(" ")
        try:
            out.append((int(pid_s), cmd.strip()))
        except (TypeError, ValueError):
            continue
    return out


def local_botting_processes() -> List[Tuple[int, str]]:
    """Local python processes driving botting scripts. Best effort."""
    own = os.getpid()
    found: List[Tuple[int, str]] = []
    try:
        if os.name == "nt":
            try:
                out = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                     "Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"],
                    capture_output=True, text=True, timeout=30,
                )
                found = parse_cim_csv(out.stdout)
            except Exception:
                found = []
            if not found:
                try:
                    out = subprocess.run(
                        ["wmic", "process", "where", "name='python.exe'",
                         "get", "ProcessId,CommandLine", "/FORMAT:CSV"],
                        capture_output=True, text=True, timeout=30,
                    )
                    found = parse_cim_csv(out.stdout)
                except Exception:
                    found = []
        else:
            out = subprocess.run(["ps", "-eo", "pid,args"],
                                 capture_output=True, text=True, timeout=15)
            found = parse_ps_output(out.stdout)
    except Exception:
        return []
    return [(pid, cmd) for pid, cmd in found if pid != own and _is_botting_cmd(cmd)]


def terminate_pid(pid: int, wait_s: float = 5.0) -> Tuple[bool, str]:
    """Terminates a local process (graceful first, force on Windows)."""
    try:
        if os.name == "nt":
            r = subprocess.run(["taskkill", "/PID", str(int(pid)), "/F"],
                               capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return True, f"pid {pid} taskkilled"
            return False, f"taskkill pid {pid} failed: {(r.stderr or r.stdout).strip()[:200]}"
        os.kill(int(pid), sigmod.SIGTERM)
        deadline = time.time() + max(1.0, wait_s)
        while time.time() < deadline:
            if not runlock.is_pid_alive(pid):
                return True, f"pid {pid} terminated"
            time.sleep(0.5)
        os.kill(int(pid), sigmod.SIGKILL)
        return True, f"pid {pid} killed after SIGTERM timeout"
    except Exception as e:  # noqa: BLE001
        return False, f"kill pid {pid} failed: {e}"


def kill_local(bot_ids=None) -> List[str]:
    """Terminates local botting processes (lock owners + strays).

    ``bot_ids`` None means every lock. Never touches this process itself.
    Always writes stop signals so loops that ignore termination still exit.
    """
    rep: List[str] = []
    locks = runlock.list_locks()
    if bot_ids is not None:
        locks = {b: info for b, info in locks.items() if b in set(bot_ids)}
    pids: dict = {}
    for bot_id, info in locks.items():
        pid = info.get("pid")
        if isinstance(pid, int) and pid != os.getpid() and runlock.is_pid_alive(pid):
            pids[pid] = f"lock bot {bot_id} ({info.get('script', '?')})"
    for pid, cmd in local_botting_processes():
        if pid not in pids:
            pids[pid] = f"stray: {cmd[:120]}"
    if not pids:
        rep.append("no local botting processes found")
    for pid, why in sorted(pids.items()):
        ok, msg = terminate_pid(pid)
        rep.append(f"{msg} [{why}]")
    for bot_id, info in locks.items():
        if not runlock.is_pid_alive(info.get("pid", -1)):
            if runlock.discard(bot_id):
                rep.append(f"removed stale lock for bot {bot_id}")
    for bot_id in locks:
        try:
            stopsig.request_stop(bot_id)
            rep.append(f"local stop signal written for bot {bot_id}")
        except Exception as e:  # noqa: BLE001
            rep.append(f"stop signal for bot {bot_id} FAILED: {e}")
    if bot_ids is None:
        try:
            stopsig.request_stop()
            rep.append("global stop signal written")
        except Exception as e:  # noqa: BLE001
            rep.append(f"global stop signal FAILED: {e}")
    return rep


def print_status(server_bots=None, server_error: str = "") -> None:
    print("[Status] -- server bots --")
    if server_error:
        print(f"[Status] server unreachable: {server_error}")
    elif not server_bots:
        print("[Status] no bots running on the server")
    else:
        for b in server_bots:
            print(
                f"[Status] id={b.bot_id} user={b.username!r} status={b.status!r} "
                f"world={b.world!r} pos=({b.pos_x:.0f},{b.pos_y:.0f})"
            )
    print("[Status] -- local botting processes --")
    procs = local_botting_processes()
    if not procs:
        print("[Status] none found")
    for pid, cmd in procs:
        print(f"[Status] pid={pid} cmd={cmd[:160]}")
    print("[Status] -- run locks --")
    locks = runlock.list_locks()
    if not locks:
        print("[Status] none")
    for bot_id in sorted(locks):
        info = locks[bot_id]
        alive = runlock.is_pid_alive(info.get("pid", -1))
        age = max(0.0, time.time() - float(info.get("heartbeat", time.time())))
        print(
            f"[Status] bot {bot_id}: pid={info.get('pid')} "
            f"script={info.get('script', '?')} alive={alive} "
            f"last_heartbeat={age:.0f}s ago"
        )
    print("[Status] -- stop signals --")
    sigs = stopsig.list_signals()
    if not sigs:
        print("[Status] none")
    for bot_id, mtime in sigs:
        who = "all bots" if bot_id is None else f"bot {bot_id}"
        print(f"[Status] {who}: {stopsig.signal_age_s(mtime):.0f}s old")


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Force-stop all bot activity via Mori gRPC")
    p.add_argument("--host", type=str, help="Mori gRPC host (default: MORI_GRPC_ADDR or 127.0.0.1)")
    p.add_argument("--port", type=int, help="Mori gRPC port (default: 50051)")
    p.add_argument("--token", type=str, help="Mori gRPC auth token (default: MORI_GRPC_TOKEN)")
    p.add_argument("--bot-id", type=int, help="Only stop this bot id (default: every bot)")
    p.add_argument("--leave", action="store_true", help="Also leave the world")
    p.add_argument("--disconnect", action="store_true", help="Also disconnect (stays offline)")
    p.add_argument("--stop-bot", action="store_true", help="Also stop (remove) the bot")
    p.add_argument("--status", action="store_true",
                   help="Only show stacking diagnostics (server bots, local "
                        "processes, locks, signals); change nothing")
    p.add_argument("--no-kill-local", action="store_true",
                   help="Do not terminate local botting processes (only send signals and server halt)")
    p.add_argument("--kill-local", action="store_true", default=True,
                   help="Terminate local botting processes (lock owners + strays; enabled by default)")
    return p


def main() -> None:
    load_dotenv()
    args = build_arg_parser().parse_args()
    should_kill_local = not args.no_kill_local

    host = args.host or os.environ.get("MORI_HOST", "192.168.193.66") or "192.168.193.66"
    env_addr = os.environ.get("MORI_GRPC_ADDR", "")
    port = args.port
    if port is None:
        if env_addr and ":" in env_addr:
            try:
                port = int(env_addr.rpartition(":")[2])
            except ValueError:
                port = 50051
        else:
            port_env = os.environ.get("MORI_GRPC_PORT", "50051")
            port = int(port_env) if port_env.isdigit() else 50051
    token = args.token or os.environ.get("MORI_GRPC_TOKEN", "")
    addr = f"{host}:{port}"

    print(f"[StopAll] connecting to Mori at {addr} ...")
    client = MoriClient(addr, token)
    server_error = ""
    bots = None
    try:
        client.connect()
        bots = client.list_bots()
    except grpc.RpcError as e:
        if e.code() == grpc.StatusCode.UNAUTHENTICATED:
            print(
                "[StopAll] server requires auth — set MORI_GRPC_TOKEN or pass --token",
                file=sys.stderr,
            )
        else:
            print(f"[StopAll] cannot reach Mori: {e.code()} {e.details()}", file=sys.stderr)
        server_error = str(e)

    if args.status:
        print_status(bots, server_error)
        sys.exit(0 if bots is not None else 1)

    if bots is None:
        # Server unreachable / auth failed, but always signal and clean up local loops.
        try:
            if args.bot_id is not None:
                stopsig.request_stop(args.bot_id)
            else:
                stopsig.request_stop()
        except Exception as e:
            print(f"[StopAll] warning: cannot write stop signal: {e}", file=sys.stderr)

        if should_kill_local:
            for line in kill_local(
                [args.bot_id] if args.bot_id is not None else None
            ):
                print(f"[StopAll] {line}")
        sys.exit(1)

    if not bots:
        print("[StopAll] no bots running — nothing to stop on server")
        if should_kill_local:
            for line in kill_local(
                [args.bot_id] if args.bot_id is not None else None
            ):
                print(f"[StopAll] {line}")
        sys.exit(0)

    if args.bot_id is not None:
        targets = [b.bot_id for b in bots if b.bot_id == args.bot_id]
        if not targets:
            print(
                f"[StopAll] bot id {args.bot_id} not found "
                f"(running: {[b.bot_id for b in bots]})",
                file=sys.stderr,
            )
            if should_kill_local:
                for line in kill_local([args.bot_id]):
                    print(f"[StopAll] {line}")
            sys.exit(1)
    else:
        targets = [b.bot_id for b in bots]
        try:
            stopsig.request_stop()  # global signal: halts every local loop
        except Exception as e:  # noqa: BLE001
            print(f"[StopAll] warning: cannot write global stop signal: {e}", file=sys.stderr)

    failed = 0
    for bot_id in targets:
        try:
            client.select_bot(bot_id)
        except (BotNotFoundError, NoBotsError) as e:
            print(f"[StopAll] {e}", file=sys.stderr)
            failed += 1
            continue
        ok, rep = halt_bot(
            client,
            leave=args.leave,
            disconnect=args.disconnect,
            stop_bot=args.stop_bot,
        )
        for line in rep:
            print(f"[StopAll] {line}")
        if not ok:
            failed += 1

    client.close()

    if should_kill_local:
        for line in kill_local(
            [args.bot_id] if args.bot_id is not None else None
        ):
            print(f"[StopAll] {line}")

    if failed:
        print(f"[StopAll] {failed}/{len(targets)} bot(s) had failures", file=sys.stderr)
        sys.exit(2)

    print(f"[StopAll] halted {len(targets)} bot(s)")


if __name__ == "__main__":
    main()
