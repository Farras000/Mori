import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2, X, ExternalLink, Copy, Check, RefreshCw, Power, RotateCcw } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { botsAtom, selectedBotIdAtom } from '@/lib/store'
import { authStore } from '@/lib/auth'
import { api, type BotStatus, type BrowserStatus, type OAuthProxy, type OAuthSession, type ProxyInfo, type WsDialog, type SavedBot, type SpawnBotBody, type SpawnLtokenBody } from '@/lib/api'
import { GoogleBrowserModal } from '@/components/GoogleBrowserModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const STATUS_COLOR: Record<BotStatus, string> = {
  connecting: 'bg-yellow-500',
  connected: 'bg-blue-500',
  in_game: 'bg-emerald-500',
  disconnected: 'bg-gray-500',
  two_factor_auth: 'bg-orange-500',
  server_overloaded: 'bg-red-500',
  too_many_logins: 'bg-purple-500',
  update_required: 'bg-gray-500',
  maintenance: 'bg-amber-500',
}

const STATUS_LABEL: Record<BotStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  in_game: 'In Game',
  disconnected: 'Disconnected',
  two_factor_auth: '2FA',
  server_overloaded: 'Overloaded',
  too_many_logins: 'Too Many Logins',
  update_required: 'Update Required',
  maintenance: 'Maintenance',
}

export function BotSidebar({ onClose }: { onClose?: () => void }) {
  const [showForm, setShowForm] = useState(false)
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 208
    const saved = localStorage.getItem('mori:sidebar-width')
    return saved ? Math.min(Math.max(parseInt(saved, 10), 160), 340) : 208
  })
  const widthRef = useRef(width)
  widthRef.current = width
  const isResizing = useRef(false)

  const MIN_WIDTH = 160
  const MAX_WIDTH = 340

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const next = Math.min(Math.max(e.clientX, MIN_WIDTH), MAX_WIDTH)
      setWidth(next)
    }
    const onMouseUp = () => {
      if (!isResizing.current) return
      isResizing.current = false
      localStorage.setItem('mori:sidebar-width', String(widthRef.current))
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return (
    <aside
      className="relative h-full shrink-0 flex flex-col bg-card border-r border-border"
      style={{ width }}
    >
      {/* Add bot / close row */}
      <div className="shrink-0 p-2 border-b border-border flex gap-1.5">
        <Button
          size="sm"
          className="flex-1 text-xs gap-1.5"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus className="w-3 h-3" />
          Add Bot
        </Button>
        {onClose && (
          <Button size="sm" variant="ghost" className="px-2 md:hidden" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        )}
      </div>

      {/* Add bot form */}
      {showForm && (
        <div className="shrink-0 border-b border-border p-2">
          <AddBotForm onDone={() => setShowForm(false)} />
        </div>
      )}

      {/* Bot list */}
      <ScrollArea className="flex-1">
        <BotList />
        <SavedBots />
      </ScrollArea>

      {/* Resize handle (drag to resize sidebar width) */}
      <div
        className="absolute top-0 right-0 h-full w-2 cursor-ew-resize bg-transparent hover:bg-primary/20 transition-colors"
        onMouseDown={(e) => {
          e.preventDefault()
          isResizing.current = true
          document.body.style.cursor = 'ew-resize'
        }}
      />
    </aside>
  )
}

// ── Saved bots (data/bots.json) ──────────────────────────────────────────────
// Every spawned bot is remembered with its credentials, proxy and delays, so a
// server restart only costs one "Spawn" click instead of a full re-login.

function SavedBots() {
  const [bots, setBots] = useState<SavedBot[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState('')

  async function refresh() {
    try {
      const res = await api.getSavedBots()
      setBots(res.bots)
    } catch {
      // ignore - the panel is optional
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  if (bots.length === 0) return null

  async function spawn(id: number) {
    setBusy(id)
    setError('')
    try {
      await api.spawnSavedBot(id)
      await refresh()
    } catch (e) {
      setError('Spawn failed - is the bot already running?')
    } finally {
      setBusy(null)
    }
  }

  async function restart(id: number) {
    setBusy(id)
    setError('')
    try {
      await api.restartSavedBot(id)
      await refresh()
    } catch {
      setError('Restart failed')
    } finally {
      setBusy(null)
    }
  }

  async function toggleAuto(id: number, auto: boolean) {
    setBusy(id)
    try {
      await api.patchSavedBot(id, { auto_spawn: auto })
      await refresh()
    } catch {
      setError('Update failed')
    } finally {
      setBusy(null)
    }
  }

  async function forget(id: number) {
    setBusy(id)
    try {
      await api.deleteSavedBot(id)
      await refresh()
    } catch {
      setError('Delete failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        Saved ({bots.length})
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {error && <p className="text-[10px] text-destructive">{error}</p>}
          {bots.map((b) => (
            <div key={b.id} className="rounded border border-border/60 p-1.5 flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-medium truncate flex-1" title={b.label}>
                  {b.label || `bot ${b.id}`}
                </span>
                {b.running && <span className="text-[9px] text-emerald-500">running</span>}
              </div>
              <p className="text-[9px] text-muted-foreground truncate">
                {b.kind} - delay {b.delays.place_ms}/{b.delays.walk_ms} ms
                {b.proxy ? ` - proxy ${b.proxy.host}:${b.proxy.port}` : ''}
              </p>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px] flex-1"
                  disabled={busy === b.id || b.running}
                  onClick={() => spawn(b.id)}>
                  {busy === b.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : 'Spawn'}
                </Button>
                <button
                  type="button"
                  title={b.running ? 'Restart the bot (same id and settings)' : 'Start the bot'}
                  disabled={busy === b.id}
                  onClick={() => (b.running ? restart(b.id) : spawn(b.id))}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50 p-0.5"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                </button>
                <button
                  type="button"
                  title={b.auto_spawn ? 'Auto-start on: click to disable' : 'Auto-start on restart: click to enable'}
                  onClick={() => toggleAuto(b.id, !b.auto_spawn)}
                  className={cn(
                    'text-[9px] px-1 py-0.5 rounded border',
                    b.auto_spawn
                      ? 'text-emerald-500 border-emerald-500/40'
                      : 'text-muted-foreground border-border',
                  )}
                >
                  auto
                </button>
                <button
                  type="button"
                  title="Forget this bot"
                  onClick={() => forget(b.id)}
                  className="text-muted-foreground hover:text-destructive p-0.5"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Pinned device MAC ───────────────────────────────────────────────────────
// One MAC per Add-Bot flow, reused dashboard → checktoken → ENet so the
// server never sees divergent values. Format matches
// `protocol/crypto.rs::random_mac` (locally-administered unicast `02:…`).
function randomMac(): string {
  const b = new Uint8Array(5)
  crypto.getRandomValues(b)
  return ['02', ...Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase())].join(':')
}

function isValidMac(m: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(m.trim())
}

// ── Add Bot Form ────────────────────────────────────────────────────────────

function AddBotForm({ onDone }: { onDone: () => void }) {
  const [mac, setMac] = useState(() => randomMac())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [ltokenStr, setLtokenStr] = useState('')
  const [showProxy, setShowProxy] = useState(false)
  const [proxyStr, setProxyStr] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [method, setMethod] = useState<'legacy' | 'ltoken' | 'google'>('legacy')

  const macValid = isValidMac(mac)
  const ltokenMac = (() => {
    const parts = ltokenStr.split('|')
    return parts.length === 4 ? parts[2].trim().toUpperCase() : ''
  })()
  const ltokenMismatch = method === 'ltoken' && ltokenMac !== '' && ltokenMac !== mac.trim().toUpperCase()

  function buildProxy(body: SpawnBotBody | SpawnLtokenBody | OAuthProxy) {
    body.mac = mac.trim().toUpperCase()
    if (showProxy && proxyStr) {
      const parts = proxyStr.split(':')
      if (parts.length >= 2) {
        body.proxy_host = parts[0]
        body.proxy_port = parseInt(parts[1], 10)
        if (parts[2]) body.proxy_username = parts[2]
        if (parts[3]) body.proxy_password = parts[3]
      }
    }
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!macValid) {
      setError('Invalid MAC — want XX:XX:XX:XX:XX:XX')
      return
    }
    if (ltokenMismatch) {
      setError(`MAC mismatch with ltoken bundle (${ltokenMac})`)
      return
    }
    setError('')
    setLoading(true)

    try {
      if (method === 'legacy') {
        const body: SpawnBotBody = { username, password }
        buildProxy(body)
        await api.spawnBot(body)
      } else if (method === 'ltoken') {
        const body: SpawnLtokenBody = { ltoken: ltokenStr }
        buildProxy(body)
        await api.spawnLtokenBot(body)
      } else {
        return
      }
      onDone()
    } catch {
      setError('Failed to spawn bot')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <label className="text-[10px] font-medium text-muted-foreground">MAC address</label>
      <div className="flex gap-1">
        <Input
          placeholder="XX:XX:XX:XX:XX:XX"
          value={mac}
          onChange={(e) => setMac(e.target.value)}
          className="h-7 text-xs font-mono flex-1"
          spellCheck={false}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 shrink-0"
          title="Randomize MAC"
          onClick={() => setMac(randomMac())}
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>
      {!macValid && (
        <p className="text-[10px] text-destructive leading-snug">Invalid MAC — want XX:XX:XX:XX:XX:XX</p>
      )}
      {ltokenMismatch && (
        <p className="text-[10px] text-destructive leading-snug">MAC differs from ltoken bundle ({ltokenMac})</p>
      )}
      <label className="text-[10px] font-medium text-muted-foreground">Account type</label>
      <Tabs value={method} onValueChange={(v) => setMethod(v as 'legacy' | 'ltoken' | 'google')}>
        <TabsList className="w-full h-7">
          <TabsTrigger value="legacy" className="flex-1 text-[10px]">Legacy</TabsTrigger>
          <TabsTrigger value="ltoken" className="flex-1 text-[10px]">Ltoken</TabsTrigger>
          <TabsTrigger value="google" className="flex-1 text-[10px]">Google</TabsTrigger>
        </TabsList>

        <TabsContent value="legacy" className="flex flex-col gap-1.5 mt-1.5">
          <Input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="h-7 text-xs"
            required={method === 'legacy'}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-7 text-xs"
            required={method === 'legacy'}
          />
        </TabsContent>

        <TabsContent value="ltoken" className="mt-1.5">
          <Input
            placeholder="token|rid|mac|wk"
            value={ltokenStr}
            onChange={(e) => setLtokenStr(e.target.value)}
            className="h-7 text-xs font-mono"
            required={method === 'ltoken'}
          />
        </TabsContent>

        <TabsContent value="google" className="mt-1.5">
          <GoogleOAuthForm mac={mac} macValid={macValid && !ltokenMismatch} getProxy={() => { const b: OAuthProxy = {}; buildProxy(b); return b }} onSpawned={onDone} />
        </TabsContent>
      </Tabs>

      <button
        type="button"
        onClick={() => setShowProxy((v) => !v)}
        className="text-[10px] text-muted-foreground hover:text-foreground text-left flex items-center gap-1 transition-colors"
      >
        {showProxy ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        Proxy
      </button>
      {showProxy && (
        <Input
          placeholder="host:port:user:pass"
          value={proxyStr}
          onChange={(e) => setProxyStr(e.target.value)}
          className="h-7 text-xs font-mono"
        />
      )}

      {method !== 'google' && (
        <Button type="submit" size="sm" className="w-full text-xs" disabled={loading || !macValid || ltokenMismatch}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Spawn'}
        </Button>
      )}
      <p className="text-[9px] text-muted-foreground leading-snug">
        The bot and its settings are saved automatically - after a server restart you only
        press Spawn again, no re-login needed.
      </p>
      {error && <p className="text-[10px] text-destructive text-center">{error}</p>}
    </form>
  )
}

// ── Google OAuth Form ───────────────────────────────────────────────────────

const OAUTH_STATUS_LABEL: Record<string, string> = {
  waiting_browser: 'Waiting for browser login',
  watching: 'Watching browser…',
  validating: 'Validating…',
  validated: 'Validated',
  failed: 'Failed',
}

function GoogleOAuthForm({ mac, macValid, getProxy, onSpawned }: { mac: string; macValid: boolean; getProxy: () => OAuthProxy; onSpawned: () => void }) {
  const [session, setSession] = useState<OAuthSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [manualToken, setManualToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)
  const [browser, setBrowser] = useState<BrowserStatus | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const browserRef = useRef(false)

  const status = session?.status.status
  const terminal = status === 'validated' || status === 'failed'

  // Validation kills the server-side tab — drop the modal so Spawn is visible.
  useEffect(() => {
    if (status === 'validated') setBrowserOpen(false)
  }, [status])

  useEffect(() => {
    api.oauthBrowserStatus().then(setBrowser).catch(() => {})
  }, [])

  useEffect(() => {
    if (!session || terminal) return
    const t = setInterval(async () => {
      try {
        const s = await api.oauthGoogleStatus(session.id)
        setSession(s)
        setError('')
        // A failure usually means the browser provider is the problem -
        // refresh its status once so the reason is visible.
        if (s.status.status === 'failed' && !browserRef.current) {
          browserRef.current = true
          api.oauthBrowserStatus().then(setBrowser).catch(() => {})
        }
      } catch {
        // keep polling; transient failures are normal behind throttles
      }
    }, 3000)
    return () => clearInterval(t)
  }, [session?.id, terminal])

  async function run<T>(fn: () => Promise<T>, onOk: (v: T) => void) {
    setError('')
    setLoading(true)
    try {
      onOk(await fn())
    } catch {
      setError('Request failed')
    } finally {
      setLoading(false)
    }
  }

  function startOver() {
    setSession(null)
    setCallbackUrl('')
    setManualToken('')
  }

  async function copyApiToken() {
    const token = authStore.getToken()
    if (!token) {
      setError('No API token - log in again')
      return
    }
    try {
      await navigator.clipboard.writeText(token)
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 1500)
    } catch {
      setError('Copy failed')
    }
  }

  async function copyCookies() {
    if (!session) return
    try {
      await navigator.clipboard.writeText(
        session.seed_cookies.map((c) => `${c.name} = ${c.value}`).join('\n'),
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copy failed')
    }
  }

  if (!session) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[10px] text-muted-foreground leading-snug">
          Mints a login session and opens a dedicated login tab. Complete Google login
          inside the in-app browser, then Spawn.
        </p>
        {browser && (
          <p className="text-[10px] text-muted-foreground leading-snug">
            Browser: {browser.provider === 'local-chrome' ? 'local Chrome' : browser.provider}
            {browser.browser_path ? ` - ${browser.browser_path}` : ''}
          </p>
        )}
        {browser && browser.provider === 'none' && (
          <p className="text-[10px] text-destructive leading-snug">
            {browser.detail}
          </p>
        )}
        {!macValid && (
          <p className="text-[10px] text-destructive leading-snug">Set a valid MAC above first — XX:XX:XX:XX:XX:XX</p>
        )}
        <Button size="sm" className="w-full text-xs" disabled={loading || !macValid}
          onClick={() => run(() => api.oauthGoogleStart({ ...getProxy(), mac: mac.trim().toUpperCase() }), setSession)}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Start Google login'}
        </Button>
        {error && <p className="text-[10px] text-destructive text-center">{error}</p>}

        <div className="mt-1 flex flex-col gap-1 rounded-md border border-border/60 p-2">
          <p className="text-[10px] font-medium">Google says &quot;may not be secure&quot;?</p>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Install the helper extension once: chrome://extensions → Developer mode → Load
            unpacked → pick <code>assets/mori-extension</code> in the Mori folder. Then paste the
            API token into the extension options.
          </p>
          <Button size="sm" variant="outline" className="w-full text-xs" onClick={copyApiToken}>
            {copiedToken ? 'API token copied' : 'Copy API token for the extension'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium">
        <span className="text-muted-foreground">Status: </span>
        {OAUTH_STATUS_LABEL[status ?? ''] ?? status}
      </p>

      {!terminal && (
        <>
          {session.viewer_live ? (
            <Button size="sm" className="w-full text-xs" onClick={() => setBrowserOpen(true)}>
              Open browser
            </Button>
          ) : browser?.provider === 'none' ? (
            <p className="text-[10px] text-destructive leading-snug">
              {browser.detail}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug">
              Preparing login tab… (starting the browser if needed)
            </p>
          )}
          <Button size="sm" variant="outline" className="w-full text-xs" disabled={loading}
            onClick={() => run(() => api.oauthGoogleOpen(session.id), () => {})}>
            Open in my browser
          </Button>
          <Button size="sm" variant="outline" className="w-full text-xs" disabled={loading}
            onClick={() => run(() => api.oauthGoogleOpenBare(session.id), () => {})}>
            Open in a clean Chrome
          </Button>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Both use a browser with no automation at all, so Google never complains. The result
            comes back through the Mori helper extension, or paste the token below.
          </p>
        </>
      )}

      {status === 'failed' && (
        <>
          <p className="text-[10px] text-destructive leading-snug">
            {(session.status as { reason: string }).reason}
          </p>
          <Button size="sm" variant="outline" className="w-full text-xs" onClick={startOver}>
            Start over
          </Button>
        </>
      )}

      {status === 'validated' && (
        <>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Account: {(session.status as { account_type: string }).account_type || 'google'}
          </p>
          <Button size="sm" className="w-full text-xs" disabled={loading}
            onClick={() => run(
              async () => api.oauthGoogleSpawn(session.id, getProxy()),
              () => onSpawned(),
            )}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Spawn bot'}
          </Button>
          <Button size="sm" variant="outline" className="w-full text-xs" disabled={loading}
            onClick={() => run(() => api.oauthGoogleRefresh(session.id), setSession)}>
            Re-validate token
          </Button>
        </>
      )}

      {!terminal && (
        <>
          <button type="button" onClick={copyCookies}
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
            {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
            {copied ? 'Copied' : `Copy ${session.seed_cookies.length} cookies for manual import`}
          </button>
          <Input
            placeholder="Paste /google/callback URL…"
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            className="h-7 text-xs font-mono"
          />
          <Button size="sm" variant="outline" className="w-full text-xs" disabled={loading || !callbackUrl}
            onClick={() => run(() => api.oauthGoogleCallback(session.id, callbackUrl), setSession)}>
            Submit callback URL
          </Button>
          <Input
            placeholder='Paste landing "token"…'
            value={manualToken}
            onChange={(e) => setManualToken(e.target.value)}
            className="h-7 text-xs font-mono"
          />
          <Button size="sm" variant="outline" className="w-full text-xs" disabled={loading || !manualToken}
            onClick={() => run(() => api.oauthGoogleToken(session.id, manualToken), setSession)}>
            Submit token
          </Button>
        </>
      )}

      {status !== 'validated' && !terminal && (
        <a href={session.authorize_url} target="_blank" rel="noreferrer"
          className="text-[10px] text-muted-foreground hover:underline flex items-center gap-1 break-all">
          <ExternalLink className="w-2.5 h-2.5 shrink-0" />
          Open externally instead
        </a>
      )}

      {error && <p className="text-[10px] text-destructive text-center">{error}</p>}

      {browserOpen && (
        <GoogleBrowserModal oauthId={session.id} onClose={() => setBrowserOpen(false)} />
      )}
    </div>
  )
}

// ── Bot List ────────────────────────────────────────────────────────────────

function BotList() {
  const bots = useAtomValue(botsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedBotIdAtom)

  if (bots.size === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-6 px-2">
        No bots running.
      </p>
    )
  }

  return (
    <div className="p-1.5 space-y-1">
      {[...bots.values()].map((bot) => (
        <BotItem
          key={bot.id}
          bot={bot}
          selected={selectedId === bot.id}
          onSelect={() => setSelectedId(bot.id)}
        />
      ))}
    </div>
  )
}

function BotItem({
  bot,
  selected,
  onSelect,
}: {
  bot: { id: number; username: string; status: BotStatus; world_name: string; gems: number; proxy: ProxyInfo | null; active_dialog?: WsDialog | null }
  selected: boolean
  onSelect: () => void
}) {
  const setBots = useSetAtom(botsAtom)
  const setSelectedId = useSetAtom(selectedBotIdAtom)

  async function handleStop(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await api.stopBot(bot.id)
      setBots((m) => { const n = new Map(m); n.delete(bot.id); return n })
      setSelectedId((id) => (id === bot.id ? null : id))
    } catch {
      // ignore
    }
  }

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_COLOR[bot.status])} />
      <span
        className={cn(
          'text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 border',
          bot.proxy
            ? bot.status === 'connected' || bot.status === 'in_game'
              ? 'bg-green-500/20 text-green-500 border-green-500/40'
              : 'bg-red-500/20 text-red-500 border-red-500/40'
            : 'bg-muted text-muted-foreground border-border',
        )}
        title={
          bot.proxy
            ? bot.status === 'connected' || bot.status === 'in_game'
              ? 'Proxy terhubung'
              : 'Proxy tidak terhubung'
            : 'Tanpa proxy (koneksi langsung)'
        }
      >
        {bot.proxy ? 'Proxy' : 'Direct'}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium truncate leading-tight">{bot.username}</p>
          {Boolean(bot.active_dialog) && (
            <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
              DIALOG
            </span>
          )}
        </div>
        {bot.world_name ? (
          <p className="text-[10px] text-muted-foreground truncate leading-tight">{bot.world_name}</p>
        ) : (
          <p className="text-[10px] text-muted-foreground leading-tight">{STATUS_LABEL[bot.status]}</p>
        )}
      </div>
      <button
        onClick={handleStop}
        title="Stop bot - the saved settings are kept, press Spawn again to bring it back"
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-destructive transition-all shrink-0"
      >
        <Power className="w-3 h-3" />
      </button>
    </div>
  )
}
