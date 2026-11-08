# Native Web Gameplay & Browser Client Specification

## 1. Overview & Architecture

Mori includes a dedicated **Native Web Game Mode** accessible via the `/game` route or the **"Go to Game"** / **"Play in Game"** buttons on the dashboard. This interface transforms Mori into a playable Growtopia client directly within any modern web browser.

The browser client communicates over Mori's high-speed local WebSocket and REST API to synchronize world geometry, players, floating items, chat, inventory, and server dialogs in real-time.

```
┌────────────────────────────────────────────────────────┐
│                   Web Browser (/game)                  │
│  ┌────────────────────┐  ┌──────────────────────────┐  │
│  │   PixiJS Canvas    │  │     Chat HUD Overlay     │  │
│  │  (Tiles & Players) │  │  (GT Color Code Parser)  │  │
│  └────────────────────┘  └──────────────────────────┘  │
│  ┌────────────────────┐  ┌──────────────────────────┐  │
│  │  Tool Toolbar      │  │  Inventory Quickbar      │  │
│  │  (Punch / Wrench)  │  │  (1-8 Slots + Backpack)  │  │
│  └────────────────────┘  └──────────────────────────┘  │
└───────────────────────────▲────────────────────────────┘
                            │ WebSocket / REST API
┌───────────────────────────▼────────────────────────────┐
│                    Mori Rust Backend                   │
│  ┌────────────────────┐  ┌──────────────────────────┐  │
│  │   Physics Engine   │  │    ENet Packet Router    │  │
│  │   (50 Hz Loop)     │  │   (Variant & State Pack) │  │
│  └────────────────────┘  └──────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 2. Keybinds & Controls

| Action | Primary Key | Secondary / Alternative |
|---|---|---|
| **Walk Left** | `A` | `Left Arrow` |
| **Walk Right** | `D` | `Right Arrow` |
| **Jump / Swim Up** | `W` | `Space` / `Up Arrow` |
| **Drop Platform / Swim Down** | `S` | `Down Arrow` |
| **Mouse Hold / Click Punch** | `Left Click` | Hold & drag across blocks to continuously punch |
| **Tool: Punch / Fist** | `1` | Click hotbar slot 1 |
| **Tool: Wrench** | `2` | Click hotbar slot 2 |
| **Wrench Player / Self** | Left Click with Wrench | Click self AABB or other player in canvas |
| **Place / Use Item** | Left Click with Item | Click target tile (Reach $\le 4$ tiles or custom) |
| **Open Backpack** | `B` | Click Backpack icon next to hotbar |
| **ESC Menu (In-Game Menu)** | `Escape` | Opens GT Menu: Continue, Respawn, Exit World, Options |
| **Chat Input** | `Enter` | Focuses bottom chat box |

---

## 3. Interactive In-Game Features

### 3.1. ESC Native Menu & Navigation
* Pressing `Escape` (or clicking the top-right Menu button) brings up the native Growtopia game menu modal:
  * **Resume / Continue Game**: Returns to current gameplay.
  * **Respawn**: Triggers `respawn` command (equivalent to suicide/respawn in native GT).
  * **Exit World**: Leaves the current world (`warp "exit"`) and transitions to the World Select screen.
  * **Game Options**: Toggle Extended Reach slider (4 to 20 tiles) and non-physics through-wall collection.
  * **Back to Dashboard**: Exits interactive mode and navigates back to `/overview`.
* When dialogs or modals are open, `Escape` hierarchically closes dialogs first before opening the ESC menu.

### 3.2. Graphical Inventory & Item Sprites
* Inventory slots render high-fidelity cropped sprite textures directly extracted from item spritesheets (`items_tiles_pageX.png`) and fallback canvas previews.
* Displays slot counts with standard format (`x99`, `x200`).
* Hotbar slots (1–8) are quick-selectable via number keys or clicks.
* Clicking the **Backpack** button (`B`) opens the full bag inventory dialog with real-time text filter/search and instant item action triggers (Wrench, Place, Drop, Trash).

### 3.3. World Select UI (Exit World State)
* When in `EXIT` state or outside any world, the game view automatically switches to the full Growtopia World Select screen:
  * **Search & Warp Bar**: Enter destination world name and optional Door ID (`TARGET|DOOR`), with Enter key warp.
  * **Recently Visited**: Automatically tracks visited worlds in browser `localStorage` for one-click re-entry.
  * **Server World Directory**: Parses `OnRequestWorldSelectMenu` packets into categorized sections ("Your Worlds", "Recently Visited", "Popular Worlds").
  * **Quick Presets**: Fast-warp buttons for START, RADIO, BUYGHC, etc.

### 3.4. Continuous Mouse Punch & Drag-Mining
* **Left Click**: Instant punch or place at target tile coordinates.
* **Hold & Drag**: Holding mouse down sends continuous hold actions to the backend scheduler, allowing native continuous block breaking as the cursor sweeps across blocks.
* Non-blocking packet dispatcher (`send_tile_action`) ensures physics and position updates remain at a rock-solid 50 Hz without thread sleeping.

### 3.5. Wrench Self & Other Players
* With the Wrench tool equipped (slot 2):
  * Clicking own player sprite or bounds triggers `wrench_player(bot.net_id)` to open your own profile dialog.
  * Clicking another player's bounding box triggers `wrench_player(target.net_id)` to inspect their stats and permissions.
  * Clicking locks, vending machines, or doors opens their configuration dialogs.

### 3.6. Overhead Nametags & Player Rendering
* Overhead nametags are dynamically positioned above each player's sprite inside the world canvas.
* Growtopia rank colors are automatically recognized:
  * Turquoise / White for standard players.
  * Gold / Yellow for moderators.
  * Cyan / Red for world owners / administrators.
* Smooth character animation with facing direction flipping, walking bob, and punch swing effects.

### 3.7. Real-Time Chat HUD
* Translucent chat overlay positioned in the lower-left corner of the screen, matching the native PC/mobile client layout.
* Parses and renders Growtopia color codes (`#0` through `#9`, `#b`, `#c`, `#d`, `#e`, `#o`, `#p`, `##`).
* Supports sending public world messages (`api.sendCmd(botId, { type: 'chat', text })`).

### 3.8. Interactive Dialogs & Auto-Dismiss Prevention
In standard botting workflows, non-interactive notifications or captcha alerts are automatically managed. For native gameplay, dialogs requiring user decisions are identified as **interactive** and **never auto-dismissed**:
* **Vending Machines**: Select quantity, see per-item gem price, purchase items.
* **World Locks / Small Locks**: Grant/revoke access to other players, toggle public access.
* **Doors & Portals**: Enter target world name or door password.
* **Player Profile**: View player level, install date, achievements, and access controls.
* **Backpack Drop / Trash**: Set item quantities for dropping or recycling.

---

## 4. Non-Physics & Extended Auto-Collect

In native Growtopia platformer physics, player collection range is strictly constrained to adjacent tiles ($\le 5$ tiles) with mandatory Line of Sight (LOS) swept raycasting. Mori includes an optional **Non-Physics Extended Range** mode configurable in the Overview tab and ESC Options.

### Features
1. **Extended Radius (>5 Tiles)**:
   * When enabled via the **"Non-Physics / Extended Range"** switch, the collection radius can be configured up to **20 tiles** away ($41 \times 41$ tile bounding area).
   * Quick presets: `5 tiles`, `8 tiles`, `10 tiles`, `15 tiles`, and `20 tiles (Max)`.
   * Slider for fine-grained distance configuration.
2. **Through-Wall Collection (Bypass Obstacles)**:
   * Toggle **"Tembus Dinding (Through-Wall Collection)"** to bypass solid blocks, bedrock, doors, and barriers.
   * Sends `{ type: "set_collect_path_check", enabled: false }` to the bot core.
   * The bot vacuums all floating items within radius regardless of physical walls.

---

## 5. API Reference for Game Controls

### 5.1. REST Command Endpoints (`POST /api/bots/:id/cmd`)

| Command Type | Payload | Description |
|---|---|---|
| `set_interactive` | `{ "type": "set_interactive", "enabled": boolean }` | Toggles 50 Hz interactive physics engine |
| `set_input` | `{ "type": "set_input", "keys": number }` | Sends WASD/Arrow bitmask (`1=Up, 2=Right, 4=Down, 8=Left`) |
| `hold_action` | `{ "type": "hold_action", "holding": boolean, "tool": number, "x": number, "y": number }` | Schedules continuous punch/place while held |
| `set_action_reach` | `{ "type": "set_action_reach", "reach": number }` | Configures tile reach limit (default 4 tiles) |
| `interactive_heartbeat` | `{ "type": "interactive_heartbeat" }` | Keeps interactive mode alive (auto-timeouts after 5s) |
| `respawn` | `{ "type": "respawn" }` | Triggers player respawn |
| `leave_world` | `{ "type": "leave_world" }` | Leaves world to `exit` menu |
| `hit` | `{ "type": "hit", "x": number, "y": number }` | Punches or punches a block/tree at `(x, y)` |
| `place` | `{ "type": "place", "x": number, "y": number, "item_id": number }` | Places block or uses consumable at `(x, y)` |
| `wrench` | `{ "type": "wrench", "x": number, "y": number }` | Wrenches a tile (vending machine, lock, door, seed) |
| `wrench_player` | `{ "type": "wrench_player", "net_id": number }` | Opens wrench dialog for player with `net_id` |
| `set_collect_config` | `{ "type": "set_collect_config", "radius_tiles": number, "blacklist": number[] }` | Sets collection radius (1–20) and blacklist |
| `set_collect_path_check`| `{ "type": "set_collect_path_check", "enabled": boolean }` | Toggles Line-of-Sight wall raycasting |
| `chat` | `{ "type": "chat", "text": string }` | Sends public in-game chat message |
| `dialog_reply` | `{ "type": "dialog_reply", "content": string }` | Submits input or buttons in an active dialog |
