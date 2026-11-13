import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { moriWs, type TileData } from './ws'
import type { BotStatus, BotSummary, InventoryItem, Player, WorldObject, ItemRecord, ProxyInfo, WsDialog, WorldMenuSection, CharacterModifiers, TradeState } from './api'
import { api } from './api'

export interface TalkBubbleEntry {
  id: number
  bot_id: number
  net_id: number
  text: string
  bubble_type: number
  expiresAt: number
}

let nextBubbleId = 1

export interface TrackInfo {
  level: number
  grow_id: number
  install_date: number
  global_playtime: number
  awesomeness: number
}

export interface LiveBot {
  id: number
  net_id: number
  username: string
  status: BotStatus
  world_name: string
  pos_x: number
  pos_y: number
  gems: number
  ping_ms: number
  world_width: number
  world_height: number
  base_weather: number
  current_weather: number
  local_clothes: number[]
  tiles: TileData[]
  players: Map<number, Player>
  objects: WorldObject[]
  inventory: InventoryItem[]
  inventory_slots: number
  console: string[]
  delays: { place_ms: number; place_max_ms?: number | null; walk_ms: number; walk_max_ms?: number | null; twofa_secs: number; server_overload_secs: number; too_many_logins_secs: number; maintenance_secs: number }
  track_info: TrackInfo | null
  auto_collect: boolean
  collect_radius_tiles: number
  collect_blacklist: number[]
  collect_path_check: boolean
  auto_reconnect: boolean
  auto_rotate_reconnect: boolean
  proxy: ProxyInfo | null
  chat: string[]
  active_dialog: WsDialog | null
  active_trade: TradeState | null
  world_menu: WorldMenuSection[]
  action_reach: number
  punch_reach: number
  build_reach: number
  reach_override: number | null
  interactive: boolean
  physics_mods?: CharacterModifiers
}

const lastBotMoveUiAt = new Map<number, number>()
const pendingBotMoveUiTimer = new Map<number, ReturnType<typeof setTimeout>>()

export function makeBot(id: number, username: string): LiveBot {
  return {
    id, net_id: 0, username,
    status: 'connecting',
    world_name: '', pos_x: 0, pos_y: 0,
    gems: 0, ping_ms: 0,
    world_width: 100, world_height: 60,
    base_weather: 0, current_weather: 0,
    local_clothes: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    tiles: [], players: new Map(),
    objects: [], inventory: [], inventory_slots: 0, console: [],
    delays: { place_ms: 200, place_max_ms: 240, walk_ms: 220, walk_max_ms: 260, twofa_secs: 120, server_overload_secs: 30, too_many_logins_secs: 5, maintenance_secs: 600 },
    track_info: null,
    auto_collect: true,
    collect_radius_tiles: 3,
    collect_blacklist: [],
    collect_path_check: true,
    auto_reconnect: true,
    auto_rotate_reconnect: true,
    proxy: null,
    chat: [],
    active_dialog: null,
    active_trade: null,
    world_menu: [],
    action_reach: 2,
    punch_reach: 2,
    build_reach: 2,
    reach_override: null,
    interactive: false,
  }
}

export const botsAtom = atom<Map<number, LiveBot>>(new Map())
export const selectedBotIdAtom = atom<number | null>(null)
export const itemNamesAtom = atom<Record<string, string>>({})
export const itemColorsAtom = atom<Record<string, number>>({})
export const itemsMapAtom = atom<Map<number, ItemRecord>>(new Map())
export const talkBubblesAtom = atom<Map<number, TalkBubbleEntry[]>>(new Map())

export const selectedBotAtom = atom((get) => {
  const id = get(selectedBotIdAtom)
  return id !== null ? (get(botsAtom).get(id) ?? null) : null
})

function patchBot(
  map: Map<number, LiveBot>,
  id: number,
  patch: Partial<LiveBot>,
): Map<number, LiveBot> {
  const bot = map.get(id)
  if (!bot) return map
  return new Map(map).set(id, { ...bot, ...patch })
}

export function useMoriStore(enabled = true) {
  const setBots = useSetAtom(botsAtom)
  const setItemNames = useSetAtom(itemNamesAtom)
  const setItemColors = useSetAtom(itemColorsAtom)
  const setTalkBubbles = useSetAtom(talkBubblesAtom)

  useEffect(() => {
    if (!enabled) return
    moriWs.connect()

    const syncBots = () => {
      api.getBots().then((list: BotSummary[]) => {
        setBots((prev) => {
          const map = new Map(prev)
          for (const b of list) {
            const existing = map.get(b.id)
            if (existing) {
              map.set(b.id, {
                ...existing,
                status: b.status,
                world_name: b.world,
                pos_x: b.pos_x,
                pos_y: b.pos_y,
                gems: b.gems,
                ping_ms: b.ping_ms,
                active_dialog: b.active_dialog !== undefined ? b.active_dialog : existing.active_dialog,
              })
            } else {
              map.set(b.id, {
                ...makeBot(b.id, b.username),
                status: b.status,
                world_name: b.world,
                pos_x: b.pos_x,
                pos_y: b.pos_y,
                gems: b.gems,
                ping_ms: b.ping_ms,
                active_dialog: b.active_dialog ?? null,
              })
            }
          }
          return map
        })
      }).catch(() => {})
    }

    syncBots()

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncBots()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    api.getItemNames().then(setItemNames).catch(() => {})
    api.getItemColors().then(setItemColors).catch(() => {})

    const handlers: Array<[string, (d: never) => void]> = [
      ['BotAdded', (d: { bot_id: number; username: string }) =>
        setBots((m) => new Map(m).set(d.bot_id, makeBot(d.bot_id, d.username)))],

      ['BotRemoved', (d: { bot_id: number }) =>
        setBots((m) => { const n = new Map(m); n.delete(d.bot_id); return n })],

      ['BotStatus', (d: { bot_id: number; status: BotStatus }) =>
        setBots((m) => patchBot(m, d.bot_id, { status: d.status }))],

      ['BotWorld', (d: { bot_id: number; world_name: string }) =>
        setBots((m) => patchBot(m, d.bot_id, {
          world_name: d.world_name, tiles: [], players: new Map(), objects: [],
        }))],

      ['BotMove', (d: { bot_id: number; x: number; y: number }) => {
        const now = performance.now()
        const last = lastBotMoveUiAt.get(d.bot_id) ?? 0
        if (now - last >= 100) {
          const t = pendingBotMoveUiTimer.get(d.bot_id)
          if (t) { clearTimeout(t); pendingBotMoveUiTimer.delete(d.bot_id) }
          lastBotMoveUiAt.set(d.bot_id, now)
          setBots((m) => patchBot(m, d.bot_id, { pos_x: d.x, pos_y: d.y }))
        } else {
          const prevT = pendingBotMoveUiTimer.get(d.bot_id)
          if (prevT) clearTimeout(prevT)
          pendingBotMoveUiTimer.set(
            d.bot_id,
            setTimeout(() => {
              pendingBotMoveUiTimer.delete(d.bot_id)
              lastBotMoveUiAt.set(d.bot_id, performance.now())
              setBots((m) => patchBot(m, d.bot_id, { pos_x: d.x, pos_y: d.y }))
            }, Math.max(16, 100 - (now - last))),
          )
        }
      }],

      ['BotGems', (d: { bot_id: number; gems: number }) =>
        setBots((m) => patchBot(m, d.bot_id, { gems: d.gems }))],

      ['BotPing', (d: { bot_id: number; ping_ms: number }) =>
        setBots((m) => patchBot(m, d.bot_id, { ping_ms: d.ping_ms }))],

      ['BotAutoCollect', (d: { bot_id: number; enabled: boolean }) =>
        setBots((m) => patchBot(m, d.bot_id, { auto_collect: d.enabled }))],

      ['BotDelays', (d: { bot_id: number; place_ms: number; place_max_ms?: number | null; walk_ms: number; walk_max_ms?: number | null; twofa_secs: number; server_overload_secs: number; too_many_logins_secs: number; maintenance_secs: number }) =>
        setBots((m) => patchBot(m, d.bot_id, { delays: { place_ms: d.place_ms, place_max_ms: d.place_max_ms, walk_ms: d.walk_ms, walk_max_ms: d.walk_max_ms, twofa_secs: d.twofa_secs, server_overload_secs: d.server_overload_secs, too_many_logins_secs: d.too_many_logins_secs, maintenance_secs: d.maintenance_secs } }))],

      ['BotProxy', (d: { bot_id: number; proxy_host: string | null; proxy_port: number | null; proxy_username?: string | null; proxy_password?: string | null }) =>
        setBots((m) => patchBot(m, d.bot_id, {
          proxy: d.proxy_host && d.proxy_port ? {
            host: d.proxy_host,
            port: d.proxy_port,
            ...(d.proxy_username ? { username: d.proxy_username } : {}),
            ...(d.proxy_password ? { password: d.proxy_password } : {}),
          } : null,
        }))],

      ['BotTrackInfo', (d: { bot_id: number; level: number; grow_id: number; install_date: number; global_playtime: number; awesomeness: number }) =>
        setBots((m) => patchBot(m, d.bot_id, {
          track_info: {
            level: d.level, grow_id: d.grow_id,
            install_date: d.install_date, global_playtime: d.global_playtime,
            awesomeness: d.awesomeness,
          },
        }))],

      ['PlayerSpawn', (d: { bot_id: number; net_id: number; name: string; country: string; x: number; y: number; clothes?: number[]; m_state?: number; sm_state?: number }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const players = new Map(bot.players)
          players.set(d.net_id, {
            net_id: d.net_id,
            name: d.name,
            country: d.country,
            pos_x: d.x,
            pos_y: d.y,
            clothes: d.clothes,
            m_state: d.m_state,
            sm_state: d.sm_state,
          })
          return patchBot(m, d.bot_id, { players })
        })],

      ['PlayerMove', (d: { bot_id: number; net_id: number; x: number; y: number }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const existing = bot.players.get(d.net_id)
          if (!existing) return m
          const players = new Map(bot.players)
          players.set(d.net_id, { ...existing, pos_x: d.x, pos_y: d.y })
          return patchBot(m, d.bot_id, { players })
        })],

      ['PlayerLeave', (d: { bot_id: number; net_id: number }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const players = new Map(bot.players)
          players.delete(d.net_id)
          return patchBot(m, d.bot_id, { players })
        })],

      ['PlayerClothes', (d: { bot_id: number; net_id: number; clothes: number[] }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const existing = bot.players.get(d.net_id)
          if (!existing) return m
          const players = new Map(bot.players)
          players.set(d.net_id, { ...existing, clothes: d.clothes })
          return patchBot(m, d.bot_id, { players })
        })],

      ['BotClothes', (d: { bot_id: number; clothes: number[] }) =>
        setBots((m) => patchBot(m, d.bot_id, { local_clothes: d.clothes }))],

      ['WorldLoaded', (d: { bot_id: number; name: string; width: number; height: number; base_weather?: number; current_weather?: number; tiles: TileData[] }) => {
        setTalkBubbles((prev) => {
          if (!prev.has(d.bot_id)) return prev
          const next = new Map(prev)
          next.delete(d.bot_id)
          return next
        })
        setBots((m) => patchBot(m, d.bot_id, {
          world_name: d.name,
          world_width: d.width, world_height: d.height,
          base_weather: d.base_weather ?? 0,
          current_weather: d.current_weather ?? d.base_weather ?? 0,
          active_trade: null,
          tiles: d.tiles, players: new Map(), objects: [],
        }))
      }],

      ['WeatherUpdate', (d: { bot_id: number; weather: number }) =>
        setBots((m) => patchBot(m, d.bot_id, { current_weather: d.weather }))],

      ['TileUpdate', (d: { bot_id: number; x: number; y: number; fg: number; bg: number; flags?: number; tile_type?: TileData['tile_type'] }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const tiles = [...bot.tiles]
          const idx = d.y * bot.world_width + d.x
          if (tiles[idx]) {
            tiles[idx] = {
              ...tiles[idx],
              fg: d.fg,
              bg: d.bg,
              flags: d.flags ?? tiles[idx].flags,
              tile_type: d.tile_type ?? tiles[idx].tile_type,
            }
          }
          return patchBot(m, d.bot_id, { tiles })
        })],

      ['ObjectsUpdate', (d: { bot_id: number; objects: WorldObject[] }) =>
        setBots((m) => patchBot(m, d.bot_id, { objects: d.objects }))],

      ['InventoryUpdate', (d: { bot_id: number; gems: number; inventory_size: number; items: InventoryItem[] }) =>
        setBots((m) => patchBot(m, d.bot_id, { gems: d.gems, inventory: d.items, inventory_slots: d.inventory_size }))],

      ['BotUsername', (d: { bot_id: number; username: string }) =>
        setBots((m) => patchBot(m, d.bot_id, { username: d.username }))],

      ['Console', (d: { bot_id: number; message: string }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const console_ = [...bot.console, d.message].slice(-500)
          return patchBot(m, d.bot_id, { console: console_ })
        })],

      ['Chat', (d: { bot_id: number; message: string; kind: "incoming" | "outgoing" }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const prefix = d.kind === 'outgoing' ? '[Kamu]' : ''
          const line = prefix ? `${prefix} ${d.message}` : d.message
          const chat = [...bot.chat, line].slice(-500)
          return patchBot(m, d.bot_id, { chat })
        })],
      ['TalkBubble', (d: { bot_id: number; net_id: number; text: string; bubble_type: number }) =>
        setTalkBubbles((prev) => {
          const now = Date.now()
          const next = new Map(prev)
          const active = (next.get(d.bot_id) ?? []).filter((b) => b.expiresAt > now)
          active.push({
            id: nextBubbleId++,
            bot_id: d.bot_id,
            net_id: d.net_id,
            text: d.text,
            bubble_type: d.bubble_type,
            expiresAt: now + 4500,
          })
          next.set(d.bot_id, active.slice(-24))
          return next
        })],

      ['TradeStart', (d: { bot_id: number; partner_net_id: number; partner_name: string }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          if (bot.active_trade && bot.active_trade.partner_net_id === d.partner_net_id) {
            return m
          }
          return patchBot(m, d.bot_id, {
            active_trade: {
              partner_net_id: d.partner_net_id,
              partner_name: d.partner_name,
              self_slots: [],
              partner_slots: [],
              self_locked: false,
              partner_locked: false,
              self_accepted: false,
              partner_accepted: false,
              status_text: '',
            },
          })
        })],

      ['TradeStatus', (d: { bot_id: number; trade: TradeState }) =>
        setBots((m) => patchBot(m, d.bot_id, { active_trade: d.trade }))],

      ['TradeEnd', (d: { bot_id: number; reason: string }) =>
        setBots((m) => patchBot(m, d.bot_id, { active_trade: null }))],

      ['DialogRequest', (d: { bot_id: number; dialog: WsDialog }) =>
        setBots((m) => patchBot(m, d.bot_id, { active_dialog: d.dialog }))],

      ['DialogClose', (d: { bot_id: number }) =>
        setBots((m) => patchBot(m, d.bot_id, { active_dialog: null }))],

      ['WorldMenu', (d: { bot_id: number; sections: WorldMenuSection[] }) =>
        setBots((m) => patchBot(m, d.bot_id, { world_menu: d.sections }))],

      ['BotPhysicsMods', (d: { bot_id: number; mods: CharacterModifiers }) =>
        setBots((m) => {
          const bot = m.get(d.bot_id)
          if (!bot) return m
          const punch_reach = d.mods.punch_reach ?? 2
          const build_reach = d.mods.build_reach ?? 2
          const action_reach = bot.reach_override ?? Math.max(punch_reach, build_reach)
          return patchBot(m, d.bot_id, {
            physics_mods: d.mods,
            punch_reach,
            build_reach,
            action_reach,
          })
        })],
    ]

    for (const [event, handler] of handlers) {
      moriWs.bus.on(event as never, handler as never)
    }
    return () => {
      for (const [event, handler] of handlers) {
        moriWs.bus.off(event as never, handler as never)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, setBots, setItemNames, setItemColors, setTalkBubbles])
}

/** Hydrate a LiveBot entry in `botsAtom` with the latest full snapshot from `/bots/:id`. */
export function hydrateBotFromState(
  botId: number,
  setBots: (updater: (prev: Map<number, LiveBot>) => Map<number, LiveBot>) => void,
): Promise<void> {
  return api
    .getBotState(botId)
    .then((s) => {
      setBots((m) => {
        const existing = m.get(botId)
        if (!existing) return m
        const players = new Map(s.players.map((p) => [p.net_id, p]))
        const tiles = s.tiles.map((t) => ({
          fg: t.fg_item_id,
          bg: t.bg_item_id,
          flags: t.flags,
          tile_type: t.tile_type,
        }))
        return new Map(m).set(botId, {
          ...existing,
          net_id: s.net_id ?? existing.net_id,
          status: s.status,
          world_name: s.world_name,
          pos_x: s.pos_x,
          pos_y: s.pos_y,
          world_width: s.world_width,
          world_height: s.world_height,
          base_weather: s.base_weather ?? existing.base_weather ?? 0,
          current_weather: s.current_weather ?? existing.current_weather ?? 0,
          local_clothes: s.local_clothes ?? existing.local_clothes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0],
          tiles,
          players,
          objects: s.objects,
          inventory: s.inventory,
          inventory_slots: s.inventory_slots,
          gems: s.gems,
          console: s.console,
          ping_ms: s.ping_ms,
          delays: s.delays,
          track_info: s.track_info,
          auto_collect: s.auto_collect,
          collect_radius_tiles: s.collect_radius_tiles,
          collect_blacklist: s.collect_blacklist,
          collect_path_check: s.collect_path_check ?? existing.collect_path_check,
          auto_reconnect: s.auto_reconnect,
          auto_rotate_reconnect: s.auto_rotate_reconnect ?? true,
          proxy: s.proxy ?? null,
          active_dialog: s.active_dialog !== undefined ? s.active_dialog : existing.active_dialog,
          active_trade: s.active_trade !== undefined ? s.active_trade : existing.active_trade,
          world_menu: s.world_menu ?? existing.world_menu,
          action_reach: s.action_reach ?? existing.action_reach ?? 2,
          punch_reach: s.punch_reach ?? s.physics_mods?.punch_reach ?? existing.punch_reach ?? 2,
          build_reach: s.build_reach ?? s.physics_mods?.build_reach ?? existing.build_reach ?? 2,
          reach_override: s.reach_override !== undefined ? s.reach_override : existing.reach_override,
          interactive: s.interactive ?? existing.interactive,
          physics_mods: s.physics_mods ?? existing.physics_mods,
        })
      })
    })
    .catch(() => {})
}

export { useAtom, useAtomValue, useSetAtom }
