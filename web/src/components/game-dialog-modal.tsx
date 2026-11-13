import { useState, useEffect, useRef, useMemo } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { api, type DialogButton, type DialogElement, type DialogField, type WsDialog } from "@/lib/api"
import { botsAtom, itemNamesAtom, type LiveBot } from "@/lib/store"
import { stripGTColors, tokenizeGTColors } from "@/lib/gt-colors"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ItemIcon } from "@/components/item-icon"
import {
  ExternalLink,
  Loader2,
  ShieldAlert,
  Clock,
  X,
  Info,
  Check,
  Search,
  Package,
  User,
} from "lucide-react"

/** Render Growtopia backtick color codes safely as styled JSX spans without raw HTML. */
function GtText({ text }: { text: string }) {
  const segments = tokenizeGTColors(text)
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} style={seg.color ? { color: seg.color } : undefined}>
          {seg.text}
        </span>
      ))}
    </>
  )
}

function playCaptchaAlertChime() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const ctx = new AudioContextClass()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "triangle"
    osc.frequency.setValueAtTime(784, ctx.currentTime)
    osc.frequency.setValueAtTime(1046, ctx.currentTime + 0.14)
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.36)
  } catch {
    // audio context blocked before user interaction
  }
}

function frameAccentClass(frame?: string | null): string {
  const f = (frame ?? "").toLowerCase()
  if (f.includes("yellow") || f.includes("gold")) {
    return "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100"
  }
  if (f.includes("green")) {
    return "border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-100"
  }
  if (f.includes("red")) {
    return "border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-100"
  }
  return "border-sky-500/35 bg-sky-500/10 hover:bg-sky-500/20 text-slate-100"
}

/**
 * Renders an inline searchable picker backed by the bot's inventory (with manual
 * fallback ID input) for native Growtopia `add_item_picker` dialog fields.
 */
function DialogItemPickerField({
  bot,
  itemNames,
  label,
  title,
  value,
  disabled,
  onChange,
}: {
  bot: LiveBot
  itemNames: Record<string, string>
  label: string
  title: string
  value: string
  disabled: boolean
  onChange: (itemId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selectedId = Number(value) || 0
  const selectedName = selectedId > 0 ? (itemNames[String(selectedId)] ?? `Item #${selectedId}`) : ""

  const filteredInv = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bot.inventory.filter((slot) => {
      if (slot.item_id <= 0 || slot.amount <= 0) return false
      if (!q) return true
      const name = (itemNames[String(slot.item_id)] ?? "").toLowerCase()
      return name.includes(q) || String(slot.item_id).includes(q)
    })
  }, [bot.inventory, itemNames, query])

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground/90">
          <GtText text={label || title || "Pilih Item"} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="h-7 gap-1.5 text-xs"
        >
          {selectedId > 0 ? (
            <>
              <ItemIcon itemId={selectedId} size={18} />
              <span className="max-w-[140px] truncate">{selectedName}</span>
            </>
          ) : (
            <>
              <Package className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Pilih Item...</span>
            </>
          )}
        </Button>
      </div>

      {open && (
        <div className="space-y-2 rounded-md border border-border bg-background/90 p-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cari item backpack atau ketik ID..."
                className="h-7 pl-7 text-xs"
              />
            </div>
            <Input
              type="number"
              min={0}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="ID"
              className="h-7 w-20 text-xs font-mono"
            />
          </div>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto pr-1">
            {filteredInv.length === 0 ? (
              <div className="col-span-2 py-2 text-center text-[11px] text-muted-foreground">
                Tidak ada item cocok di backpack.
              </div>
            ) : (
              filteredInv.map((slot) => {
                const name = itemNames[String(slot.item_id)] ?? `Item #${slot.item_id}`
                const active = selectedId === slot.item_id
                return (
                  <button
                    key={slot.item_id}
                    type="button"
                    onClick={() => {
                      onChange(String(slot.item_id))
                      setOpen(false)
                    }}
                    className={`flex items-center gap-2 rounded border px-2 py-1 text-left text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border/60 bg-card/60 hover:bg-accent"
                    }`}
                  >
                    <ItemIcon itemId={slot.item_id} size={20} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        x{slot.amount} · #{slot.item_id}
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function GameDialogModal({ bot }: { bot: LiveBot }) {
  const dialog: WsDialog | null = bot.active_dialog
  const itemNames = useAtomValue(itemNamesAtom)
  const setBots = useSetAtom(botsAtom)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [checkboxValues, setCheckboxValues] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")

  // Auto-close timeout for purely informational (non-interactive, non-captcha) dialogs
  const [timeLeft, setTimeLeft] = useState(5)
  const [isPaused, setIsPaused] = useState(false)
  const dismissedRef = useRef(false)

  const elements = dialog?.elements ?? []
  const checkboxes = dialog?.checkboxes ?? []
  const embedData = dialog?.embed_data ?? []

  const isCaptcha =
    Boolean(dialog) &&
    (dialog!.dialog_name.toLowerCase().includes("captcha") ||
      dialog!.title.toLowerCase().includes("captcha") ||
      dialog!.body_text.some((t: string) =>
        t.toLowerCase().includes("captcha") ||
        t.toLowerCase().includes("puzzle") ||
        t.toLowerCase().includes("human") ||
        t.toLowerCase().includes("verify")
      ))

  const hasInteractiveElement = elements.some(
    (el) =>
      el.type === "text_input" ||
      el.type === "checkbox" ||
      el.type === "button" ||
      el.type === "item_picker" ||
      el.type === "player_info",
  )

  const isInteractive =
    Boolean(dialog) &&
    (dialog!.inputs.length > 0 ||
      checkboxes.length > 0 ||
      dialog!.buttons.length > 0 ||
      Boolean(dialog!.confirm_label) ||
      hasInteractiveElement ||
      dialog!.dialog_name.toLowerCase().includes("vend") ||
      dialog!.dialog_name.toLowerCase().includes("lock") ||
      dialog!.dialog_name.toLowerCase().includes("door") ||
      dialog!.dialog_name.toLowerCase().includes("storage") ||
      dialog!.dialog_name.toLowerCase().includes("phone") ||
      dialog!.dialog_name.toLowerCase().includes("wrench") ||
      dialog!.dialog_name.toLowerCase().includes("trade") ||
      dialog!.dialog_name.toLowerCase().includes("friend") ||
      dialog!.dialog_name.toLowerCase().includes("drop") ||
      dialog!.dialog_name.toLowerCase().includes("trash"))

  useEffect(() => {
    if (dialog) {
      const initialFields: Record<string, string> = {}
      for (const em of dialog.embed_data ?? []) {
        initialFields[em.key] = em.value
      }
      for (const f of dialog.inputs) {
        initialFields[f.name] = f.default_val ?? ""
      }
      for (const el of dialog.elements ?? []) {
        if (el.type === "text_input") {
          initialFields[el.name] = el.default_val ?? ""
        } else if (el.type === "item_picker" && el.default_item_id > 0) {
          initialFields[el.name] = String(el.default_item_id)
        }
      }
      setFormValues(initialFields)

      const initialChecks: Record<string, boolean> = {}
      for (const cb of dialog.checkboxes ?? []) {
        initialChecks[cb.name] = cb.checked
      }
      for (const el of dialog.elements ?? []) {
        if (el.type === "checkbox") {
          initialChecks[el.name] = el.checked
        }
      }
      setCheckboxValues(initialChecks)

      setErrorMsg("")
      setSubmitting(false)
      setTimeLeft(5)
      setIsPaused(false)
      dismissedRef.current = false

      if (isCaptcha) {
        playCaptchaAlertChime()
        if (typeof window !== "undefined" && "Notification" in window) {
          if (Notification.permission === "granted") {
            new Notification("⚠️ Mori Alert: Verifikasi Captcha Masuk!", {
              body: `Bot #${bot.id} (${bot.username || "Bot"}): ${stripGTColors(dialog.title || "Captcha")} memerlukan respon!`,
            })
          } else if (Notification.permission === "default") {
            Notification.requestPermission().catch(() => {})
          }
        }
      }
    }
  }, [dialog, isCaptcha, bot.id, bot.username])

  useEffect(() => {
    if (!dialog || isCaptcha || isInteractive || isPaused) return
    if (timeLeft <= 0) {
      if (!dismissedRef.current) {
        dismissedRef.current = true
        handleDismiss()
      }
      return
    }
    const timer = setTimeout(() => {
      setTimeLeft((prev) => prev - 1)
    }, 1000)
    return () => clearTimeout(timer)
  }, [dialog, isCaptcha, isInteractive, isPaused, timeLeft])

  if (!dialog) return null

  function buildSubmitFields(): Record<string, string> {
    const merged: Record<string, string> = {}
    for (const em of embedData) {
      merged[em.key] = em.value
    }
    for (const [k, checked] of Object.entries(checkboxValues)) {
      merged[k] = checked ? "1" : "0"
    }
    for (const [k, val] of Object.entries(formValues)) {
      merged[k] = val
    }
    return merged
  }

  async function handleDismiss() {
    if (!dialog || dismissedRef.current) return
    dismissedRef.current = true
    setBots((prev) => {
      const cur = prev.get(bot.id)
      if (!cur || !cur.active_dialog) return prev
      const next = new Map(prev)
      next.set(bot.id, { ...cur, active_dialog: null })
      return next
    })
    try {
      await api.sendCmd(bot.id, { type: "dismiss_dialog" })
    } catch {
      // offline / already closed
    }
  }

  async function handleSubmit(buttonName: string) {
    if (!dialog || submitting) return
    setSubmitting(true)
    setErrorMsg("")
    try {
      await api.sendCmd(bot.id, {
        type: "dialog_return",
        dialog_name: dialog.dialog_name,
        button: buttonName,
        fields: buildSubmitFields(),
      })
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Gagal mengirim respon dialog.")
      setSubmitting(false)
    }
  }

  // Lift the first label matching dialog.title into <DialogTitle> so the title is not repeated in the body.
  const headerLabelIdx = dialog.title
    ? elements.findIndex((el) => el.type === "label" && el.text === dialog.title)
    : -1
  const headerTitleItemId =
    headerLabelIdx >= 0 && elements[headerLabelIdx]?.type === "label"
      ? elements[headerLabelIdx].item_id ?? null
      : null

  // Group consecutive icon-buttons from native `add_button_with_icon` horizontally like in Growtopia
  type RenderChunk =
    | { kind: "element"; el: DialogElement; key: string }
    | { kind: "icon_row"; items: Array<Extract<DialogElement, { type: "button" }>>; key: string }

  const renderChunks: RenderChunk[] = []
  let pendingIconRow: Array<Extract<DialogElement, { type: "button" }>> = []

  const flushIconRow = (idx: number) => {
    if (pendingIconRow.length > 0) {
      renderChunks.push({ kind: "icon_row", items: pendingIconRow, key: `iconrow-${idx}` })
      pendingIconRow = []
    }
  }

  elements.forEach((el, idx) => {
    if (idx === headerLabelIdx) return
    if (el.type === "button" && !el.url && el.item_id !== null && el.item_id !== undefined) {
      pendingIconRow.push(el)
    } else {
      flushIconRow(idx)
      renderChunks.push({ kind: "element", el, key: `el-${idx}` })
    }
  })
  flushIconRow(elements.length)

  const renderButton = (btn: {
    name: string
    label: string
    url?: string | null
    item_id?: number | null
    frame?: string | null
  }, key: string, compactIcon?: boolean) => {
    if (btn.url) {
      return (
        <a
          key={key}
          href={btn.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-full items-center justify-between rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
        >
          <GtText text={btn.label || btn.name || "Buka Tautan"} />
          <ExternalLink className="h-4 w-4 shrink-0" />
        </a>
      )
    }

    if (compactIcon && btn.item_id != null) {
      return (
        <button
          key={key}
          type="button"
          disabled={submitting}
          onClick={() => handleSubmit(btn.name)}
          className={`flex min-w-[92px] flex-1 basis-[calc(50%-0.25rem)] items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors disabled:opacity-50 ${frameAccentClass(btn.frame)}`}
        >
          <ItemIcon itemId={btn.item_id} size={26} />
          <span className="min-w-0 flex-1 break-words leading-tight">
            <GtText text={btn.label || btn.name} />
          </span>
        </button>
      )
    }

    return (
      <Button
        key={key}
        type="button"
        variant="secondary"
        disabled={submitting}
        onClick={() => handleSubmit(btn.name)}
        className={`h-auto min-h-9 w-full justify-start gap-2 border px-3 py-1.5 text-left text-xs font-medium ${frameAccentClass(btn.frame)}`}
      >
        {btn.item_id != null && <ItemIcon itemId={btn.item_id} size={20} />}
        <span className="flex-1 break-words"><GtText text={btn.label || btn.name} /></span>
      </Button>
    )
  }

  const fallbackBodyLines =
    dialog.title && dialog.body_text[0] === dialog.title
      ? dialog.body_text.slice(1)
      : dialog.body_text

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) handleDismiss() }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md border-primary/40 bg-card p-5 shadow-2xl sm:max-w-lg"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <DialogHeader className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {isCaptcha ? (
                <span className="flex items-center gap-1.5 rounded border border-red-500/30 bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-400">
                  <ShieldAlert className="h-3.5 w-3.5 animate-pulse" />
                  VERIFIKASI CAPTCHA
                </span>
              ) : (
                <span className="flex items-center gap-1.5 rounded border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-400">
                  <Info className="h-3.5 w-3.5" />
                  Dialog Game
                </span>
              )}

              {!isCaptcha && !isInteractive && (
                <span className="flex items-center gap-1 rounded border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  <Clock className="h-3 w-3 text-sky-400" />
                  {isPaused ? "Timer Dijeda" : `Menutup dalam ${timeLeft}s`}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="max-w-[140px] truncate font-mono text-[11px] text-muted-foreground">
                {dialog.dialog_name || "dialog"}
              </span>
              {!isCaptcha && (
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="rounded-sm p-0.5 text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100"
                  title="Tutup dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <DialogTitle className="flex items-center gap-2 text-base font-bold text-foreground">
            {headerTitleItemId != null && <ItemIcon itemId={headerTitleItemId} size={22} />}
            <span><GtText text={dialog.title || "Dialog Game"} /></span>
          </DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (dialog.confirm_label) {
              handleSubmit("")
            } else {
              const firstActionBtn = dialog.buttons.find((b) => !b.url)
              if (firstActionBtn) {
                handleSubmit(firstActionBtn.name)
              }
            }
          }}
          className="space-y-3"
        >
          <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pr-1">
            {renderChunks.length > 0 ? (
              renderChunks.map((chunk) => {
                if (chunk.kind === "icon_row") {
                  return (
                    <div key={chunk.key} className="flex flex-wrap gap-1.5">
                      {chunk.items.map((btn, bi) => renderButton(btn, `${chunk.key}-${bi}`, true))}
                    </div>
                  )
                }

                const el = chunk.el
                switch (el.type) {
                  case "label":
                    return (
                      <div
                        key={chunk.key}
                        className={`flex items-center gap-2 ${
                          el.align === "center" ? "justify-center text-center" : ""
                        }`}
                      >
                        {el.item_id != null && <ItemIcon itemId={el.item_id} size={el.size === "big" ? 28 : 20} />}
                        <span
                          className={
                            el.size === "big"
                              ? "text-sm font-bold text-foreground"
                              : "text-xs font-semibold text-foreground/90"
                          }
                        >
                          <GtText text={el.text} />
                        </span>
                      </div>
                    )

                  case "textbox":
                    return (
                      <div
                        key={chunk.key}
                        className={`whitespace-pre-wrap leading-relaxed text-foreground/90 ${
                          el.small ? "text-xs text-muted-foreground" : "text-sm"
                        }`}
                      >
                        <GtText text={el.text} />
                      </div>
                    )

                  case "text_input":
                    return (
                      <div key={chunk.key} className="space-y-1">
                        {el.label && (
                          <label className="block text-xs font-medium text-muted-foreground">
                            <GtText text={el.label} />
                          </label>
                        )}
                        <Input
                          type={el.is_password ? "password" : "text"}
                          value={formValues[el.name] ?? ""}
                          onChange={(e) =>
                            setFormValues((prev) => ({ ...prev, [el.name]: e.target.value }))
                          }
                          maxLength={el.max_len > 0 ? el.max_len : undefined}
                          placeholder={el.default_val || `Masukkan ${stripGTColors(el.label || el.name)}...`}
                          className="h-9 bg-background text-sm"
                          disabled={submitting}
                        />
                      </div>
                    )

                  case "checkbox": {
                    const checked = Boolean(checkboxValues[el.name])
                    return (
                      <button
                        key={chunk.key}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={submitting}
                        onClick={() =>
                          setCheckboxValues((prev) => ({ ...prev, [el.name]: !prev[el.name] }))
                        }
                        className="flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50 disabled:opacity-50"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/50 bg-background"
                          }`}
                        >
                          {checked && <Check className="h-3 w-3 stroke-[3]" />}
                        </span>
                        <span className="flex-1 text-foreground/95">
                          <GtText text={el.label || el.name} />
                        </span>
                      </button>
                    )
                  }

                  case "button":
                    return renderButton(el, chunk.key, false)

                  case "item_picker":
                    return (
                      <DialogItemPickerField
                        key={chunk.key}
                        bot={bot}
                        itemNames={itemNames}
                        label={el.label}
                        title={el.title}
                        value={formValues[el.name] ?? ""}
                        disabled={submitting}
                        onChange={(id) => setFormValues((prev) => ({ ...prev, [el.name]: id }))}
                      />
                    )

                  case "player_info":
                    return (
                      <div
                        key={chunk.key}
                        className="flex items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2.5"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sky-300">
                          <User className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-foreground">
                            <GtText text={el.player_name} />
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            {el.level && <span>Level {el.level}</span>}
                            {el.xp && <span>· XP {el.xp}</span>}
                          </div>
                        </div>
                      </div>
                    )

                  case "spacer":
                    return <div key={chunk.key} className={el.size === "big" ? "h-3" : "h-1"} />
                }
              })
            ) : (
              <>
                {fallbackBodyLines.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/40 p-3 text-sm leading-relaxed text-foreground/90">
                    {fallbackBodyLines.map((line: string, i: number) => (
                      <div key={i} className="whitespace-pre-wrap">
                        <GtText text={line} />
                      </div>
                    ))}
                  </div>
                )}

                {checkboxes.map((cb) => {
                  const checked = Boolean(checkboxValues[cb.name])
                  return (
                    <button
                      key={cb.name}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() =>
                        setCheckboxValues((prev) => ({ ...prev, [cb.name]: !prev[cb.name] }))
                      }
                      className="flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-left text-xs"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/50 bg-background"
                        }`}
                      >
                        {checked && <Check className="h-3 w-3 stroke-[3]" />}
                      </span>
                      <span className="flex-1"><GtText text={cb.label || cb.name} /></span>
                    </button>
                  )
                })}

                {dialog.inputs.map((field: DialogField) => (
                  <div key={field.name} className="space-y-1">
                    {field.label && (
                      <label className="text-xs font-medium text-muted-foreground">
                        <GtText text={field.label} />
                      </label>
                    )}
                    <Input
                      value={formValues[field.name] ?? ""}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      maxLength={field.max_len > 0 ? field.max_len : undefined}
                      placeholder={field.default_val || `Masukkan ${stripGTColors(field.label || field.name)}...`}
                      className="h-9 bg-background text-sm"
                      disabled={submitting}
                    />
                  </div>
                ))}

                {dialog.buttons.length > 0 && (
                  <div className="space-y-1.5">
                    {dialog.buttons.map((btn: DialogButton, idx: number) =>
                      renderButton(btn, `${btn.name}-${idx}`, false)
                    )}
                  </div>
                )}
              </>
            )}

            {errorMsg && (
              <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">
                {errorMsg}
              </div>
            )}
          </div>

          <DialogFooter className="flex-row justify-end gap-2 pt-1">
            {(dialog.cancel_label || dialog.quick_exit || !isCaptcha) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={handleDismiss}
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
              >
                <GtText text={dialog.cancel_label || "Tutup"} />
              </Button>
            )}

            {dialog.confirm_label && (
              <Button
                type="submit"
                size="sm"
                disabled={submitting}
                className="h-8 text-xs"
              >
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                <GtText text={dialog.confirm_label} />
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
