const GT_COLORS: Record<string, string> = {
  '0': '#ffffff', '1': '#adf4ff', '2': '#49fc00', '3': '#bfdaff', '4': '#ff271d',
  '5': '#ebb7ff', '6': '#ffca6f', '7': '#e6e6e6', '8': '#ff9445', '9': '#ffee7d',
  '!': '#d1fff9', '@': '#ffcdc9', '#': '#ff8ff3', '$': '#fffcc5', '^': '#b5ff97',
  '&': '#feeeff', 'w': '#ffffff', 'o': '#fce6ba', 'p': '#ffdff1', 'b': '#1a1a1a',
  'q': '#0c60a4', 'e': '#19b9ff', 'r': '#6fd357', 't': '#2f830d', 'a': '#515151',
  's': '#9e9e9e', 'c': '#50ffff',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface GtColorSegment {
  text: string
  color?: string
}

/** Tokenize Growtopia `` `X `` color-coded text into plain segments with optional hex colors. */
export function tokenizeGTColors(text: string): GtColorSegment[] {
  if (!text) return []
  const segments: GtColorSegment[] = []
  let activeColor: string | undefined
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) {
      segments.push(activeColor ? { text: buf, color: activeColor } : { text: buf })
      buf = ''
    }
  }

  while (i < text.length) {
    if (text[i] === '`' && i + 1 < text.length) {
      flush()
      const code = text[i + 1]
      activeColor = code === '`' ? undefined : GT_COLORS[code]
      i += 2
    } else {
      buf += text[i]
      i++
    }
  }
  flush()
  return segments
}

export function parseGTColors(text: string): string {
  return tokenizeGTColors(text)
    .map((seg) => (seg.color ? `<span style="color:${seg.color}">${escapeHtml(seg.text)}</span>` : escapeHtml(seg.text)))
    .join('')
}

export function stripGTColors(text: string): string {
  if (!text) return ''
  return text.replace(/`./g, '').trim()
}
