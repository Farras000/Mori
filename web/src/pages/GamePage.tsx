import { useState, useEffect, useRef, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { botsAtom, selectedBotIdAtom, selectedBotAtom, itemNamesAtom, type LiveBot } from '@/lib/store'
import { api, type InventoryItem } from '@/lib/api'
import { GameCanvas } from '@/components/game-canvas'
import { GameDialogModal } from '@/components/game-dialog-modal'
import { GameMenu } from '@/components/game-menu'
import { WorldSelect } from '@/components/world-select'
import { ItemIcon } from '@/components/item-icon'
import { GameInputManager } from '@/lib/game-input'
import { parseGTColors } from '@/lib/gt-colors'
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
  Zap,
  Menu,
  Trash2,
  ArrowDownToLine,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

export function GamePage({ onBack }: { onBack: () => void }) {
  const bots = useAtomValue(botsAtom)
  const setSelectedBotId = useSetAtom(selectedBotIdAtom)
  const selectedBot = useAtomValue(selectedBotAtom)
  const itemNames = useAtomValue(itemNamesAtom)

  // Fallback to first bot if none selected
  const botList = Array.from(bots.values())
  const bot: LiveBot | null = selectedBot || botList[0] || null

  // Active item ID: 18 = punch, 32 = wrench, other = placeable item
  const [activeItemId, setActiveItemId] = useState<number>(18)
  const [actionReach, setActionReach] = useState<number>(bot?.action_reach || 4)
  const [chatOpen, setChatOpen] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatStatus, setChatStatus] = useState('')
  const [inventoryModalOpen, setInventoryModalOpen] = useState(false)
  const [gameMenuOpen, setGameMenuOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number; inReach: boolean } | null>(null)

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
    if (bot?.action_reach) {
      setActionReach(bot.action_reach)
    }
  }, [bot?.id, bot?.action_reach])

  // Suspend input manager when modals are open
  useEffect(() => {
    const isModalOpen = inventoryModalOpen || gameMenuOpen || !!actionItemModal || !!bot?.active_dialog
    inputManagerRef.current?.setSuspended(isModalOpen)
  }, [inventoryModalOpen, gameMenuOpen, actionItemModal, bot?.active_dialog])

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
    const targetNetId = bot.net_id || 1
    api.sendCmd(bot.id, { type: 'wrench_player', net_id: targetNetId }).catch((err) => {
      console.error('Failed to wrench self:', err)
    })
  }, [bot])

  // Wrench another player
  const handlePlayerWrench = useCallback((netId: number) => {
    if (!bot) return
    api.sendCmd(bot.id, { type: 'wrench_player', net_id: netId }).catch(() => {})
  }, [bot])

  // Send chat message
  const handleSendChat = async () => {
    if (!bot) return
    const text = chatInput.trim()
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

      // Hotkeys for tool selection
      if (e.key === '1' || e.key.toLowerCase() === 'q') {
        setActiveItemId(18) // Fist
      } else if (e.key === '2' || e.key.toLowerCase() === 'e') {
        setActiveItemId(32) // Wrench
      } else if (e.key.toLowerCase() === 'r') {
        handleWrenchSelf()
      } else if (e.key.toLowerCase() === 'b') {
        setInventoryModalOpen((prev) => !prev)
      } else if (e.key >= '3' && e.key <= '9') {
        const slotIdx = parseInt(e.key) - 3
        if (bot && bot.inventory[slotIdx]) {
          setActiveItemId(bot.inventory[slotIdx].item_id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [bot, handleSendChat, handleWrenchSelf, actionItemModal, inventoryModalOpen])

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

  // Quick hotbar items: Slots 1 & 2 are Fist and Wrench; 3..8 are inventory items
  const hotbarInventory: InventoryItem[] = bot.inventory.slice(0, 6)
  const isWorldExit = !bot.world_name || bot.world_name === 'EXIT'

  // Filtered backpack inventory
  const filteredInventory = bot.inventory.filter((slot) => {
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
            onClick={() => setGameMenuOpen(true)}
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
              onChange={(e) => setSelectedBotId(Number(e.target.value))}
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

          {/* Wrench Self Button */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2.5 gap-1.5 font-medium hover:bg-accent text-accent-foreground border-white/15"
            onClick={handleWrenchSelf}
            title="Wrench Yourself (R) - Open Profile Dialog"
          >
            <User className="w-3.5 h-3.5 text-primary" />
            <span className="hidden sm:inline">Self (R)</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={toggleFullscreen}
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
            actionReach={actionReach}
            onTileHover={setHoveredTile}
            onPlayerWrench={handlePlayerWrench}
            className="w-full h-full"
          />
        )}

        {/* ── Floating In-Game Chat Overlay (Top-Left) ────────────────────────── */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 pointer-events-auto">
          <div className="flex items-center justify-between px-2.5 py-1 rounded-t-lg bg-black/85 backdrop-blur-md border-t border-x border-white/15 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5 font-bold text-white/95">
              <MessageSquare className="w-3.5 h-3.5 text-primary" />
              Chat Feed
            </span>
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className="text-[10px] hover:text-white transition-colors"
            >
              {chatOpen ? 'Minimize' : 'Expand'}
            </button>
          </div>

          {chatOpen && (
            <div className="w-[320px] sm:w-[420px] h-[190px] rounded-b-lg bg-black/80 backdrop-blur-md border border-white/15 p-2 flex flex-col gap-1.5 shadow-2xl">
              <div className="flex-1 min-h-0 overflow-y-auto space-y-1 font-mono text-[11px] leading-relaxed pr-1 select-text">
                {bot.chat.length === 0 ? (
                  <div className="text-white/40 italic py-2">No messages yet. Press Enter to chat.</div>
                ) : (
                  bot.chat.slice(-60).map((line, idx) => (
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
                  onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                  placeholder="Press Enter to talk (/say, /pull, /ban)..."
                  className="h-7 text-xs bg-black/50 border-white/20 text-white placeholder:text-white/40"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs bg-primary hover:bg-primary/90 text-white"
                  onClick={handleSendChat}
                  disabled={!chatInput.trim()}
                >
                  <Send className="w-3.5 h-3.5" />
                </Button>
              </div>
              {chatStatus && (
                <div className="text-[10px] text-muted-foreground">{chatStatus}</div>
              )}
            </div>
          )}
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

            <span className="text-white/40 text-[10px] hidden md:inline">
              Hold Left Click = Punch/Place • Right Click = Wrench
            </span>
          </div>

          {/* Quick Inventory Hotbar with Native Graphical Icons */}
          <div className="pointer-events-auto flex items-center gap-1.5 p-1.5 rounded-xl bg-black/90 backdrop-blur-md border border-white/20 shadow-2xl">
            {/* Slot 1: Fist / Punch (18) */}
            <button
              onClick={() => setActiveItemId(18)}
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
              onClick={() => setActiveItemId(32)}
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

            {/* Slots 3..8: Hotbar Items */}
            {hotbarInventory.map((slot, idx) => {
              const isSelected = activeItemId === slot.item_id
              return (
                <button
                  key={`${slot.item_id}-${idx}`}
                  onClick={() => setActiveItemId(slot.item_id)}
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
              onClick={() => setInventoryModalOpen(true)}
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

          {/* Search bar */}
          <div className="relative mb-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              value={backpackSearch}
              onChange={(e) => setBackpackSearch(e.target.value)}
              placeholder="Search items by name or ID..."
              className="pl-9 h-9 text-xs bg-background"
            />
          </div>

          <div className="flex-1 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 p-1">
            {filteredInventory.map((slot) => {
              const isSelected = activeItemId === slot.item_id
              return (
                <div
                  key={slot.item_id}
                  className={cn(
                    'group relative flex flex-col items-center justify-between p-2 rounded-lg border text-center transition-all cursor-pointer',
                    isSelected
                      ? 'border-primary bg-primary/20 shadow-sm'
                      : 'border-border bg-background hover:bg-accent'
                  )}
                  onClick={() => {
                    setActiveItemId(slot.item_id)
                    setInventoryModalOpen(false)
                  }}
                >
                  <ItemIcon itemId={slot.item_id} size={36} />

                  <span className="text-[10px] font-medium text-foreground truncate w-full mt-1.5 leading-tight">
                    {itemLabel(slot.item_id)}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-primary mt-0.5">
                    x{slot.amount}
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
        actionReach={actionReach}
        onActionReachChange={setActionReach}
      />

      {/* ── In-Game Native Modal Dialog ────────────────────────────────────────── */}
      <GameDialogModal bot={bot} />
    </div>
  )
}
