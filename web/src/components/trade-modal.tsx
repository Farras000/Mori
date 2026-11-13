import { useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { api, type TradeSlot, type TradeState } from '@/lib/api'
import { itemNamesAtom, itemsMapAtom, type LiveBot } from '@/lib/store'
import { stripGTColors } from '@/lib/gt-colors'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ItemIcon } from '@/components/item-icon'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Lock,
  Plus,
  Search,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'

interface TradeSidePanelProps {
  title: string
  slots: TradeSlot[]
  locked: boolean
  accepted: boolean
  editable?: boolean
  itemNames: Record<string, string>
  onRemoveSlot?: (itemId: number) => void
}

function TradeSidePanel({
  title,
  slots,
  locked,
  accepted,
  editable = false,
  itemNames,
  onRemoveSlot,
}: TradeSidePanelProps) {
  const displaySlots = Math.max(4, slots.length)

  return (
    <div
      className={cn(
        'rounded-lg border p-2.5 flex flex-col gap-2 transition-colors',
        locked
          ? 'border-emerald-500/50 bg-emerald-500/5'
          : 'border-border bg-background/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-foreground truncate">{title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border',
              locked
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-amber-500/10 text-amber-300 border-amber-500/30',
            )}
          >
            {locked ? <Lock className="w-2.5 h-2.5" /> : <Unlock className="w-2.5 h-2.5" />}
            {locked ? 'Locked' : 'Editing'}
          </span>
          {accepted && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40">
              <CheckCircle2 className="w-2.5 h-2.5" />
              Ready
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {Array.from({ length: displaySlots }).map((_, idx) => {
          const slot = slots[idx]
          if (!slot || slot.item_id <= 0) {
            return (
              <div
                key={`empty-${idx}`}
                className="h-16 rounded border border-dashed border-white/10 bg-black/20 flex items-center justify-center text-[10px] text-muted-foreground/40"
              >
                Empty
              </div>
            )
          }

          const name = itemNames[String(slot.item_id)] ?? `Item #${slot.item_id}`
          return (
            <div
              key={`${slot.item_id}-${idx}`}
              className="group relative h-16 rounded border border-white/15 bg-card/80 p-1 flex flex-col items-center justify-between text-center"
              title={`${name} x${slot.count}`}
            >
              <ItemIcon itemId={slot.item_id} size={26} />
              <span className="text-[9px] text-foreground/90 truncate w-full leading-tight">
                {name}
              </span>
              <span className="text-[9px] font-mono font-bold text-amber-300 leading-none">
                x{slot.count}
              </span>
              {editable && !locked && onRemoveSlot && (
                <button
                  type="button"
                  title="Remove from trade"
                  onClick={() => onRemoveSlot(slot.item_id)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-rose-600 hover:bg-rose-500 text-white hidden group-hover:flex items-center justify-center shadow"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface TradeModalProps {
  bot: LiveBot
}

/** Native Growtopia-style player-to-player live trade dialog. */
export function TradeModal({ bot }: TradeModalProps) {
  const trade: TradeState | null = bot.active_trade ?? null
  const itemNames = useAtomValue(itemNamesAtom)
  const itemsMap = useAtomValue(itemsMapAtom)
  const setItemsMap = useSetAtom(itemsMapAtom)

  const [search, setSearch] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [offerCount, setOfferCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [partnerModifiedWarning, setPartnerModifiedWarning] = useState(false)

  const prevPartnerSigRef = useRef('')
  const cancelledRef = useRef(false)

  // Hydrate missing item records shown inside either trade offer column
  useEffect(() => {
    if (!trade) return
    const missing: number[] = []
    for (const s of [...trade.self_slots, ...trade.partner_slots]) {
      if (s.item_id > 0 && !itemsMap.has(s.item_id)) {
        missing.push(s.item_id)
      }
    }
    if (missing.length === 0) return
    api
      .getItemsByIds(Array.from(new Set(missing)))
      .then((records) => {
        if (!records?.length) return
        setItemsMap((prev) => {
          const next = new Map(prev)
          for (const rec of records) next.set(rec.id, rec)
          return next
        })
      })
      .catch(() => {})
  }, [trade, itemsMap, setItemsMap])

  // Flag partner offer edits so the player remembers to re-verify before locking/confirming
  useEffect(() => {
    if (!trade) {
      cancelledRef.current = false
      prevPartnerSigRef.current = ''
      setPartnerModifiedWarning(false)
      setSelectedItemId(null)
      setSearch('')
      return
    }
    const sig = trade.partner_slots.map((s) => `${s.item_id}:${s.count}`).join('|')
    if (prevPartnerSigRef.current && prevPartnerSigRef.current !== sig) {
      setPartnerModifiedWarning(true)
      const timer = window.setTimeout(() => setPartnerModifiedWarning(false), 4500)
      prevPartnerSigRef.current = sig
      return () => window.clearTimeout(timer)
    }
    prevPartnerSigRef.current = sig
  }, [trade])

  const tradableInventory = useMemo(() => {
    const q = search.trim().toLowerCase()
    return bot.inventory.filter((slot) => {
      if (slot.item_id === 18 || slot.item_id === 32 || slot.amount <= 0) return false
      if (!q) return true
      const name = (itemNames[String(slot.item_id)] ?? '').toLowerCase()
      return name.includes(q) || String(slot.item_id).includes(q)
    })
  }, [bot.inventory, search, itemNames])

  const selectedSlot = useMemo(
    () => bot.inventory.find((s) => s.item_id === selectedItemId) ?? null,
    [bot.inventory, selectedItemId],
  )

  if (!trade) return null

  const partnerClean = stripGTColors(trade.partner_name) || `Player #${trade.partner_net_id}`
  const bothLocked = trade.self_locked && trade.partner_locked

  const sendTradeCmd = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      // silent fallback; WS console/toast reports server failures
    } finally {
      setBusy(false)
    }
  }

  const handleOfferItem = () => {
    if (!selectedSlot || trade.self_locked) return
    const qty = Math.max(1, Math.min(selectedSlot.amount, offerCount))
    sendTradeCmd(() => api.sendCmd(bot.id, { type: 'trade_offer_item', item_id: selectedSlot.item_id, count: qty }))
  }

  const handleRemoveSlot = (itemId: number) => {
    if (trade.self_locked) return
    sendTradeCmd(() => api.sendCmd(bot.id, { type: 'trade_offer_item', item_id: itemId, count: 0 }))
  }

  const handleToggleLock = () => {
    sendTradeCmd(() => api.sendCmd(bot.id, { type: 'trade_accept', locked: !trade.self_locked }))
  }

  const handleConfirmTrade = () => {
    sendTradeCmd(() => api.sendCmd(bot.id, { type: 'trade_confirm' }))
  }

  const handleCancelTrade = () => {
    if (cancelledRef.current) return
    cancelledRef.current = true
    sendTradeCmd(() => api.sendCmd(bot.id, { type: 'trade_cancel' }))
  }

  return (
    <Dialog open={Boolean(trade)} onOpenChange={(open) => { if (!open) handleCancelTrade() }}>
      <DialogContent showCloseButton={false} className="max-w-2xl bg-card/95 border-white/15 backdrop-blur-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border bg-black/25 flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-sm font-bold flex items-center gap-2">
            <ArrowLeftRight className="w-4 h-4 text-amber-400" />
            <span>Trading with {partnerClean}</span>
          </DialogTitle>
          <button
            type="button"
            onClick={handleCancelTrade}
            disabled={busy}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Cancel Trade"
          >
            <X className="w-4 h-4" />
          </button>
        </DialogHeader>

        <div className="p-4 flex flex-col gap-3 max-h-[82vh] overflow-y-auto">
          {(partnerModifiedWarning || trade.status_text) && (
            <div
              className={cn(
                'px-3 py-1.5 rounded-md border text-xs flex items-center gap-2',
                partnerModifiedWarning
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-200',
              )}
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                {partnerModifiedWarning
                  ? `${partnerClean} updated their trade offer. Verify items carefully before locking!`
                  : stripGTColors(trade.status_text)}
              </span>
            </div>
          )}

          {/* Side-by-side Offer Slots */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TradeSidePanel
              title={`${bot.username || 'Your'} Offer`}
              slots={trade.self_slots}
              locked={trade.self_locked}
              accepted={trade.self_accepted}
              editable
              itemNames={itemNames}
              onRemoveSlot={handleRemoveSlot}
            />
            <TradeSidePanel
              title={`${partnerClean}'s Offer`}
              slots={trade.partner_slots}
              locked={trade.partner_locked}
              accepted={trade.partner_accepted}
              itemNames={itemNames}
            />
          </div>

          {/* Inventory Selector to Add Items */}
          <div className="rounded-lg border border-border bg-black/20 p-3 flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                Add Item from Backpack {trade.self_locked ? '(Unlock offer first to edit)' : ''}
              </span>
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search item..."
                  className="h-7 pl-7 text-xs bg-background/70"
                />
              </div>
            </div>

            <div className="grid grid-cols-5 sm:grid-cols-7 gap-1.5 max-h-40 overflow-y-auto pr-1">
              {tradableInventory.length === 0 ? (
                <div className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  No matching items in backpack.
                </div>
              ) : (
                tradableInventory.map((slot) => {
                  const name = itemNames[String(slot.item_id)] ?? `Item #${slot.item_id}`
                  const isSelected = slot.item_id === selectedItemId
                  return (
                    <button
                      key={slot.item_id}
                      type="button"
                      disabled={trade.self_locked || busy}
                      onClick={() => {
                        setSelectedItemId(slot.item_id)
                        setOfferCount((prev) => Math.max(1, Math.min(slot.amount, prev || 1)))
                      }}
                      className={cn(
                        'p-1.5 rounded border flex flex-col items-center justify-between text-center transition-colors disabled:opacity-45',
                        isSelected
                          ? 'border-primary bg-primary/20'
                          : 'border-border bg-background/70 hover:bg-accent',
                      )}
                      title={`${name} (Owned: ${slot.amount})`}
                    >
                      <ItemIcon itemId={slot.item_id} size={24} />
                      <span className="text-[9px] truncate w-full mt-1 leading-tight">{name}</span>
                      <span className="text-[9px] font-mono text-primary font-bold">x{slot.amount}</span>
                    </button>
                  )
                })
              )}
            </div>

            {/* Selected Item Count & Add Action */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/60">
              <div className="flex items-center gap-2 min-w-0">
                {selectedSlot ? (
                  <>
                    <ItemIcon itemId={selectedSlot.item_id} size={22} />
                    <span className="text-xs font-medium truncate max-w-[160px]">
                      {itemNames[String(selectedSlot.item_id)] ?? `Item #${selectedSlot.item_id}`}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      max={selectedSlot.amount}
                      disabled={trade.self_locked || busy}
                      value={offerCount}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10)
                        setOfferCount(Number.isNaN(v) ? 1 : Math.max(1, Math.min(selectedSlot.amount, v)))
                      }}
                      className="h-7 w-20 text-xs font-mono"
                    />
                    <div className="hidden sm:flex items-center gap-1">
                      {[1, 10, 50, 200].map((preset) =>
                        selectedSlot.amount >= preset ? (
                          <Button
                            key={preset}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={trade.self_locked || busy}
                            onClick={() => setOfferCount(preset)}
                            className="h-6 px-1.5 text-[10px]"
                          >
                            {preset}
                          </Button>
                        ) : null,
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={trade.self_locked || busy}
                        onClick={() => setOfferCount(selectedSlot.amount)}
                        className="h-6 px-1.5 text-[10px]"
                      >
                        Max
                      </Button>
                    </div>
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Select an item above to add it to your trade offer.
                  </span>
                )}
              </div>

              <Button
                type="button"
                size="sm"
                disabled={!selectedSlot || trade.self_locked || busy}
                onClick={handleOfferItem}
                className="h-7 px-3 text-xs gap-1 font-semibold"
              >
                <Plus className="w-3.5 h-3.5" />
                Add to Offer
              </Button>
            </div>
          </div>
        </div>

        {/* Footer Controls */}
        <div className="px-4 py-3 border-t border-border bg-black/25 flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={handleCancelTrade}
            className="h-8 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-500/15"
          >
            Cancel Trade
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={trade.self_locked ? 'secondary' : 'default'}
              disabled={busy}
              onClick={handleToggleLock}
              className="h-8 text-xs font-semibold gap-1.5"
            >
              {trade.self_locked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
              {trade.self_locked ? 'Unlock Offer' : 'Lock / Accept'}
            </Button>

            {bothLocked && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={handleConfirmTrade}
                className="h-8 text-xs font-bold gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Confirm Final Trade
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
