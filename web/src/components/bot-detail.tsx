import { useState, useRef, useEffect, Fragment, type ReactNode } from "react";
import {
  X,
  Gem,
  Wifi,
  PlugZap,
  Unplug,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useSetAtom, useAtomValue } from "jotai";
import {
  selectedBotIdAtom,
  botsAtom,
  itemNamesAtom,
  type LiveBot,
} from "@/lib/store";
import { api } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { parseGTColors } from "@/lib/gt-colors";
import { Minimap } from "@/components/minimap";
import { cn } from "@/lib/utils";
import type { BotStatus, ProxyInfo } from "@/lib/api";

const STATUS_DOT: Record<BotStatus, string> = {
  connecting: "bg-yellow-500",
  connected: "bg-blue-500",
  in_game: "bg-emerald-500",
  disconnected: "bg-gray-500",
  two_factor_auth: "bg-orange-500",
  server_overloaded: "bg-red-500",
  too_many_logins: "bg-purple-500",
  update_required: "bg-gray-500",
  maintenance: "bg-amber-500",
};

export function BotDetail({ bot }: { bot: LiveBot }) {
  const setSelectedId = useSetAtom(selectedBotIdAtom);
  const setBots = useSetAtom(botsAtom);

  // Seed full state from REST on mount / bot change
  useEffect(() => {
    api.getBotState(bot.id).then((s) => {
      setBots((m) => {
        const existing = m.get(bot.id);
        if (!existing) return m;
        const players = new Map(s.players.map((p) => [p.net_id, p]));
        const tiles = s.tiles.map((t) => ({
          fg: t.fg_item_id,
          bg: t.bg_item_id,
          flags: t.flags,
          tile_type: t.tile_type,
        }));
        return new Map(m).set(bot.id, {
          ...existing,
          status: s.status,
          world_name: s.world_name,
          pos_x: s.pos_x,
          pos_y: s.pos_y,
          world_width: s.world_width,
          world_height: s.world_height,
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
          auto_reconnect: s.auto_reconnect,
          proxy: s.proxy ?? null,
        });
      });
    })
      .catch(() => {});
  }, [bot.id, setBots]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 h-10 bg-card border-b border-border">
        <span
          className={cn(
            "w-2 h-2 rounded-full shrink-0",
            STATUS_DOT[bot.status],
          )}
        />
        <span className="font-semibold text-xs">{bot.username}</span>
        {bot.world_name && (
          <>
            <span className="text-border text-xs">|</span>
            <span className="text-xs text-muted-foreground">
              {bot.world_name}
            </span>
            <span className="text-xs text-muted-foreground/50">
              ({bot.pos_x.toFixed(1)}, {bot.pos_y.toFixed(1)})
            </span>
          </>
        )}
        <div className="flex-1" />
        {bot.gems > 0 && (
          <span className="flex items-center gap-1 text-xs text-emerald-500 font-medium">
            <Gem className="w-3 h-3" />
            {bot.gems.toLocaleString()}
          </span>
        )}
        {(bot.ping_ms > 0 || bot.status === "disconnected") && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wifi className="w-3 h-3" />
            {bot.status === "disconnected" ? "-" : `${bot.ping_ms}ms`}
          </span>
        )}
        <button
          title="Reconnect"
          onClick={() => api.sendCmd(bot.id, { type: "reconnect" })}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <PlugZap className="w-3 h-3" />
        </button>
        <button
          title="Disconnect"
          onClick={() => api.sendCmd(bot.id, { type: "disconnect" })}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Unplug className="w-3 h-3" />
        </button>
        <button
          onClick={() => setSelectedId(null)}
          className="ml-1 w-5 h-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Tabs */}
      <Tabs
        defaultValue="overview"
        className="flex-1 flex flex-col overflow-hidden"
      >
        <TabsList className="shrink-0 w-full justify-start rounded-none border-b border-border bg-card/40 h-9 px-2 gap-0">
          {(["overview", "console", "script", "config"] as const).map((t) => (
            <TabsTrigger
              key={t}
              value={t}
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 h-full text-xs capitalize"
            >
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="flex-1 overflow-hidden m-0">
          <OverviewTab bot={bot} />
        </TabsContent>

        <TabsContent
          value="console"
          className="flex-1 overflow-hidden m-0 p-4 flex flex-col"
        >
          <ConsoleTab lines={bot.console} />
        </TabsContent>

        <TabsContent
          value="script"
          className="flex-1 overflow-hidden m-0 p-4 flex flex-col gap-3"
        >
          <ScriptTab botId={bot.id} />
        </TabsContent>

        <TabsContent value="config" className="flex-1 overflow-auto m-0 p-4">
          <ConfigTab
            botId={bot.id}
            delays={bot.delays}
            autoCollect={bot.auto_collect}
            autoReconnect={bot.auto_reconnect}
            proxy={bot.proxy}
            botStatus={bot.status}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────

function WarpInput({ botId }: { botId: number }) {
  const [worldName, setWorldName] = useState('')
  const [doorId, setDoorId] = useState('')

  const doWarp = () => {
    const name = worldName.trim().toUpperCase()
    if (!name) return
    api.sendCmd(botId, { type: 'warp', name, id: doorId.trim() }).catch(() => {})
  }

  return (
    <div className="flex gap-1 mb-2">
      <Input
        className="h-7 text-xs uppercase"
        placeholder="World name"
        value={worldName}
        onChange={(e) => setWorldName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && doWarp()}
      />
      <Input
        className="h-7 text-xs w-16"
        placeholder="Door"
        value={doorId}
        onChange={(e) => setDoorId(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && doWarp()}
      />
      <Button size="sm" className="h-7 text-xs px-2" onClick={doWarp}>
        Warp
      </Button>
    </div>
  )
}

function OverviewTab({ bot }: { bot: LiveBot }) {
  const players = [...bot.players.values()];
  const itemNames = useAtomValue(itemNamesAtom);
  const itemLabel = (id: number) => {
    const name = itemNames[String(id)];
    return name ? `${name} (${id})` : String(id);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden p-4 gap-4">
      {/* Top PiP Dock: Minimap + Chat side-by-side (Pinned / Always visible) */}
      <div className="shrink-0 flex flex-col sm:flex-row gap-4 items-start">
        <div className="w-full sm:w-[440px] shrink-0">
          <Section label="Minimap" hint="klik untuk jalan · scroll untuk zoom">
            <div className="w-full aspect-video">
              <Minimap bot={bot} />
            </div>
          </Section>
        </div>

        <div className="w-full sm:w-[380px] lg:w-[420px] shrink-0 h-[272px]">
          <ChatPanel botId={bot.id} chat={bot.chat} />
        </div>
      </div>

      {/* Bottom Content: Scrollable independent area */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pr-3 pb-4">
          {/* Left column: tiles + players */}
          <div className="flex flex-col gap-4">
            <Section label="Tiles in World">
              <TilesTable tiles={bot.tiles} itemLabel={itemLabel} />
            </Section>

            <Section label="Players in World">
              <DataTable
                columns={["Name", "Net ID", "Country"]}
                rows={players.map((p) => [p.name, String(p.net_id), p.country])}
                empty="No players"
              />
            </Section>
          </div>

          {/* Right column: account + inventory + objects */}
          <div className="flex flex-col gap-4">
            <Section label="Account">
              <div className="rounded border border-border bg-background p-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                {[
                  ["Level", bot.track_info?.level],
                  ["Grow ID", bot.track_info?.grow_id],
                  ["Awesomeness", bot.track_info?.awesomeness],
                  [
                    "Playtime",
                    bot.track_info
                      ? `${Math.floor(bot.track_info.global_playtime / 3600)}h`
                      : null,
                  ],
                  [
                    "Install Date",
                    bot.track_info
                      ? new Date(
                          bot.track_info.install_date * 1000,
                        ).toLocaleDateString()
                      : null,
                  ],
                ].map(([label, val]) => (
                  <Fragment key={label}>
                    <span className="text-muted-foreground">
                      {label}
                    </span>
                    <span className="text-foreground">
                      {val ?? "—"}
                    </span>
                  </Fragment>
                ))}
              </div>
              <button
                className="mt-2 w-full rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                onClick={() => api.sendCmd(bot.id, { type: "accept_access" })}
              >
                Accept Access
              </button>
            </Section>

            <AutoCollectRangePanel
              botId={bot.id}
              collectRadiusTiles={bot.collect_radius_tiles}
              collectBlacklist={bot.collect_blacklist}
            />

            <Section label="Movement">
              <WarpInput botId={bot.id} />
              <DPad botId={bot.id} />
            </Section>

            <Section
              label="Inventory"
              hint={bot.inventory_slots > 0 ? `${bot.inventory.length} / ${bot.inventory_slots} slots` : undefined}
            >
              <InventoryTable
                botId={bot.id}
                inventory={bot.inventory}
                itemLabel={itemLabel}
              />
            </Section>

            <Section label="Floating Objects">
              <DataTable
                columns={["Item", "Amt", "Pos", "UID"]}
                rows={bot.objects.map((o) => [
                  itemLabel(o.item_id),
                  String(o.count),
                  `${o.x.toFixed(1)},${o.y.toFixed(1)}`,
                  String(o.uid),
                ])}
                empty="No objects"
              />
            </Section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Overview: auto-collect range + blacklist ────────────────────────────────

/** 9×9 so Chebyshev distance from center runs 0..4 → clickable radius 1..5 (was 5×5 → max 3). */
const COLLECT_GRID = 9
const COLLECT_MID = (COLLECT_GRID - 1) / 2

function collectChebyshev(row: number, col: number) {
  return Math.max(Math.abs(row - COLLECT_MID), Math.abs(col - COLLECT_MID))
}

function collectRadiusFromCell(row: number, col: number) {
  return Math.min(5, Math.max(1, collectChebyshev(row, col) + 1))
}

function cellInsideCollectRadius(row: number, col: number, radiusTiles: number) {
  return collectChebyshev(row, col) < radiusTiles
}

function AutoCollectRangePanel({
  botId,
  collectRadiusTiles,
  collectBlacklist,
}: {
  botId: number
  collectRadiusTiles: number
  collectBlacklist: number[]
}) {
  const [collectRadius, setCollectRadius] = useState(collectRadiusTiles)
  const [blacklist, setBlacklist] = useState<number[]>(() => [...collectBlacklist])
  const [blacklistInput, setBlacklistInput] = useState('')
  const setBots = useSetAtom(botsAtom)
  const itemNames = useAtomValue(itemNamesAtom)

  useEffect(() => {
    setCollectRadius(collectRadiusTiles)
    setBlacklist([...collectBlacklist].sort((a, b) => a - b))
  }, [collectRadiusTiles, collectBlacklist.join(',')])

  const itemLabel = (id: number) => {
    const name = itemNames[String(id)]
    return name ? `${name} (${id})` : String(id)
  }

  async function sendCollectConfig(nextRadius: number, nextBlacklist: number[]) {
    const prevRadius = collectRadius
    const prevBlacklist = blacklist
    setCollectRadius(nextRadius)
    setBlacklist(nextBlacklist)
    setBots((m) => {
      const b = m.get(botId)
      if (!b) return m
      return new Map(m).set(botId, {
        ...b,
        collect_radius_tiles: nextRadius,
        collect_blacklist: [...nextBlacklist].sort((a, b) => a - b),
      })
    })
    try {
      await api.sendCmd(botId, {
        type: 'set_collect_config',
        radius_tiles: nextRadius,
        blacklist: nextBlacklist,
      })
    } catch {
      setCollectRadius(prevRadius)
      setBlacklist(prevBlacklist)
      setBots((m) => {
        const b = m.get(botId)
        if (!b) return m
        return new Map(m).set(botId, {
          ...b,
          collect_radius_tiles: prevRadius,
          collect_blacklist: [...prevBlacklist].sort((a, b) => a - b),
        })
      })
    }
  }

  function onCollectCellClick(row: number, col: number) {
    const next = collectRadiusFromCell(row, col)
    void sendCollectConfig(next, blacklist)
  }

  function addBlacklistId() {
    const id = parseInt(blacklistInput.trim(), 10)
    if (!Number.isFinite(id) || id < 0 || id > 65535) return
    if (blacklist.includes(id)) return
    const next = [...blacklist, id].sort((a, b) => a - b)
    setBlacklistInput('')
    void sendCollectConfig(collectRadius, next)
  }

  function removeBlacklistId(id: number) {
    const next = blacklist.filter((x) => x !== id)
    void sendCollectConfig(collectRadius, next)
  }

  return (
    <>
      <Section
        label="Auto-collect range"
        hint="square in tiles"
      >
        <div className="flex flex-col items-center gap-2 w-full">
          <div
            className="grid gap-0.5 w-fit shrink-0 p-1 rounded border border-border bg-muted/30"
            style={{ gridTemplateColumns: `repeat(${COLLECT_GRID}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: COLLECT_GRID * COLLECT_GRID }, (_, i) => {
              const row = Math.floor(i / COLLECT_GRID)
              const col = i % COLLECT_GRID
              const inRange = cellInsideCollectRadius(row, col, collectRadius)
              const isCenter = row === COLLECT_MID && col === COLLECT_MID
              return (
                <button
                  key={i}
                  type="button"
                  title={`Set radius ${collectRadiusFromCell(row, col)}`}
                  onClick={() => onCollectCellClick(row, col)}
                  className={cn(
                    'w-6 h-6 rounded-sm border text-[9px] font-medium transition-colors',
                    inRange
                      ? 'bg-primary/35 border-primary/50 text-foreground'
                      : 'bg-background/80 border-border text-muted-foreground',
                    isCenter && 'ring-1 ring-primary ring-inset',
                  )}
                >
                  {isCenter ? '●' : ''}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Radius: <span className="text-foreground font-medium tabular-nums">{collectRadius}</span> tile{collectRadius === 1 ? '' : 's'}
          </p>
        </div>
      </Section>
      <Section label="Do not auto-collect" hint="item IDs">
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            max={65535}
            placeholder="Item ID"
            value={blacklistInput}
            onChange={(e) => setBlacklistInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addBlacklistId()}
            className="h-7 text-xs"
          />
          <Button size="sm" variant="secondary" className="text-xs shrink-0 h-7" type="button" onClick={addBlacklistId}>
            Add
          </Button>
        </div>
        <ul className="max-h-32 overflow-y-auto rounded border border-border bg-background divide-y divide-border text-xs">
          {blacklist.length === 0 ? (
            <li className="px-2 py-2 text-muted-foreground text-center">No blacklisted items</li>
          ) : (
            blacklist.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="truncate">{itemLabel(id)}</span>
                <button
                  type="button"
                  onClick={() => removeBlacklistId(id)}
                  className="shrink-0 text-muted-foreground hover:text-destructive text-[10px] uppercase tracking-wide"
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
      </Section>
    </>
  )
}

// ── Console tab ─────────────────────────────────────────────────────────────

function ConsoleTab({ lines }: { lines: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <ScrollArea className="flex-1 min-h-0 rounded border border-border bg-background p-3 font-mono text-[12px] leading-relaxed">
      {lines.length === 0 ? (
        <span className="text-muted-foreground">No output yet.</span>
      ) : (
        lines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap break-all"
            dangerouslySetInnerHTML={{ __html: parseGTColors(line) }}
          />
        ))
      )}
      <div ref={bottomRef} />
    </ScrollArea>
  );
}

// ── Chat panel (embedded in overview right sidebar) ─────────────────────────

function ChatPanel({ botId, chat }: { botId: number; chat: string[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await api.sendCmd(botId, { type: "say", text });
      setStatus("Terkirim");
      setTimeout(() => setStatus(""), 2000);
    } catch {
      setStatus("Gagal mengirim");
      setTimeout(() => setStatus(""), 2000);
    }
  }

  return (
    <Section label="Chat" hint="ketik /pull, /ban, /say, atau pesan biasa" className="h-full">
      <div className="flex flex-col h-full gap-2 min-h-0">
        <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
          {chat.length === 0 ? (
            <span className="text-muted-foreground">Belum ada pesan chat.</span>
          ) : (
            chat.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all mb-1">
                {line.startsWith("[Kamu]") ? (
                  <span className="text-primary">{line}</span>
                ) : (
                  <span className="text-foreground">{line}</span>
                )}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="/pull, /ban, /say…"
            className="flex-1 h-6 text-[10px]"
            spellCheck={false}
          />
          <Button size="sm" className="text-[10px] px-2" onClick={send} disabled={!input.trim()}>
            Kirim
          </Button>
          {status && (
            <span className="text-[10px] text-muted-foreground">{status}</span>
          )}
        </div>
      </div>
    </Section>
  );
}

// ── Script tab ──────────────────────────────────────────────────────────────

function ScriptTab({ botId }: { botId: number }) {
  const [script, setScript] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(`bot_script_${botId}`);
    setScript(saved ?? "");
  }, [botId]);

  async function run() {
    try {
      await api.sendCmd(botId, { type: "run_script", content: script });
      localStorage.setItem(`bot_script_${botId}`, script);
      setStatus("Running…");
    } catch {
      setStatus("Error");
    }
  }

  async function stop() {
    try {
      await api.sendCmd(botId, { type: "stop_script" });
      setStatus("Stopped");
    } catch {
      setStatus("Error");
    }
  }

  return (
    <>
      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        spellCheck={false}
        className="flex-1 font-mono text-[13px] bg-background border border-border rounded p-3 text-foreground resize-none outline-none leading-relaxed focus:border-ring transition-colors"
        placeholder={'-- Lua script\nbot:warp("START")\nsleep(500)'}
      />
      <div className="shrink-0 flex items-center gap-2">
        <Button size="sm" variant="default" className="text-xs" onClick={run}>
          Run
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="text-xs"
          onClick={stop}
        >
          Stop
        </Button>
        {status && (
          <span className="text-xs text-muted-foreground">{status}</span>
        )}
      </div>
    </>
  );
}

// ── Config tab ──────────────────────────────────────────────────────────────

function formatProxy(p: ProxyInfo | null | undefined): string {
  if (!p) return "";
  const base = `${p.host}:${p.port}`;
  if (p.username) return p.password ? `${base}:${p.username}:${p.password}` : `${base}:${p.username}`;
  return base;
}

function parseProxyStr(raw: string):
  | { empty: true }
  | { empty: false; body: { proxy_host: string; proxy_port: number; proxy_username?: string; proxy_password?: string } }
  | { error: string } {
  const s = raw.trim();
  if (!s) return { empty: true };
  const parts = s.split(":");
  if (parts.length < 2 || !parts[0].trim()) return { error: "Want host:port[:user[:pass]]" };
  const port = parseInt(parts[1].trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be 1–65535" };
  const body: { proxy_host: string; proxy_port: number; proxy_username?: string; proxy_password?: string } = {
    proxy_host: parts[0].trim(),
    proxy_port: port,
  };
  if (parts[2]?.trim()) body.proxy_username = parts[2].trim();
  const pass = parts.slice(3).join(":").trim();
  if (pass) body.proxy_password = pass;
  return { empty: false, body };
}

function ConfigTab({
  botId,
  delays,
  autoCollect,
  autoReconnect,
  proxy,
  botStatus,
}: {
  botId: number;
  delays: {
    place_ms: number;
    place_max_ms?: number | null;
    walk_ms: number;
    walk_max_ms?: number | null;
    twofa_secs: number;
    server_overload_secs: number;
    too_many_logins_secs: number;
    maintenance_secs: number;
  };
  autoCollect: boolean;
  autoReconnect: boolean;
  proxy: ProxyInfo | null;
  botStatus: BotStatus;
}) {
  const [placeMs, setPlaceMs] = useState(String(delays.place_ms));
  const [placeMaxMs, setPlaceMaxMs] = useState(delays.place_max_ms != null ? String(delays.place_max_ms) : "");
  const [walkMs, setWalkMs] = useState(String(delays.walk_ms));
  const [walkMaxMs, setWalkMaxMs] = useState(delays.walk_max_ms != null ? String(delays.walk_max_ms) : "");
  const [twofaSecs, setTwofaSecs] = useState(String(delays.twofa_secs));
  const [serverOverloadSecs, setServerOverloadSecs] = useState(
    String(delays.server_overload_secs),
  );
  const [tooManyLoginsSecs, setTooManyLoginsSecs] = useState(
    String(delays.too_many_logins_secs),
  );
  const [maintenanceSecs, setMaintenanceSecs] = useState(
    String(delays.maintenance_secs),
  );
  const [status, setStatus] = useState("");
  const setBots = useSetAtom(botsAtom);

  // sync when bot prop changes
  useEffect(() => {
    setPlaceMs(String(delays.place_ms));
    setPlaceMaxMs(delays.place_max_ms != null ? String(delays.place_max_ms) : "");
    setWalkMs(String(delays.walk_ms));
    setWalkMaxMs(delays.walk_max_ms != null ? String(delays.walk_max_ms) : "");
    setTwofaSecs(String(delays.twofa_secs));
    setServerOverloadSecs(String(delays.server_overload_secs));
    setTooManyLoginsSecs(String(delays.too_many_logins_secs));
    setMaintenanceSecs(String(delays.maintenance_secs));
  }, [
    delays.place_ms,
    delays.place_max_ms,
    delays.walk_ms,
    delays.walk_max_ms,
    delays.twofa_secs,
    delays.server_overload_secs,
    delays.too_many_logins_secs,
    delays.maintenance_secs,
  ]);

  async function save() {
    const newDelays = {
      place_ms: parseInt(placeMs, 10) || 0,
      place_max_ms: placeMaxMs ? parseInt(placeMaxMs, 10) : null,
      walk_ms: parseInt(walkMs, 10) || 0,
      walk_max_ms: walkMaxMs ? parseInt(walkMaxMs, 10) : null,
      twofa_secs: parseInt(twofaSecs, 10) || 120,
      server_overload_secs: parseInt(serverOverloadSecs, 10) || 30,
      too_many_logins_secs: parseInt(tooManyLoginsSecs, 10) || 5,
      maintenance_secs: parseInt(maintenanceSecs, 10) || 600,
    };
    try {
      await api.sendCmd(botId, { type: "set_delays", ...newDelays });
      setBots((m) => {
        const bot = m.get(botId);
        if (!bot) return m;
        return new Map(m).set(botId, { ...bot, delays: newDelays });
      });
      setStatus("Saved");
      setTimeout(() => setStatus(""), 2000);
    } catch {
      setStatus("Error");
    }
  }

  // ── Proxy (disconnect-first) ──
  const [proxyStr, setProxyStr] = useState(() => formatProxy(proxy));
  const [proxyStatus, setProxyStatus] = useState("");
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);

  useEffect(() => {
    setProxyStr(formatProxy(proxy));
  }, [proxy?.host, proxy?.port, proxy?.username, proxy?.password]);

  const needsDisconnect = botStatus !== "disconnected";

  async function waitForDisconnected(timeoutMs = 10000) {
    const start = Date.now();
    for (;;) {
      try {
        const s = await api.getBotState(botId);
        if (s.status === "disconnected") return true;
      } catch {
        // keep polling
      }
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function saveProxy() {
    const parsed = parseProxyStr(proxyStr);
    if ("error" in parsed) {
      setProxyStatus(parsed.error);
      return;
    }
    setProxyBusy(true);
    setProxyStatus("");
    try {
      // Guarantee: bot must be offline before the proxy is swapped so the
      // old UDP-via-proxy socket is torn down first.
      if (needsDisconnect) {
        setProxyStatus("Disconnecting…");
        await api.sendCmd(botId, { type: "disconnect" });
        const offline = await waitForDisconnected();
        if (!offline) {
          setProxyStatus("Disconnect timed out — try again");
          return;
        }
      }
      if (parsed.empty) {
        await api.sendCmd(botId, { type: "set_proxy" });
      } else {
        await api.sendCmd(botId, { type: "set_proxy", ...parsed.body });
      }
      const next: ProxyInfo | null = parsed.empty
        ? null
        : {
            host: parsed.body.proxy_host,
            port: parsed.body.proxy_port,
            ...(parsed.body.proxy_username ? { username: parsed.body.proxy_username } : {}),
            ...(parsed.body.proxy_password ? { password: parsed.body.proxy_password } : {}),
          };
      setBots((m) => {
        const bot = m.get(botId);
        if (!bot) return m;
        return new Map(m).set(botId, { ...bot, proxy: next });
      });
      setProxyStatus("Saved — reconnect to apply");
      setTimeout(() => setProxyStatus(""), 4000);
    } catch {
      setProxyStatus("Error");
    } finally {
      setProxyBusy(false);
    }
  }

  async function testProxy() {
    const parsed = parseProxyStr(proxyStr);
    if ("error" in parsed) {
      setProxyStatus(parsed.error);
      return;
    }
    if (parsed.empty) {
      setProxyStatus("Enter a proxy to test");
      return;
    }
    setProxyTesting(true);
    setProxyStatus("Testing…");
    try {
      const r = await api.testProxy({
        proxy_host: parsed.body.proxy_host,
        proxy_port: parsed.body.proxy_port,
        ...(parsed.body.proxy_username ? { proxy_username: parsed.body.proxy_username } : {}),
        ...(parsed.body.proxy_password ? { proxy_password: parsed.body.proxy_password } : {}),
      });
      const failed = [r.socks5, r.server_data, r.enet].find((c) => !c.ok);
      setProxyStatus(failed ? `Failed: ${failed.error ?? "check failed"}` : "All checks passed");
    } catch {
      setProxyStatus("Test failed");
    } finally {
      setProxyTesting(false);
    }
  }

  return (
    <div className="max-w-xs flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Action Delays (ms)
        </p>
        <span className="text-[10px] text-primary/80 font-mono">
          Interval Min – Max
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Place / Punch (ms)</span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {placeMs} {placeMaxMs && parseInt(placeMaxMs, 10) > parseInt(placeMs, 10) ? `– ${placeMaxMs}` : ""} ms
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={0}
              step={10}
              placeholder="Min ms"
              value={placeMs}
              onChange={(e) => setPlaceMs(e.target.value)}
              className="h-7 text-xs"
              title="Minimum Delay"
            />
            <Input
              type="number"
              min={0}
              step={10}
              placeholder="Max ms (acak)"
              value={placeMaxMs}
              onChange={(e) => setPlaceMaxMs(e.target.value)}
              className="h-7 text-xs"
              title="Maksimum Delay (jika diisi, bot mengacak interval antar min dan max)"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Walk / Pathfind (ms)</span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {walkMs} {walkMaxMs && parseInt(walkMaxMs, 10) > parseInt(walkMs, 10) ? `– ${walkMaxMs}` : ""} ms
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={0}
              step={10}
              placeholder="Min ms"
              value={walkMs}
              onChange={(e) => setWalkMs(e.target.value)}
              className="h-7 text-xs"
              title="Minimum Delay"
            />
            <Input
              type="number"
              min={0}
              step={10}
              placeholder="Max ms (acak)"
              value={walkMaxMs}
              onChange={(e) => setWalkMaxMs(e.target.value)}
              className="h-7 text-xs"
              title="Maksimum Delay (jika diisi, bot mengacak interval antar min dan max)"
            />
          </div>
        </div>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Pending Retry Delays (s)
      </p>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            2FA / Account Protection (s)
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            value={twofaSecs}
            onChange={(e) => setTwofaSecs(e.target.value)}
            className="h-7 text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Server Overloaded (s)
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            value={serverOverloadSecs}
            onChange={(e) => setServerOverloadSecs(e.target.value)}
            className="h-7 text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Too Many Logins (s)
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            value={tooManyLoginsSecs}
            onChange={(e) => setTooManyLoginsSecs(e.target.value)}
            className="h-7 text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Maintenance (s)
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            value={maintenanceSecs}
            onChange={(e) => setMaintenanceSecs(e.target.value)}
            className="h-7 text-xs"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="text-xs" onClick={save}>
          Save
        </Button>
        {status && (
          <span className="text-xs text-muted-foreground">{status}</span>
        )}
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Behaviour
      </p>
      <label className="flex items-center gap-2 cursor-pointer">
        <Switch
          size="sm"
          checked={autoCollect}
          onCheckedChange={(enabled) => {
            setBots((m) => {
              const bot = m.get(botId);
              if (!bot) return m;
              return new Map(m).set(botId, { ...bot, auto_collect: enabled });
            });
            api
              .sendCmd(botId, { type: "set_auto_collect", enabled })
              .catch(() => {
                setBots((m) => {
                  const bot = m.get(botId);
                  if (!bot) return m;
                  return new Map(m).set(botId, {
                    ...bot,
                    auto_collect: !enabled,
                  });
                });
              });
          }}
        />
        <span className="text-xs text-muted-foreground">
          Auto-collect dropped items
        </span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <Switch
          size="sm"
          checked={autoReconnect}
          onCheckedChange={(enabled) => {
            setBots((m) => {
              const bot = m.get(botId);
              if (!bot) return m;
              return new Map(m).set(botId, { ...bot, auto_reconnect: enabled });
            });
            api
              .sendCmd(botId, { type: "set_auto_reconnect", enabled })
              .catch(() => {
                setBots((m) => {
                  const bot = m.get(botId);
                  if (!bot) return m;
                  return new Map(m).set(botId, {
                    ...bot,
                    auto_reconnect: !enabled,
                  });
                });
              });
          }}
        />
        <span className="text-xs text-muted-foreground">
          Auto-reconnect on disconnect
        </span>
      </label>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Proxy
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">
          Current: {proxy ? formatProxy(proxy) : "direct (no proxy)"}
        </span>
        <Input
          placeholder="host:port:user:pass — empty = direct"
          value={proxyStr}
          onChange={(e) => setProxyStr(e.target.value)}
          className="h-7 text-xs font-mono"
          spellCheck={false}
        />
        {needsDisconnect && (
          <p className="text-[11px] text-amber-500 leading-snug">
            Bot is {botStatus} — saving will disconnect it first. Reconnect afterwards to use the new proxy.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" className="text-xs" onClick={saveProxy} disabled={proxyBusy}>
            {proxyBusy ? "Saving…" : needsDisconnect ? "Disconnect & Save" : "Save proxy"}
          </Button>
          <Button size="sm" variant="outline" className="text-xs" onClick={testProxy} disabled={proxyTesting || proxyBusy}>
            {proxyTesting ? "Testing…" : "Test"}
          </Button>
          {!needsDisconnect && (
            <Button size="sm" variant="outline" className="text-xs" onClick={() => api.sendCmd(botId, { type: "reconnect" })}>
              Reconnect
            </Button>
          )}
          {proxyStatus && (
            <span className="text-xs text-muted-foreground">{proxyStatus}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function Section({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {hint && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground/50 ml-1">
            — {hint}
          </span>
        )}
      </p>
      {children}
    </div>
  );
}

function DataTable({
  columns,
  rows,
  empty,
  maxH = "max-h-40",
}: {
  columns: string[];
  rows: string[][];
  empty: string;
  maxH?: string;
}) {
  return (
    <ScrollArea className={cn("rounded border border-border", maxH)}>
      <Table className="text-xs">
        <TableHeader className="sticky top-0 bg-card">
          <TableRow className="border-b border-border">
            {columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-2 text-center text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function InventoryTable({
  botId,
  inventory,
  itemLabel,
}: {
  botId: number;
  inventory: import("@/lib/api").InventoryItem[];
  itemLabel: (id: number) => string;
}) {
  const [trashTarget, setTrashTarget] = useState<import("@/lib/api").InventoryItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [error, setError] = useState("");

  async function cmd(type: string, item_id: number, count?: number) {
    await api.sendCmd(botId, {
      type,
      item_id,
      ...(count !== undefined ? { count } : {}),
    } as never);
  }

  async function trashEverything() {
    // One command per stack - the backend trashes a single item id + count.
    // A failing stack must not stop the others, so the sends are settled
    // individually.
    const stacks = inventory.filter((i) => i.amount > 0);
    const results = await Promise.allSettled(
      stacks.map((i) => cmd("trash", i.item_id, i.amount)),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      setError(`${failed} of ${stacks.length} stacks could not be trashed`);
    }
    setEmptyOpen(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {inventory.length > 0 && (
        <div className="flex justify-end">
          <Btn variant="danger" onClick={() => setEmptyOpen(true)}>
            Trash all items
          </Btn>
        </div>
      )}
      <ScrollArea className="max-h-72 rounded border border-border">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 bg-card">
            <TableRow className="border-b border-border">
              <TableHead>Item</TableHead>
              <TableHead>Amt</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inventory.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="py-2 text-center text-muted-foreground"
                >
                  Empty
                </TableCell>
              </TableRow>
            ) : (
              [...inventory]
                .sort((a, b) => b.amount - a.amount)
                .map((i) => (
                  <TableRow key={i.item_id}>
                    <TableCell>
                      {i.is_active && (
                        <span className="text-primary mr-1">●</span>
                      )}
                      {itemLabel(i.item_id)}
                    </TableCell>
                    <TableCell>{i.amount}</TableCell>
                    <TableCell className="px-2 py-1">
                      <div className="flex gap-1 flex-wrap">
                        {i.action_type === 20 &&
                          (i.is_active ? (
                            <Btn
                              onClick={() => cmd("unwear", i.item_id)}
                              variant="active"
                            >
                              Unwear
                            </Btn>
                          ) : (
                            <Btn onClick={() => cmd("wear", i.item_id)}>Wear</Btn>
                          ))}
                        <Btn onClick={() => cmd("drop", i.item_id, 1)}>Drop</Btn>
                        <Btn onClick={() => cmd("drop", i.item_id, i.amount)}>
                          Drop All
                        </Btn>
                        <Btn
                          onClick={() => cmd("trash", i.item_id, i.amount)}
                          variant="danger"
                        >
                          Trash All
                        </Btn>
                        <Btn
                          onClick={() => setTrashTarget(i)}
                          variant="danger"
                        >
                          Trash…
                        </Btn>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>

      {trashTarget && (
        <TrashAmountDialog
          botId={botId}
          item={trashTarget}
          itemLabel={itemLabel}
          onClose={() => setTrashTarget(null)}
        />
      )}
      {emptyOpen && (
        <EmptyInventoryDialog
          inventory={inventory}
          itemLabel={itemLabel}
          onConfirm={trashEverything}
          onClose={() => setEmptyOpen(false)}
        />
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

/** Trash a chosen amount of one stack. */
function TrashAmountDialog({
  botId,
  item,
  itemLabel,
  onClose,
}: {
  botId: number;
  item: import("@/lib/api").InventoryItem;
  itemLabel: (id: number) => string;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("1");
  const [error, setError] = useState("");
  const max = item.amount;

  async function send() {
    const n = Math.max(1, Math.min(max, Math.trunc(Number(amount)) || 1));
    setError("");
    try {
      await api.sendCmd(botId, {
        type: "trash",
        item_id: item.item_id,
        count: n,
      } as never);
      onClose();
    } catch {
      setError("Trash failed - is the bot connected?");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Trash {itemLabel(item.item_id)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {max} in the inventory - how many should be destroyed?
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={1}
            max={max}
            value={amount}
            autoFocus
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            className="h-7 text-xs"
          />
          <Btn onClick={() => setAmount(String(max))}>Max ({max})</Btn>
        </div>
        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" className="text-xs" onClick={send}>
            Trash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Empty the whole inventory (destructive - asks first). */
function EmptyInventoryDialog({
  inventory,
  itemLabel,
  onConfirm,
  onClose,
}: {
  inventory: import("@/lib/api").InventoryItem[];
  itemLabel: (id: number) => string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-sm">Trash the whole inventory?</DialogTitle>
          <DialogDescription className="text-xs">
            {inventory.length} stacks will be destroyed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 overflow-y-auto rounded border border-border divide-y divide-border text-[10px]">
          {inventory.map((i) => (
            <li key={i.item_id} className="px-2 py-1 flex justify-between gap-2">
              <span className="truncate">{itemLabel(i.item_id)}</span>
              <span className="text-muted-foreground">× {i.amount}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" className="text-xs" onClick={onConfirm}>
            Trash everything
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TilesTable({
  tiles,
  itemLabel,
}: {
  tiles: { fg: number; bg: number; flags: number; tile_type: unknown }[];
  itemLabel: (id: number) => string;
}) {
  const counts = new Map<number, number>();
  for (const t of tiles) {
    if (t.fg !== 0) counts.set(t.fg, (counts.get(t.fg) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => [itemLabel(id), count.toLocaleString()]);
  return <DataTable columns={["Tile", "Count"]} rows={rows} empty="No tiles" />;
}

function DPad({ botId }: { botId: number }) {
  const move = (x: number, y: number) =>
    api.sendCmd(botId, { type: "move", x, y }).catch(() => {});

  return (
    <div className="grid grid-cols-3 gap-1 w-fit mx-auto">
      <div />
      <button
        onClick={() => move(0, -1)}
        className="flex items-center justify-center w-8 h-8 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors"
      >
        <ChevronUp className="w-4 h-4" />
      </button>
      <div />
      <button
        onClick={() => move(-1, 0)}
        className="flex items-center justify-center w-8 h-8 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        onClick={() => move(0, 1)}
        className="flex items-center justify-center w-8 h-8 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors"
      >
        <ChevronDown className="w-4 h-4" />
      </button>
      <button
        onClick={() => move(1, 0)}
        className="flex items-center justify-center w-8 h-8 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function Btn({
  onClick,
  variant = "default",
  children,
}: {
  onClick: () => void;
  variant?: "default" | "active" | "danger";
  children: ReactNode;
}) {
  const cls = {
    default: "bg-secondary hover:bg-secondary/80 text-secondary-foreground",
    active: "bg-primary/20 hover:bg-primary/30 text-primary",
    danger: "bg-destructive/20 hover:bg-destructive/30 text-destructive",
  }[variant];
  return (
    <button
      onClick={onClick}
      className={cn("px-1.5 py-0.5 rounded text-[10px] transition-colors", cls)}
    >
      {children}
    </button>
  );
}
