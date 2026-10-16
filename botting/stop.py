"""Local stop-signal helpers for Mori botting scripts.

`stop_all.py` (or any operator) drops a signal file here; long-running local
loops such as ``ClearWorldRunner`` check :func:`should_stop` every iteration
and exit gracefully. This is what actually halts a *locally running* Python
script — the gRPC ``StopScript`` RPC only stops server-side Lua.

Files live in ``botting/.stop/``: ``all`` halts every bot, ``<bot_id>``
halts one bot. Signals are one-shot: :func:`clear_stop` removes them (the
clear-world runner clears stale signals for itself on startup).
"""

from __future__ import annotations

import os
import time
from typing import List, Optional, Tuple

_STOP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".stop")


def _path(bot_id: Optional[int] = None) -> str:
    name = "all" if bot_id is None else str(int(bot_id))
    return os.path.join(_STOP_DIR, name)


def request_stop(bot_id: Optional[int] = None) -> str:
    """Drops a stop signal (global when ``bot_id`` is None). Returns the path."""
    os.makedirs(_STOP_DIR, exist_ok=True)
    path = _path(bot_id)
    with open(path, "w", encoding="utf-8") as f:
        f.write("stop\n")
    return path


def clear_stop(bot_id: Optional[int] = None) -> None:
    """Removes a stop signal, if present."""
    try:
        os.remove(_path(bot_id))
    except FileNotFoundError:
        pass
    except OSError:
        pass


def should_stop(bot_id: Optional[int] = None) -> bool:
    """True when a global stop — or one for this ``bot_id`` — is pending."""
    if os.path.exists(_path(None)):
        return True
    if bot_id is not None and os.path.exists(_path(bot_id)):
        return True
    return False


def list_signals() -> List[Tuple[Optional[int], float]]:
    """Pending signals as (bot_id or None for global, mtime). Best effort."""
    out: List[Tuple[Optional[int], float]] = []
    try:
        names = os.listdir(_STOP_DIR)
    except OSError:
        return out
    for name in names:
        bot_id: Optional[int] = None if name == "all" else None
        if name != "all":
            try:
                bot_id = int(name)
            except ValueError:
                continue
        try:
            mtime = os.path.getmtime(os.path.join(_STOP_DIR, name))
        except OSError:
            continue
        out.append((bot_id, mtime))
    out.sort(key=lambda t: (t[0] is not None, t[0] or 0))
    return out


def signal_age_s(mtime: float) -> float:
    return max(0.0, time.time() - mtime)
