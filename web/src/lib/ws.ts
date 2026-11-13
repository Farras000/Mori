import type { BotStatus, WorldObject, InventoryItem, WsDialog, WorldMenuSection, CharacterModifiers, TradeState } from './api'
import { authStore } from './auth'

// ── Event payload types ────────────────────────────────────────────────────

export interface TileData {
  fg: number
  bg: number
  flags: number
  tile_type: { type: string } & Record<string, unknown>
}

export type WsEventMap = {
  BotAdded: { bot_id: number; username: string }
  BotRemoved: { bot_id: number }
  BotStatus: { bot_id: number; status: BotStatus }
  BotWorld: { bot_id: number; world_name: string }
  BotMove: { bot_id: number; x: number; y: number; on_ground?: boolean }
  BotGems: { bot_id: number; gems: number }
  BotPing: { bot_id: number; ping_ms: number }
  BotAutoCollect: { bot_id: number; enabled: boolean }
  BotDelays: { bot_id: number; place_ms: number; walk_ms: number; twofa_secs: number; server_overload_secs: number; too_many_logins_secs: number; maintenance_secs: number }
  BotProxy: { bot_id: number; proxy_host: string | null; proxy_port: number | null; proxy_username?: string | null; proxy_password?: string | null }
  BotTrackInfo: {
    bot_id: number
    level: number
    grow_id: number
    install_date: number
    global_playtime: number
    awesomeness: number
  }
  PlayerSpawn: { bot_id: number; net_id: number; name: string; country: string; x: number; y: number; clothes?: number[]; m_state?: number; sm_state?: number }
  PlayerMove: { bot_id: number; net_id: number; x: number; y: number }
  PlayerLeave: { bot_id: number; net_id: number }
  PlayerClothes: { bot_id: number; net_id: number; clothes: number[] }
  BotClothes: { bot_id: number; clothes: number[] }
  WorldLoaded: { bot_id: number; name: string; width: number; height: number; base_weather?: number; current_weather?: number; tiles: TileData[] }
  WeatherUpdate: { bot_id: number; weather: number }
  TileUpdate: { bot_id: number; x: number; y: number; fg: number; bg: number; flags?: number; tile_type?: TileData['tile_type'] }
  ObjectsUpdate: { bot_id: number; objects: WorldObject[] }
  InventoryUpdate: { bot_id: number; gems: number; items: InventoryItem[] }
  Console: { bot_id: number; message: string }
  Chat: { bot_id: number; message: string; kind: "incoming" | "outgoing" }
  TalkBubble: { bot_id: number; net_id: number; text: string; bubble_type: number }
  PlaySfx: { bot_id: number; file: string; delay_ms: number }
  TradeStart: { bot_id: number; partner_net_id: number; partner_name: string }
  TradeStatus: { bot_id: number; trade: TradeState }
  TradeEnd: { bot_id: number; reason: string }
  DialogRequest: { bot_id: number; dialog: WsDialog }
  DialogClose: { bot_id: number }
  WorldMenu: { bot_id: number; sections: WorldMenuSection[] }
  BotPhysicsMods: { bot_id: number; mods: CharacterModifiers }
  TileDamage: { bot_id: number; x: number; y: number; damage: number; max_health: number }
}

type Listener<K extends keyof WsEventMap> = (data: WsEventMap[K]) => void
type AnyListener = (event: string, data: unknown) => void

// ── EventBus ───────────────────────────────────────────────────────────────

class EventBus {
  private listeners = new Map<string, Set<Listener<never>>>()
  private anyListeners = new Set<AnyListener>()

  on<K extends keyof WsEventMap>(event: K, fn: Listener<K>) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn as Listener<never>)
  }

  off<K extends keyof WsEventMap>(event: K, fn: Listener<K>) {
    this.listeners.get(event)?.delete(fn as Listener<never>)
  }

  onAny(fn: AnyListener) {
    this.anyListeners.add(fn)
  }

  offAny(fn: AnyListener) {
    this.anyListeners.delete(fn)
  }

  emit<K extends keyof WsEventMap>(event: K, data: WsEventMap[K]) {
    this.listeners.get(event)?.forEach((fn) => fn(data as never))
    this.anyListeners.forEach((fn) => fn(event, data))
  }
}

// ── MoriWebSocket singleton ────────────────────────────────────────────────

class MoriWebSocket {
  readonly bus = new EventBus()
  private ws: WebSocket | null = null
  private posSubscribers = new Map<number, Set<(x: number, y: number, onGround?: boolean) => void>>()

  subscribePos(botId: number, cb: (x: number, y: number, onGround?: boolean) => void): () => void {
    if (!this.posSubscribers.has(botId)) {
      this.posSubscribers.set(botId, new Set())
    }
    this.posSubscribers.get(botId)!.add(cb)
    return () => {
      this.posSubscribers.get(botId)?.delete(cb)
    }
  }

  notifyPos(botId: number, x: number, y: number, onGround?: boolean) {
    this.posSubscribers.get(botId)?.forEach((cb) => cb(x, y, onGround))
  }
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  connect(baseUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`) {
    if (this.ws) return
    const token = authStore.getToken()
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl
    this.ws = new WebSocket(url)

    this.ws.onmessage = (e) => {
      try {
        const { event, data } = JSON.parse(e.data) as { event: string; data: unknown }
        if (event === 'BotMove') {
          const move = data as { bot_id: number; x: number; y: number; on_ground?: boolean }
          this.notifyPos(move.bot_id, move.x, move.y, move.on_ground)
        }
        this.bus.emit(event as keyof WsEventMap, data as never)
      } catch {
        // ignore malformed frames
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      if (!this.destroyed) {
        this.retryTimer = setTimeout(() => this.connect(baseUrl), 3000)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.destroyed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
  }
}

export const moriWs = new MoriWebSocket()
