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
| **Tool: Punch / Fist** | `1` / `Q` | Click hotbar slot 1 |
| **Tool: Wrench** | `2` / `E` | Click hotbar slot 2 (or `Right Click` anytime) |
| **Wrench Self (Profile)** | `R` | `Shift + Left/Right Click` on self, or click `Self (R)` button |
| **Enter Door / Portal** | `F` | `Double Click` Door tile, or click HUD `Enter [F]` button |
| **Wrench Tile / Player** | `Left Click` (Wrench) / `Right Click` | Interactive tiles (Vending Machine, Door, Lock) take priority over self; hold `Alt` to wrench a tile behind another player |
| **Place / Use Item** | `Left Click` with Item | Click target tile within reach |
| **Hotbar Slots 3–8** | `3` – `8` | Quick-select pinned or usable backpack items |
| **Open Backpack** | `B` | Click Backpack icon next to hotbar |
| **ESC Menu (In-Game Menu)** | `Escape` | Closes open popups first, then opens GT Menu |
| **Chat Input** | `Enter` | Focuses / sends bottom-left chat box |

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

### 3.5. Wrench Priority, Self Profile & Door Entry
* With the Wrench tool equipped (`2` / `E`) or on `Right Click` anywhere in reach:
  * **Interactive & foreground tiles under your feet take priority** (Vending Machines, Doors, Locks, Signs, Display Blocks, Shelves, growing Trees), preventing self-wrench from hijacking tiles you are standing on.
  * Clicking empty air / background over your own character opens your **Profile (`wrench_self`)**, or hold `Shift + Click` on yourself anytime (even while standing inside a Vending Machine or Door).
  * Clicking another player's bounding box triggers `wrench_player(target.net_id)` to inspect their stats/trade; hold `Alt + Click` to wrench a tile underneath another player.
  * **Enter Doors**: Press `F` near a Door/Portal, double-click the door tile, or click the HUD `Enter [F]` pill to send `active(x, y)`.

### 3.6. Nametags, Speech Bubbles, Clothing & Weather
* **Overhead Speech Bubbles (`OnTalkBubble`)**: Incoming chat/system talk bubbles render in crisp stacked rounded pills anchored above each speaker's head and fade out smoothly.
* **Equipped Clothing & Gear**: Parses `OnSendInventoryState`, local/remote `OnSetClothing`, and character visual state into layered character apparel (hair/hat, shirt, pants, shoes, face, hand, back wings/capes, neck, ancillaries).
* **Weather Skies & Tile Fidelity**: Maps world weather IDs (Sunny, Sunset, Night, Desert, Stormy, Spooky, Snowy, Space) to sky palettes, moon/stars, and tinted drifting clouds; renders seed trees using seed sprites (`action_type=19`) with trunk+leaf compositing, growth scaling, and ripe fruit pips; displays item & price overlays on Vending Machines, Display Blocks, and Shelves plus Public door badges (`0x80`) and Fire/Wet/Paint tile tints.
* **Game Sound Effects & Asset Cache**: Plays `OnPlayPositioned` / `action|play_sfx` audio clips via `/growtopia-cdn/` with a persistent mute toggle button in the top bar. Fetched Growtopia CDN textures and audio are cached locally under `cache/growtopia` (configurable via `MORI_CDN_CACHE_DIR`, with upstream override `GROWTOPIA_CDN_URL` and optional `GROWTOPIA_CDN_MIRROR`).

### 3.7. Real-Time Chat HUD
* Translucent chat overlay positioned in the bottom-left corner of the screen, matching the native client layout.
* Parses and renders Growtopia backtick color codes (`` `0 ``–`` `9 ``, `` `w ``, `` `o ``, `` `p ``, `` `b ``, `` `q ``, `` `e ``, `` `r ``, `` `t ``, `` `a ``, `` `s ``, `` `c ``, `` `! ``, `` `@ ``, `` `# ``, `` `$ ``, `` `^ ``, `` `& ``) cleanly via `tokenizeGTColors`.
* Supports sending public world chat & slash commands (`api.sendCmd(botId, { type: 'say', text })`, e.g. `/trade <name>`).

### 3.8. Interactive Native Dialogs & Checkboxes
Dialogs requiring user decisions are handled interactively in element order and **never auto-dismissed** unless marked non-interactive (`quick_exit`):
* **Doors & Portals**: Edit label/destination/ID, toggle **Open to public** checkbox (`is_open`), or delete door.
* **Vending Machines**: Select purchase quantity (`add_item_picker` / inputs), view prices, and buy/configure stock.
* **World Locks / Small Locks**: Grant/revoke access, checkbox permissions (`ignore_empty`, `allow_break`, etc.).
* **Checkboxes, Item Pickers & Embed Data**: Submits checkbox values as `1`/`0`, supports searchable backpack `add_item_picker` fields, and preserves hidden `embed_data` fields on `dialog_return`.
* **Native Presentation & Single-Dismiss Guard**: Renders Growtopia color tokens via React `GtText` spans (no raw HTML leaks), lifts duplicate header labels/icons cleanly into the modal title, and pairs single-tap debounced `wrench` packets with optimistic `dismiss_dialog` state updates so modals never double-open or show duplicate close icons.

### 3.9. Player-to-Player Trade UI
* Trigger a trade by typing `/trade <player>` in chat, wrenching a player, or opening the **Players** popover in the header and clicking **Trade**.
* Displays live side-by-side offer grids (`self_slots` and `partner_slots`), lock/ready badges, safety warning banner whenever the partner edits their slots, searchable backpack item & quantity selector, **Lock / Accept** toggle, **Confirm Final Trade**, and **Cancel Trade**.

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

### 5.1. REST Command Endpoints (`POST /bots/:id/cmd`)

| Command Type | Payload | Description |
|---|---|---|
| `set_interactive` | `{ "type": "set_interactive", "enabled": boolean }` | Toggles 50 Hz interactive physics engine |
| `set_input` | `{ "type": "set_input", "left": boolean, "right": boolean, "jump": boolean, "down": boolean }` | Sends directional movement flags |
| `hold_action` | `{ "type": "hold_action", "active": boolean, "x": number, "y": number, "item": number }` | Schedules continuous punch/place/wrench while held |
| `set_action_reach` | `{ "type": "set_action_reach", "tiles": number }` | Overrides action reach limit (`0` = reset to native) |
| `interactive_heartbeat` | `{ "type": "interactive_heartbeat" }` | Keeps interactive mode alive |
| `respawn` | `{ "type": "respawn" }` | Triggers player respawn |
| `leave_world` | `{ "type": "leave_world" }` | Exits current world |
| `hit` | `{ "type": "hit", "x": number, "y": number }` | Punches a block/tree at `(x, y)` |
| `place` | `{ "type": "place", "x": number, "y": number, "item": number }` | Places block or uses consumable at `(x, y)` |
| `wrench` | `{ "type": "wrench", "x": number, "y": number }` | Wrenches a tile (vending machine, lock, door, seed) |
| `wrench_player` | `{ "type": "wrench_player", "net_id": number }` | Opens wrench dialog for player with `net_id` |
| `wrench_self` | `{ "type": "wrench_self" }` | Wrenches self (opens profile dialog natively) |
| `active` | `{ "type": "active", "x": number, "y": number }` | Enters a door or activates tile at `(x, y)` |
| `enter` | `{ "type": "enter", "pass"?: string }` | Sends enter action (optionally with password) |
| `trade_start` | `{ "type": "trade_start", "target_net_id": number }` | Initiates a trade with `target_net_id` |
| `trade_offer_item` | `{ "type": "trade_offer_item", "item_id": number, "count": number }` | Sets item offer count in active trade (`0` removes) |
| `trade_accept` | `{ "type": "trade_accept", "locked": boolean }` | Locks/unlocks current trade offer |
| `trade_confirm` | `{ "type": "trade_confirm" }` | Confirms final trade when both sides are locked |
| `trade_cancel` | `{ "type": "trade_cancel" }` | Cancels active trade |
| `set_collect_config` | `{ "type": "set_collect_config", "radius_tiles": number, "blacklist": number[] }` | Sets collection radius (1–20) and blacklist |
| `set_collect_path_check`| `{ "type": "set_collect_path_check", "enabled": boolean }` | Toggles Line-of-Sight wall raycasting |
| `say` | `{ "type": "say", "text": string }` | Sends public in-game chat or command |
| `wear` | `{ "type": "wear", "item_id": number }` | Equips a wearable item from inventory |
| `unwear` | `{ "type": "unwear", "item_id": number }` | Unequips an active clothing item |
| `drop` | `{ "type": "drop", "item_id": number, "count": number }` | Drops items onto the tile |
| `trash` | `{ "type": "trash", "item_id": number, "count": number }` | Trashes items from inventory |
| `dialog_return` | `{ "type": "dialog_return", "dialog_name": string, "button": string, "fields"?: Record<string, string> }` | Submits button click, inputs, checkboxes, and embed data |
| `dismiss_dialog` | `{ "type": "dismiss_dialog" }` | Clears/closes the active dialog state |
