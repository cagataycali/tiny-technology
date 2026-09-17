/**
 * Conversation state for the TUI — pure functions, no React, no I/O, so the
 * concurrency rules can be tested without a TTY.
 *
 * WHY this exists: the composer used to drop a submit while tiny was streaming
 * (`if (!q || busy) return`) even though the placeholder promised the input was
 * "queued after". Now every submit becomes its own conversation with its own
 * colour, tool chips and clock, and they all run at once — no cap, nothing
 * dropped. (A cap is opt-in per state; see MAX_CONCURRENT.)
 *
 * WHY isolated history per conversation: Bedrock validates toolUse/toolResult
 * pairing strictly, so two live turns appending into one shared message array
 * produce an invalid sequence (devduck's SharedMessages trick doesn't port).
 * Each conversation runs on a forked agent and merges its finished exchange back
 * into the parent history in completion order.
 */
import type { TurnEvent } from '../agent/agent.js'

/** Panel colours, handed out round-robin so neighbours never share one. */
export const PALETTE = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red'] as const
export type ConvColor = (typeof PALETTE)[number]

/**
 * No cap: every submit starts immediately, however many are already running.
 * The user asked for this explicitly — the machine and the model API are the
 * only real limits, and a UI-imposed ceiling just hides work that could already
 * be in flight. The queue plumbing below stays because it costs nothing and
 * `createState({ maxConcurrent: n })` is the one honest way to get a ceiling
 * back (a slow API, a laptop on battery) without reintroducing dropped input.
 */
export const MAX_CONCURRENT = Infinity

export type ConvStatus = 'queued' | 'running' | 'done' | 'cancelled'

/**
 * 'turn' is one agent turn: it starts, streams, ends by itself.
 * 'session' is a long-lived duplex stream (the bidirectional voice agent) that
 * ends only when the user ends it — so it gets a panel but never occupies a
 * turn slot, otherwise one open mic would eat a quarter of the concurrency.
 */
export type ConvKind = 'turn' | 'session'

/**
 * `detail` is the one-line answer to "doing what?" — the shell command, the file
 * being edited, the URL. A chip that says only `bash` is nearly content-free when
 * three panels each show one; the model already sends the arguments, the TUI just
 * used to drop them on the floor.
 */
export interface ToolChip { name: string; done: boolean; error?: string; detail?: string }

/** Keys worth showing, in the order we'd rather show them. */
const DETAIL_KEYS = [
  'command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'url', 'query', 'q',
  'prompt', 'task', 'text', 'message', 'action', 'name', 'package', 'pattern', 'expression',
]

const DETAIL_MAX = 56

/**
 * Compact, human-readable summary of a tool's arguments — pure so it can be
 * tested without a terminal.
 *
 * Deliberately lossy: this is a glance-level label, not a log. It never throws
 * (a tool's input is model-generated and can be any shape) and returns undefined
 * when there's nothing worth showing, so the chip falls back to the bare name.
 */
export function summarizeToolInput(name: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' && input.trim() ? clip(input) : undefined
  }
  const obj = input as Record<string, unknown>

  // httpRequest reads as one thing — "GET api.github.com/repos" — not two fields.
  if (typeof obj.url === 'string') {
    const method = typeof obj.method === 'string' ? `${obj.method.toUpperCase()} ` : ''
    return clip(method + obj.url.replace(/^https?:\/\//, ''))
  }

  for (const key of DETAIL_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) {
      // A file edit's real subject is the path; the mode ('create', 'view') is
      // the useful qualifier when it's there.
      const mode = key === 'path' || key.toLowerCase().includes('file')
        ? (typeof obj.mode === 'string' ? obj.mode : typeof obj.command === 'string' ? obj.command : '')
        : ''
      return clip(mode && mode !== v ? `${mode} ${v}` : v)
    }
    if (typeof v === 'number' || typeof v === 'boolean') return clip(String(v))
  }
  return undefined
}

/** One line, whitespace-collapsed, bounded — a chip is one row of a panel. */
function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? flat.slice(0, DETAIL_MAX - 1) + '…' : flat
}

export interface Conversation {
  id: number
  color: ConvColor
  kind: ConvKind
  status: ConvStatus
  query: string
  text: string
  tools: ToolChip[]
  error?: string
  /**
   * A handled hiccup — a context overflow the agent trimmed its way out of. Kept
   * apart from `error` because the fold-back rule reads `error` as "this turn's
   * history is unsafe to keep", and a recovered turn's history is perfectly good.
   */
  notice?: string
  /** Auto-generated /loop iteration rather than something the user typed. */
  loop: boolean
  queuedAt: number
  startedAt?: number
  finishedAt?: number
}

export interface ConvState {
  items: Conversation[]
  nextId: number
  colorCursor: number
  maxConcurrent: number
  totalSubmitted: number
  totalCompleted: number
}

export interface SubmitInput {
  query: string
  kind?: ConvKind
  loop?: boolean
  now?: number
}

/** State change plus the conversations the caller must now actually start. */
export interface Launch {
  state: ConvState
  launch: Conversation[]
}

export function createState(opts: { maxConcurrent?: number } = {}): ConvState {
  return {
    items: [],
    nextId: 1,
    colorCursor: 0,
    maxConcurrent: opts.maxConcurrent ?? MAX_CONCURRENT,
    totalSubmitted: 0,
    totalCompleted: 0,
  }
}

/**
 * Promote queued conversations while there's room. Iterating in insertion order
 * is what makes the queue FIFO; `continue` rather than `break` lets a session
 * behind a full turn queue still start, since sessions don't consume slots.
 */
function drain(state: ConvState, now: number): Launch {
  const items = [...state.items]
  const launch: Conversation[] = []
  let running = items.filter((c) => c.status === 'running' && c.kind === 'turn').length

  for (let i = 0; i < items.length; i++) {
    const c = items[i]
    if (c.status !== 'queued') continue
    if (c.kind === 'turn') {
      if (running >= state.maxConcurrent) continue
      running++
    }
    const started: Conversation = { ...c, status: 'running', startedAt: now }
    items[i] = started
    launch.push(started)
  }
  return { state: { ...state, items }, launch }
}

/** Accept a submit — always. It either starts now or waits its turn. */
export function submit(state: ConvState, input: SubmitInput): Launch {
  const now = input.now ?? Date.now()
  const conv: Conversation = {
    id: state.nextId,
    color: PALETTE[state.colorCursor % PALETTE.length],
    kind: input.kind ?? 'turn',
    status: 'queued',
    query: input.query,
    text: '',
    tools: [],
    loop: input.loop ?? false,
    queuedAt: now,
  }
  return drain(
    {
      ...state,
      items: [...state.items, conv],
      nextId: state.nextId + 1,
      colorCursor: state.colorCursor + 1,
      totalSubmitted: state.totalSubmitted + 1,
    },
    now,
  )
}

/**
 * Fold one stream event into one conversation. Events name their conversation,
 * so interleaved streams from several forked agents can't cross-contaminate.
 * A `done` event only backfills text — finishing is `complete()`'s job, because
 * the caller also has to merge history and drain the queue.
 */
export function applyEvent(state: ConvState, id: number, ev: TurnEvent): ConvState {
  const idx = state.items.findIndex((c) => c.id === id)
  if (idx < 0) return state
  const c = state.items[idx]
  // Late events from a cancelled turn are noise, not state.
  if (c.status === 'cancelled' || c.status === 'done') return state

  let next: Conversation
  switch (ev.kind) {
    case 'text':
      next = { ...c, text: c.text + ev.text }
      break
    case 'tool_start':
      next = {
        ...c,
        tools: [...c.tools, {
          name: ev.name || 'tool',
          done: false,
          detail: summarizeToolInput(ev.name, ev.input),
        }],
      }
      break
    case 'tool_end': {
      const tools = c.tools.map((t) => ({ ...t }))
      const name = ev.name || 'tool'
      // Match the most recent unfinished chip of that name; fall back to any
      // unfinished chip so a renamed/unnamed result still closes something.
      let hit = -1
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].name === name && !tools[i].done) { hit = i; break }
      }
      if (hit < 0) hit = tools.findIndex((t) => !t.done)
      if (hit >= 0) { tools[hit].done = true; tools[hit].error = ev.error }
      next = { ...c, tools }
      break
    }
    case 'notice':
      next = { ...c, notice: ev.message }
      break
    case 'error':
      next = { ...c, error: ev.message }
      break
    case 'done':
      next = { ...c, text: c.text || ev.text }
      break
    default:
      return state // reasoning deltas aren't rendered per panel
  }
  const items = [...state.items]
  items[idx] = next
  return { ...state, items }
}

export interface Completion extends Launch {
  /** The conversation that just landed — the caller renders it and merges it. */
  finished?: Conversation
}

/** Mark a conversation finished and start whatever was waiting behind it. */
export function complete(state: ConvState, id: number, now = Date.now()): Completion {
  const idx = state.items.findIndex((c) => c.id === id)
  if (idx < 0) return { state, launch: [] }
  const c = state.items[idx]
  if (c.status === 'done' || c.status === 'cancelled') return { state, launch: [] }

  const finished: Conversation = { ...c, status: 'done', finishedAt: now }
  const items = [...state.items]
  items[idx] = finished
  const drained = drain({ ...state, items, totalCompleted: state.totalCompleted + 1 }, now)
  return { ...drained, finished }
}

/**
 * Cancel one conversation. A running turn's generator keeps producing until it
 * notices, so `applyEvent` ignores anything that arrives afterwards.
 */
export function cancel(state: ConvState, id: number, now = Date.now()): Completion {
  const idx = state.items.findIndex((c) => c.id === id)
  if (idx < 0) return { state, launch: [] }
  const c = state.items[idx]
  if (c.status === 'done' || c.status === 'cancelled') return { state, launch: [] }

  const finished: Conversation = { ...c, status: 'cancelled', finishedAt: now }
  const items = [...state.items]
  items[idx] = finished
  const drained = drain({ ...state, items }, now)
  return { ...drained, finished }
}

/** Drop everything still waiting — Esc on an empty composer. */
export function dropQueued(state: ConvState): { state: ConvState; dropped: number } {
  const keep = state.items.filter((c) => c.status !== 'queued')
  return { state: { ...state, items: keep }, dropped: state.items.length - keep.length }
}

/** Forget a conversation the UI has moved into <Static>. */
export function remove(state: ConvState, id: number): ConvState {
  return { ...state, items: state.items.filter((c) => c.id !== id) }
}

export const running = (s: ConvState): Conversation[] => s.items.filter((c) => c.status === 'running')
export const queued = (s: ConvState): Conversation[] => s.items.filter((c) => c.status === 'queued')
export const activeCount = (s: ConvState): number => running(s).length
export const queuedCount = (s: ConvState): number => queued(s).length
/** True while any turn is streaming — the old single `busy` flag, derived. */
export const isBusy = (s: ConvState): boolean => running(s).some((c) => c.kind === 'turn')

/** Newest running turn — what a single ^C should stop. */
export function newestRunning(s: ConvState): Conversation | undefined {
  const r = running(s).filter((c) => c.kind === 'turn')
  return r.length ? r[r.length - 1] : undefined
}

export function find(s: ConvState, id: number): Conversation | undefined {
  return s.items.find((c) => c.id === id)
}

/** Wall time this conversation has been running (queue wait excluded). */
export function elapsedMs(c: Conversation, now = Date.now()): number {
  if (!c.startedAt) return 0
  return Math.max(0, (c.finishedAt ?? now) - c.startedAt)
}

/** Compact clock for a panel label: 4s, 42s, 1m12s. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m${String(s).padStart(2, '0')}s`
}
