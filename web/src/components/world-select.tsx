import { useState, useEffect } from 'react'
import { api, type WorldMenuSection } from '@/lib/api'
import type { LiveBot } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Globe,
  DoorOpen,
  History,
  Users,
  Compass,
  ArrowRight,
  Loader2,
} from 'lucide-react'

interface WorldSelectProps {
  bot: LiveBot
}

const RECENT_WORLDS_KEY = 'mori_recent_worlds'

export function WorldSelect({ bot }: WorldSelectProps) {
  const [worldInput, setWorldInput] = useState('')
  const [doorIdInput, setDoorIdInput] = useState('')
  const [isWarping, setIsWarping] = useState(false)
  const [recentWorlds, setRecentWorlds] = useState<string[]>([])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_WORLDS_KEY)
      if (saved) {
        setRecentWorlds(JSON.parse(saved))
      }
    } catch {}
  }, [])

  const addRecentWorld = (name: string) => {
    const upper = name.trim().toUpperCase()
    if (!upper) return
    const filtered = [upper, ...recentWorlds.filter((w) => w !== upper)].slice(0, 10)
    setRecentWorlds(filtered)
    try {
      localStorage.setItem(RECENT_WORLDS_KEY, JSON.stringify(filtered))
    } catch {}
  }

  const handleWarp = async (name: string, doorId: string = '') => {
    const cleanName = name.trim().toUpperCase()
    if (!cleanName) return

    setIsWarping(true)
    addRecentWorld(cleanName)
    try {
      await api.sendCmd(bot.id, {
        type: 'warp',
        name: cleanName,
        id: doorId.trim(),
      })
    } catch {
      setIsWarping(false)
    }
  }

  // Auto reset warping state if world name changed
  useEffect(() => {
    if (bot.world_name && bot.world_name !== 'EXIT') {
      setIsWarping(false)
    }
  }, [bot.world_name])

  const sections: WorldMenuSection[] = bot.world_menu || []

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#060a0e] via-[#091118] to-[#04070a] p-4 select-none overflow-y-auto">
      <div className="w-full max-w-xl flex flex-col gap-5 my-auto">
        {/* Title & Status */}
        <div className="flex flex-col items-center text-center gap-1.5">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-lg shadow-primary/5">
            <Globe className="w-7 h-7" />
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white mt-1">
            Growtopia World Select
          </h2>
          <p className="text-xs text-muted-foreground">
            Pilih world tujuan atau masukkan nama world untuk masuk
          </p>
        </div>

        {/* Warp Input Box */}
        <div className="p-3.5 rounded-xl border border-white/10 bg-black/60 backdrop-blur-md shadow-2xl flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                value={worldInput}
                onChange={(e) => setWorldInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleWarp(worldInput, doorIdInput)}
                placeholder="Enter world name (e.g. START, BUYGHC)..."
                className="h-10 text-sm font-semibold uppercase bg-white/5 border-white/15 text-white placeholder:text-white/40 pl-3 pr-8"
                autoFocus
                disabled={isWarping}
              />
            </div>
            <Input
              value={doorIdInput}
              onChange={(e) => setDoorIdInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleWarp(worldInput, doorIdInput)}
              placeholder="Door ID"
              className="w-24 h-10 text-xs bg-white/5 border-white/15 text-white placeholder:text-white/40"
              disabled={isWarping}
            />
            <Button
              className="h-10 px-5 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white gap-2 shadow"
              onClick={() => handleWarp(worldInput, doorIdInput)}
              disabled={!worldInput.trim() || isWarping}
            >
              {isWarping ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Warping...
                </>
              ) : (
                <>
                  Warp <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </div>

          {/* Quick presets */}
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <span className="text-[10px] text-muted-foreground mr-1">Quick:</span>
            {['START', 'TRADE', 'BUYGHC', 'HELP'].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => {
                  setWorldInput(w)
                  handleWarp(w)
                }}
                className="px-2 py-0.5 rounded text-[11px] font-mono bg-white/5 hover:bg-white/15 border border-white/10 text-white/80 transition-colors"
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        {/* Recently Visited */}
        {recentWorlds.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
              <History className="w-3.5 h-3.5 text-amber-400" /> Recently Visited
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {recentWorlds.slice(0, 8).map((w) => (
                <button
                  key={w}
                  onClick={() => handleWarp(w)}
                  disabled={isWarping}
                  className="p-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/15 text-left flex items-center justify-between transition-all group"
                >
                  <span className="text-xs font-bold font-mono text-white group-hover:text-primary truncate">
                    {w}
                  </span>
                  <DoorOpen className="w-3.5 h-3.5 text-white/40 group-hover:text-primary shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Server World Sections (My Worlds, Popular, etc.) */}
        {sections.map((sec, idx) => (
          <div key={idx} className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-semibold text-white/90">
              <span className="flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-primary" /> {sec.heading}
              </span>
              <span className="text-[10px] text-muted-foreground font-normal">
                {sec.worlds.length} worlds
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {sec.worlds.map((w, wIdx) => (
                <button
                  key={wIdx}
                  onClick={() => handleWarp(w.name)}
                  disabled={isWarping}
                  className="p-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/15 text-left flex items-center justify-between transition-all group"
                >
                  <span className="text-xs font-bold font-mono text-white group-hover:text-primary truncate">
                    {w.name}
                  </span>
                  {w.count > 0 && (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">
                      <Users className="w-2.5 h-2.5" />
                      {w.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
