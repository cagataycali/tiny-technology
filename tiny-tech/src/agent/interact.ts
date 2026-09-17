/**
 * 💬 use_interact — inline interactive prompts. devduck dialog.py, tiny-shaped.
 *
 * The agent asks the HUMAN mid-turn: text input, password, yes/no, radio
 * select, pizza-style checkbox, button row, multi-field forms. Completely
 * dynamic — the model decides the question, options and shape at runtime.
 *
 * ── one tool, three surfaces ────────────────────────────────────────────────
 * The same tool call must work wherever the agent runs:
 *   TUI (Ink)    App.tsx registers a handler via setInteractionHandler() —
 *                the question renders as a live component inside the
 *                transcript, Ink keeps owning stdin, promise resolves on
 *                submit. (devduck: tools/tui.py set_tui_app pattern.)
 *   REPL/oneshot no handler registered → raw-mode stdin fallback below:
 *                arrow-key cursor, space toggles, masked password. The REPL's
 *                readline listeners are detached for the duration and
 *                restored after, so keys aren't double-consumed.
 *   daemon/mesh  no TTY → returns an error result the model can adapt to
 *                ("no interactive terminal") instead of hanging a relay turn.
 *
 * ── why a broker and not two tools ─────────────────────────────────────────
 * The model shouldn't have to know which surface it's on. It says "ask the
 * user to pick", and the surface that can render richest wins.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InteractOption { value: string; label: string }
export interface InteractField {
  name: string
  label?: string
  type?: 'text' | 'password'
  default?: string
  required?: boolean
}
export interface InteractRequest {
  type: 'input' | 'password' | 'confirm' | 'select' | 'multiselect' | 'buttons' | 'form' | 'message'
  text: string
  title?: string
  options?: InteractOption[]
  fields?: InteractField[]
  default?: string
  timeoutMs: number
}
export type InteractResult =
  | { ok: true; value: any }
  | { ok: false; cancelled?: boolean; error?: string }

// ─── Broker — the TUI registers here; absent, terminal fallback runs ───────

type UiHandler = (req: InteractRequest) => Promise<InteractResult>
let uiHandler: UiHandler | null = null

/** TUI surfaces register a renderer; pass null on unmount. */
export function setInteractionHandler(h: UiHandler | null): void { uiHandler = h }
export function hasInteractionHandler(): boolean { return uiHandler !== null }

export async function requestInteraction(req: InteractRequest): Promise<InteractResult> {
  if (uiHandler) {
    // Race against timeout — a relay envelope may be waiting on this turn.
    return await withTimeout(uiHandler(req), req.timeoutMs)
  }
  return await termInteract(req)
}

/** No answer for this long and the turn gives up rather than hanging forever. */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * A missing or nonsense timeout must never mean "give up immediately".
 * `setTimeout(fn, NaN)` fires on the NEXT TICK, so an unset timeoutMs would
 * auto-cancel the question before the human could see it — and report it as
 * "timed out after NaNs". The tool clamps its own input; this covers every
 * other caller.
 */
function timeoutFor(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS
}

function withTimeout(p: Promise<InteractResult>, ms: number): Promise<InteractResult> {
  const limit = timeoutFor(ms)
  return Promise.race([
    p,
    new Promise<InteractResult>((res) => setTimeout(() => res({ ok: false, cancelled: true, error: `timed out after ${limit / 1000}s` }), limit).unref?.()),
  ])
}

// ─── Terminal fallback (REPL / one-shot) ────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m',
  hide: '\x1b[?25l', show: '\x1b[?25h',
}

/**
 * Detach every existing stdin listener (the REPL's readline included), take
 * raw mode, and hand back a restore(). Without the detach the REPL interface
 * consumes the same keystrokes the dialog is reading.
 */
function captureStdin() {
  const stdin: any = process.stdin
  const savedData = stdin.listeners('data').slice()
  const savedKeypress = stdin.listeners('keypress').slice()
  for (const l of savedData) stdin.removeListener('data', l)
  for (const l of savedKeypress) stdin.removeListener('keypress', l)
  const wasRaw = !!stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()

  let handler: ((s: string) => void) | null = null
  const listener = (buf: Buffer) => handler?.(buf.toString('utf-8'))
  stdin.on('data', listener)

  return {
    onKey(fn: (s: string) => void) { handler = fn },
    restore() {
      stdin.removeListener('data', listener)
      stdin.setRawMode?.(wasRaw)
      for (const l of savedData) stdin.on('data', l)
      for (const l of savedKeypress) stdin.on('keypress', l)
      process.stdout.write(ANSI.show)
    },
  }
}

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', ctrlC: '\x03', esc: '\x1b', backspace: '\x7f' }

async function termInteract(req: InteractRequest): Promise<InteractResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { ok: false, error: 'no interactive terminal — running headless (daemon/mesh); ask via a message rail instead' }
  }
  const out = process.stdout
  const cap = captureStdin()
  const limit = timeoutFor(req.timeoutMs)   // same guard as the TUI path
  const cleanupTimer = setTimeout(() => finishOnce({ ok: false, cancelled: true, error: `timed out after ${limit / 1000}s` }), limit)
  cleanupTimer.unref?.()

  let finished = false
  let resolveOuter: (r: InteractResult) => void
  const done = new Promise<InteractResult>((res) => { resolveOuter = res })
  const finishOnce = (r: InteractResult) => {
    if (finished) return
    finished = true
    clearTimeout(cleanupTimer)
    cap.restore()
    out.write('\n')
    resolveOuter(r)
  }

  const header = `\n${ANSI.cyan}${ANSI.bold}? ${req.title ? req.title + ' — ' : ''}${ANSI.reset}${req.text}\n`

  try {
    switch (req.type) {
      case 'message': {
        out.write(header + `${ANSI.dim}  press enter to continue${ANSI.reset}\n`)
        cap.onKey((k) => { if (k === KEY.enter || k === '\n') finishOnce({ ok: true, value: 'acknowledged' }); if (k === KEY.ctrlC || k === KEY.esc) finishOnce({ ok: false, cancelled: true }) })
        break
      }
      case 'confirm': {
        out.write(header + `${ANSI.dim}  (y/n)${ANSI.reset} `)
        cap.onKey((k) => {
          const c = k.toLowerCase()
          if (c === 'y') { out.write('yes'); finishOnce({ ok: true, value: true }) }
          else if (c === 'n') { out.write('no'); finishOnce({ ok: true, value: false }) }
          else if (k === KEY.ctrlC || k === KEY.esc) finishOnce({ ok: false, cancelled: true })
        })
        break
      }
      case 'input':
      case 'password': {
        out.write(header + '  › ')
        let buf = req.default || ''
        const mask = req.type === 'password'
        out.write(mask ? '*'.repeat(buf.length) : buf)
        cap.onKey((k) => {
          if (k === KEY.enter || k === '\n') { finishOnce({ ok: true, value: buf }); return }
          if (k === KEY.ctrlC || k === KEY.esc) { finishOnce({ ok: false, cancelled: true }); return }
          if (k === KEY.backspace) { if (buf.length) { buf = buf.slice(0, -1); out.write('\b \b') } return }
          // printable chars only (skip other escape sequences)
          if (k >= ' ' && !k.startsWith('\x1b')) { buf += k; out.write(mask ? '*'.repeat(k.length) : k) }
        })
        break
      }
      case 'select':
      case 'buttons':
      case 'multiselect': {
        const opts = req.options || []
        if (!opts.length) { finishOnce({ ok: false, error: 'no options provided' }); break }
        const multi = req.type === 'multiselect'
        let cursor = 0
        const checked = new Set<number>()
        const hint = multi ? '↑/↓ move · space toggle · a all · enter confirm · esc cancel' : '↑/↓ move · enter select · esc cancel'
        out.write(header + `${ANSI.dim}  ${hint}${ANSI.reset}\n` + ANSI.hide)

        const draw = (first = false) => {
          if (!first) out.write(`\x1b[${opts.length}A\r\x1b[J`)
          for (let i = 0; i < opts.length; i++) {
            const cur = i === cursor
            const box = multi ? (checked.has(i) ? `${ANSI.green}[x]${ANSI.reset} ` : '[ ] ') : ''
            const ptr = cur ? `${ANSI.cyan}${ANSI.bold}❯ ` : '  '
            out.write(`  ${ptr}${box}${opts[i].label}${ANSI.reset}\n`)
          }
        }
        draw(true)
        cap.onKey((k) => {
          if (k === KEY.up) { cursor = (cursor - 1 + opts.length) % opts.length; draw() }
          else if (k === KEY.down) { cursor = (cursor + 1) % opts.length; draw() }
          else if (k === ' ' && multi) { checked.has(cursor) ? checked.delete(cursor) : checked.add(cursor); draw() }
          else if (k.toLowerCase() === 'a' && multi) { checked.size === opts.length ? checked.clear() : opts.forEach((_, i) => checked.add(i)); draw() }
          else if (k === KEY.enter || k === '\n') {
            finishOnce({ ok: true, value: multi ? [...checked].sort((a, b) => a - b).map((i) => opts[i].value) : opts[cursor].value })
          }
          else if (k === KEY.ctrlC || k === KEY.esc) finishOnce({ ok: false, cancelled: true })
        })
        break
      }
      case 'form': {
        // Sequential fields on one captured stdin — restore only at the end.
        const fields = req.fields || []
        if (!fields.length) { finishOnce({ ok: false, error: 'no fields provided' }); break }
        out.write(header)
        const values: Record<string, string> = {}
        let idx = 0
        let buf = fields[0].default || ''
        const label = (f: InteractField) => `  ${ANSI.bold}${f.label || f.name}${f.required ? ' *' : ''}:${ANSI.reset} `
        out.write(label(fields[0]) + (fields[0].type === 'password' ? '*'.repeat(buf.length) : buf))
        cap.onKey((k) => {
          const f = fields[idx]
          const mask = f.type === 'password'
          if (k === KEY.enter || k === '\n') {
            if (f.required && !buf.trim()) { out.write(`\n  ${ANSI.yellow}required${ANSI.reset}\n` + label(f)); buf = ''; return }
            values[f.name] = buf
            idx += 1
            if (idx >= fields.length) { finishOnce({ ok: true, value: values }); return }
            buf = fields[idx].default || ''
            out.write('\n' + label(fields[idx]) + (fields[idx].type === 'password' ? '*'.repeat(buf.length) : buf))
            return
          }
          if (k === KEY.ctrlC || k === KEY.esc) { finishOnce({ ok: false, cancelled: true }); return }
          if (k === KEY.backspace) { if (buf.length) { buf = buf.slice(0, -1); out.write('\b \b') } return }
          if (k >= ' ' && !k.startsWith('\x1b')) { buf += k; out.write(mask ? '*'.repeat(k.length) : k) }
        })
        break
      }
      default:
        finishOnce({ ok: false, error: `unknown interaction type: ${(req as any).type}` })
    }
  } catch (e: any) {
    finishOnce({ ok: false, error: String(e?.message || e) })
  }
  return done
}

// ─── The tool ───────────────────────────────────────────────────────────────

/** Normalize loose option shapes the model may produce. */
function normalizeOptions(raw?: any[]): InteractOption[] | undefined {
  if (!raw) return undefined
  return raw.map((o) => {
    if (typeof o === 'string') return { value: o, label: o }
    if (Array.isArray(o)) return { value: String(o[0]), label: String(o[1] ?? o[0]) }
    return { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
  }).filter((o) => o.value || o.label)
}

export function makeInteractTool() {
  return tool({
    name: 'use_interact',
    description: `Ask the HUMAN at this terminal a question mid-turn — inline interactive UI. Types:
- input (free text, optional default) · password (masked, never echoed back)
- confirm (yes/no → boolean) · message (info box, enter to continue)
- select (radio — arrow keys, pick ONE) · multiselect (checkboxes — space toggles, pick MANY, e.g. pizza toppings)
- buttons (small horizontal choice) · form (multi-field: fields=[{name,label,type,default,required}])
Options: options=["a","b"] or [{value,label},…]. Works in TUI and REPL; headless returns an error you should adapt to.
Use whenever you need a decision, credential, or preference instead of guessing. Result JSON: {ok,value} or {ok:false,cancelled}.`,
    inputSchema: z.object({
      type: z.enum(['input', 'password', 'confirm', 'select', 'multiselect', 'buttons', 'form', 'message']),
      text: z.string().describe('The question or message to show'),
      title: z.string().optional(),
      options: z.array(z.union([
        z.string(),
        z.object({ value: z.string(), label: z.string().optional() }),
      ])).optional().describe('Choices for select/multiselect/buttons'),
      fields: z.array(z.object({
        name: z.string(),
        label: z.string().optional(),
        type: z.enum(['text', 'password']).optional(),
        default: z.string().optional(),
        required: z.boolean().optional(),
      })).optional().describe('Fields for form'),
      default: z.string().optional().describe('Default value for input'),
      timeout_sec: z.number().optional().describe('Max seconds to wait (default 180)'),
    }),
    callback: async (input: any) => {
      const req: InteractRequest = {
        type: input.type,
        text: input.text,
        title: input.title,
        options: normalizeOptions(input.options),
        fields: input.fields,
        default: input.default,
        timeoutMs: Math.min(Math.max((input.timeout_sec ?? 180), 5), 3600) * 1000,
      }
      if ((req.type === 'select' || req.type === 'multiselect' || req.type === 'buttons') && !req.options?.length) {
        return JSON.stringify({ ok: false, error: 'options required for ' + req.type })
      }
      if (req.type === 'form' && !req.fields?.length) {
        return JSON.stringify({ ok: false, error: 'fields required for form' })
      }
      const result = await requestInteraction(req)
      // Passwords reach the model as a value it may need (e.g. to use in a
      // command) — that's the point of asking. Everything else round-trips too.
      return JSON.stringify(result)
    },
  })
}
