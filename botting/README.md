# Mori Botting — Growtopia Clear World Script

An automated, physics-compliant, anti-cheat safe **Clear World** script for Growtopia, powered by Mori's external gRPC control plane.

---

## Key Features

1. **Strict Growtopia Physics & Anti-Cheat Compliance**:
   - **Anti-Float (Foothold Validation)**: Bot only walks on tiles that are supported by solid ground beneath (`y + 1`). Multi-tile pathing never cuts across mid-air.
   - **Anti-Teleport (Single-Step Adjacent Movement)**: Bot steps exactly 1 tile at a time (`|dx| + |dy| == 1`) using `WalkTo` with natural movement pacing (`walk_delay_ms >= 180-200ms`, ~5 tiles/sec), well below the server's anomaly detection threshold (~7.5–10 tiles/sec).
   - **Gravity & Settle**: If blocks beneath the bot are destroyed, the bot settles downward tile-by-tile onto solid ground.
   - **Vanilla Punch Range**: Hits are limited to valid reach (`abs(dx) <= 3, abs(dy) <= 3, abs(dx) + abs(dy) <= 4`). Hit delays default to `~180ms`.
2. **Top-to-Bottom Layer Clearing**:
   - Clears from the topmost layer (smallest Y) to bottom. This ensures the bot always stands on solid footholds without floating or needing to jump.
   - Clears foreground first, then background.
3. **Obstacle & Lock Protection**:
   - **World Lock (ID 242)** and all small/big/huge/diamond/blue gem/robotic locks are strictly protected and never punched.
   - **Bedrock (ID 8)** and **Main Door (ID 6)** are protected.
   - Background tiles behind unbreakable foreground obstacles are recognized as unreachable and skipped.
4. **Stuck Detection & Auto-Respawn Recovery**:
   - If the bot gets trapped or cannot find a grounded path to remaining targets, it executes `Respawn(BotRef)` to safely return to the world spawn door and recalculates paths from there.
5. **Auto-Collection**:
   - Periodically collects dropped gems and seeds within reach.

---

## Target Blocks

- **Dirt**: ID `2` (Foreground)
- **Lava**: ID `4` (Foreground)
- **Rock / Granite**: ID `10` (Foreground)
- **Cave Background**: ID `14` (Background)

*(Customizable via `--blocks` flag or `.env`)*

---

## Setup & Installation

Install dependencies:
```bash
pip install -r botting/requirements.txt
```

Ensure `.env` in the repository root has your server address and token (if auth is enabled):
```env
MORI_GRPC_ADDR=127.0.0.1:50051
MORI_GRPC_TOKEN=your_token_here
```

---

## Running the Clear World Script

Basic usage (uses `.env` defaults and automatically attaches to the first in-game bot):
```bash
python botting/clear_world.py
```

Targeting a specific bot ID:
```bash
python botting/clear_world.py --bot-id 1
```

Custom host, port, or blocks:
```bash
python botting/clear_world.py --host 127.0.0.1 --port 50051 --blocks 2,4,10,14
```

Adjusting walk and punch delays:
```bash
python botting/clear_world.py --walk-delay 200 --punch-delay 180
```

---

## Running Unit Tests

Run the physics and navigator test suite:
```bash
python -m unittest discover -s botting/tests -p "test_*.py" -v
```
