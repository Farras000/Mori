import { useDeferredValue, useMemo, useState } from 'react'
import { BookOpen, Code2, FileText, Search, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { GRPC_DOC_SECTIONS, GRPC_DOC_VERSION, GRPC_PROTO_PATH } from '@/lib/grpc-docs'
import { cn } from '@/lib/utils'

function matchesText(haystack: string, term: string) {
  return haystack.toLowerCase().includes(term)
}

export function GrpcDocsPage({ isPublic = false }: { isPublic?: boolean }) {
  const [q, setQ] = useState('')
  const deferredQuery = useDeferredValue(q)

  const filtered = useMemo(() => {
    const term = deferredQuery.trim().toLowerCase()
    return GRPC_DOC_SECTIONS
      .map((section) => {
        const entries = section.entries ?? []
        const tables = section.tables ?? []
        if (!term) return { ...section, matchedEntries: entries, matchedTables: tables }
        const matchedEntries = entries.filter((entry) =>
          matchesText(
            [entry.name, entry.signature, entry.description, ...(entry.details ?? [])].filter(Boolean).join(' '),
            term,
          ),
        )
        const matchedTables = tables.filter((table) =>
          matchesText([table.title, ...table.columns, ...table.rows.flat()].join(' '), term),
        )
        const sectionMatch = matchesText(
          [section.title, section.summary, section.example].filter(Boolean).join(' '),
          term,
        )
        return {
          ...section,
          matchedEntries: sectionMatch ? entries : matchedEntries,
          matchedTables: sectionMatch ? tables : matchedTables,
        }
      })
      .filter((s) => s.matchedEntries.length > 0 || s.matchedTables.length > 0)
  }, [deferredQuery])

  const totalEntries = useMemo(
    () => GRPC_DOC_SECTIONS.reduce((sum, s) => sum + (s.entries?.length ?? 0), 0),
    [],
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="z-10 shrink-0 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="gap-1.5">
                  <BookOpen className="size-3" />
                  gRPC API
                </Badge>
                <Badge variant="secondary">v{GRPC_DOC_VERSION}</Badge>
                <Badge variant="outline">mori.v1.Mori · :50051</Badge>
                {isPublic && <Badge variant="outline">Public — no login</Badge>}
              </div>
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  Mori gRPC reference
                </h1>
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                  Control bots from Python / Go / Node. Raw agent-friendly markdown:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">/docs/grpc/index.md</code>{' '}
                  Proto:{' '}
                  <a className="underline" href={GRPC_PROTO_PATH}>mori.proto</a>
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 lg:min-w-[22rem]">
              <StatCard label="Sections" value={String(GRPC_DOC_SECTIONS.length)} />
              <StatCard label="RPCs" value={String(totalEntries)} />
              <StatCard label="Hits" value={String(filtered.length)} />
            </div>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full max-w-xl">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search RPCs, fields, tables..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-10 rounded-xl border-border/70 bg-background pl-10 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              {q.trim() ? (
                <Button size="sm" variant="ghost" onClick={() => setQ('')}>Clear search</Button>
              ) : (
                <p className="text-xs text-muted-foreground">Split files cross-link; agents fetch only what they need.</p>
              )}
              <a href="/docs/grpc/index.md" className="text-xs underline text-muted-foreground flex items-center gap-1">
                <FileText className="size-3" /> index.md
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-7xl min-h-0 flex-1 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-border/70 bg-card/40 xl:block">
          <div className="h-full overflow-y-auto overscroll-contain">
            <div className="sticky top-0 z-10 bg-card/95 px-4 pb-2 pt-4 backdrop-blur">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.26em] text-muted-foreground">Jump to section</p>
            </div>
            <div className="space-y-2 px-4 pb-4">
              {filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => document.getElementById(`grpc-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="w-full rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-background"
                >
                  <p className="text-sm font-medium text-foreground">{s.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{s.summary}</p>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
            {filtered.map((s) => (
              <section key={s.id} id={`grpc-${s.id}`} className="scroll-mt-4 overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm">
                <div className="border-b border-border/70 bg-gradient-to-r from-muted/70 via-card to-card px-6 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-muted-foreground">{s.title}</p>
                      <h2 className="text-xl font-semibold tracking-tight text-foreground">{s.summary}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{s.matchedEntries.length + s.matchedTables.length} blocks</Badge>
                      <a href={s.markdownPath} className="text-xs underline text-muted-foreground flex items-center gap-1">
                        <FileText className="size-3" /> .md
                      </a>
                    </div>
                  </div>
                </div>
                <div className="space-y-5 p-6">
                  {s.matchedEntries.length > 0 && (
                    <div className="grid gap-3">
                      {s.matchedEntries.map((e) => (
                        <article key={`${s.id}-${e.name}-${e.signature ?? 'entry'}`} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary">{e.name}</Badge>
                              {e.signature && (
                                <code className="rounded-lg bg-muted px-2.5 py-1 font-mono text-xs text-foreground">{e.signature}</code>
                              )}
                            </div>
                            <p className="text-sm leading-6 text-foreground">{e.description}</p>
                            {e.details && e.details.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {e.details.map((d) => (
                                  <span key={d} className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground">{d}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {s.matchedTables.map((t) => (
                    <div key={`${s.id}-${t.title}`} className="overflow-hidden rounded-2xl border border-border/70">
                      <div className="border-b border-border/70 bg-muted/40 px-4 py-3">
                        <h3 className="text-sm font-semibold text-foreground">{t.title}</h3>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {t.columns.map((c) => (
                              <TableHead key={c} className="text-xs font-semibold">{c}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {t.rows.map((row, ri) => (
                            <TableRow key={`${t.title}-${ri}`}>
                              {row.map((cell, ci) => (
                                <TableCell key={`${t.title}-${ri}-${ci}`} className={cn('align-top text-xs leading-6', ci === 0 ? 'font-mono text-foreground' : 'text-muted-foreground')}>{cell}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                  {s.example && (
                    <div className="overflow-hidden rounded-2xl border border-border/70 bg-zinc-950 text-zinc-50">
                      <div className="border-b border-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-zinc-400">Example</div>
                      <pre className="overflow-x-auto p-4 text-xs leading-6"><code>{s.example}</code></pre>
                    </div>
                  )}
                </div>
              </section>
            ))}
            {filtered.length === 0 && (
              <div className="rounded-3xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
                <p className="text-lg font-medium text-foreground">No gRPC docs matched.</p>
                <p className="mt-2 text-sm text-muted-foreground">Try SpawnBot, WalkTo, GetTile, SubscribeEvents.</p>
              </div>
            )}
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Code2 className="size-3" /> Agent tip: curl without auth —
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">curl localhost:3000/docs/grpc/quickstart.md</code>
              <Sparkles className="size-3" />
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}
