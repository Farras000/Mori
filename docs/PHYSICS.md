# Growtopia Client Physics & Movement Specification

## 1. Overview & Architecture

This document specifies the exact 2D platformer physics model used by the Growtopia game client (based on Robinson Technologies' Proton SDK) and its implementation within the **Mori** framework.

In standard Growtopia gameplay, character movement is client-simulated and server-synchronized:
1. The client runs a continuous fixed-timestep physics loop calculating position, horizontal velocity, vertical gravity, friction, drag, and collision against tile bounding boxes.
2. The client periodically transmits `GameUpdatePacket` of type `GamePacketType::State` (0x00) containing the current sub-pixel coordinates `(vector_x, vector_y)`, the active velocity vectors `(vector_x2, vector_y2)`, and state bitflags (`WALK`, `STANDING`, `JUMP`, `SWIM`, `TRAMPOLINE`, etc.).
3. The server validates movement boundaries, enforces anti-cheat rules (e.g. speed thresholds and wall clipping), and dictates environmental physics parameters via `GamePacketType::SetCharacterState` (`vector_x2` for world gravity, `vector_y2` for character velocity scaling).

---

## 2. World Coordinate System & Hitboxes

* **Tile Dimensions**: $32.0 \times 32.0$ pixels per tile.
* **Standard World Size**: 100 tiles wide by 60 tiles high ($3200 \times 1920$ pixels).
* **Player Axis-Aligned Bounding Box (AABB)**:
  * Width: $20.0\text{ px}$ (centered horizontally within a 32px tile, offset by $6.0\text{ px}$).
  * Height: $30.0\text{ px}$ (offset from the tile top by $2.0\text{ px}$).
  * Bounding Box bounds:
    $$\text{left} = x + 6.0, \quad \text{right} = x + 26.0$$
    $$\text{top} = y + 2.0, \quad \text{bottom} = y + 32.0$$

---

## 3. Physical Constants & Equations

### Default Constants
| Parameter | Default Value | Unit | Controlled By |
|---|---|---|---|
| **Base Gravity** | $1000.0$ to $1200.0$ | $\text{px/s}^2$ | Server `SetCharacterState.vector_x2` / Weather / Items |
| **Base Walk Speed** | $250.0$ to $300.0$ | $\text{px/s}$ | Server `SetCharacterState.vector_y2` / Items |
| **Jump Impulse** | $-420.0$ to $-460.0$ | $\text{px/s}$ | Standard Jump Height ($\approx 2.7$ tiles) |
| **Terminal Velocity** | $1000.0$ | $\text{px/s}$ | Maximum downward fall speed |
| **Ground Friction** | $0.80$ to $0.85$ | per tick | Deceleration on solid surfaces |
| **Ice Friction** | $0.98$ | per tick | Slippery deceleration |
| **Air Resistance** | $0.92$ | per tick | Horizontal drift dampening |
| **Water Drag** | $0.45$ | factor | Dampening on gravity and horizontal velocity |
| **Water Upward Speed** | $-180.0$ | $\text{px/s}$ | Buoyant swim impulse |

### Kinematic Equations (per tick $\Delta t$)
1. **Horizontal Acceleration & Friction**:
   * Moving Right: $v_x = \min(v_x + \text{accel} \cdot \Delta t, \text{walk\_speed})$
   * Moving Left: $v_x = \max(v_x - \text{accel} \cdot \Delta t, -\text{walk\_speed})$
   * Idling (Friction): $v_x = v_x \cdot \text{friction}^{\Delta t \cdot 60}$
2. **Vertical Gravity**:
   * If airborne: $v_y = \min(v_y + \text{gravity} \cdot \Delta t, \text{terminal\_velocity})$
   * Jumping: if `on_ground` and `jump_pressed`, $v_y = \text{jump\_impulse}$
3. **Position Integration**:
   $$x_{t+1} = x_t + v_x \cdot \Delta t$$
   $$y_{t+1} = y_t + v_y \cdot \Delta t$$

---

## 4. Tile Collision Mechanics

Collision resolution uses Swept AABB checks against neighboring tiles within the player's potential displacement bounding envelope:

| Collision Type | Behavior | Description |
|---|---|---|
| `0` (None) | Passable | Air, background, collectibles |
| `1` (Solid) | Full AABB Blocking | Collides on Left, Right, Top, and Bottom |
| `2` (Platform) | One-Way Top | Only blocks downward motion ($v_y \ge 0$) when player's feet were previously $\le \text{platform\_top}$. Down-key passes through |
| `3, 10, 11` | Gateway / Gate | Solid unless the user holds world/door lock permissions or is open |
| `4` (Toggle) | Dynamic Solid | Solid when `TileFlags::IS_ON` is true |
| `5` (One-Way) | Directional Wall | Solid in one direction, passable in opposite based on `TileFlags::FLIPPED_X` |
| `7` (Down-Only) | Vertical Pass | Only passable downwards |
| `9` (Invert Toggle)| Dynamic Solid | Solid when `TileFlags::IS_ON` is false |
| Trampoline | Bouncy | Reflects $v_y = -v_y \times \text{bounce\_coeff}$, sets `TRAMPOLINE` flag |
| Water / Slime | Viscous | Applies drag, enables swimming controls, sets `SWIM` flag |

---

## 5. Packet Flag Lifecycle

When sending movement updates to the server via `GamePacketType::State`:

| Bitfield Flag | Hex Value | Set Condition |
|---|---|---|
| `WALK` | `0x0000_0001` | $|v_x| > 1.0$ (player in horizontal motion) |
| `FACING_LEFT` | `0x0000_0010` | Moving or looking to the left |
| `STANDING` | `0x0000_0020` | `on_ground == true` (resting on solid/platform) |
| `JUMP` | `0x0000_0080` | `is_jumping == true` ($v_y < 0$ in the air) |
| `TRAMPOLINE` | `0x0000_8000` | Recently rebounded from a bouncy tile |
| `SLIDE` | `0x0002_0000` | Sliding along ice or slippery surfaces |
| `SWIM` | `0x0010_0000` | Submerged in water |

---

## 6. Mori Physics Architecture

The physics engine is implemented in Rust under `src/physics/`:
* `src/physics/mod.rs`: Module exports and high-level types.
* `src/physics/config.rs`: Physics configuration parameters (gravity, speeds, friction, hitboxes).
* `src/physics/state.rs`: Position, velocity, flags, and contact state.
* `src/physics/collision.rs`: Tile collision detection, raycasting, and swept AABB resolution.
* `src/physics/controller.rs`: Step-by-step physics simulation driving bot inputs toward target waypoints.

---

## 7. Interactive Native Game Mode Physics Loop (`tick_interactive`)

For browser gameplay on `/game`, Mori integrates a dedicated 50 Hz real-time physics tick loop inside the bot execution cycle (`tick_interactive` in `src/bot/core.rs`):

1. **Sub-Pixel Movement & Velocity Integration**:
   * Instead of snapping whole tiles or using discrete tile hops, key presses (`A` / `D`) apply continuous horizontal acceleration ($1200\text{ px/s}^2$) clamped to max speed ($250\text{ px/s}$).
   * A single quick tap of `D` moves the player by only a fraction of a block ($\approx 4\text{ px}$ per tick), exactly matching native Growtopia feel.
2. **Continuous Real-Time Gravity**:
   * Downward acceleration ($1100\text{ px/s}^2$) is applied every tick unless resting on solid ground (`on_ground == true`).
   * Jumping with `W` or `Space` gives an instant vertical impulse ($v_y = -440\text{ px/s}$), creating natural parabolic arcs that automatically land and stop on collision floors.
3. **Bandwidth-Optimized State Synchronization**:
   * The client transmits State packets to the server when moving at a rate-limited 20 Hz (every 50 ms) or immediately upon state transitions (landing, jumping, stopping).
   * WebSocket pushes position updates at 50 Hz to the browser canvas without triggering React state re-renders.
4. **Non-Blocking Continuous Action Scheduler**:
   * Holding down the mouse button queues continuous block breaking/placing at target coordinates.
   * Actions are dispatched using `send_tile_action()` without sleeping the thread, preventing physics stutters.
