import { useState, useEffect } from "react"
import { api, type DialogButton, type DialogField, type WsDialog } from "@/lib/api"
import { type LiveBot } from "@/lib/store"
import { parseGTColors } from "@/lib/gt-colors"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertCircle, ExternalLink, Loader2, ShieldAlert } from "lucide-react"

export function GameDialogModal({ bot }: { bot: LiveBot }) {
  const dialog: WsDialog | null = bot.active_dialog
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")

  useEffect(() => {
    if (dialog) {
      const initial: Record<string, string> = {}
      for (const input of dialog.inputs) {
        initial[input.name] = input.default_val || ""
      }
      setFormValues(initial)
      setErrorMsg("")
      setSubmitting(false)

      // Play audio chime alert via Web Audio API (works without external files)
      try {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (AudioContextClass) {
          const ctx = new AudioContextClass()
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = "sine"
          osc.frequency.setValueAtTime(880, ctx.currentTime)
          osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35)
          gain.gain.setValueAtTime(0.3, ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35)
          osc.connect(gain)
          gain.connect(ctx.destination)
          osc.start()
          osc.stop(ctx.currentTime + 0.35)
        }
      } catch {
        // AudioContext might require user gesture on first load
      }

      // Trigger desktop system notification
      if (typeof window !== "undefined" && "Notification" in window) {
        if (Notification.permission === "granted") {
          new Notification("⚠️ Mori Alert: Dialog / Captcha Masuk!", {
            body: `Bot #${bot.id} (${bot.username || "Bot"}): ${dialog.title || "Game Dialog"} memerlukan respon!`,
          })
        } else if (Notification.permission === "default") {
          Notification.requestPermission().catch(() => {})
        }
      }
    }
  }, [dialog])

  if (!dialog) return null

  const isCaptcha =
    dialog.dialog_name.toLowerCase().includes("captcha") ||
    dialog.title.toLowerCase().includes("captcha") ||
    dialog.body_text.some((t: string) =>
      t.toLowerCase().includes("captcha") ||
      t.toLowerCase().includes("puzzle") ||
      t.toLowerCase().includes("human") ||
      t.toLowerCase().includes("verify")
    )

  async function handleAction(buttonClicked: string) {
    if (!dialog) return
    setSubmitting(true)
    setErrorMsg("")
    try {
      await api.sendCmd(bot.id, {
        type: "dialog_return",
        dialog_name: dialog.dialog_name,
        button: buttonClicked,
        fields: formValues,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal mengirim respon"
      setErrorMsg(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={true} onOpenChange={() => {}}>
      <DialogContent className="max-w-md sm:max-w-lg border-primary/40 bg-card p-6 shadow-2xl">
        <DialogHeader className="gap-1.5 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            {isCaptcha ? (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">
                <ShieldAlert className="w-3.5 h-3.5 animate-pulse" />
                VERIFIKASI CAPTCHA
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded bg-primary/20 text-primary border border-primary/30">
                <AlertCircle className="w-3.5 h-3.5" />
                GAME DIALOG
              </span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto font-mono">
              Bot #{bot.id} ({bot.username || "Bot"})
            </span>
          </div>

          <DialogTitle
            className="text-base font-bold tracking-tight text-foreground flex items-center gap-2"
            dangerouslySetInnerHTML={{ __html: parseGTColors(dialog.title || "Game Dialog") }}
          />
        </DialogHeader>

        {/* Dialog Body Text */}
        <div className="flex flex-col gap-2.5 py-3 text-xs leading-relaxed max-h-[300px] overflow-y-auto pr-1">
          {dialog.body_text.length === 0 ? (
            <p className="text-muted-foreground italic">Tidak ada pesan teks dalam dialog ini.</p>
          ) : (
            dialog.body_text.map((text: string, idx: number) => (
              <div
                key={idx}
                className="text-foreground/90 whitespace-pre-wrap break-words font-mono text-[11px]"
                dangerouslySetInnerHTML={{ __html: parseGTColors(text) }}
              />
            ))
          )}

          {/* External URL Buttons (Webview Captcha / Verification Links) */}
          {dialog.buttons
            .filter((btn: DialogButton) => Boolean(btn.url))
            .map((btn: DialogButton, idx: number) => (
              <div key={idx} className="p-3 my-1 rounded border border-blue-500/30 bg-blue-500/10 flex flex-col gap-2">
                <span className="text-[11px] text-blue-300 font-medium">
                  Verifikasi memerlukan halaman eksternal:
                </span>
                <a
                  href={btn.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors shadow-sm"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {btn.label || "Buka Halaman Verifikasi"}
                </a>
              </div>
            ))}

          {/* Form Text Inputs */}
          {dialog.inputs.length > 0 && (
            <div className="flex flex-col gap-3 pt-2">
              {dialog.inputs.map((input: DialogField) => (
                <div key={input.name} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={input.name}
                    className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide"
                    dangerouslySetInnerHTML={{
                      __html: parseGTColors(input.label || input.name),
                    }}
                  />
                  <Input
                    id={input.name}
                    value={formValues[input.name] ?? ""}
                    maxLength={input.max_len || 100}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setFormValues((prev) => ({
                        ...prev,
                        [input.name]: e.target.value,
                      }))
                    }
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter" && !submitting) {
                        e.preventDefault()
                        handleAction(dialog.confirm_label || "submit")
                      }
                    }}
                    placeholder="Ketik jawaban di sini…"
                    className="text-xs h-8 bg-background border-border"
                    autoFocus
                  />
                </div>
              ))}
            </div>
          )}

          {/* Standalone Action Buttons */}
          {dialog.buttons.filter((btn: DialogButton) => !btn.url).length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {dialog.buttons
                .filter((btn: DialogButton) => !btn.url)
                .map((btn: DialogButton, idx: number) => (
                  <Button
                    key={idx}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    disabled={submitting}
                    onClick={() => handleAction(btn.name || btn.label)}
                  >
                    {btn.label || btn.name}
                  </Button>
                ))}
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-red-400 font-medium pt-1">{errorMsg}</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 pt-2 border-t border-border flex sm:justify-end">
          {dialog.cancel_label && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => handleAction(dialog.cancel_label || "cancel")}
              className="text-xs h-8"
            >
              {dialog.cancel_label}
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            disabled={submitting}
            onClick={() => handleAction(dialog.confirm_label || "submit")}
            className="text-xs h-8 px-4 font-semibold"
          >
            {submitting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Mengirim…
              </span>
            ) : (
              dialog.confirm_label || "Kirim Jawaban"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
