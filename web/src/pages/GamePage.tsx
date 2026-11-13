import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  botsAtom,
  selectedBotIdAtom,
  selectedBotAtom,
  itemNamesAtom,
  itemsMapAtom,
  hydrateBotFromState,
  type LiveBot,
} from '@/lib/store'
import { api, type InventoryItem, type ItemRecord } from '@/lib/api'
import { moriWs } from '@/lib/ws'
import { GameCanvas } from '@/components/game-canvas'
import { GameDialogModal } from '@/components/game-dialog-modal'
import { TradeModal } from '@/components/trade-modal'
import { GameMenu } from '@/components/game-menu'
import { WorldSelect } from '@/components/world-select'
import { ItemIcon } from '@/components/item-icon'
import { GameInputManager } from '@/lib/game-input'
import { parseGTColors, stripGTColors } from '@/lib/gt-colors'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  MessageSquare,
  Backpack,
  Send,
  Sparkles,
  Maximize2,
  Minimize2,
  User,
  Users,
  Zap,
  Menu,
  Trash2,
  ArrowDownToLine,
  Search,
  DoorOpen,
  Volume2,
  VolumeX,
  ArrowLeftRight,
  Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

function extractChatDisplayText(line: string): string | null {
  const cleaned = line.replace(/\0/g, '').trim()
  if (!cleaned) return null
  const parts = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const isSfxPayload = parts.some(
    (p) =>
      p === 'action|play_sfx' ||
      p.startsWith('action|play_sfx') ||
      p.startsWith('file|audio/') ||
      /^delayMS\|\d+/.test(p)
  )
  if (isSfxPayload) {
    const msgLine = parts.find((p) => p.startsWith('msg|'))
    return msgLine ? msgLine.slice(4).trim() || null : null
  }
  return cleaned
}

/** Locate an adjacent or overlapping door/portal tile near the player's current position. */
function findNearbyDoor(
  bot: LiveBot | null,
  itemsMap: Map<number, ItemRecord>,
): { x: number; y: number; label: string } | null {
  if (!bot || bot.world_width <= 0 || bot.world_height <= 0 || bot.tiles.length === 0) {
    return null
  }
  const cx = Math.floor(bot.pos_x + 10 / 32)
  const cy = Math.floor(bot.pos_y + 15 / 32)
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ]

  for (const [dx, dy] of offsets) {
    const tx = cx + dx
    const ty = cy + dy
    if (tx < 0 || ty < 0 || tx >= bot.world_width || ty >= bot.world_height) continue
    const tile = bot.tiles[ty * bot.world_width + tx]
    if (!tile) continue
    const fgItem = tile.fg > 0 ? itemsMap.get(tile.fg) : undefined
    const isDoor =
      tile.tile_type?.type === 'Door' ||
      (tile.fg > 0 && fgItem !== undefined && (fgItem.action_type === 2 || fgItem.action_type === 3 || fgItem.action_type === 27))
    if (isDoor) {
      const rawLabel = (tile.tile_type as { label?: unknown } | undefined)?.label
      const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : fgItem?.name || 'Door'
      return { x: tx, y: ty, label }
    }
  }
  return null
}

export function GamePage({ onBack }: { onBack: () => void }) {
  const bots = useAtomValue(botsAtom)
  const setBots = useSetAtom(botsAtom)
  const setSelectedBotId = useSetAtom(selectedBotIdAtom)
  const selectedBot = useAtomValue(selectedBotAtom)
  const itemNames = useAtomValue(itemNamesAtom)
  const setItemNames = useSetAtom(itemNamesAtom)
  const itemsMap = useAtomValue(itemsMapAtom)

  // Fallback to first bot if none selected
  const botList = Array.from(bots.values())
  const bot: LiveBot | null = selectedBot || botList[0] || null

  // Active item ID: 18 = punch, 32 = wrench, other = placeable item
  const [activeItemId, setActiveItemId] = useState<number>(18)
  const [reachOverride, setReachOverride] = useState<number | null>(bot?.reach_override ?? null)
  const [chatOpen, setChatOpen] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatStatus, setChatStatus] = useState('')
  const [inventoryModalOpen, setInventoryModalOpen] = useState(false)
  const [playersMenuOpen, setPlayersMenuOpen] = useState(false)
  const [gameMenuOpen, setGameMenuOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [sfxMuted, setSfxMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mori:sfx_muted') === '1'
    } catch {
      return false
    }
  })
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number; inReach: boolean } | null>(null)
  const failedSfxUrlsRef = useRef<Set<string>>(new Set())

  // Drop / Trash dialog state
  const [actionItemModal, setActionItemModal] = useState<{
    type: 'drop' | 'trash'
    itemId: number
    maxCount: number
    amount: number
  } | null>(null)

  const [backpackSearch, setBackpackSearch] = useState('')

  const chatBottomRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputManagerRef = useRef<GameInputManager | null>(null)

  // Hydrate full bot state (tiles, objects, players, inventory, action_reach) on bot switch
  useEffect(() => {
    if (!bot?.id) return
    hydrateBotFromState(bot.id, setBots).catch(() => {})
  }, [bot?.id, setBots])

  // Ensure itemNames map is populated if initial app boot raced with authentication
  useEffect(() => {
    if (Object.keys(itemNames).length > 0) return
    let cancelled = false
    api
      .getItemNames()
      .then((names) => {
        if (!cancelled && names && Object.keys(names).length > 0) {
          setItemNames(names)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [itemNames, setItemNames])

  // Attach and maintain GameInputManager for real-time WASD movement
  useEffect(() => {
    if (!bot) return
    const mgr = new GameInputManager(bot.id)
    inputManagerRef.current = mgr
    mgr.start()

    return () => {
      mgr.stop()
      inputManagerRef.current = null
    }
  }, [bot?.id])

  // Update input manager bot ID when changed
  useEffect(() => {
    if (bot && inputManagerRef.current) {
      inputManagerRef.current.setBotId(bot.id)
    }
    if (bot) {
      setReachOverride(bot.reach_override ?? null)
    }
  }, [bot?.id, bot?.reach_override])

  const nativePunchReach = bot?.punch_reach ?? bot?.physics_mods?.punch_reach ?? 2
  const nativeBuildReach = bot?.build_reach ?? bot?.physics_mods?.build_reach ?? 2
  const effectiveReach =
    reachOverride !== null
      ? reachOverride
      : activeItemId === 18
        ? nativePunchReach
        : activeItemId === 32
          ? Math.max(nativePunchReach, nativeBuildReach)
          : nativeBuildReach

  const handleActionReachChange = (tiles: number) => {
    const nextOverride = tiles <= 0 ? null : tiles
    setReachOverride(nextOverride)
    if (!bot) return
    setBots((m) => {
      const cur = m.get(bot.id)
      if (!cur) return m
      const next = new Map(m)
      next.set(bot.id, {
        ...cur,
        reach_override: nextOverride,
        action_reach: nextOverride ?? Math.max(cur.punch_reach, cur.build_reach),
      })
      return next
    })
  }

  // Suspend input manager when modals are open
  useEffect(() => {
    const isModalOpen =
      inventoryModalOpen ||
      gameMenuOpen ||
      !!actionItemModal ||
      !!bot?.active_dialog ||
      !!bot?.active_trade
    inputManagerRef.current?.setSuspended(isModalOpen)
  }, [inventoryModalOpen, gameMenuOpen, actionItemModal, bot?.active_dialog, bot?.active_trade])

  // Play native Growtopia OnPlayPositioned / action|play_sfx sounds via backend CDN proxy
  useEffect(() => {
    if (!bot?.id) return
    const activeTimers: number[] = []
    const onPlaySfx = (d: { bot_id: number; file: string; delay_ms: number }) => {
      if (d.bot_id !== bot.id || sfxMuted) return
      const cleanRel = d.file
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^growtopia\//i, '')
      if (!cleanRel || cleanRel.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(cleanRel)) return

      const url = `/growtopia-cdn/growtopia/${cleanRel}`
      if (failedSfxUrlsRef.current.has(url)) return

      const trigger = () => {
        try {
          const audio = new Audio(url)
          audio.volume = 0.35
          audio.onerror = () => {
            failedSfxUrlsRef.current.add(url)
          }
          audio.play().catch(() => {})
        } catch {
          // ignore playback failures before user gesture or unsupported codecs
        }
      }

      const delay = Math.max(0, Math.min(2000, d.delay_ms || 0))
      if (delay > 0) {
        activeTimers.push(window.setTimeout(trigger, delay))
      } else {
        trigger()
      }
    }

    moriWs.bus.on('PlaySfx', onPlaySfx)
    return () => {
      moriWs.bus.off('PlaySfx', onPlaySfx)
      for (const t of activeTimers) window.clearTimeout(t)
    }
  }, [bot?.id, sfxMuted])

  const toggleSfxMute = () => {
    setSfxMuted((prev) => {
      const next = !prev
      try {
        localStorage.setItem('mori:sfx_muted', next ? '1' : '0')
      } catch {
        // ignore storage restrictions
      }
      return next
    })
  }

  // Scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (chatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [bot?.chat, chatOpen])

  // Fullscreen toggle handler
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {})
      setIsFullscreen(true)
    } else {
      document.exitFullscreen().catch(() => {})
      setIsFullscreen(false)
    }
  }

  // Wrench self handler
  const handleWrenchSelf = useCallback(() => {
    if (!bot) return
    api.sendCmd(bot.id, { type: 'wrench_self' }).catch((err) => {
      console.error('Failed to wrench self:', err)
    })
  }, [bot])

  // Nearby door / portal quick-enter helper
  const nearbyDoor = useMemo(() => findNearbyDoor(bot, itemsMap), [bot, itemsMap])

  const handleEnterDoor = useCallback(() => {
    if (!bot || !nearbyDoor) return
    api.sendCmd(bot.id, { type: 'active', x: nearbyDoor.x, y: nearbyDoor.y }).catch(() => {})
  }, [bot, nearbyDoor])

  // Send chat message
  const handleSendChat = async () => {
    if (!bot) return
    const text = chatInput.trim()
    chatInputRef.current?.blur()
    if (!text) return
    setChatInput('')
    try {
      await api.sendCmd(bot.id, { type: 'say', text })
      setChatStatus('Sent')
      setTimeout(() => setChatStatus(''), 1500)
    } catch {
      setChatStatus('Failed')
      setTimeout(() => setChatStatus(''), 1500)
    }
  }

  const [backpackTab, setBackpackTab] = useState<'all' | 'blocks' | 'wearables'>('all')
  const [pinnedHotbar, setPinnedHotbar] = useState<number[]>(() => {
    try {
      const saved = bot?.id ? localStorage.getItem(`mori:hotbar:${bot.id}`) : null
      return saved ? (JSON.parse(saved) as number[]) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    if (!bot?.id) return
    try {
      const saved = localStorage.getItem(`mori:hotbar:${bot.id}`)
      setPinnedHotbar(saved ? (JSON.parse(saved) as number[]) : [])
    } catch {
      setPinnedHotbar([])
    }
  }, [bot?.id])

  const promoteToHotbar = useCallback(
    (itemId: number) => {
      if (!bot?.id || itemId === 18 || itemId === 32) return
      setPinnedHotbar((prev) => {
        const next = [itemId, ...prev.filter((id) => id !== itemId)].slice(0, 6)
        try {
          localStorage.setItem(`mori:hotbar:${bot.id}`, JSON.stringify(next))
        } catch {
          // ignore storage quota errors
        }
        return next
      })
    },
    [bot?.id],
  )

  // Quick hotbar items: Slots 1 & 2 are fixed Fist/Wrench; 3..8 hold usable non-wearable items
  // with pinned items first, zero Fist (18) or Wrench (32) duplicates.
  const hotbarInventory: InventoryItem[] = useMemo(() => {
    const inv = bot?.inventory ?? []
    const usable = inv.filter(
      (s) => s.item_id !== 18 && s.item_id !== 32 && s.action_type !== 20,
    )
    const byId = new Map(usable.map((s) => [s.item_id, s]))
    const picked: InventoryItem[] = []
    const seen = new Set<number>()
    for (const id of pinnedHotbar) {
      const slot = byId.get(id)
      if (slot && !seen.has(id)) {
        picked.push(slot)
        seen.add(id)
      }
    }
    for (const slot of usable) {
      if (picked.length >= 6) break
      if (!seen.has(slot.item_id)) {
        picked.push(slot)
        seen.add(slot.item_id)
      }
    }
    return picked.slice(0, 6)
  }, [bot?.inventory, pinnedHotbar])

  // Global keybinds
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

      // Enter for chat focus/send
      if (e.key === 'Enter') {
        if (isInput) {
          handleSendChat()
        } else {
          e.preventDefault()
          chatInputRef.current?.focus()
        }
        return
      }

      // ESC Priority Handling
      if (e.key === 'Escape') {
        if (isInput) {
          target.blur()
          return
        }
        if (playersMenuOpen) {
          setPlayersMenuOpen(false)
          return
        }
        if (actionItemModal) {
          setActionItemModal(null)
          return
        }
        if (inventoryModalOpen) {
          setInventoryModalOpen(false)
          return
        }
        // Toggle Game Menu
        setGameMenuOpen((prev) => !prev)
        return
      }

      if (isInput) return

      // Hotkeys for tool selection & door interact
      if (e.key === '1' || e.key.toLowerCase() === 'q') {
        setActiveItemId(18) // Fist
      } else if (e.key === '2' || e.key.toLowerCase() === 'e') {
        setActiveItemId(32) // Wrench
      } else if (e.key.toLowerCase() === 'r') {
        handleWrenchSelf()
      } else if (e.key.toLowerCase() === 'f') {
        handleEnterDoor()
      } else if (e.key.toLowerCase() === 'b') {
        setInventoryModalOpen((prev) => !prev)
      } else if (e.key >= '3' && e.key <= '8') {
        const slotIdx = parseInt(e.key, 10) - 3
        const slot = hotbarInventory[slotIdx]
        if (slot) {
          setActiveItemId(slot.item_id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [bot, hotbarInventory, handleSendChat, handleWrenchSelf, handleEnterDoor, playersMenuOpen, actionItemModal, inventoryModalOpen])

  const itemLabel = (id: number) => {
    if (id === 18) return 'Fist / Punch'
    if (id === 32) return 'Wrench'
    return itemNames[String(id)] || `Item #${id}`
  }

  if (!bot) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 bg-background text-foreground">
        <p className="text-muted-foreground text-sm">No bots connected.</p>
        <Button size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Dashboard
        </Button>
      </div>
    )
  }

  const isWorldExit = !bot.world_name || bot.world_name === 'EXIT'

  // Filtered backpack inventory by tab + search (excluding duplicate built-in Fist 18 / Wrench 32)
  const filteredInventory = bot.inventory.filter((slot) => {
    if (slot.item_id === 18 || slot.item_id === 32) return false
    if (backpackTab === 'blocks' && slot.action_type === 20) return false
    if (backpackTab === 'wearables' && slot.action_type !== 20) return false
    if (!backpackSearch.trim()) return true
    const name = itemLabel(slot.item_id).toLowerCase()
    return name.includes(backpackSearch.toLowerCase()) || String(slot.item_id).includes(backpackSearch)
  })

  // Drop / Trash submission
  const handleConfirmItemAction = async () => {
    if (!actionItemModal || !bot) return
    const { type, itemId, amount } = actionItemModal
    setActionItemModal(null)
    if (amount <= 0) return

    try {
      if (type === 'drop') {
        await api.sendCmd(bot.id, { type: 'drop', item_id: itemId, count: amount })
      } else if (type === 'trash') {
        await api.sendCmd(bot.id, { type: 'trash', item_id: itemId, count: amount })
      }
    } catch (err) {
      console.error(`Failed to ${type} item:`, err)
    }
  }

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col bg-[#070b0e] text-foreground select-none relative overflow-hidden font-sans"
    >
      {/* ── Top Game Navigation Bar ────────────────────────────────────────────── */}
      <header className="shrink-0 h-11 bg-card/90 backdrop-blur border-b border-border px-3 flex items-center justify-between z-20">
        <div className="flex items-center gap-2">
          {/* Game Menu Toggle (ESC) */}
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.currentTarget.blur()
              setGameMenuOpen(true)
            }}
            className="h-8 px-2.5 text-xs font-semibold gap-1.5 hover:bg-muted text-foreground"
            title="Open Game Menu (ESC)"
          >
            <Menu className="w-4 h-4" />
            <span className="hidden sm:inline">Menu</span>
            <kbd className="hidden md:inline px-1 py-0.2 text-[9px] font-mono bg-muted rounded border border-border">
              ESC
            </kbd>
          </Button>

          {/* Bot selector dropdown if multiple bots */}
          {botList.length > 1 && (
            <select
              value={bot.id}
              onChange={(e) => {
                setSelectedBotId(Number(e.target.value))
                e.currentTarget.blur()
              }}
              className="h-8 px-2 rounded border border-border bg-background text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {botList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.username || `Bot #${b.id}`} {b.world_name ? `(${b.world_name})` : ''}
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center gap-1.5 ml-1">
            <span
              className={cn(
                'px-2.5 py-0.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 border',
                isWorldExit
                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                  : 'bg-primary/20 text-primary border-primary/30'
              )}
            >
              <span
                className={cn(
                  'w-2 h-2 rounded-full',
                  isWorldExit ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500 animate-pulse'
                )}
              />
              {bot.world_name ? bot.world_name.toUpperCase() : 'WORLD SELECT'}
            </span>

            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-muted/60 text-muted-foreground border border-border/50">
              {bot.ping_ms} ms
            </span>

            <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-400" />
              {bot.gems.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Center / Right controls */}
        <div className="flex items-center gap-2">
          {bot.net_id > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground hidden md:inline">
              NetID: {bot.net_id}
            </span>
          )}

          {/* World Players / Quick Trade Popover Trigger */}
          {!isWorldExit && (
            <Button
              size="sm"
              variant="outline"
              className={cn(
                'h-7 text-xs px-2.5 gap-1.5 font-medium border-white/15',
                playersMenuOpen ? 'bg-primary/20 text-primary border-primary/50' : 'hover:bg-accent text-accent-foreground',
              )}
              onClick={(e) => {
                e.currentTarget.blur()
                setPlayersMenuOpen((prev) => !prev)
              }}
              title="Players in World - Quick Wrench or Start Trade"
            >
              <Users className="w-3.5 h-3.5 text-sky-400" />
              <span className="hidden sm:inline">Players</span>
              <span className="font-mono text-[10px] px-1 rounded bg-white/10">
                {bot.players.size + 1}
              </span>
            </Button>
          )}

          {/* Wrench Self Button */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2.5 gap-1.5 font-medium hover:bg-accent text-accent-foreground border-white/15"
            onClick={(e) => {
              e.currentTarget.blur()
              handleWrenchSelf()
            }}
            title="Wrench Yourself (R) - Open Profile Dialog"
          >
            <User className="w-3.5 h-3.5 text-primary" />
            <span className="hidden sm:inline">Self (R)</span>
          </Button>

          {/* SFX Mute Toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.currentTarget.blur()
              toggleSfxMute()
            }}
            title={sfxMuted ? 'Unmute Sound Effects' : 'Mute Sound Effects'}
          >
            {sfxMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.currentTarget.blur()
              toggleFullscreen()
            }}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </Button>
        </div>
      </header>

      {/* ── Main Game Viewport ────────────────────────────────────────────────── */}
      <div className="flex-1 relative overflow-hidden flex flex-col">
        {/* World Select Screen (Displayed when at EXIT) */}
        {isWorldExit ? (
          <WorldSelect bot={bot} />
        ) : (
          <GameCanvas
            bot={bot}
            activeItemId={activeItemId}
            actionReach={effectiveReach}
            onTileHover={setHoveredTile}
            className="w-full h-full"
          />
        )}

        {/* Quick World Players / Trade List Popover */}
        {!isWorldExit && playersMenuOpen && (
          <div className="absolute top-3 right-3 z-20 w-64 rounded-lg border border-white/15 bg-black/90 backdrop-blur-md shadow-2xl p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-bold text-white/95 border-b border-white/10 pb-1.5">
              <span>Players in {bot.world_name}</span>
              <button
                type="button"
                onClick={() => setPlayersMenuOpen(false)}
                className="text-muted-foreground hover:text-white text-[11px] px-1"
              >
                Close
              </button>
            </div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              <div className="flex items-center justify-between px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/25 text-xs">
                <span className="font-semibold text-emerald-300 truncate">{bot.username || 'You'} (You)</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    handleWrenchSelf()
                    setPlayersMenuOpen(false)
                  }}
                >
                  Profile
                </Button>
              </div>
              {Array.from(bot.players.values()).length === 0 ? (
                <div className="text-[11px] text-muted-foreground py-2 text-center">
                  No other players nearby.
                </div>
              ) : (
                Array.from(bot.players.values()).map((p) => {
                  const pName = stripGTColors(p.name) || `Player #${p.net_id}`
                  return (
                    <div
                      key={p.net_id}
                      className="flex items-center justify-between gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-xs"
                    >
                      <span className="truncate text-white/90 font-medium">{pName}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-sky-300 hover:bg-sky-500/20"
                          title={`Wrench ${pName}`}
                          onClick={() => {
                            api.sendCmd(bot.id, { type: 'wrench_player', net_id: p.net_id }).catch(() => {})
                            setPlayersMenuOpen(false)
                          }}
                        >
                          <Wrench className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[10px] text-amber-300 hover:bg-amber-500/20 gap-1"
                          title={`Trade with ${pName}`}
                          onClick={() => {
                            api.sendCmd(bot.id, { type: 'trade_start', target_net_id: p.net_id }).catch(() => {})
                            setPlayersMenuOpen(false)
                          }}
                        >
                          <ArrowLeftRight className="w-3 h-3" />
                          Trade
                        </Button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* ── Floating In-Game Chat Overlay (Top-Left) ────────────────────────── */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 pointer-events-auto">
          <div className="flex items-center justify-between px-2.5 py-1 rounded-t-lg bg-black/85 backdrop-blur-md border-t border-x border-white/15 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5 font-bold text-white/95">
              <MessageSquare className="w-3.5 h-3.5 text-primary" />
              Chat Feed
            </span>
            <button
              onClick={(e) => {
                e.currentTarget.blur()
                setChatOpen(!chatOpen)
              }}
              className="text-[10px] hover:text-white transition-colors"
            >
              {chatOpen ? 'Minimize' : 'Expand'}
            </button>
          </div>

          {chatOpen && (() => {
            const visibleChatLines = bot.chat
              .map(extractChatDisplayText)
              .filter((line): line is string => line !== null)
              .slice(-60)

            return (
              <div className="w-[320px] sm:w-[420px] h-[190px] rounded-b-lg bg-black/80 backdrop-blur-md border border-white/15 p-2 flex flex-col gap-1.5 shadow-2xl">
                <div className="flex-1 min-h-0 overflow-y-auto space-y-1 font-mono text-[11px] leading-relaxed pr-1 select-text">
                  {visibleChatLines.length === 0 ? (
                    <div className="text-white/40 italic py-2">No messages yet. Press Enter to chat.</div>
                  ) : (
                    visibleChatLines.map((line, idx) => (
                      <div
                        key={idx}
                        className="whitespace-pre-wrap break-words"
                        dangerouslySetInnerHTML={{ __html: parseGTColors(line) }}
                      />
                    ))
                  )}
                  <div ref={chatBottomRef} />
                </div>

                {/* Chat Input */}
                <div className="shrink-0 flex items-center gap-1 pt-1 border-t border-white/15">
                  <Input
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Press Enter to talk (/say, /pull, /ban)..."
                    className="h-7 text-xs bg-black/50 border-white/20 text-white placeholder:text-white/40"
                    spellCheck={false}
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-xs bg-primary hover:bg-primary/90 text-white"
                    onClick={(e) => {
                      e.currentTarget.blur()
                      handleSendChat()
                    }}
                    disabled={!chatInput.trim()}
                  >
                    <Send className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {chatStatus && (
                  <div className="text-[10px] text-muted-foreground">{chatStatus}</div>
                )}
              </div>
            )
          })()}
        </div>

        {/* ── Bottom HUD: Hotbar & Tool Indicators ────────────────────────────── */}
        <div className="absolute bottom-3 inset-x-0 z-10 flex flex-col items-center gap-2 pointer-events-none">
          {/* Active Tool / Hover Info Pill */}
          <div className="pointer-events-auto px-3.5 py-1 rounded-full bg-black/85 backdrop-blur-md border border-white/15 text-[11px] flex items-center gap-3 shadow-xl">
            <span className="flex items-center gap-1.5 text-white font-medium">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Equipped:{' '}
              <strong className="text-primary font-bold">
                {itemLabel(activeItemId)}
              </strong>
            </span>

            {hoveredTile && (
              <span className="text-white/70 font-mono text-[10px]">
                Target: ({hoveredTile.x}, {hoveredTile.y}) •{' '}
                <span className={hoveredTile.inReach ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                  {hoveredTile.inReach ? 'In Reach' : 'Too Far'}
                </span>
              </span>
            )}

            {nearbyDoor && (
              <Button
                type="button"
                size="sm"
                onClick={(e) => {
                  e.currentTarget.blur()
                  handleEnterDoor()
                }}
                className="h-5 px-2 text-[10px] font-bold bg-cyan-500/20 hover:bg-cyan-500/35 text-cyan-200 border border-cyan-400/50 gap-1"
                title={`Enter ${nearbyDoor.label} at (${nearbyDoor.x}, ${nearbyDoor.y}) [F]`}
              >
                <DoorOpen className="w-3 h-3" />
                Enter [F]
              </Button>
            )}

            <span className="text-white/40 text-[10px] hidden lg:inline">
              Hold Left = Punch/Place • Right = Wrench • Dbl-Click/[F] = Enter Door • Shift+Wrench = Self
            </span>

            {bot.physics_mods?.active_effects && bot.physics_mods.active_effects.length > 0 && (
              <div className="flex items-center gap-1 ml-1">
                {bot.physics_mods.active_effects.map((eff) => {
                  const isMalady = eff.includes('Feet') || eff.includes('Brainworms') || eff.includes('Gemcuts') || eff.includes('Grumble') || eff.includes('Heart')
                  return (
                    <span
                      key={eff}
                      className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                        isMalady
                          ? 'bg-rose-500/20 border-rose-400/50 text-rose-300'
                          : 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200',
                      )}
                    >
                      {eff}
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {/* Quick Inventory Hotbar with Native Graphical Icons */}
          <div className="pointer-events-auto flex items-center gap-1.5 p-1.5 rounded-xl bg-black/90 backdrop-blur-md border border-white/20 shadow-2xl">
            {/* Slot 1: Fist / Punch (18) */}
            <button
              onClick={(e) => {
                e.currentTarget.blur()
                setActiveItemId(18)
              }}
              className={cn(
                'relative w-12 h-12 rounded-lg border flex flex-col items-center justify-center p-1 transition-all',
                activeItemId === 18
                  ? 'border-primary bg-primary/25 scale-105 shadow-[0_0_12px_rgba(59,130,246,0.6)]'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              )}
              title="Fist / Punch (Press 1 or Q)"
            >
              <span className="absolute top-0.5 left-1 text-[9px] font-mono text-white/50">1</span>
              <ItemIcon itemId={18} size={28} />
            </button>

            {/* Slot 2: Wrench (32) */}
            <button
              onClick={(e) => {
                e.currentTarget.blur()
                setActiveItemId(32)
              }}
              className={cn(
                'relative w-12 h-12 rounded-lg border flex flex-col items-center justify-center p-1 transition-all',
                activeItemId === 32
                  ? 'border-primary bg-primary/25 scale-105 shadow-[0_0_12px_rgba(59,130,246,0.6)]'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              )}
              title="Wrench Tool (Press 2 or E)"
            >
              <span className="absolute top-0.5 left-1 text-[9px] font-mono text-white/50">2</span>
              <ItemIcon itemId={32} size={28} />
            </button>

            {/* Slots 3..8: Fixed-width 6 Hotbar Quick Slots */}
            {Array.from({ length: 6 }, (_, idx) => {
              const slot = hotbarInventory[idx]
              if (!slot) {
                return (
                  <div
                    key={`empty-${idx}`}
                    className="relative w-12 h-12 rounded-lg border border-white/10 bg-white/[0.02] flex items-center justify-center"
                    title={`Empty Quick Slot ${idx + 3} — Select an item from Bag`}
                  >
                    <span className="absolute top-0.5 left-1 text-[9px] font-mono text-white/25">
                      {idx + 3}
                    </span>
                  </div>
                )
              }
              const isSelected = activeItemId === slot.item_id
              return (
                <button
                  key={slot.item_id}
                  onClick={(e) => {
                    e.currentTarget.blur()
                    setActiveItemId(slot.item_id)
                  }}
                  className={cn(
                    'relative w-12 h-12 rounded-lg border flex flex-col items-center justify-center p-1 transition-all',
                    isSelected
                      ? 'border-primary bg-primary/25 scale-105 shadow-[0_0_12px_rgba(59,130,246,0.6)]'
                      : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
                  )}
                  title={`${itemLabel(slot.item_id)} (${slot.amount}) - Press ${idx + 3}`}
                >
                  <span className="absolute top-0.5 left-1 text-[9px] font-mono text-white/50">
                    {idx + 3}
                  </span>
                  <ItemIcon itemId={slot.item_id} size={26} />
                  <span className="absolute bottom-0.5 right-1 text-[10px] font-mono font-black text-amber-300 drop-shadow">
                    {slot.amount}
                  </span>
                </button>
              )
            })}

            {/* Backpack Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.currentTarget.blur()
                setInventoryModalOpen(true)
              }}
              className="h-12 px-3 text-xs border-white/20 bg-white/5 hover:bg-white/15 text-white gap-1.5"
              title="Open Full Backpack (B)"
            >
              <Backpack className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline font-bold">Bag</span>
            </Button>
          </div>
        </div>
      </div>

      {/* ── Backpack / Full Inventory Modal ───────────────────────────────────── */}
      <Dialog open={inventoryModalOpen} onOpenChange={setInventoryModalOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col bg-card border-border shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center justify-between pr-6">
              <span className="flex items-center gap-2 font-bold">
                <Backpack className="w-5 h-5 text-primary" />
                Backpack ({bot.inventory.length} / {bot.inventory_slots || 100} slots)
              </span>
            </DialogTitle>
          </DialogHeader>

          {/* Filter tabs & search bar */}
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5 text-xs">
              {([
                ['all', 'All'],
                ['blocks', 'Blocks & Seeds'],
                ['wearables', 'Wearables'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setBackpackTab(key)}
                  className={cn(
                    'px-2.5 py-1 rounded-md font-medium transition-colors',
                    backpackTab === key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="relative flex-1 min-w-[160px]">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
              <Input
                value={backpackSearch}
                onChange={(e) => setBackpackSearch(e.target.value)}
                placeholder="Search items by name or ID..."
                className="pl-9 h-9 text-xs bg-background"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 p-1">
            {filteredInventory.map((slot) => {
              const isWearable = slot.action_type === 20
              const isSelected = activeItemId === slot.item_id
              return (
                <div
                  key={slot.item_id}
                  className={cn(
                    'group relative flex flex-col items-center justify-between p-2 rounded-lg border text-center transition-all cursor-pointer',
                    slot.is_active && isWearable
                      ? 'border-emerald-500/80 bg-emerald-500/15 shadow-sm'
                      : isSelected
                      ? 'border-primary bg-primary/20 shadow-sm'
                      : 'border-border bg-background hover:bg-accent'
                  )}
                  onClick={() => {
                    if (isWearable) {
                      api
                        .sendCmd(bot.id, {
                          type: slot.is_active ? 'unwear' : 'wear',
                          item_id: slot.item_id,
                        })
                        .catch(() => {})
                    } else {
                      setActiveItemId(slot.item_id)
                      promoteToHotbar(slot.item_id)
                      setInventoryModalOpen(false)
                    }
                  }}
                  title={
                    isWearable
                      ? `${itemLabel(slot.item_id)} — Click to ${slot.is_active ? 'Unequip' : 'Equip'}`
                      : `${itemLabel(slot.item_id)} — Click to equip to Hotbar`
                  }
                >
                  {isWearable && slot.is_active && (
                    <span className="absolute top-1 left-1 px-1 rounded bg-emerald-500/90 text-[8px] font-bold text-black uppercase leading-tight">
                      Worn
                    </span>
                  )}
                  <ItemIcon itemId={slot.item_id} size={36} />

                  <span className="text-[10px] font-medium text-foreground truncate w-full mt-1.5 leading-tight">
                    {itemLabel(slot.item_id)}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-primary mt-0.5">
                    {isWearable ? (slot.is_active ? 'Equipped' : 'Wear') : `x${slot.amount}`}
                  </span>

                  {/* Drop / Trash action triggers on hover */}
                  <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5">
                    <button
                      type="button"
                      title="Drop Item"
                      onClick={(e) => {
                        e.stopPropagation()
                        setActionItemModal({
                          type: 'drop',
                          itemId: slot.item_id,
                          maxCount: slot.amount,
                          amount: Math.min(200, slot.amount),
                        })
                      }}
                      className="p-1 rounded bg-black/80 hover:bg-black text-amber-300"
                    >
                      <ArrowDownToLine className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      title="Trash Item"
                      onClick={(e) => {
                        e.stopPropagation()
                        setActionItemModal({
                          type: 'trash',
                          itemId: slot.item_id,
                          maxCount: slot.amount,
                          amount: Math.min(200, slot.amount),
                        })
                      }}
                      className="p-1 rounded bg-black/80 hover:bg-black text-rose-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Drop / Trash Quantity Dialog ────────────────────────────────────── */}
      <Dialog open={!!actionItemModal} onOpenChange={(open) => !open && setActionItemModal(null)}>
        <DialogContent className="max-w-xs bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-sm capitalize font-bold flex items-center gap-2">
              {actionItemModal?.type === 'drop' ? (
                <ArrowDownToLine className="w-4 h-4 text-amber-400" />
              ) : (
                <Trash2 className="w-4 h-4 text-rose-400" />
              )}
              {actionItemModal?.type} Item
            </DialogTitle>
          </DialogHeader>

          {actionItemModal && (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-3 p-2 rounded-lg bg-background border border-border">
                <ItemIcon itemId={actionItemModal.itemId} size={32} />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold text-foreground truncate">
                    {itemLabel(actionItemModal.itemId)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Available: {actionItemModal.maxCount}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-muted-foreground font-medium">Quantity:</label>
                <Input
                  type="number"
                  min={1}
                  max={actionItemModal.maxCount}
                  value={actionItemModal.amount}
                  onChange={(e) =>
                    setActionItemModal({
                      ...actionItemModal,
                      amount: Math.max(1, Math.min(actionItemModal.maxCount, parseInt(e.target.value) || 1)),
                    })
                  }
                  className="h-8 text-xs font-mono font-bold"
                />
              </div>

              <div className="grid grid-cols-4 gap-1">
                {[1, 10, 50, actionItemModal.maxCount].map((cnt) => (
                  <Button
                    key={cnt}
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] font-mono px-1"
                    onClick={() =>
                      setActionItemModal({
                        ...actionItemModal,
                        amount: Math.min(actionItemModal.maxCount, cnt),
                      })
                    }
                  >
                    {cnt === actionItemModal.maxCount ? 'All' : cnt}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button size="sm" variant="ghost" onClick={() => setActionItemModal(null)} className="h-8 text-xs">
              Cancel
            </Button>
            <Button
              size="sm"
              variant={actionItemModal?.type === 'trash' ? 'destructive' : 'default'}
              onClick={handleConfirmItemAction}
              className="h-8 text-xs font-bold capitalize"
            >
              Confirm {actionItemModal?.type}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── ESC Game Menu Modal ────────────────────────────────────────────────── */}
      <GameMenu
        bot={bot}
        isOpen={gameMenuOpen}
        onClose={() => setGameMenuOpen(false)}
        onBackToOverview={onBack}
        actionReach={effectiveReach}
        onActionReachChange={handleActionReachChange}
      />

      {/* ── Live Player-to-Player Trade Modal ──────────────────────────────────── */}
      <TradeModal bot={bot} />

      {/* ── In-Game Native Modal Dialog ────────────────────────────────────────── */}
      <GameDialogModal bot={bot} />
    </div>
  )
}
