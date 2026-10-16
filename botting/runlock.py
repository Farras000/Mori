"""Single-instance run locks for Mori botting scripts.

One bot must have exactly one local driver: two ``clear_world.py`` processes
on the same ``bot_id`` send interleaved ``WalkTo``/``Hit`` RPCs and the bot
zig-zags no matter how good the sweep logic is. A lock file per bot at
``botting/.run/<bot_id>.json`` records ``{pid, script, started, heartbeat}``.

- :func:`acquire` refuses when the owner PID is alive (identify it in the
  message so the operator can kill it). A lock whose PID is dead is taken
  over. ``takeover=True`` first asks the owner to exit gracefully via a
  per-bot stop signal and waits up to ``wait_s``.
- :func:`refresh` renews the heartbeat, but only when the caller really is
  the owner (PID match) — no token plumbing needed.
- ``MORI_RUN_DIR`` overrides the lock directory (used by tests).

Liveness check direction is fail-safe: when in doubt the PID counts as
*alive* (refuse stacking) rather than dead.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, Optional, Tuple

_DEFAULT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".run")
_HEARTBEAT_TTL_S = 5.0


def run_dir() -> str:
    return os.environ.get("MORI_RUN_DIR", "") or _DEFAULT_DIR


def _path(bot_id: int) -> str:
    return os.path.join(run_dir(), f"{int(bot_id)}.json")


def is_pid_alive(pid: int) -> bool:
    """True when a process with this PID exists (fail-safe: True on error)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return exit_code.value == 259  # STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            try:
                out = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                for line in (out.stdout or "").splitlines():
                    parts = [p.strip().strip('"') for p in line.split('","')]
                    if len(parts) >= 2 and parts[1] == str(pid):
                        return True
                return False
            except Exception:
                return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return True
    return True


def read_lock(bot_id: int) -> Optional[Dict[str, Any]]:
    try:
        with open(_path(bot_id), "r", encoding="utf-8") as f:
            info = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None
    return info if isinstance(info, dict) else None


def _write_lock(bot_id: int, script: str) -> Dict[str, Any]:
    os.makedirs(run_dir(), exist_ok=True)
    info = {
        "pid": os.getpid(),
        "script": script,
        "started": time.time(),
        "heartbeat": time.time(),
    }
    tmp = _path(bot_id) + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.replace(tmp, _path(bot_id))
    return info


def _describe(info: Dict[str, Any]) -> str:
    age = max(0.0, time.time() - float(info.get("started", time.time())))
    hb = max(0.0, time.time() - float(info.get("heartbeat", time.time())))
    return (
        f"pid={info.get('pid')} script={info.get('script', '?')} "
        f"age={age:.0f}s last_heartbeat={hb:.0f}s ago"
    )


def acquire(
    bot_id: int,
    script: str = "clear_world",
    takeover: bool = False,
    wait_s: float = 20.0,
) -> Tuple[bool, str]:
    """Takes the run lock for ``bot_id``. Returns (ok, message/info)."""
    existing = read_lock(bot_id)
    if existing is not None:
        owner = existing.get("pid")
        if owner == os.getpid():
            _write_lock(bot_id, script)
            return True, "re-acquired own lock"
        if owner is not None and is_pid_alive(owner):
            if not takeover:
                return False, f"already owned by {_describe(existing)}"
            from botting import stop as stopsig  # lazy: avoid import cycle

            stopsig.request_stop(bot_id)
            deadline = time.time() + max(1.0, wait_s)
            while time.time() < deadline:
                time.sleep(1.0)
                cur = read_lock(bot_id)
                if cur is None:
                    break
                if cur.get("pid") != owner or not is_pid_alive(cur.get("pid")):
                    break
            else:
                return False, f"owner still alive after takeover wait: {_describe(existing)}"
            cur = read_lock(bot_id)
            if cur is not None and cur.get("pid") not in (None, os.getpid(), owner):
                return False, f"lock changed hands during takeover: {_describe(cur)}"
            if cur is not None and cur.get("pid") == owner and is_pid_alive(owner):
                return False, f"owner still alive after takeover wait: {_describe(existing)}"
        # Owner dead (or lock stale): fall through and take over.
    _write_lock(bot_id, script)
    return True, "lock acquired"


_last_refresh: Dict[int, float] = {}


def refresh(bot_id: int) -> bool:
    """Renews the heartbeat when this process owns the lock (throttled)."""
    now = time.time()
    if now - _last_refresh.get(int(bot_id), 0.0) < _HEARTBEAT_TTL_S:
        return True
    info = read_lock(bot_id)
    if info is None or info.get("pid") != os.getpid():
        return False
    info["heartbeat"] = now
    try:
        os.makedirs(run_dir(), exist_ok=True)
        with open(_path(bot_id), "w", encoding="utf-8") as f:
            json.dump(info, f)
    except OSError:
        return False
    _last_refresh[int(bot_id)] = now
    return True


def release(bot_id: int) -> bool:
    """Releases the lock, but only when this process owns it."""
    try:
        info = read_lock(bot_id)
    except Exception:
        return False
    if info is None or info.get("pid") != os.getpid():
        return False
    try:
        os.remove(_path(bot_id))
    except OSError:
        return False
    _last_refresh.pop(int(bot_id), None)
    return True


def discard(bot_id: int) -> bool:
    """Force-removes a lock file regardless of owner (dead-owner cleanup)."""
    try:
        os.remove(_path(bot_id))
    except OSError:
        return False
    _last_refresh.pop(int(bot_id), None)
    return True


def list_locks() -> Dict[int, Dict[str, Any]]:
    """All lock files by bot id (best effort)."""
    out: Dict[int, Dict[str, Any]] = {}
    try:
        names = os.listdir(run_dir())
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            bot_id = int(name[: -len(".json")])
        except ValueError:
            continue
        info = read_lock(bot_id)
        if info is not None:
            out[bot_id] = info
    return out


if __name__ == "__main__":
    print(f"run dir: {run_dir()}", file=sys.stderr)
    for bot_id, info in sorted(list_locks().items()):
        alive = is_pid_alive(info.get("pid", -1))
        print(f"bot {bot_id}: {_describe(info)} alive={alive}")
