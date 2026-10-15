import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { authStore } from '@/lib/auth'

function viewWsUrl(oauthId: string): string {
  const token = authStore.getToken() ?? ''
  if (import.meta.env.DEV) {
    return `ws://localhost:3000/oauth/google/${oauthId}/view?token=${encodeURIComponent(token)}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/oauth/google/${oauthId}/view?token=${encodeURIComponent(token)}`
}

function btnName(b: number): string {
  return b === 1 ? 'middle' : b === 2 ? 'right' : 'left'
}

/** In-modal remote browser: screencast frames down, input events up.
 *  Port of remote-browser/frontend viewer patterns (frame-px + fw/fh mapping,
 *  non-passive wheel, click-to-focus keyboard, insertText-only typing). */
export function GoogleBrowserModal({ oauthId, onClose }: { oauthId: string; onClose: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const manualClose = useRef(false)
  const retryRef = useRef(0)
  const rafRef = useRef(0)
  const pendingMove = useRef<{ x: number; y: number; fw?: number; fh?: number } | null>(null)
  const lastUrl = useRef<string | null>(null)
  const frames = useRef(0)
  const [connected, setConnected] = useState(false)
  const [focused, setFocused] = useState(false)
  const [fps, setFps] = useState(0)
  const [status, setStatus] = useState('connecting…')

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }, [])

  const toPage = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current
    if (!img) return null
    const rect = img.getBoundingClientRect()
    const sx = (img.naturalWidth || rect.width) / rect.width
    const sy = (img.naturalHeight || rect.height) / rect.height
    return {
      x: Math.round((clientX - rect.left) * sx),
      y: Math.round((clientY - rect.top) * sy),
      fw: img.naturalWidth || undefined,
      fh: img.naturalHeight || undefined,
    }
  }, [])

  const connect = useCallback(() => {
    manualClose.current = false
    try { wsRef.current?.close() } catch { /* ignore */ }
    const ws = new WebSocket(viewWsUrl(oauthId))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => {
      retryRef.current = 0
      setConnected(true)
      setStatus('streaming — complete Google login in this window')
    }
    ws.onclose = () => {
      setConnected(false)
      if (manualClose.current) {
        setStatus('disconnected')
        return
      }
      const n = Math.min(retryRef.current++, 5)
      setStatus('reconnecting…')
      setTimeout(() => { if (!manualClose.current) connect() }, 1000 * 2 ** n)
    }
    ws.onerror = () => setStatus('connection error (tab may have closed)')
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data)
          if (m.t === 'error') setStatus(m.message)
        } catch { /* ignore */ }
        return
      }
      const blob = new Blob([ev.data], { type: 'image/jpeg' })
      const url = URL.createObjectURL(blob)
      frames.current += 1
      if (imgRef.current) imgRef.current.src = url
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
      lastUrl.current = url
    }
  }, [oauthId])

  useEffect(() => {
    connect()
    const t = setInterval(() => {
      setFps(frames.current)
      frames.current = 0
    }, 1000)
    return () => {
      clearInterval(t)
      manualClose.current = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      try { wsRef.current?.close() } catch { /* ignore */ }
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
    }
  }, [connect])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = toPage(e.clientX, e.clientY)
      if (p) send({ t: 'wheel', ...p, dx: e.deltaX, dy: e.deltaY })
    }
    img.addEventListener('wheel', onWheel, { passive: false })
    return () => img.removeEventListener('wheel', onWheel)
  }, [send, toPage])

  useEffect(() => {
    if (!focused) return
    // Never swallow browser shortcuts (F5/F11/F12, Ctrl+R/W/…) — the remote
    // page gets plain keys and text only.
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (/^F\d+$/.test(e.key)) return
      e.preventDefault()
      if (e.key.length === 1) {
        send({ t: 'type', text: e.key })
        return
      }
      if (e.repeat) return
      send({ t: 'key', kind: 'down', key: e.key, code: e.code, text: '' })
    }
    const up = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length === 1 || /^F\d+$/.test(e.key)) return
      e.preventDefault()
      send({ t: 'key', kind: 'up', key: e.key, code: e.code })
    }
    const blur = () => setFocused(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [focused, send])

  const queueMove = (clientX: number, clientY: number) => {
    const p = toPage(clientX, clientY)
    if (!p) return
    pendingMove.current = p
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (pendingMove.current) {
        send({ t: 'move', ...pendingMove.current })
        pendingMove.current = null
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-none! sm:max-w-none! w-screen! h-[100dvh]! left-0! top-0! translate-x-0! translate-y-0! m-0! rounded-none! border-x-0 p-3 flex flex-col gap-2"
      >
        <DialogHeader className="shrink-0 flex flex-row items-center gap-2 space-y-0">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <DialogTitle className="text-xs font-medium flex-1 truncate">Google login</DialogTitle>
          <span className="text-[10px] text-muted-foreground">{fps} fps</span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onClose} aria-label="Close">
            <X className="w-3 h-3" />
          </Button>
        </DialogHeader>
        <p className="shrink-0 text-[10px] text-muted-foreground">{status}</p>
        <div className="flex-1 min-h-0 overflow-auto rounded border border-border bg-black">
          {!connected && (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          <img
            ref={imgRef}
            className="w-full h-auto block select-none"
            style={{ display: connected ? undefined : 'none' }}
            alt="remote login browser"
            draggable={false}
            onClick={() => setFocused(true)}
            onMouseMove={(e) => queueMove(e.clientX, e.clientY)}
            onMouseDown={(e) => {
              setFocused(true)
              const p = toPage(e.clientX, e.clientY)
              if (p) send({ t: 'down', ...p, button: btnName(e.button) })
            }}
            onMouseUp={(e) => {
              const p = toPage(e.clientX, e.clientY)
              if (p) send({ t: 'up', ...p, button: btnName(e.button) })
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
        <p className="shrink-0 text-[10px] text-muted-foreground">
          Click the page to type ({focused ? 'typing on' : 'typing off'}). Closing this window keeps the
          login running — reopen it from the Google tab.
        </p>
      </DialogContent>
    </Dialog>
  )
}
