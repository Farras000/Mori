import type { DocSection } from './lua-docs'

export type GrpcDocSection = DocSection & {
  markdownPath: string
}

export const GRPC_DOC_VERSION = '2.0.0'

export const GRPC_DOC_FILES = [
  { id: 'index', path: '/docs/grpc/index.md' },
  { id: 'overview', path: '/docs/grpc/overview.md' },
  { id: 'quickstart', path: '/docs/grpc/quickstart.md' },
  { id: 'manager', path: '/docs/grpc/manager.md' },
  { id: 'world-actions', path: '/docs/grpc/world-actions.md' },
  { id: 'tile-inventory', path: '/docs/grpc/tile-inventory.md' },
  { id: 'movement', path: '/docs/grpc/movement.md' },
  { id: 'collection', path: '/docs/grpc/collection.md' },
  { id: 'connection-raw', path: '/docs/grpc/connection-raw.md' },
  { id: 'settings', path: '/docs/grpc/settings.md' },
  { id: 'scripts', path: '/docs/grpc/scripts.md' },
  { id: 'queries', path: '/docs/grpc/queries.md' },
  { id: 'events', path: '/docs/grpc/events.md' },
  { id: 'messages', path: '/docs/grpc/messages.md' },
  { id: 'errors', path: '/docs/grpc/errors.md' },
] as const

export const GRPC_PROTO_PATH = '/docs/mori.proto'

export const GRPC_DOC_SECTIONS: GrpcDocSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    summary: 'Endpoint, auth, reads-vs-writes model, and offset rules.',
    markdownPath: '/docs/grpc/overview.md',
    entries: [
      { name: 'Endpoint', signature: 'localhost:50051', description: 'Override with MORI_GRPC_ADDR, e.g. 127.0.0.1:50051.' },
      { name: 'Auth', signature: 'authorization: Bearer <token>', description: 'Required on every call when MORI_GRPC_TOKEN is set, else UNAUTHENTICATED.' },
      { name: 'BotRef', signature: '{ bot_id }', description: 'Wrapper for every per-bot RPC. Missing → INVALID_ARGUMENT, unknown → NOT_FOUND.' },
      { name: 'Offsets', description: 'Place/Hit/Wrench/Active x/y are offsets from bot tile (Lua parity). WalkTo/FindPath/IsInTile are absolute.' },
    ],
    tables: [
      {
        title: 'RPC groups',
        columns: ['Group', 'File'],
        rows: [
          ['Manager', 'manager.md'],
          ['World actions', 'world-actions.md'],
          ['Tile / inventory', 'tile-inventory.md'],
          ['Movement', 'movement.md'],
          ['Collection', 'collection.md'],
          ['Connection / raw', 'connection-raw.md'],
          ['Settings', 'settings.md'],
          ['Scripts', 'scripts.md'],
          ['Queries', 'queries.md'],
          ['Events', 'events.md'],
        ],
      },
    ],
  },
  {
    id: 'quickstart',
    title: 'Quickstart',
    summary: 'protoc generation and minimal Python client.',
    markdownPath: '/docs/grpc/quickstart.md',
    entries: [
      { name: 'Install', signature: 'pip install grpcio grpcio-tools', description: 'Stubs generate automatically via examples/grpc_bootstrap.py on first run.' },
      { name: 'Generate', signature: 'python -m grpc_tools.protoc -I proto ... proto/mori.proto', description: 'Manual stub generation for examples/.' },
      { name: 'Channel', signature: 'grpc.insecure_channel(MORI_GRPC_ADDR)', description: 'Pair with metadata [(authorization, Bearer TOKEN)] when token is set.' },
    ],
    example: `import os, sys, grpc\nsys.path.insert(0, "examples")\nimport grpc_bootstrap as gen\npb, rpc = gen.pb, gen.rpc\nmd = [("authorization", f"Bearer {os.environ['MORI_GRPC_TOKEN']}")]\nstub = rpc.MoriStub(grpc.insecure_channel("localhost:50051"))\nbots = stub.ListBots(pb.Empty(), metadata=md)\nbot = pb.BotRef(bot_id=bots.bots[0].bot_id)\nstub.Say(pb.SayRequest(bot=bot, text="hi"), metadata=md)`,
  },
  {
    id: 'manager',
    title: 'Manager',
    summary: 'Spawn, stop, list, and snapshot bots.',
    markdownPath: '/docs/grpc/manager.md',
    entries: [
      { name: 'SpawnBot', signature: 'SpawnBot({ username, password, proxy?, has_proxy }) -> { bot_id }', description: 'Username+password required. Proxy needs has_proxy=true with host/port.', details: ['Invalid host → INVALID_ARGUMENT'] },
      { name: 'SpawnLtokenBot', signature: 'SpawnLtokenBot({ ltoken, proxy?, has_proxy }) -> { bot_id }', description: 'ltoken is token|rid|mac|wk, validated immediately.' },
      { name: 'StopBot', signature: 'StopBot(BotRef) -> Empty', description: 'Unknown id → NOT_FOUND.' },
      { name: 'ListBots', signature: 'ListBots(Empty) -> { bots[] }', description: 'Each bot: bot_id, username, status, world, pos_x, pos_y, gems, ping_ms.' },
      { name: 'GetBotState', signature: 'GetBotState(BotRef) -> BotState', description: 'Full snapshot (see Messages).' },
      { name: 'GetConfig', signature: 'GetConfig(BotRef) -> BotConfig', description: 'Auto-collect, blacklist, delays, reconnect flags.' },
    ],
  },
  {
    id: 'world-actions',
    title: 'World actions',
    summary: 'Chat, warp, doors, and world presence.',
    markdownPath: '/docs/grpc/world-actions.md',
    entries: [
      { name: 'Say', signature: 'Say({ bot, text })', description: 'Send chat message.' },
      { name: 'Warp', signature: 'Warp({ bot, name, id })', description: 'Warp by world name; id is door ID, default "".' },
      { name: 'LeaveWorld', signature: 'LeaveWorld(BotRef)', description: 'Leave current world.' },
      { name: 'Respawn', signature: 'Respawn(BotRef)', description: 'Respawn bot.' },
      { name: 'Active', signature: 'Active({ bot, x, y })', description: 'Toggle tile at offset from bot.', details: ['x/y are offsets'] },
      { name: 'Enter', signature: 'Enter({ bot, pass?, has_pass })', description: 'Enter door; set has_pass=true with pass for locked doors.' },
      { name: 'AcceptAccess', signature: 'AcceptAccess(BotRef)', description: 'Wrench nearest player and confirm both dialogs.' },
    ],
  },
  {
    id: 'tile-inventory',
    title: 'Tile / inventory',
    summary: 'Block actions and item management.',
    markdownPath: '/docs/grpc/tile-inventory.md',
    entries: [
      { name: 'Place', signature: 'Place({ bot, x, y, item_id })', description: 'Place block at offset from bot.' },
      { name: 'Hit', signature: 'Hit({ bot, x, y })', description: 'Punch tile at offset.' },
      { name: 'Wrench', signature: 'Wrench({ bot, x, y })', description: 'Wrench tile at offset.' },
      { name: 'WrenchPlayer', signature: 'WrenchPlayer({ bot, net_id })', description: 'Wrench player by net ID from GetPlayers.' },
      { name: 'Wear / Unwear', signature: 'Wear({ bot, item_id })', description: 'Equip / unequip item.' },
      { name: 'Drop / Trash', signature: 'Drop({ bot, item_id, count })', description: 'Drop to world / permanently delete.' },
      { name: 'FastDrop / FastTrash', signature: 'FastDrop({ bot, item_id, count })', description: 'Skip normal delay.' },
      { name: 'Buy', signature: 'Buy({ bot, pack_id })', description: 'Buy store pack, e.g. small_lock.' },
    ],
    example: `stub.Place(pb.PlaceRequest(bot=bot, x=1, y=0, item_id=2), metadata=md)\nstub.Hit(pb.TileActionRequest(bot=bot, x=1, y=0), metadata=md)`,
  },
  {
    id: 'movement',
    title: 'Movement',
    summary: 'Direct moves and pathfinding.',
    markdownPath: '/docs/grpc/movement.md',
    entries: [
      { name: 'MoveRelative', signature: 'MoveRelative({ bot, x, y })', description: 'Move relative in pixel/float coords.' },
      { name: 'MoveTo', signature: 'MoveTo({ bot, x, y })', description: 'Move absolute in pixel/float coords.' },
      { name: 'WalkTo', signature: 'WalkTo({ bot, x, y })', description: 'Pathfind to absolute tile; negatives → INVALID_ARGUMENT.' },
      { name: 'FindPath', signature: 'FindPath({ bot, x, y })', description: 'Non-blocking pathfind start to absolute tile.' },
      { name: 'SetDirection', signature: 'SetDirection({ bot, facing_left })', description: 'Facing only.' },
    ],
    tables: [
      {
        title: 'Coordinate systems',
        columns: ['RPC', 'Units', 'Origin'],
        rows: [
          ['MoveRelative / MoveTo', 'float pixels÷32 (tiles)', 'relative / absolute'],
          ['WalkTo / FindPath / IsInTile', 'int tiles', 'absolute'],
          ['Place / Hit / Wrench / Active', 'int tiles', 'offset from bot'],
        ],
      },
    ],
  },
  {
    id: 'collection',
    title: 'Collection',
    summary: 'Auto and targeted pickup (fire-and-forget).',
    markdownPath: '/docs/grpc/collection.md',
    entries: [
      { name: 'Collect', signature: 'Collect({ bot, range, interval_ms })', description: 'Collect nearby drops within range pixels. Count not returned over gRPC.', details: ['Fire-and-forget'] },
      { name: 'CollectObject', signature: 'CollectObject({ bot, oid, range })', description: 'Collect single oid from GetWorld/GetObject if in range.' },
    ],
  },
  {
    id: 'connection-raw',
    title: 'Connection / raw',
    summary: 'Reconnect control and low-level packets.',
    markdownPath: '/docs/grpc/connection-raw.md',
    entries: [
      { name: 'Reconnect', signature: 'Reconnect(BotRef)', description: 'Clears manual latch; reconnects immediately if offline.' },
      { name: 'Disconnect', signature: 'Disconnect(BotRef)', description: 'Manual disconnect; stays offline until Reconnect.' },
      { name: 'SendPacket', signature: 'SendPacket({ bot, packet_type, text })', description: 'packet_type must fit u8.', details: ['>255 → INVALID_ARGUMENT'] },
      { name: 'SendRaw', signature: 'SendRaw({ bot, packet })', description: 'Full GameUpdatePacket; missing packet is no-op default.' },
      { name: 'SetMac', signature: 'SetMac({ bot, mac })', description: 'MAC XX:XX:XX:XX:XX:XX.' },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    summary: 'Toggles, delays, and collect tuning.',
    markdownPath: '/docs/grpc/settings.md',
    entries: [
      { name: 'SetAutoCollect etc.', signature: 'Set*(SetBoolRequest { bot, enabled })', description: 'SetAutoCollect, SetIgnoreGems, SetIgnoreEssences, SetAutoLeaveOnMod, SetAutoBan, SetCollectPathCheck, SetAutoReconnect.' },
      { name: 'SetCollectInterval etc.', signature: 'Set*(SetUintRequest { bot, value })', description: 'SetCollectInterval, SetReconnectInterval, SetPlaceDelay, SetWalkDelay in ms.' },
      { name: 'SetCollectRange', signature: 'SetCollectRange({ bot, value 0-255 })', description: 'Radius in tiles; >255 → INVALID_ARGUMENT.' },
      { name: 'SetDelays', signature: 'SetDelays({ bot, delays })', description: 'place_ms, walk_ms, twofa_secs, server_overload_secs, too_many_logins_secs, maintenance_secs.', details: ['Defaults 500,500,120,30,5,600'] },
      { name: 'SetCollectConfig', signature: 'SetCollectConfig({ bot, radius_tiles, blacklist[] })', description: 'radius_tiles ≤255; blacklist ids clamped to u16.' },
    ],
  },
  {
    id: 'scripts',
    title: 'Scripts',
    summary: 'Embedded Lua runner (one script per bot).',
    markdownPath: '/docs/grpc/scripts.md',
    entries: [
      { name: 'RunScript', signature: 'RunScript({ bot, content })', description: 'Run Lua 5.4 source; replaces running script.' },
      { name: 'StopScript', signature: 'StopScript(BotRef)', description: 'Stop current script; no-op if none.' },
    ],
    example: `stub.RunScript(pb.RunScriptRequest(bot=bot, content="say('hi')"), metadata=md)`,
  },
  {
    id: 'queries',
    title: 'Queries',
    summary: 'Snapshots for world, inventory, players, items.',
    markdownPath: '/docs/grpc/queries.md',
    entries: [
      { name: 'GetWorld', signature: 'GetWorld(BotRef) -> WorldResponse', description: 'Full tiles+objects+players. NOT_FOUND if not in world.', details: ['Heavy — avoid hot-loop polling'] },
      { name: 'GetInventory', signature: 'GetInventory(BotRef)', description: 'size, gems, items[{ item_id, amount, is_active, action_type }].' },
      { name: 'GetPlayers / GetPlayer', signature: 'GetPlayers(BotRef) / GetPlayer({ bot, net_id|name })', description: 'Name lookup is case-insensitive.' },
      { name: 'GetTile', signature: 'GetTile({ bot, x, y })', description: 'Absolute tile; OOB → NOT_FOUND.' },
      { name: 'GetObject', signature: 'GetObject({ bot, oid })', description: 'Single drop by uid.' },
      { name: 'GetItemInfo / ListItems', signature: 'GetItemInfo({ id|name }) / ListItems({ query, page, page_size })', description: 'Numeric string resolves as id; page_size clamped 1-200.' },
      { name: 'GetLocal / GetPing', signature: 'GetLocal(BotRef) / GetPing(BotRef)', description: 'Local player + mac; ping_ms.' },
      { name: 'IsInWorld / IsInTile', signature: 'IsInWorld({ bot, name?, has_name }) / IsInTile({ bot, x, y })', description: 'has_name=false means any world.' },
    ],
  },
  {
    id: 'events',
    title: 'Events',
    summary: 'Server-streaming SubscribeEvents (replaces listenEvents).',
    markdownPath: '/docs/grpc/events.md',
    entries: [
      { name: 'SubscribeEvents', signature: 'SubscribeEvents({ bot_ids }) -> stream BotEvent', description: 'Empty bot_ids = all bots. Buffer 256; lag skipped.', details: ['Cancel by dropping stream'] },
    ],
    tables: [
      {
        title: 'BotEvent oneof',
        columns: ['Field', 'Payload'],
        rows: [
          ['bot_added', 'BotInfo'],
          ['bot_removed', 'BotRef'],
          ['bot_status', '{ bot_id, status }'],
          ['bot_world', '{ bot_id, world_name }'],
          ['bot_move', '{ bot_id, x, y }'],
          ['bot_gems / bot_ping', '{ bot_id, gems } / { ping_ms }'],
          ['player_spawn / move / leave', '{ bot_id, net_id, name?, x?, y? }'],
          ['world_loaded', '{ bot_id, name, width, height, tiles[] }'],
          ['tile_update', '{ bot_id, x, y, fg, bg }'],
          ['objects_update', '{ bot_id, objects[] }'],
          ['inventory_update', '{ bot_id, gems, size, items[] }'],
          ['console', '{ bot_id, message }'],
          ['track_info', '{ level, grow_id, install_date, playtime, awesomeness }'],
          ['username / auto_collect / delays', '{ bot_id, value }'],
        ],
      },
    ],
    example: `for ev in stub.SubscribeEvents(pb.SubscribeRequest(bot_ids=[bot.bot_id]), metadata=md):\n    print(ev.WhichOneof("event"))`,
  },
  {
    id: 'messages',
    title: 'Messages',
    summary: 'Response shapes for BotState, world, items, config.',
    markdownPath: '/docs/grpc/messages.md',
    entries: [
      { name: 'BotState', description: 'status, username, mac, world_name, pos, world size, objects, players, inventory, gems, console, ping, config.' },
      { name: 'WorldResponse', description: 'name, width, height, tiles[{ x,y,fg,bg,flags,tile_type }], objects, players.' },
      { name: 'ItemInfo', description: 'id, name, action/collision/clothing types, rarity, grow_time, textures, colors, strength=block_health/6.' },
      { name: 'BotConfig / BotDelays', description: 'Collect flags + delays; defaults 500,500,120,30,5,600.' },
    ],
  },
  {
    id: 'errors',
    title: 'Errors',
    summary: 'gRPC codes, status values, and fixes.',
    markdownPath: '/docs/grpc/errors.md',
    tables: [
      {
        title: 'Codes',
        columns: ['Code', 'When', 'Fix'],
        rows: [
          ['NOT_FOUND', 'unknown bot/world/tile/object/player/item', 'ListBots, re-query'],
          ['INVALID_ARGUMENT', 'missing BotRef, bad proxy/packet/coords', 'fix shape per group file'],
          ['UNAUTHENTICATED', 'token missing/wrong', 'export MORI_GRPC_TOKEN, pass metadata'],
          ['INTERNAL', 'manager lock poisoned', 'restart, report'],
        ],
      },
      {
        title: 'Status values',
        columns: ['Value', 'Meaning'],
        rows: [
          ['connecting / connected / in_game', 'startup → online'],
          ['disconnected', 'manual; needs Reconnect'],
          ['two_factor_auth / server_overloaded / too_many_logins / maintenance', 'retry after matching *_secs delay'],
          ['update_required', 'permanent stop'],
        ],
      },
    ],
  },
]
