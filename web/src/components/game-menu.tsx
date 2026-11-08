import { useState } from 'react'
import { api } from '@/lib/api'
import type { LiveBot } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Play,
  RotateCcw,
  LogOut,
  Settings,
  ArrowLeft,
  X,
  Zap,
} from 'lucide-react'

interface GameMenuProps {
  bot: LiveBot
  isOpen: boolean
  onClose: () => void
  onBackToOverview: () => void
  actionReach: number
  onActionReachChange: (reach: number) => void
}

export function GameMenu({
  bot,
  isOpen,
  onClose,
  onBackToOverview,
  actionReach,
  onActionReachChange,
}: GameMenuProps) {
  const [tab, setTab] = useState<'main' | 'options'>('main')
  const [extendedReach, setExtendedReach] = useState(actionReach > 4)

  if (!isOpen) return null

  const handleRespawn = async () => {
    try {
      await api.sendCmd(bot.id, { type: 'respawn' })
      onClose()
    } catch {}
  }

  const handleExitWorld = async () => {
    try {
      await api.sendCmd(bot.id, { type: 'leave_world' })
      onClose()
    } catch {}
  }

  const handleToggleExtendedReach = (enabled: boolean) => {
    setExtendedReach(enabled)
    const newReach = enabled ? Math.max(8, actionReach) : 4
    onActionReachChange(newReach)
    api.sendCmd(bot.id, { type: 'set_action_reach', tiles: newReach }).catch(() => {})
  }

  const handleReachSlider = (val: number) => {
    onActionReachChange(val)
    api.sendCmd(bot.id, { type: 'set_action_reach', tiles: val }).catch(() => {})
  }

  const handleToggleThroughWall = async (throughWall: boolean) => {
    // throughWall = true means path_check is disabled/false
    await api.sendCmd(bot.id, { type: 'set_collect_path_check', enabled: !throughWall }).catch(() => {})
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm select-none p-4">
      <div className="w-full max-w-sm rounded-xl border border-white/15 bg-card/95 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-foreground">
              {tab === 'main' ? 'Game Menu' : 'Options & Settings'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 flex flex-col gap-2.5">
          {tab === 'main' ? (
            <>
              <Button
                variant="default"
                className="w-full h-10 text-sm font-semibold justify-start px-4 gap-3 bg-emerald-600 hover:bg-emerald-500 text-white"
                onClick={onClose}
              >
                <Play className="w-4 h-4" /> Continue Playing
              </Button>

              <Button
                variant="outline"
                className="w-full h-10 text-sm font-medium justify-start px-4 gap-3 hover:bg-muted"
                onClick={handleRespawn}
              >
                <RotateCcw className="w-4 h-4 text-amber-400" /> Respawn
              </Button>

              <Button
                variant="outline"
                className="w-full h-10 text-sm font-medium justify-start px-4 gap-3 hover:bg-muted"
                onClick={handleExitWorld}
              >
                <LogOut className="w-4 h-4 text-rose-400" /> Exit World (Leave)
              </Button>

              <Button
                variant="outline"
                className="w-full h-10 text-sm font-medium justify-start px-4 gap-3 hover:bg-muted"
                onClick={() => setTab('options')}
              >
                <Settings className="w-4 h-4 text-primary" /> Options & Game Controls
              </Button>

              <div className="my-1 border-t border-border" />

              <Button
                variant="ghost"
                className="w-full h-9 text-xs text-muted-foreground hover:text-foreground justify-start px-4 gap-3"
                onClick={onBackToOverview}
              >
                <ArrowLeft className="w-4 h-4" /> Back to Bot Dashboard
              </Button>
            </>
          ) : (
            <>
              {/* Options sub-menu */}
              <div className="flex flex-col gap-3">
                {/* Extended Reach Switch */}
                <div className="p-2.5 rounded-lg border border-border bg-background flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-amber-400" /> Extended Action Reach
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        Jangkauan punch & place melebihi native 4 tiles
                      </span>
                    </div>
                    <Switch
                      checked={extendedReach}
                      onCheckedChange={handleToggleExtendedReach}
                    />
                  </div>

                  {extendedReach && (
                    <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Reach limit:</span>
                        <span className="font-bold text-foreground">{actionReach} tiles</span>
                      </div>
                      <input
                        type="range"
                        min={4}
                        max={20}
                        step={1}
                        value={actionReach}
                        onChange={(e) => handleReachSlider(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500 h-1.5 bg-muted rounded cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* Through Wall Collect */}
                <div className="p-2.5 rounded-lg border border-border bg-background flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold text-foreground">Through-Wall Collection</span>
                    <span className="text-[10px] text-muted-foreground">
                      Ambil floating items di balik tembok
                    </span>
                  </div>
                  <Switch
                    checked={!bot.collect_path_check}
                    onCheckedChange={handleToggleThroughWall}
                  />
                </div>
              </div>

              <div className="my-1 border-t border-border" />

              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={() => setTab('main')}
              >
                <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to Menu
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
