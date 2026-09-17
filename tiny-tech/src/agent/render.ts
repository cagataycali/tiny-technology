/**
 * 🎨 use_render — dynamic rendered terminal content. devduck rich_interface.py
 * + tools/tui.py panel/markdown actions, tiny-shaped, zero new dependencies.
 *
 * The agent composes UI out of components at runtime — panels, tables, trees,
 * key/value grids, markdown, syntax-highlighted code, progress bars, rules —
 * and they render as real ANSI in the transcript instead of a wall of prose.
 *
 * Same broker pattern as use_interact: the TUI registers a display handler so
 * rendered blocks land inside Ink's <Static> transcript; without one (REPL,
 * one-shot) the ANSI string goes straight to stdout. Headless (daemon/mesh)
 * the rendered text is returned in the tool result, so a remote peer still
 * gets the table — as text — instead of nothing.
 *
 * Everything renders through ONE code path (renderComponents → string) so the
 * three surfaces can't drift apart.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { renderMarkdown } from '../tui/markdown.js'

// ─── Component vocabulary ───────────────────────────────────────────────────

export interface RenderComponent {
  type: 'panel' | 'table' | 'tree' | 'markdown' | 'syntax' | 'text' | 'rule' | 'keyvalue' | 'progress'
  title?: string
  content?: string
  style?: string            // color name for borders/accents
  headers?: string[]
  rows?: string[][]
  label?: string
  items?: any[]             // tree items: strings or {label, items}
  language?: string
  code?: string
  data?: Record<string, any> // keyvalue pairs
  total?: number
  completed?: number
  description?: string
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const COLORS: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33', blue: '34',
  magenta: '35', cyan: '36', white: '37', gray: '90', grey: '90',
}
const c = (name: string | undefined, s: string) =>
  `\x1b[${COLORS[name || 'cyan'] || '36'}m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** Visible width — strip ANSI, count wide CJK/emoji as 2 (approx). */
function vw(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '')
  let w = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1
  }
  return w
}
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - vw(s)))

function termWidth(): number {
  return Math.min(process.stdout.columns || 100, 120)
}

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderPanel(comp: RenderComponent): string {
  const width = termWidth() - 2
  const inner = width - 4
  const body = comp.content ? renderMarkdown(comp.content) : ''
  const lines = body.split('\n').flatMap((l) => wrapAnsi(l, inner))
  const title = comp.title ? ` ${comp.title} ` : ''
  const top = c(comp.style, `╭─${title}${'─'.repeat(Math.max(0, width - vw(title) - 2))}╮`)
  const bot = c(comp.style, `╰${'─'.repeat(width)}╯`)
  const mid = lines.map((l) => `${c(comp.style, '│')} ${pad(l, inner)} ${c(comp.style, '│')}`)
  return [top, ...mid, bot].join('\n')
}

/** Wrap a line to width, ANSI-aware enough for our own output. */
function wrapAnsi(line: string, width: number): string[] {
  if (vw(line) <= width) return [line]
  const out: string[] = []
  let cur = ''
  for (const word of line.split(' ')) {
    if (cur && vw(cur) + 1 + vw(word) > width) { out.push(cur); cur = word }
    else cur = cur ? cur + ' ' + word : word
    while (vw(cur) > width) { out.push(cur.slice(0, width)); cur = cur.slice(width) }
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

function renderTable(comp: RenderComponent): string {
  const headers = comp.headers || []
  const rows = (comp.rows || []).map((r) => r.map((x) => String(x ?? '')))
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 1)
  const widths: number[] = []
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(vw(headers[i] || ''), ...rows.map((r) => vw(r[i] || '')), 1)
  }
  const sep = (l: string, m: string, r: string) =>
    c(comp.style, l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r)
  // Every row renders `cols` cells: a ragged row (model gave fewer cells than
  // headers) pads with blanks instead of producing a short, unclosed line.
  const row = (cells: string[], boldRow = false) =>
    c(comp.style, '│') + Array.from({ length: cols }, (_, i) => ` ${pad(boldRow ? bold(cells[i] || '') : (cells[i] || ''), widths[i])} `).join(c(comp.style, '│')) + c(comp.style, '│')
  const out: string[] = []
  if (comp.title) out.push(bold(comp.title))
  out.push(sep('╭', '┬', '╮'))
  if (headers.length) { out.push(row(headers, true)); out.push(sep('├', '┼', '┤')) }
  for (const r of rows) out.push(row(r))
  out.push(sep('╰', '┴', '╯'))
  return out.join('\n')
}

function renderTree(comp: RenderComponent): string {
  const out: string[] = [c(comp.style, bold(comp.label || comp.title || '•'))]
  const walk = (items: any[], prefix: string) => {
    items.forEach((item, i) => {
      const last = i === items.length - 1
      const branch = last ? '└── ' : '├── '
      const nextPrefix = prefix + (last ? '    ' : '│   ')
      if (typeof item === 'object' && item !== null && 'label' in item) {
        out.push(prefix + c(comp.style, branch) + item.label)
        if (Array.isArray(item.items)) walk(item.items, nextPrefix)
      } else {
        out.push(prefix + c(comp.style, branch) + String(item))
      }
    })
  }
  walk(comp.items || [], '')
  return out.join('\n')
}

function renderSyntax(comp: RenderComponent): string {
  // marked-terminal already highlights fenced code via cli-highlight
  const lang = comp.language || ''
  const code = comp.code || comp.content || ''
  return renderMarkdown('```' + lang + '\n' + code + '\n```')
}

function renderKeyValue(comp: RenderComponent): string {
  const data = comp.data || {}
  const keys = Object.keys(data)
  const kw = Math.max(...keys.map(vw), 1)
  const out: string[] = []
  if (comp.title) out.push(bold(comp.title))
  for (const k of keys) out.push(`  ${c(comp.style, pad(k, kw))}  ${String(data[k])}`)
  return out.join('\n')
}

function renderProgress(comp: RenderComponent): string {
  const total = comp.total || 100
  const done = Math.min(comp.completed || 0, total)
  const width = Math.min(40, termWidth() - 30)
  const filled = Math.round((done / total) * width)
  const pct = Math.round((done / total) * 100)
  const bar = c(comp.style || 'green', '█'.repeat(filled)) + dim('░'.repeat(width - filled))
  return `  ${comp.description || comp.title || ''} ${bar} ${pct}% ${dim(`(${done}/${total})`)}`
}

function renderRule(comp: RenderComponent): string {
  const width = termWidth()
  const title = comp.title || comp.content
  if (!title) return c(comp.style, '─'.repeat(width))
  const side = Math.max(0, Math.floor((width - vw(title) - 2) / 2))
  return c(comp.style, '─'.repeat(side)) + ` ${bold(title)} ` + c(comp.style, '─'.repeat(width - side - vw(title) - 2))
}

export function renderComponents(components: RenderComponent[]): string {
  const parts: string[] = []
  for (const comp of components) {
    try {
      switch (comp.type) {
        case 'panel': parts.push(renderPanel(comp)); break
        case 'table': parts.push(renderTable(comp)); break
        case 'tree': parts.push(renderTree(comp)); break
        case 'markdown': parts.push(renderMarkdown(comp.content || '')); break
        case 'syntax': parts.push(renderSyntax(comp)); break
        case 'text': parts.push(comp.style ? c(comp.style, comp.content || '') : (comp.content || '')); break
        case 'rule': parts.push(renderRule(comp)); break
        case 'keyvalue': parts.push(renderKeyValue(comp)); break
        case 'progress': parts.push(renderProgress(comp)); break
        default: parts.push(String((comp as any).content || ''))
      }
    } catch (e: any) {
      parts.push(dim(`(render error in ${comp.type}: ${e?.message || e})`))
    }
  }
  return parts.join('\n')
}

// ─── Broker — TUI registers a display sink; fallback prints ─────────────────
//
// The handler receives the STRUCTURED components, not pre-painted ANSI. The
// TUI is React — it generates real Ink elements from the spec (colors, borders
// and layout as component props, resizable, part of the tree), instead of
// embedding a fixed-width ANSI bitmap inside a <Text>. The ANSI renderer above
// remains the fallback for plain stdout and the headless text return.

type DisplayHandler = (components: RenderComponent[], title?: string) => void
let displayHandler: DisplayHandler | null = null

export function setRenderHandler(h: DisplayHandler | null): void { displayHandler = h }

export function display(components: RenderComponent[], title?: string): 'tui' | 'stdout' | 'headless' {
  if (displayHandler) { displayHandler(components, title); return 'tui' }
  if (process.stdout.isTTY) { process.stdout.write('\n' + renderComponents(components) + '\n'); return 'stdout' }
  return 'headless'
}

// ─── The tool ───────────────────────────────────────────────────────────────

export function makeRenderTool() {
  return tool({
    name: 'use_render',
    description: `Render rich UI in the user's terminal — compose components dynamically instead of describing data in prose. Components (pass as array):
- {type:'panel', title, content(markdown), style} — bordered box
- {type:'table', title, headers:[...], rows:[[...]], style}
- {type:'tree', label, items:[string | {label, items:[...]}]} — hierarchy
- {type:'keyvalue', title, data:{k:v,...}} — aligned key/value grid
- {type:'markdown', content} — full markdown (headings, lists, code fences)
- {type:'syntax', language, code} — highlighted code block
- {type:'progress', description, total, completed} — progress bar snapshot
- {type:'rule', title} — horizontal divider · {type:'text', content, style}
styles: cyan green yellow magenta red blue gray. Use for status reports, comparisons, file listings, results — anything tabular or structured. Headless: rendered text returns in the result instead.`,
    inputSchema: z.object({
      components: z.array(z.object({
        type: z.enum(['panel', 'table', 'tree', 'markdown', 'syntax', 'text', 'rule', 'keyvalue', 'progress']),
        title: z.string().optional(),
        content: z.string().optional(),
        style: z.string().optional(),
        headers: z.array(z.string()).optional(),
        rows: z.array(z.array(z.string())).optional(),
        label: z.string().optional(),
        items: z.array(z.any()).optional(),
        language: z.string().optional(),
        code: z.string().optional(),
        data: z.record(z.string(), z.any()).optional(),
        total: z.number().optional(),
        completed: z.number().optional(),
        description: z.string().optional(),
      })).min(1),
      title: z.string().optional().describe('Overall block title (used by TUI panel)'),
    }),
    callback: async (input: any) => {
      const components = input.components as RenderComponent[]
      const surface = display(components, input.title)
      if (surface === 'headless') {
        // No screen — hand the rendering back (plain text) so it reaches the asker.
        const ansi = renderComponents(components)
        return `Rendered (headless — shown inline):\n${ansi.replace(/\x1b\[[0-9;]*m/g, '')}`
      }
      return `Rendered ${components.length} component(s) to ${surface === 'tui' ? 'the TUI' : 'the terminal'}. The user can see it — don't repeat the same data in prose.`
    },
  })
}
