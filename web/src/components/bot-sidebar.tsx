import { useEffect, useState } from 'react'
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2, X, ExternalLink, Copy, Check } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { botsAtom, selectedBotIdAtom } from '@/lib/store'
import { api, type BotStatus, type OAuthProxy, type OAuthSession, type SpawnBotBody, type SpawnLtokenBody } from '@/lib/api'
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

  return (
    <aside className="w-52 h-full shrink-0 flex flex-col bg-card border-r border-border">
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
      </ScrollArea>
    </aside>
  )
}

// ── Add Bot Form ────────────────────────────────────────────────────────────

function AddBotForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [ltokenStr, setLtokenStr] = useState('')
  const [showProxy, setShowProxy] = useState(false)
  const [proxyStr, setProxyStr] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [method, setMethod] = useState<'legacy' | 'ltoken' | 'google'>('legacy')

  function buildProxy(body: SpawnBotBody | SpawnLtokenBody | OAuthProxy) {
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
          <GoogleOAuthForm getProxy={() => { const b: OAuthProxy = {}; buildProxy(b); return b }} onSpawned={onDone} />
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
        <Button type="submit" size="sm" className="w-full text-xs" disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Spawn'}
        </Button>
      )}
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

function GoogleOAuthForm({ getProxy, onSpawned }: { getProxy: () => OAuthProxy; onSpawned: () => void }) {
  const [session, setSession] = useState<OAuthSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [manualToken, setManualToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [cloakDetail, setCloakDetail] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)

  const status = session?.status.status
  const terminal = status === 'validated' || status === 'failed'

  // Validation kills the server-side tab — drop the modal so Spawn is visible.
  useEffect(() => {
    if (status === 'validated') setBrowserOpen(false)
  }, [status])

  useEffect(() => {
    api.oauthBrowserStatus().then((b) => setCloakDetail(b.detail)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!session || terminal) return
    const t = setInterval(async () => {
      try {
        const s = await api.oauthGoogleStatus(session.id)
        setSession(s)
        setError('')
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
        {cloakDetail && <p className="text-[10px] text-muted-foreground leading-snug">Browser: {cloakDetail}</p>}
        <Button size="sm" className="w-full text-xs" disabled={loading}
          onClick={() => run(() => api.oauthGoogleStart(getProxy()), setSession)}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Start Google login'}
        </Button>
        {error && <p className="text-[10px] text-destructive text-center">{error}</p>}
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
        session.viewer_live ? (
          <Button size="sm" className="w-full text-xs" onClick={() => setBrowserOpen(true)}>
            Open browser
          </Button>
        ) : (
          <p className="text-[10px] text-muted-foreground leading-snug">
            Preparing login tab… it appears here when ready.
          </p>
        )
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
  bot: { id: number; username: string; status: BotStatus; world_name: string; gems: number }
  selected: boolean
  onSelect: () => void
}) {
  const setBots = useSetAtom(botsAtom)
  const setSelectedId = useSetAtom(selectedBotIdAtom)

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await api.deleteBot(bot.id)
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
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate leading-tight">{bot.username}</p>
        {bot.world_name ? (
          <p className="text-[10px] text-muted-foreground truncate leading-tight">{bot.world_name}</p>
        ) : (
          <p className="text-[10px] text-muted-foreground leading-tight">{STATUS_LABEL[bot.status]}</p>
        )}
      </div>
      <button
        onClick={handleDelete}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-destructive transition-all shrink-0"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}
