/**
 * 🎙️ The realtime call, rendered in the Ink TUI.
 *
 * agent/realtime.ts is the call; agent/voice-cli.ts prints it to a pipe. This
 * is the third surface: a live strip inside the TUI, so a call happens WHILE
 * you keep typing instead of taking the terminal over.
 *
 * The hard part here is not the pixels — it is the event rate. A realtime call
 * emits a `level` event per microphone frame (a frame every ~20–40 ms) plus a
 * transcript delta per word. Handing each one to setState repaints Ink's whole
 * tree 30–50 times a second, and since paint and keystroke handling share one
 * event loop, the composer goes sticky mid-call: you type "npm run build" and
 * watch the letters land late. So the store below COALESCES — it absorbs every
 * event immediately (cheap, no React) and wakes the renderer at most ~12 fps,
 * always including a trailing flush so the final frame ("ended") is never the
 * one that got dropped.
 *
 * Mounting is deliberately two pieces:
 *   · CallStore — framework-free, testable without a terminal, and the thing
 *     that owns the RealtimeCall's onEvent firehose.
 *   · <VoiceCallStrip> — pure props in, elements out.
 * App.tsx wires them together with useVoiceCall(store); nothing in here reaches
 * back into the app, which is what lets a call and a typed conversation run at
 * the same time.
 */
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from 'ink'
import type { RealtimeEvent } from '../agent/realtime.js'

/** ~12 fps. Fast enough that a mic meter reads as live, slow enough that Ink's
 *  paint never competes with the keystrokes going into the composer. */
export const FRAME_MS = 80

/** The live strip only ever shows the tail of what's being said — the full text
 *  leaves via the `turn` event and lands in the transcript. */
const TAIL_CHARS = 400

/** Peak-hold decay per paint: the meter falls back visibly instead of snapping,
 *  which is what makes a bar chart read as sound rather than as noise. */
const DECAY = 0.12

export type CallPhase = 'connecting' | 'listening' | 'speaking' | 'working' | 'ended'

export interface CallSnapshot {
  phase: CallPhase
  /** Latest mic frame level, 0..1. */
  level: number
  /** Decaying peak-hold, 0..1 — drawn behind the level. */
  peak: number
  /** The last thing the person said, transcribed. */
  you: string
  /** What the tiny is saying right now, streaming. */
  tiny: string
  /** Recent tool activity, newest last, capped. */
  tools: { id: string; name: string; args: any; output?: string }[]
  error: string
  /** Completed exchanges so far — the call's own turn counter. */
  turns: number
  /** True between a barge-in and the next thing said, so the strip can show it. */
  interrupted: boolean
  model: string
  voice: string
  fullDuplex: boolean
}

const EMPTY: CallSnapshot = {
  phase: 'connecting', level: 0, peak: 0, you: '', tiny: '', tools: [],
  error: '', turns: 0, interrupted: false, model: '', voice: '', fullDuplex: false,
}

/**
 * Absorbs a RealtimeCall's events and publishes a paint-rate snapshot.
 *
 * Deliberately not a React thing: the call starts before the component mounts
 * (a realtime session is metered from connect, so nothing should wait on a
 * render), and the tests drive it with plain event objects.
 */
export class CallStore {
  private snap: CallSnapshot
  private listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  /** Injected so tests don't sleep; production passes nothing. */
  private now: () => number
  private lastPaint = 0

  constructor(meta?: { model?: string; voice?: string; fullDuplex?: boolean; now?: () => number }) {
    this.snap = { ...EMPTY, model: meta?.model || '', voice: meta?.voice || '', fullDuplex: !!meta?.fullDuplex }
    this.now = meta?.now || Date.now
  }

  /** useSyncExternalStore's pair. The snapshot is immutable per publish, so
   *  React's identity check is the whole re-render decision. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getSnapshot = (): CallSnapshot => this.snap

  /** Hand this straight to `new RealtimeCall({ onEvent: store.handle })`. */
  handle = (e: RealtimeEvent): void => {
    const s = this.snap
    let next: CallSnapshot | null = null
    switch (e.type) {
      case 'status':
        next = {
          ...s,
          phase: e.status === 'live' ? (s.phase === 'connecting' ? 'listening' : s.phase)
            : e.status === 'connecting' ? 'connecting' : 'ended',
          ...(e.status === 'ended' || e.status === 'error' ? { level: 0, peak: 0 } : {}),
        }
        break
      case 'level':
        // The hottest event by far — mutate in place and let the timer publish.
        // Cloning per frame would allocate a snapshot 30× a second for a bar
        // that only gets looked at 12 times.
        s.level = e.level
        if (e.level > s.peak) s.peak = e.level
        this.dirty = true
        this.schedule()
        return
      case 'user_transcript':
        next = { ...s, you: e.text, tiny: '', interrupted: false, tools: [] }
        break
      case 'response_started':
        next = { ...s, phase: 'speaking', tiny: '', interrupted: false }
        break
      case 'assistant_transcript':
        next = { ...s, phase: 'speaking', tiny: tail(s.tiny + e.delta) }
        break
      case 'response_done':
        next = { ...s, phase: s.phase === 'ended' ? 'ended' : 'listening' }
        break
      case 'barge_in':
        // Not an error and not silence: the person cut in. Keep the half-said
        // sentence on screen — cutting someone off mid-word is information.
        next = { ...s, phase: 'listening', interrupted: true }
        break
      case 'tool_call':
        next = { ...s, phase: 'working', tools: [...s.tools, { id: e.id, name: e.name, args: e.args }].slice(-3) }
        break
      case 'tool_result':
        next = {
          ...s,
          tools: s.tools.map((t) => (t.id === e.id ? { ...t, output: e.output } : t)),
        }
        break
      case 'turn':
        next = { ...s, turns: s.turns + 1 }
        break
      case 'error':
        next = { ...s, error: e.error }
        break
      default:
        return
    }
    this.snap = next
    this.dirty = true
    this.schedule()
  }

  /** Leading-edge publish when the budget allows, trailing timer otherwise —
   *  a call that ends between paints must still paint its last frame. */
  private schedule() {
    const t = this.now()
    if (t - this.lastPaint >= FRAME_MS) { this.flush(); return }
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, FRAME_MS - (t - this.lastPaint))
    this.timer.unref?.()
  }

  /** Publish now. Exposed for tests and for the mount site's teardown. */
  flush = (): void => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty) return
    this.dirty = false
    this.lastPaint = this.now()
    // Peak decays on publish, not on a clock: no events means no repaint means
    // nothing to decay toward.
    const peak = Math.max(this.snap.level, this.snap.peak - DECAY)
    this.snap = { ...this.snap, peak }
    for (const fn of this.listeners) { try { fn() } catch { /* a listener's bug is not the call's */ } }
  }

  /** Drop the pending timer — the strip is gone, nothing left to paint. */
  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.listeners.clear()
  }
}

const tail = (s: string) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s)

/** Subscribe a component to a store. */
export function useVoiceCall(store: CallStore | null): CallSnapshot {
  const subscribe = store ? store.subscribe : NOOP_SUBSCRIBE
  const get = store ? store.getSnapshot : NOOP_SNAPSHOT
  return useSyncExternalStore(subscribe, get, get)
}
const NOOP_SUBSCRIBE = () => () => {}
const NOOP_SNAPSHOT = () => EMPTY

// ─── The strip ──────────────────────────────────────────────────────────────

const METER_WIDTH = 12

/** A level meter drawn with block glyphs: filled to the level, a single peak
 *  marker where the loudest recent frame was. */
export function meterBars(level: number, peak: number, width = METER_WIDTH): string {
  const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
  const lit = Math.round(clamp(level) * width)
  const mark = Math.min(width - 1, Math.round(clamp(peak) * width) - 1)
  let s = ''
  for (let i = 0; i < width; i++) s += i < lit ? '█' : i === mark && mark >= lit ? '▖' : '·'
  return s
}

const PHASE_LABEL: Record<CallPhase, string> = {
  connecting: 'dialling…',
  listening: 'listening',
  speaking: 'speaking',
  working: 'running a tool',
  ended: 'call ended',
}
const PHASE_COLOR: Record<CallPhase, string> = {
  connecting: 'yellow', listening: 'green', speaking: 'cyan', working: 'magenta', ended: 'gray',
}
/** Every phase word occupies the same width, so the meter next to it does not
 *  slide sideways each time the phase changes — a moving meter reads as jitter. */
export const LABEL_WIDTH = Math.max(...Object.values(PHASE_LABEL).map((s) => s.length))

/**
 * One row = one line, always.
 *
 * The strip lives directly above the composer, so its HEIGHT must not change
 * while someone is speaking: Ink repaints from the first changed line down, and
 * a box that grows a line mid-word drags the prompt and the cursor with it. So
 * nothing here wraps — the fixed parts refuse to shrink (flexShrink={0}) and
 * the variable parts truncate. The spoken answer truncates from the START,
 * because the newest words are the ones being said right now.
 */
export function VoiceCallStrip({ state }: { state: CallSnapshot }) {
  const c = PHASE_COLOR[state.phase]
  const meta = [
    state.model,
    state.voice && `voice ${state.voice}`,
    state.turns > 0 && `${state.turns} turn${state.turns === 1 ? '' : 's'}`,
    // Only worth a word when it is NOT the default: a muted mic changes how the
    // call behaves, an open one is just how a call works.
    !state.fullDuplex && 'echo gating',
  ].filter(Boolean).join(' · ')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c} paddingX={1}>
      <Box>
        <Box flexShrink={0}>
          <Text color={c} bold>{'● ' + PHASE_LABEL[state.phase].padEnd(LABEL_WIDTH)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{'  ' + meterBars(state.level, state.peak) + '  '}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor wrap="truncate">{meta}</Text>
        </Box>
      </Box>

      {state.you ? (
        <Box>
          <Box flexShrink={0}><Text bold>you </Text></Box>
          <Box flexGrow={1}><Text wrap="truncate">{state.you}</Text></Box>
        </Box>
      ) : null}

      {state.tiny ? (
        <Box>
          <Box flexShrink={0}><Text color="cyan">tiny </Text></Box>
          <Box flexGrow={1}><Text wrap="truncate-start">{state.tiny}</Text></Box>
          {state.interrupted ? <Box flexShrink={0}><Text dimColor> ⏸</Text></Box> : null}
        </Box>
      ) : null}

      {state.tools.map((t) => (
        <Box key={t.id}>
          <Box flexShrink={0}><Text dimColor>{'  · ' + t.name}</Text></Box>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate">
              {t.output === undefined ? '…' : ` → ${t.output.replace(/\s+/g, ' ').slice(0, 60)}`}
            </Text>
          </Box>
        </Box>
      ))}

      {state.error ? <Text color="red" wrap="truncate">{'! ' + state.error}</Text> : null}
    </Box>
  )
}

/**
 * What App.tsx needs, in one call — kept here so the wiring is a line and not a
 * lump of call plumbing inside a 900-line component.
 *
 * ```tsx
 * const [store, setStore] = useState<CallStore | null>(null)
 * const callState = useVoiceCall(store)
 * // on /voice:
 * const { call, store } = await openCall({ api, tools, onTurn: (u, a) => …history… })
 * // in the tree:
 * {store && <VoiceCallStrip state={callState} />}
 * ```
 */
export interface OpenCallOptions {
  apiKey?: string
  model?: string
  voice?: string
  /** false = mute the mic while the tiny is audible. Undefined = the default,
   *  which is open (resolveFullDuplex). */
  fullDuplex?: boolean
  context?: string
  tools?: any[]
  /** Run a tool. The TUI passes agent.invokeTool: the SDK's vended tools need a
   *  real ToolContext, and without it bash and fileEditor answer every spoken
   *  request with "Tool context is required". */
  executeTool?: (name: string, args: any) => Promise<string> | string
  /** A completed exchange — the caller decides where it lands (transcript,
   *  injectExchange, both). The store only counts them. */
  onTurn?: (user: string, assistant: string, continuation: boolean) => void
}

export async function openCall(opts: OpenCallOptions): Promise<{ store: CallStore; call: any }> {
  const { RealtimeCall, DEFAULT_REALTIME_MODEL, resolveVoice, resolveFullDuplex } = await import('../agent/realtime.js')
  const { detectBackend, missingAudioHint } = await import('../agent/audio.js')

  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY || ''
  if (!apiKey) throw new Error('voice needs an OpenAI key: export OPENAI_API_KEY=… (gpt-realtime is the only true speech-to-speech model in the API today)')
  const backend = detectBackend()
  if (!backend) throw new Error(missingAudioHint())

  const model = opts.model || process.env.TINY_VOICE_MODEL || DEFAULT_REALTIME_MODEL
  const voice = resolveVoice(opts.voice)
  // Default open: interruption is the model's own (interrupt_response), and a
  // muted mic is a VAD that never hears the person talking over it.
  const fullDuplex = resolveFullDuplex(opts.fullDuplex)
  const store = new CallStore({ model, voice, fullDuplex })

  const call = new RealtimeCall({
    apiKey, model, voice, backend, fullDuplex,
    context: opts.context,
    tools: opts.tools,
    executeTool: opts.executeTool,
    onEvent: (e) => {
      store.handle(e)
      if (e.type === 'turn') opts.onTurn?.(e.user, e.assistant, e.continuation)
    },
  })
  await call.start()
  return { store, call }
}
