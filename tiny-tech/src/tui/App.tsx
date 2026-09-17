/**
 * tiny TUI — Ink (React for terminals; the Claude Code / Gemini CLI stack).
 *
 * Clean agent surface:
 *   header    identity · model · mode
 *   transcript scrolling turn history (user / assistant / tool chips)
 *   panels    one per LIVE conversation — colour, tool chips, clock
 *   composer  bordered input, Esc = clear, double ^C = exit
 *
 * 🧵 CONCURRENT CONVERSATIONS — the composer never blocks. Every submit starts
 * its own turn on its own forked agent (TinyAgent.forkSession) and they all run
 * at once: ask a second question while the first is still thinking and it starts
 * immediately. The old `if (!q || busy) return` silently DROPPED that second
 * question while the placeholder claimed it was "queued after" — that specific
 * lie is what this replaces.
 *
 * All conversation state lives in conversations.ts as pure functions, so the
 * concurrency rules (queueing, cancel, completion order) are testable without a
 * TTY. This file owns only the effects a reducer can't: forking an agent,
 * consuming its stream, folding the finished exchange back into the session.
 *
 * /loop — autonomous mode (devduck ambient/auto style):
 *   toggle with `/loop` (or `/loop <task>` to set the goal + start)
 *   after every turn, once the user is idle for 3s, tiny keeps working
 *   on the last task by itself. Typing cancels the pending iteration.
 *   The agent stops the loop by including [LOOP_DONE] in a response.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Box, Text, Spacer, Static, useApp, useInput, usePaste, useStdout,
  useAnimation, useWindowSize, useIsScreenReaderEnabled,
} from 'ink'
import TextInput from 'ink-text-input'
import type { TinyAgent, TurnEvent } from '../agent/agent.js'
import type { MeshNode, MeshPeer } from '../mesh/zenoh.js'
import { setInteractionHandler, type InteractRequest, type InteractResult } from '../agent/interact.js'
import { setRenderHandler, type RenderComponent } from '../agent/render.js'
import { RenderBlock } from './components.js'
import { CallStore, VoiceCallStrip, useVoiceCall } from './voice-call.js'
import { renderMarkdown } from './markdown.js'
import { toolIcon } from './tool-icons.js'
import { panelBudget, tailRows, MENU_ROWS, type PanelBudget } from './layout.js'
import { LogoFrame } from './logo.js'
import { filterCommands, ghostFor, helpText, type SlashCommand } from './commands.js'
import { SlashMenu, SelectList } from './select.js'
import { LoopStrip, loopStripRows, useRunningLoops } from './loop-strip.js'
import { SpawnStrip, spawnStripRows, useSpawnBatches } from './spawn-strip.js'
import { Marquee, marqueeRowFor, useMarquee, marqueeHistoryItems } from './marquee.js'
import { appendHistory, loadInputHistory } from '../agent/history.js'
import {
  createState, submit as submitConv, applyEvent as applyConvEvent,
  complete as completeConv, cancel as cancelConvState, dropQueued, remove,
  isBusy, activeCount, queuedCount, newestRunning, running, find, elapsedMs, formatElapsed,
  type ConvState, type Conversation, type ConvColor, type ToolChip,
} from './conversations.js'

const LOOP_IDLE_MS = 3000
const LOOP_MAX_ITERATIONS = 100
const LOOP_DONE_SIGNALS = ['[LOOP_DONE]', '[AMBIENT_DONE]', '[TASK_COMPLETE]']
/**
 * How long a second Esc still counts as "yes, really" — the same window and the
 * same convention as the double ^C that quits (lastCtrlC below).
 */
const ESC_CONFIRM_MS = 2000

/**
 * Wipe the visible screen AND the scrollback, then home the cursor.
 *
 * Needed because <Static> output is already WRITTEN — dropping the items from
 * React state stops Ink re-rendering them, but the bytes are in the terminal's
 * buffer and no state change can take them back. 2J clears the screen, 3J the
 * scrollback (so ⌘K-style scrolling up doesn't resurrect the conversation the
 * user just asked to forget), H parks the cursor at the top for Ink's next frame.
 */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/**
 * Orientation, as chips rather than as sentences. Ink reflows them for the width
 * the terminal actually has (flexWrap below), which is the point: the two
 * hand-split lines these replace fit 100 columns and wrapped mid-phrase at 80,
 * where most terminals actually are.
 */
const HINTS = [
  'ask anytime — turns run in parallel',
  '^C stops the newest',
  'Esc clears',
  "double ^C or 'exit' quits",
  '/loop autonomous',
  '!cmd shell',
  '/help',
]

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The one spinner, on Ink's shared animation timer.
 *
 * useAnimation consolidates every caller onto a single internal interval, so six
 * live panels animate in phase off one clock instead of six independent
 * setIntervals drifting apart (which is what ink-spinner gave us, one timer per
 * instance).
 *
 * aria-hidden: ten braille frames a second is nothing to a screen reader, and
 * every row a spinner sits on already carries the words too — "thinking…",
 * "running bash…", "2 running".
 */
function Spinner({ color = 'yellow' }: { color?: string }) {
  const { frame } = useAnimation({ interval: 80 })
  return <Text color={color} aria-hidden>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
}

interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
  tools: ToolChip[]
  error?: string
  loop?: boolean          // auto-generated loop iteration
  shell?: boolean         // !cmd shell escape output
  mesh?: boolean          // 🕸 mesh activity notice (dim one-liner)
  render?: { components: RenderComponent[]; title?: string }  // use_render — generated Ink components
  color?: ConvColor       // the conversation's panel colour, kept in the transcript
  /**
   * `#3` — set only when this conversation shared the screen with another.
   * Answers land in completion order, so with concurrency "the question above"
   * stops being a reliable pairing and the id has to be said out loud.
   */
  tag?: string
  /** How long the turn ran, for the transcript. Undefined for local notices. */
  ms?: number
}

export interface AppProps {
  agent: TinyAgent
  who: string
  /** Live mesh node (already started, announcements silenced) — peer strip + /peers */
  mesh?: MeshNode
}

/** A queued use_interact question and the promise waiting on its answer. */
interface Pending { key: number; req: InteractRequest; resolve: (r: InteractResult) => void }

/**
 * Optional ceiling: TINY_MAX_CONCURRENT=3 makes a fourth submit QUEUE instead of
 * starting. Unset means no cap (conversations.ts MAX_CONCURRENT) — the machine
 * and the model API are the real limits. Either way, nothing is dropped.
 */
function envCap(): number | undefined {
  const raw = Number(process.env.TINY_MAX_CONCURRENT)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export default function App({ agent, who, mesh }: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<Turn[]>([])       // completed turns (Static)
  /**
   * Remount key for <Static>. Bumping it is how /clear actually forgets: Static
   * only ever prints items added since its last flush (it holds an internal
   * index), so shrinking `history` prints nothing and would swallow the notice
   * that says the session was cleared. A new key mounts a fresh Static — index
   * back to 0, header reprinted like a fresh boot — and Ink resets its
   * accumulated static output when the Static identity changes, so nothing that
   * was cleared can be replayed by a later full redraw (resize, fullscreen frame).
   */
  const [staticKey, setStaticKey] = useState(0)
  const [loopMode, setLoopMode] = useState(false)
  const [loopCountdown, setLoopCountdown] = useState(false) // idle timer armed
  const idRef = useRef(0)
  const lastCtrlC = useRef(0)
  // ↑/↓ input recall — seeded from ~/.tiny_history, session inputs appended
  const inputHistory = useRef<string[]>(loadInputHistory())
  const histIdx = useRef(-1)              // -1 = live input (not browsing)
  const draft = useRef('')                // stashed live input while browsing
  const [suggestion, setSuggestion] = useState('')
  /**
   * ⚡ The slash menu. `input` alone decides whether it is open (filterCommands
   * returns null unless the input is a bare command being typed), so the cursor
   * is the ONLY state — there is deliberately no "dismissed" flag: Esc clears the
   * half-typed command, which closes the menu by making it empty. A separate
   * dismissal would mean Esc had to be pressed twice to get back to a blank
   * composer, for the sake of keeping text nobody wants to keep.
   */
  const [menuCursor, setMenuCursor] = useState(0)
  // 💬 /marquee viewer — a modal SelectList over the blackboard's history.
  // Cursor-only state: the items are re-read when the command opens it, not
  // polled, because history is a thing you read, not a thing that jumps.
  const [mqView, setMqView] = useState<{ items: Array<{ key: string; label: string; detail: string }>; cursor: number } | null>(null)
  const lastEsc = useRef(0)
  /** The pending "Esc again to stop N running turns" hint, or ''. */
  const [escArmed, setEscArmed] = useState('')
  const loopTask = useRef<string | null>(null)               // goal the loop works on
  const loopIter = useRef(0)
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loopModeRef = useRef(false)

  loopModeRef.current = loopMode

  // ♾️ Background loops (use_loop), polled off disk — the picture-in-picture
  // strip. See loop-strip.tsx for why this is a poll and not a subscription.
  const runningLoops = useRunningLoops()
  // 🤖 spawn_agents batches — same disk-poll contract as the loops above:
  // the batch may run in another process, so ~/.tiny/spawns is the channel.
  const spawnBatches = useSpawnBatches()

  // 💬 The shared marquee blackboard, polled off disk for the same reason —
  // any process (a loop, a mesh peer, this agent via marquee_say) may write it.
  const marqueeEntries = useMarquee()

  const menuMatches = filterCommands(input)
  const menuOpen = !!menuMatches

  // 🎙️ /voice — a realtime call (agent/realtime.ts): one socket, audio tokens
  // in and audio tokens out, interruptible, tools called mid-sentence. The same
  // thing the iOS app does, and the only voice path there is — a turn-taking
  // listen→think→speak loop was tried here and deleted, because "speech to
  // speech" with a two-second gap between the speech and the speech is a
  // different, worse product wearing the same name.
  const callRef = useRef<import('../agent/realtime.js').RealtimeCall | null>(null)
  const [callStore, setCallStore] = useState<CallStore | null>(null)
  const callState = useVoiceCall(callStore)

  /**
   * Hang up. Returns how many mic frames were muted, or null if no call was live.
   *
   * MUST run on every way out of the TUI, not just /voice: the call owns a
   * `rec`/`ffmpeg` child process holding the microphone and a socket that is
   * metered from connect. Quit with a call up and the terminal is gone while the
   * mic light stays on.
   */
  const hangUp = useCallback((): number | null => {
    const call = callRef.current
    if (!call) return null
    callRef.current = null
    const gated = call.gatedFrames
    call.stop()
    return gated
  }, [])
  // Ink's exit() unmounts the tree, so this covers the paths that don't call
  // hangUp() themselves (a crash, an upstream unmount, ^C's double tap).
  useEffect(() => () => { hangUp() }, [hangUp])

  /**
   * 🧵 Conversation state lives in a ref and is MIRRORED into React state for
   * rendering. The reducer is pure, but its transitions carry effects the reducer
   * can't own — fork an agent, start a stream, absorb history — and those must
   * not run inside a setState updater, which React is free to call twice. So:
   * read the ref, compute the next state, publish it, then run the effects.
   */
  const stateRef = useRef<ConvState>(createState({ maxConcurrent: envCap() }))
  const [conv, setConv] = useState<ConvState>(stateRef.current)
  const publish = useCallback((next: ConvState) => { stateRef.current = next; setConv(next) }, [])

  /** The forked agent behind each live conversation — cancel and absorb need it. */
  const forks = useRef(new Map<number, TinyAgent>())

  /**
   * Every conversation that has EVER shared the screen with another. The `#id`
   * tag is what tells two interleaved answers apart in the transcript, so it has
   * to survive the race: the last of two concurrent turns to land is alone by
   * the time it lands, and judging by the count at that moment would strip the
   * tag from exactly the answer that most needs it.
   */
  const shared = useRef(new Set<number>())

  /**
   * 📐 The terminal's real size, and a re-render whenever it changes. Panel
   * budgets come out of `rows` and truncation out of `columns`, so a resize
   * reflows the live area instead of leaving it laid out for the width it had
   * when the process started.
   */
  const { columns, rows } = useWindowSize()

  /**
   * Ink 7 has a real screen-reader mode (INK_SCREEN_READER=true): it drops the
   * borders and the layout and reads the tree as text. What it can't do is know
   * which of our glyphs are decoration, so we say — see the aria-hidden marks
   * below.
   */
  const screenReader = useIsScreenReaderEnabled()

  const liveCount = conv.items.length
  /**
   * Panel clocks have to move while nothing is streaming, and subscribing to
   * useAnimation IS the subscription: it shares one internal timer with every
   * spinner already on screen, where the setInterval this replaces was a second
   * clock doing the same job. The returned frame is deliberately unused.
   *
   * Off under a screen reader, where the clocks are aria-hidden anyway — a
   * duration re-announced once a second is worse than no duration.
   */
  useAnimation({ interval: 1000, isActive: liveCount > 0 && !screenReader })

  /**
   * 🕸 Mesh presence, as React state instead of stderr lines. The node was
   * started with announce:false (raw writes through Ink's frame tear the
   * screen — the exact bug this replaces); here the same events update a
   * count by the composer, and answered peer commands get one dim transcript
   * line so remote work isn't invisible.
   */
  const [peerCount, setPeerCount] = useState(() => mesh?.listAllPeers().length ?? 0)
  useEffect(() => {
    if (!mesh) return
    const refresh = () => setPeerCount(mesh.listAllPeers().length)
    mesh.setHandlers({
      onPeerJoin: refresh,
      onPeerLeave: refresh,
      onPeerCommand: ({ from, command }) => {
        const q = command.length > 120 ? command.slice(0, 120) + '…' : command
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `🕸 ${from} asked: ${q}`, tools: [], mesh: true }])
        refresh()
      },
    })
    // Registry-only peers (other local processes) never fire join/leave here —
    // a slow poll keeps the count honest for them too.
    const t = setInterval(refresh, 10_000)
    return () => { clearInterval(t); mesh.setHandlers({ onPeerJoin: null, onPeerLeave: null, onPeerCommand: null }) }
  }, [mesh])

  // 💬 use_interact — the agent asks the human mid-turn. Registered per mount,
  // torn down on unmount.
  //
  // A QUEUE, not a slot: with concurrent conversations two turns can reach for
  // the terminal in the same moment, and a single slot would overwrite the first
  // question — leaving its promise unresolved and that entire turn hung until
  // the tool's timeout fired. One question shows at a time; the rest wait.
  const [interacts, setInteracts] = useState<Pending[]>([])
  useEffect(() => {
    setInteractionHandler((req) => new Promise<InteractResult>((resolve) => {
      setInteracts((q) => [...q, { key: ++idRef.current, req, resolve }])
    }))
    // 🎨 use_render — the structured spec becomes real Ink components
    // (components.tsx generates the element tree; no pre-painted ANSI).
    setRenderHandler((components, title) => {
      setHistory((h) => [...h, {
        id: ++idRef.current, role: 'assistant', text: '',
        tools: [], render: { components, title },
      }])
    })
    return () => { setInteractionHandler(null); setRenderHandler(null) }
  }, [])

  const finishInteract = useCallback((r: InteractResult) => {
    const head = interacts[0]
    if (!head) return
    head.resolve(r)
    setInteracts((q) => q.slice(1))
    // Echo the answer into the transcript so the exchange reads back.
    // "(cancelled)" for everything read as "you pressed Esc" even when the
    // question timed out after three minutes or was malformed and never
    // answerable. The result already carries the true sentence; prefer it.
    const shown = r.ok
      ? (head.req.type === 'password' ? '••••••' : Array.isArray(r.value) ? r.value.join(', ') : String(r.value))
      : r.error ? `(${r.error})`
      : '(cancelled)'
    setHistory((h) => [...h, { id: ++idRef.current, role: 'user', text: `${head.req.text} → ${shown}`, tools: [] }])
  }, [interacts])

  const clearLoopTimer = useCallback(() => {
    if (loopTimer.current) { clearTimeout(loopTimer.current); loopTimer.current = null }
    setLoopCountdown(false)
  }, [])

  /**
   * 📋 Paste, on its own channel.
   *
   * Ink 7 turns bracketed paste into a separate event, and with nothing
   * listening it replays the whole chunk — newlines and all — through useInput,
   * where ink-text-input writes the raw \n into a single-line value: the field
   * shows one mangled row, enter never submits it, and backspacing out is the
   * only escape. Pasting a path, a stack trace or an error is most of what
   * anyone does at a terminal agent, so it gets handled rather than approximated.
   *
   * Newlines collapse to spaces because the composer is one line and a
   * multi-line paste is one message — not a stack of questions to submit. The
   * question queue owns the keyboard when it's up, so paste follows it there
   * (InteractView has its own handler for the field being filled in).
   */
  usePaste((text) => {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (!flat) return
    histIdx.current = -1
    setInput((v) => (v && !/\s$/.test(v) ? `${v} ${flat}` : v + flat))
    setSuggestion('')
    if (loopModeRef.current) clearLoopTimer()
  }, { isActive: !interacts.length })

  const stopLoop = useCallback((note?: string) => {
    clearLoopTimer()
    setLoopMode(false)
    loopModeRef.current = false
    loopTask.current = null
    loopIter.current = 0
    if (note) {
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: note, tools: [] }])
    }
  }, [clearLoopTimer])

  /** Move a settled conversation into the <Static> transcript. */
  const pushExchange = useCallback((c: Conversation, concurrent: boolean, note?: string) => {
    const tag = concurrent ? `#${c.id}` : undefined
    const ms = elapsedMs(c)
    setHistory((h) => [...h,
      { id: ++idRef.current, role: 'user', text: c.query, tools: [], loop: c.loop, color: c.color, tag, ms },
      {
        id: ++idRef.current, role: 'assistant', color: c.color, tag, loop: c.loop,
        text: note ? (c.text ? `${c.text}\n${note}` : note) : c.text,
        tools: c.tools, error: c.error,
      },
    ])
  }, [])

  // ── Conversation machinery ────────────────────────────────────────────────
  // Plain closures, not useCallback: they read mutable refs rather than
  // render-time state, so a stale closure can't go wrong — and it lets finish
  // and start call each other without a ref indirection.

  const applyStreamEvent = (id: number, ev: TurnEvent) => {
    publish(applyConvEvent(stateRef.current, id, ev))
  }

  /** Did this conversation ever have company? Latches on, cleared when it lands. */
  const markShared = (): void => {
    if (activeCount(stateRef.current) < 2) return
    for (const c of running(stateRef.current)) shared.current.add(c.id)
  }

  /**
   * A conversation ended on its own. Returns whatever the drain freed up so the
   * caller starts it — fold-back and launch stay in one order.
   */
  const finishConversation = (id: number): Conversation[] => {
    const fork = forks.current.get(id)
    markShared()
    const concurrent = shared.current.delete(id)
    const { state, launch, finished } = completeConv(stateRef.current, id)
    // Already cancelled, or already gone: the late arrival of a stream we
    // stopped watching. Nothing to fold, nothing to print.
    if (!finished) { forks.current.delete(id); return launch }

    if (fork) {
      // A clean end folds the REAL exchange back — tool calls, results and all —
      // so the next conversation inherits what actually happened. A turn that
      // errored can end on a toolUse whose toolResult never came, and Bedrock
      // rejects the whole history the next time it's sent, so that one folds
      // back as plain text: worse context, valid conversation.
      //
      // `notice` is deliberately NOT consulted: a turn that overflowed, trimmed
      // and then answered is a turn that succeeded, and it folds back in full.
      if (finished.error) {
        agent.injectExchange(finished.query, summarize(finished.text, finished.error))
      } else if (agent.absorb(fork) === 0 && agent.lastAbsorbIssue) {
        // absorb() vetoed the seam (a dangling tool pair would invalidate the
        // whole session history). Same fallback, and say so rather than lose the
        // turn silently — that silence is what made the session go amnesic.
        agent.injectExchange(finished.query, summarize(finished.text, agent.lastAbsorbIssue))
      }
      forks.current.delete(id)
    }

    // The notice rides into the transcript as a footnote: the answer is real, but
    // "I dropped the oldest history to fit this in" is something the user has to
    // be told, or the next thing tiny forgets looks like a new bug.
    pushExchange(finished, concurrent, finished.notice ? `⚠ ${finished.notice}` : undefined)
    publish(remove(state, id))

    if (!finished.loop) appendHistory(finished.query, finished.text || finished.error)

    if (loopModeRef.current && finished.loop && LOOP_DONE_SIGNALS.some((s) => finished.text.includes(s))) {
      stopLoop(`↻ loop complete after ${loopIter.current} iteration${loopIter.current === 1 ? '' : 's'}`)
    }
    return launch
  }

  const startConversation = (c: Conversation): void => {
    // Its OWN history, seeded from the session's — forkSession() explains why a
    // shared message array can't work under strict toolUse/toolResult pairing.
    const fork = agent.forkSession()
    forks.current.set(c.id, fork)
    markShared()
    void (async () => {
      try {
        for await (const ev of fork.streamTurn(c.query)) applyStreamEvent(c.id, ev)
      } catch (e: any) {
        // streamTurn reports failures as events; this is the escape hatch for
        // one that throws instead, so a panel can't hang forever.
        applyStreamEvent(c.id, { kind: 'error', message: String(e?.message || e) })
      } finally {
        finishConversation(c.id).forEach(startConversation)
      }
    })()
  }

  /**
   * Stop one conversation. Its exchange is NOT absorbed: a turn cut mid-flight
   * can sit on a toolUse whose result never came, which poisons every later turn
   * that sends the history. A text-only summary goes in instead, so the session
   * still knows what was asked and how far it got.
   */
  const cancelConversation = (id: number): void => {
    const fork = forks.current.get(id)
    fork?.cancelTurn()
    markShared()
    const concurrent = shared.current.delete(id)
    const { state, launch, finished } = cancelConvState(stateRef.current, id)
    forks.current.delete(id)
    if (finished) {
      agent.injectExchange(finished.query, summarize(finished.text, 'the user cancelled this turn before it finished'))
      pushExchange(finished, concurrent, '⊘ cancelled')
      publish(remove(state, id))
    } else {
      publish(state)
    }
    launch.forEach(startConversation)
  }

  /** Accept a submit — starts now, or queues if a cap is set. Never dropped. */
  const openConversation = (query: string, loop = false): void => {
    const { state, launch } = submitConv(stateRef.current, { query, loop })
    publish(state)
    launch.forEach(startConversation)
  }

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      const now = Date.now()
      const doubleTap = now - lastCtrlC.current < 2000
      lastCtrlC.current = now
      if (doubleTap) { hangUp(); exit(); return }
      // One press means "stop": the loop stops arming AND the newest live turn
      // is really cancelled. A second press within 2s still exits.
      if (loopModeRef.current) stopLoop('↻ loop stopped (^C)')
      const target = newestRunning(stateRef.current)
      if (target) cancelConversation(target.id)
      return
    }
    // While a question is on screen it owns the keyboard: its Esc means "cancel
    // this question", and the composer must not read the same press as "drop the
    // queue" — two handlers acting on one key, one of them invisibly destructive.
    // ^C stays above this: stopping a turn has to work even mid-question.
    if (interacts.length) return
    // 💬 The /marquee viewer owns ↑/↓ and Esc while it is up — same contract
    // as the slash menu: navigation keys change hands, printable keys stay
    // with the composer, so typing simply continues the conversation.
    if (mqView) {
      if (key.escape || key.return) { setMqView(null); return }
      if (key.upArrow || key.downArrow) {
        setMqView((v) => {
          if (!v || !v.items.length) return v
          const n = v.items.length
          return { ...v, cursor: key.upArrow ? (v.cursor - 1 + n) % n : (v.cursor + 1) % n }
        })
        return
      }
    }
    /**
     * Esc closes or stops the INNERMOST thing, in this order:
     *   1. text in the composer      → clear it (which also closes the menu)
     *   2. turns queued behind a cap → drop them
     *   3. turns RUNNING             → cancel them all (needs a second Esc)
     *
     * ^C stays "stop the newest"; Esc at rest is "stop everything". Layer 4 asks
     * twice on purpose and it is the only layer that does: Esc is also the first
     * byte of every arrow-key and mouse escape sequence, and over ssh or a laggy
     * multiplexer a lone ESC does occasionally arrive orphaned. Layers 1–3 are
     * recoverable — a stray one costs a keystroke. Layer 4 throws away minutes of
     * a turn that cannot be resumed, so it borrows the double-tap window the exit
     * path already uses.
     */
    if (key.escape) {
      if (input) {
        setInput('')
        setSuggestion('')
        setMenuCursor(0)
        histIdx.current = -1
        if (loopModeRef.current) clearLoopTimer() // typing intent — hold the loop
        return
      }
      const { state, dropped } = dropQueued(stateRef.current)
      if (dropped) {
        publish(state)
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `⊘ dropped ${dropped} queued`, tools: [] }])
        return
      }
      const live = running(stateRef.current)
      if (live.length) {
        const now = Date.now()
        const confirmed = now - lastEsc.current < ESC_CONFIRM_MS
        lastEsc.current = now
        if (!confirmed) {
          setEscArmed(`Esc again to stop ${live.length} running turn${live.length === 1 ? '' : 's'}`)
          return
        }
        setEscArmed('')
        if (loopModeRef.current) stopLoop('↻ loop stopped (Esc)')
        for (const c of live) cancelConversation(c.id)
        return
      }
      histIdx.current = -1
      if (loopModeRef.current) clearLoopTimer()
      return
    }
    // Any other key disarms the pending "Esc again" — a confirmation that
    // survives you typing something else is a trap.
    if (escArmed) { setEscArmed(''); lastEsc.current = 0 }

    // ⚡ While the menu is up it owns ↑/↓ — the same keys mean "input history"
    // when it is closed. Nothing else changes hands: every printable key still
    // goes to the focused composer, which is what keeps filtering alive.
    if (menuOpen && (key.upArrow || key.downArrow)) {
      const n = menuMatches!.length
      if (!n) return
      setMenuCursor((c) => key.upArrow ? (c - 1 + n) % n : (c + 1) % n)
      return
    }
    // ↑/↓ — recall past inputs (shell-style). No longer gated on idle: the
    // composer is always open now, so its keys always work.
    if (key.upArrow) {
      const h = inputHistory.current
      if (!h.length) return
      if (histIdx.current === -1) { draft.current = input; histIdx.current = h.length }
      if (histIdx.current > 0) {
        histIdx.current -= 1
        setInput(h[histIdx.current])
        setSuggestion('')
      }
    }
    if (key.downArrow) {
      const h = inputHistory.current
      if (histIdx.current === -1) return
      histIdx.current += 1
      if (histIdx.current >= h.length) {
        histIdx.current = -1
        setInput(draft.current)
      } else {
        setInput(h[histIdx.current])
      }
      setSuggestion('')
    }
    // Tab — accept the highlighted command when the menu is up (the cursor may
    // have moved off the first match, and the ghost only ever shows that one),
    // otherwise the ghost suggestion.
    if (key.tab) {
      const pick = menuOpen ? menuMatches![Math.min(menuCursor, menuMatches!.length - 1)] : undefined
      if (pick) {
        setInput(pick.args ? `${pick.name} ` : pick.name)
        setSuggestion('')
        setMenuCursor(0)
        return
      }
      if (suggestion) {
        setInput(suggestion)
        setSuggestion('')
      }
    }
  })

  const submit = useCallback(async (value: string) => {
    /**
     * ⚡ Enter with the menu up runs the HIGHLIGHTED row, not the literal text —
     * otherwise arrowing down to /peers and pressing Enter would send whatever
     * half-typed word the filter was built from to the model.
     *
     * Two rules, and the second one matters more than it looks:
     *  · a row picked off the LIST that takes an argument completes into the
     *    composer instead of running — nobody who just arrowed onto `/say` meant
     *    to send an empty line into a call;
     *  · but a command TYPED OUT IN FULL always runs, argument or not. Bare
     *    `/cancel` (stop the newest), bare `/loop` (toggle) and bare `/say`
     *    (which explains itself) are all real, documented commands, and having
     *    the menu silently re-type what the user had already finished typing is
     *    the kind of help that makes a UI feel like it is arguing.
     */
    const picked = filterCommands(value)
    if (picked && picked.length) {
      const pick = picked[Math.min(menuCursor, picked.length - 1)]
      setMenuCursor(0)
      if (pick.name !== value.trim()) {
        if (pick.args) {
          setInput(`${pick.name} `)
          setSuggestion('')
          return
        }
        value = pick.name
      }
    }
    const q = value.trim()
    if (!q) return
    setInput('')
    setSuggestion('')
    histIdx.current = -1
    if (inputHistory.current[inputHistory.current.length - 1] !== q) inputHistory.current.push(q)
    clearLoopTimer()

    if (['exit', 'quit', 'q'].includes(q.toLowerCase())) { hangUp(); exit(); return }

    // !cmd — shell escape: run locally, show output, inject exchange into
    // agent history so the agent has the context on subsequent turns.
    if (q.startsWith('!') && q.length > 1) {
      const cmd = q.slice(1).trim()
      setHistory((h) => [...h, { id: ++idRef.current, role: 'user', text: q, tools: [] }])
      let out = ''
      let failed = false
      try {
        // exec, not execSync: a synchronous shell blocks the event loop, which
        // now means freezing every conversation streaming beside it.
        const { promisify } = await import('node:util')
        const { exec } = await import('node:child_process')
        const r = await promisify(exec)(cmd, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
        out = String(r.stdout || '') + String(r.stderr || '')
      } catch (e: any) {
        failed = true
        out = String(e?.stdout || '') + String(e?.stderr || e?.message || e)
      }
      const shown = out.length > 8000 ? out.slice(0, 8000) + `\n… (${out.length - 8000} more chars truncated)` : out
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: shown || '(no output)', tools: [], shell: true, error: failed ? 'command failed' : undefined }])
      // Inject into agent conversation so it sees what happened
      agent.injectExchange(
        `I ran this shell command myself: \`${cmd}\``,
        'Command ' + (failed ? 'FAILED' : 'succeeded') + '. Output:\n```\n' + (shown || '(no output)') + '\n```',
      )
      return
    }

    // /clear — start over: forget the conversation AND wipe the screen.
    //
    // Both halves are the point. Clearing only the transcript leaves the model
    // remembering everything (so the next answer refers to things no longer on
    // screen); clearing only the model's history leaves the screen claiming a
    // context that is gone. Until this existed, `/clear` had no handler at all,
    // so it went to the model as a QUESTION — and the model answered "context
    // cleared on my side", which was simply false. That specific lie is what
    // this replaces.
    //
    // Live turns are NOT killed: their own history was forked before the clear,
    // so they finish with the context they started with and their answers land
    // in the fresh transcript. Said out loud rather than hidden — /cancel all
    // first if that's not what you want.
    if (q === '/clear' || q === '/reset') {
      const live = running(stateRef.current).filter((c) => c.kind === 'turn')
      const queued = queuedCount(stateRef.current)
      const dropped = agent.clearHistory?.() ?? 0
      shared.current.clear()
      // Wipe first, then re-seed the transcript: Static renders only what has
      // been added SINCE its last flush, so an empty items array prints nothing
      // and the notice below becomes the first line of the new session.
      try { stdout?.write(CLEAR_SCREEN) } catch { /* not a TTY — state clear is enough */ }
      setStaticKey((k) => k + 1)
      const notes = [
        dropped > 0 ? `forgot ${dropped} message${dropped === 1 ? '' : 's'}`
          : agent.isLocal ? 'history was already empty' : 'history lives server-side — nothing local to forget',
      ]
      if (live.length) notes.push(`${live.map((c) => `#${c.id}`).join(' ')} still running with the OLD context — answers will land below`)
      if (queued) notes.push(`${queued} queued turn${queued === 1 ? '' : 's'} kept`)
      if (loopModeRef.current) notes.push('loop still ON (/loop stops it)')
      setHistory([{ id: ++idRef.current, role: 'assistant', tools: [], text: `🧼 cleared — ${notes.join(' · ')}` }])
      return
    }

    // /cancel [#id | all] — ^C can only ever reach the NEWEST turn, which is the
    // wrong one as soon as the slow turn you actually want to kill is #2 of five.
    // The panels already show their ids; this is how you use them.
    if (q === '/cancel' || q.startsWith('/cancel ')) {
      const arg = q.slice(7).trim().replace(/^#/, '').toLowerCase()
      const live = running(stateRef.current).filter((c) => c.kind === 'turn')
      if (!live.length) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: '⊘ nothing is running', tools: [] }])
        return
      }
      if (arg === 'all') {
        // Snapshot first: cancelConversation mutates the live list as it goes.
        for (const c of [...live]) cancelConversation(c.id)
        return
      }
      if (!arg) { cancelConversation(live[live.length - 1].id); return }
      const id = Number(arg)
      const target = Number.isFinite(id) ? find(stateRef.current, id) : undefined
      if (!target || target.status !== 'running') {
        setHistory((h) => [...h, {
          id: ++idRef.current, role: 'assistant', tools: [],
          text: `⊘ no running conversation #${arg} — live: ${live.map((c) => `#${c.id}`).join(' ')}`,
        }])
        return
      }
      cancelConversation(target.id)
      return
    }

    // /say <text> — type INTO the live call. In a terminal this matters more
    // than on a phone: a stack trace or a path is something you paste, never
    // something you read aloud. It does not hijack the composer — a bare submit
    // is still a normal concurrent turn, which is this TUI's whole point.
    if (q.startsWith('/say ') || q === '/say') {
      const text = q.slice(4).trim()
      if (callRef.current) {
        const sent = text && callRef.current.sendUserText(text)
        setHistory((h) => [...h, {
          id: ++idRef.current, role: 'assistant', tools: [],
          text: sent ? `🎙️ said: ${text}` : '🎙️ /say <text> — nothing to say',
        }])
        return
      }
      // No call → the marquee. Same core marquee_say uses, so the entry gets
      // an id, a seed and this host's author — every terminal replays it.
      if (!text) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: '💬 /say <text> — writes on the shared marquee' }])
        return
      }
      try {
        const { appendMarquee } = await import('../agent/marquee.js')
        const e = appendMarquee({ text })
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `💬 on the marquee as ${e.author} — id ${e.id}` }])
      } catch (e: any) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `💬 could not write marquee: ${String(e?.message || e)}`, error: 'write failed' }])
      }
      return
    }

    // /marquee — the blackboard's history, read straight off disk like /loops:
    // a modal SelectList (newest first), ↑/↓ scrolls, Esc closes. /marquee
    // again while it is up closes it — every toggle in this UI works that way.
    if (q === '/marquee') {
      if (mqView) { setMqView(null); return }
      try {
        const { readMarquee } = await import('../agent/marquee.js')
        const items = marqueeHistoryItems(readMarquee())
        if (!items.length) {
          setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: '💬 the blackboard is empty — /say <text> writes the first line' }])
          return
        }
        setMqView({ items, cursor: 0 })
      } catch (e: any) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `💬 could not read marquee: ${String(e?.message || e)}`, error: 'read failed' }])
      }
      return
    }

    // /voice — a REALTIME call: one socket, audio in and audio out, interruptible,
    // tools mid-sentence, and every exchange folded into this session's history so
    // hanging up doesn't erase what was said.
    if ((q === '/voice' || q.startsWith('/voice ')) && !callRef.current) {
      const tools: any[] = agent.mountedTools
      let store: CallStore
      try {
        const opened = await (await import('./voice-call.js')).openCall({
          tools,
          // The mic stays open by default so the model's own VAD can interrupt
          // itself when you talk over it. `/voice --half-duplex` mutes it while
          // the tiny is audible — only worth it if your speaker feeds your mic.
          fullDuplex: /\s--half-duplex\b/.test(q) ? false : undefined,
          // Executed by the agent, so a spoken "check the build" runs in the
          // SAME shell session the typed conversation uses.
          executeTool: (name, args) => agent.invokeTool(name, args),
          context: `The user is at a terminal in ${process.cwd()} on ${process.platform}. They can also type at you — treat typed text as spoken.`,
          // The call's transcript IS the session's transcript: on screen, and in
          // the agent's own messages, so the next TYPED question knows about it.
          onTurn: (user, assistant, continuation) => {
            if (!continuation) setHistory((h) => [...h, { id: ++idRef.current, role: 'user', text: `🎙️ ${user}`, tools: [] }])
            setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: assistant || '(answered by voice)', tools: [] }])
            agent.injectExchange(continuation ? '(voice call — continued speaking)' : `(spoken aloud) ${user}`, assistant || '(answered by voice)')
          },
        })
        store = opened.store
        callRef.current = opened.call
      } catch (e: any) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `🎙️ ${String(e?.message || e)}`, tools: [] }])
        return
      }
      setCallStore(store)
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: '🎙️ call live — just talk. /say <text> to type into it · /voice to hang up', tools: [] }])
      return
    }
    if ((q === '/voice' || q.startsWith('/voice ')) && callRef.current) {
      const gated = hangUp() ?? 0
      callStore?.flush()
      callStore?.dispose()
      setCallStore(null)
      setHistory((h) => [...h, {
        id: ++idRef.current, role: 'assistant', tools: [],
        // An honest end-of-call line: half duplex mutes the mic while the tiny
        // is audible, and someone who talked over it deserves to know why.
        text: `🎙️ call ended${gated > 0 ? ` — muted the mic for ${gated} frames while speaking (/voice --interrupt on headphones)` : ''}`,
      }])
      return
    }

    // /model — runtime model swap, answered here (a model turn about changing
    // the model would be paid for by the OLD model). Bare /model reads the
    // config off the real constructed model object; a spec swaps via the same
    // factory the launch path used, and any failure keeps the old model.
    if (q === '/model' || q.startsWith('/model ')) {
      const arg = q.slice(6).trim()
      if (!arg) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `🧠 ${agent.modelInfo()} — /model provider:model_id[:max_tokens] swaps it` }])
        return
      }
      try {
        const line = await agent.swapModel(arg)
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `🧠 ${line}` }])
      } catch (e: any) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', tools: [], text: `🧠 ${String(e?.message || e)}`, error: 'model swap failed' }])
      }
      return
    }

    // /peers — the fleet, read straight off the mesh node: id, host, model,
    // tools, age. No model turn — same reason /loops reads the disk.
    if (q === '/peers') {
      const peers = mesh?.listAllPeers() ?? []
      const text = !mesh ? '🕸 mesh is off (--no-mesh / TINY_MESH=false)'
        : !peers.length ? `🕸 ${mesh.instanceId} — no peers discovered yet`
        : [`🕸 ${mesh.instanceId} — ${peers.length} peer${peers.length === 1 ? '' : 's'}:`,
           ...peers.map((p) => {
             const age = Math.max(0, Math.round((Date.now() - p.lastSeen) / 1000))
             const bits = [p.hostname, p.model, p.toolCount ? `${p.toolCount} tools` : '', p.source === 'registry' ? 'local' : ''].filter(Boolean).join(' · ')
             return `  ${p.instanceId}  ${bits}  (${age}s ago)`
           })].join('\n')
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text, tools: [], mesh: true }])
      return
    }

    // /help — answered HERE, instantly. It was in the autocomplete list but had
    // no handler, so the one command promising orientation cost a model turn
    // and came back as whatever the model guessed the UI could do.
    if (q === '/help') {
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: helpText(), tools: [] }])
      return
    }

    // /loops — read the records straight off disk, no model turn: a status
    // question answered by an agent costs seconds and a context slot; the same
    // words read from ~/.tiny/loops cost neither.
    //
    // /tasks is kept as an alias, not dropped: it was the documented name for
    // background work until use_loop replaced it, and a retired command that
    // silently becomes a question to the model is worse than one that answers.
    if (q === '/loops' || q === '/tasks') {
      try {
        const mod = await import('../agent/loop.js')
        const text = (mod as any).summarizeLoops((mod as any).listLoops())
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text, tools: [] }])
      } catch (e: any) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `could not read loops: ${String(e?.message || e)}`, tools: [], error: 'read failed' }])
      }
      return
    }

    // /loop — toggle autonomous mode; optional inline task: /loop refactor the parser
    if (q === '/loop' || q.startsWith('/loop ')) {
      const arg = q.slice(5).trim()
      if (loopMode && !arg) { stopLoop('↻ loop stopped'); return }
      const task = arg || loopTask.current || lastUserTask(stateRef.current, history)
      if (!task) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: '↻ nothing to loop on — give me a task first (`/loop <task>` or ask something, then `/loop`)', tools: [] }])
        return
      }
      loopTask.current = task
      loopIter.current = 0
      setLoopMode(true)
      loopModeRef.current = true
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `↻ loop ON — working on: "${task.slice(0, 120)}"\n  fires ${LOOP_IDLE_MS / 1000}s after you stop typing · \`/loop\` again or ^C to stop · agent says [LOOP_DONE] when finished`, tools: [] }])
      return
    }

    loopTask.current = q // any new query becomes the loop's task
    openConversation(q)
  }, [history, loopMode, clearLoopTimer, stopLoop, exit, agent, menuCursor, mqView])

  // Typing resets the idle timer — loop only fires after 3s of silence.
  const onInputChange = useCallback((v: string) => {
    setInput(v)
    histIdx.current = -1
    if (loopModeRef.current) clearLoopTimer()
    // Typing anything un-dismisses the menu and re-homes its cursor: the list
    // it was pointing into is a different list now.
    setMenuCursor(0)
    // autocomplete: slash commands first, then history prefix match
    if (v.length >= 1) {
      const slash = ghostFor(v)
      if (slash) { setSuggestion(slash); return }
      if (v.length >= 2) {
        const h = inputHistory.current
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i].startsWith(v) && h[i] !== v) { setSuggestion(h[i]); return }
        }
      }
    }
    setSuggestion('')
  }, [clearLoopTimer])

  const busy = isBusy(conv)

  // Arm the loop timer whenever: loop on, nothing streaming, input empty.
  // Iterations stay strictly SERIAL even though the UI is concurrent — a loop is
  // one train of thought continuing, and N autonomous turns racing on the same
  // task would undo each other's work.
  useEffect(() => {
    if (!loopMode || busy || input.length > 0 || !loopTask.current) return
    if (loopIter.current >= LOOP_MAX_ITERATIONS) {
      stopLoop(`↻ loop hit max iterations (${LOOP_MAX_ITERATIONS})`)
      return
    }
    setLoopCountdown(true)
    loopTimer.current = setTimeout(() => {
      loopTimer.current = null
      setLoopCountdown(false)
      if (!loopModeRef.current || isBusy(stateRef.current)) return
      loopIter.current += 1
      const prompt =
        `You're in autonomous /loop mode (iteration ${loopIter.current}). ` +
        `Keep making concrete progress on: "${loopTask.current}". ` +
        `Take the next step now. When the task is truly complete, end your response with [LOOP_DONE] on a line of its own.`
      openConversation(prompt, true)
    }, LOOP_IDLE_MS)
    return () => { if (loopTimer.current) { clearTimeout(loopTimer.current); loopTimer.current = null } }
  }, [loopMode, busy, input, stopLoop])

  const loopRows = loopStripRows(runningLoops, Date.now(), columns)
  const spawnRows = spawnStripRows(spawnBatches, Date.now())
  const live = conv.items
  const bare = live.length === 1        // one turn owns the frame — no border
  const active = activeCount(conv)
  const waiting = queuedCount(conv)
  const question = interacts[0]

  /**
   * 🌈 The header is DEFERRED. <Static> writes its items exactly once, so a
   * header flushed there at mount can never animate. Instead: while the
   * session is empty the header renders in the LIVE region — logo cycling on
   * the shared animation clock — and only once the first turn is about to
   * join the transcript does the frozen copy flush into Static (one item
   * ahead of the turn, same flush). One header on screen at all times;
   * animated exactly while it's the only thing to look at. (/clear seeds the
   * new session with its notice, so the reprinted header is the frozen one —
   * the animation belongs to an EMPTY session, and that one isn't.)
   */
  const headerLive = history.length === 0 && live.length === 0
  const { frame: heroFrame } = useAnimation({ interval: 90, isActive: headerLive && !screenReader })

  /**
   * What each live panel may spend, given everything else claiming rows right
   * now. The composer is the one element that must always be reachable, so the
   * chrome is subtracted first and the panels divide what's left.
   */
  const budget = panelBudget({
    rows,
    panels: live.length,
    question: !!question,
    call: !!callStore,
    status: active > 1 || waiting > 0,
    loop: !busy && loopMode,
    loops: loopRows.length,
    spawns: spawnRows.length,
    menu: menuOpen,
    marquee: !!marqueeRowFor(marqueeEntries),
    marqueeView: !!mqView,
    meshFooter: peerCount > 0,
  })

  /** The one header — frozen into Static once conversation starts. */
  const header = (frame: number) => (
    <Box key="header" flexDirection="column" marginBottom={1}>
      <LogoFrame frame={frame} />
      <Box marginTop={1}>
        <Text dimColor>{who} · {agent.modelLabel}{agent.isLocal ? '' : ' (server proxy)'}</Text>
      </Box>
      {/* The user's own tools. A file that failed to load is theirs to
          fix, and the TUI is the default surface — without this line the
          only symptom is a tool that quietly isn't there. */}
      {agent.localTools && agent.localTools.loaded.length > 0 && (
        <Text dimColor>  🔧 {agent.localTools.loaded.map((t) => t.name).join(' ')}</Text>
      )}
      {agent.localTools?.skipped.map((s) => (
        <Text key={s.file} color="yellow">  ⚠️  {s.file}: {s.reason}</Text>
      ))}
      {/* One row on a wide terminal, two or three on a narrow one:
          flexWrap moves whole hints down instead of breaking one in
          half. Each chip refuses to shrink, or Ink would squeeze the
          words to fit the row rather than reflow them. */}
      <Box flexWrap="wrap" columnGap={2} paddingLeft={2}>
        {HINTS.map((h) => (
          <Box key={h} flexShrink={0}><Text dimColor>{h}</Text></Box>
        ))}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column">
      {/* Completed turns — Static renders once, scrolls naturally. The header
          joins the items only when the session stops being empty: Static
          flushes it (frame 0, frozen) in the same pass as the first turn. */}
      <Static key={staticKey} items={headerLive ? [] : [{ id: -1 } as any, ...history]}>
        {(item: any) =>
          item.id === -1 ? header(0) : <TurnView key={item.id} turn={item} />
        }
      </Static>

      {/* 🌈 The live header — same markup, animating on the shared clock,
          shown while the transcript is empty. Unmounts the moment the first
          conversation starts; its frozen twin lands in Static in that same
          render pass, so exactly one header is ever on screen. */}
      {headerLive && header(heroFrame)}

      {/* 🧵 Live conversations — one panel each, all streaming at once */}
      {live.map((c) => (
        <ConvPanel key={c.id} conv={c} bare={bare} budget={budget} columns={columns} />
      ))}

      {/* 💬 Inline interaction — agent question awaiting the human */}
      {question && (
        <InteractView key={question.key} req={question.req} waiting={interacts.length - 1} onDone={finishInteract} />
      )}

      {/* 🎙️ Realtime call — a fixed-height strip (voice-call.tsx): phase, mic
          meter, live transcript, tools. Fixed height because it sits above the
          composer and a box that grows mid-word drags the cursor with it. */}
      {callStore && <VoiceCallStrip state={callState} />}

      {/* ♾️ Background loops — picture-in-picture, the call strip's shape. Sits
          below the call so a live call stays closest to the composer. */}
      <LoopStrip rows={loopRows} />

      {/* 🤖 spawn_agents batches — one row each, the loop strip's linger and
          vocabulary. Below the loops: a batch is a single concurrent pass,
          subordinate to the long-running work above it. */}
      <SpawnStrip rows={spawnRows} />

      {/* 💬 Marquee — the blackboard's newest line, one row, typewriter reveal.
          Below the loop strip: loops are this machine's own work, the marquee
          is the room talking. */}
      <Marquee entries={marqueeEntries} />

      {/* Status line — every panel carries its own spinner, so this is the
          summary: what's in flight, and what's waiting behind a cap. */}
      {(active > 1 || waiting > 0) && (
        <Box marginTop={0}>
          <Spinner />
          <Text dimColor> {active} running{waiting ? ` · ${waiting} queued` : ''}</Text>
          {loopMode && (
            <>
              <Spacer />
              <Text color="magenta">↻ loop #{loopIter.current}</Text>
            </>
          )}
        </Box>
      )}
      {!busy && loopMode && (
        <Box marginTop={0}>
          <Text color="magenta">↻ </Text>
          <Text dimColor>
            {loopCountdown ? `loop armed — continuing in ${LOOP_IDLE_MS / 1000}s unless you type…` : 'loop on — waiting for idle'}
            {` (iter ${loopIter.current})`}
          </Text>
        </Box>
      )}

      {/* ⚡ Slash menu — directly above the composer it filters, and the same
          control as the voice picker (select.tsx). */}
      {menuOpen && <Box marginTop={1}><SlashMenu matches={menuMatches!} cursor={menuCursor} maxRows={MENU_ROWS} /></Box>}

      {/* 💬 /marquee — the blackboard's history in the shared list control.
          Modal in keys only (↑/↓, Esc); printable keys still reach the
          composer, so reading history never blocks saying something. */}
      {mqView && (
        <SelectList
          title="💬 marquee — newest first"
          items={mqView.items}
          cursor={mqView.cursor}
          maxRows={8}
          border
          hint="↑/↓ scroll · esc or /marquee closes"
        />
      )}

      {/* Composer — open whether or not anything is streaming */}
      <Box borderStyle="round" borderColor={escArmed ? 'red' : loopMode ? 'magenta' : busy ? 'cyan' : 'green'} paddingX={1} marginTop={1}
        aria-role="textbox" aria-state={{ disabled: !!question, busy }}>
        <Text color={loopMode ? 'magenta' : 'green'}>{loopMode ? '↻ ' : '> '}</Text>
        <TextInput
          value={input}
          onChange={onInputChange}
          onSubmit={submit}
          placeholder={
            active
              ? `${active} running — ask another, it starts now`
              : loopMode ? 'type to interrupt loop · /loop to stop' : 'ask tiny anything · /loop = autonomous'
          }
          focus={!question}
        />
        {suggestion && input && suggestion.startsWith(input) ? (
          <Text dimColor>{suggestion.slice(input.length)} ⇥</Text>
        ) : null}
      </Box>
      {escArmed ? <Box paddingX={1}><Text color="red">⚠ {escArmed}</Text></Box> : null}
      {/* One quiet footer row: the fleet at a glance. It replaces the stderr
          join/leave lines — the count moving IS the announcement. */}
      {peerCount > 0 && (
        <Box paddingX={1}>
          <Text dimColor aria-hidden>🕸 </Text>
          <Text dimColor>{peerCount} peer{peerCount === 1 ? '' : 's'} on mesh · /peers</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * What a turn that didn't finish cleanly contributes to session history.
 * Text-only by design — see finishConversation / cancelConversation.
 */
function summarize(text: string, why: string): string {
  const partial = text.trim()
  return partial ? `${partial.slice(0, 4000)}\n\n[${why}]` : `[${why} — no output]`
}

/**
 * Most recent real user query, for `/loop` with no explicit task. Live
 * conversations come first: the newest thing asked may still be streaming, and
 * that is exactly what "loop on this" should mean.
 */
function lastUserTask(state: ConvState, history: Turn[]): string | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const c = state.items[i]
    if (!c.loop && !c.query.startsWith('/')) return c.query
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t.role === 'user' && !t.loop && !t.text.startsWith('/')) return t.text
  }
  return null
}

/**
 * Tool chips: the glyph says what KIND of work it is, `detail` says what the
 * work actually IS — the command, the path, the URL. Without the detail three
 * concurrent panels all read `⚙ ⌘ bash` and the screen stops being informative
 * at exactly the moment there's the most to tell apart.
 *
 * `limit` keeps a tool-heavy panel from growing past the composer; the older
 * chips are summarised as a count rather than silently vanishing.
 *
 * ONE ROW PER CHIP, always. The status glyph and the tool name are fixed and
 * refuse to shrink; everything variable shares the rest of the row and truncates
 * at whatever width there turns out to be. Cutting the detail to a constant
 * number of characters instead — the `.slice(0, 80)` this replaces — is a bet on
 * the terminal's width that is wrong in both directions: it wrapped a chip onto
 * a second row at 60 columns (which breaks the panel's border) and threw away
 * room it had at 200.
 */
function ToolChips({ tools, limit }: { tools: ToolChip[]; limit?: number }) {
  if (!tools.length) return null
  const hidden = limit && tools.length > limit ? tools.length - limit : 0
  const shown = hidden ? tools.slice(-limit!) : tools
  return (
    <Box flexDirection="column">
      {hidden > 0 && <Text dimColor>  ⋯ {hidden} earlier tool call{hidden === 1 ? '' : 's'}</Text>}
      {shown.map((t, i) => (
        <Box key={i} columnGap={1}>
          <Box flexShrink={0}>
            <Text color={t.error ? 'red' : t.done ? 'green' : 'yellow'}>
              {t.error ? '✗' : t.done ? '✓' : '⚙'}
            </Text>
            <Text dimColor aria-hidden>{` ${toolIcon(t.name)}`}</Text>
            <Text dimColor>{` ${t.name}`}</Text>
          </Box>
          {t.detail || t.error ? (
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                {t.detail}
                {t.error ? <Text color="red">{`${t.detail ? ' ' : ''}— ${t.error}`}</Text> : null}
              </Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}

/**
 * 🧵 One live conversation.
 *
 * `bare` — the single-turn case renders exactly like the old one-at-a-time UI
 * (no border, no id): a box drawn around the only thing on screen is pure noise.
 * The moment a second conversation exists both get framed, because then the
 * colour and the `#id` are the only way to tell whose output is whose.
 *
 * Nothing here is measured in characters. The query, the tool details and the
 * streaming text all take whatever room `budget` and `columns` say they have —
 * Ink truncates the rows and layout.ts bounds the height — so the panel fits an
 * 60-column laptop split and a 200-column monitor without a second code path.
 */
function ConvPanel({ conv, bare, budget, columns }: {
  conv: Conversation
  bare: boolean
  budget: PanelBudget
  columns: number
}) {
  const busyTool = [...conv.tools].reverse().find((t) => !t.done)
  const clock = formatElapsed(elapsedMs(conv))
  const phase = busyTool
    ? `running ${busyTool.name}${busyTool.detail ? ` ${busyTool.detail}` : ''}…`
    : 'thinking…'
  // A framed panel spends two columns on its border and two on its padding, so
  // its text wraps four columns earlier than the terminal is wide.
  const inner = Math.max(20, columns - (bare ? 0 : 4))
  const text = conv.text ? renderMarkdown(tailRows(conv.text, budget.text, inner), { streaming: true }) : ''

  if (conv.status === 'queued') {
    return (
      <Box marginTop={1}>
        <Box flexShrink={0}>
          <Text color={conv.color}>⋯ </Text>
          <Text dimColor>#{conv.id} queued — </Text>
        </Box>
        <Box flexGrow={1}><Text dimColor wrap="truncate-end">{conv.query}</Text></Box>
      </Box>
    )
  }

  if (bare) {
    return (
      <Box flexDirection="column" marginTop={1} aria-state={{ busy: true }}>
        {/* Echo the question. The composer cleared on submit and the settled
            ❯ line only lands in <Static> when the turn ENDS — without this row
            the user's own words are nowhere on screen for the whole stream,
            which reads as "my message was eaten". Same glyph and color as the
            settled TurnView row, so the live line becomes the transcript line
            without appearing to move. */}
        <Box>
          <Box flexShrink={0}><Text color={conv.color || 'cyan'} bold>{'❯ '}</Text></Box>
          <Text color={conv.color || 'cyan'}>{conv.query}</Text>
        </Box>
        <ToolChips tools={conv.tools} limit={budget.chips} />
        {text ? <Text>{text}</Text> : null}
        {conv.notice ? <Text color="yellow">⚠ {conv.notice}</Text> : null}
        {conv.error ? <Text color="red">error: {conv.error}</Text> : null}
        <Box>
          <Spinner />
          <Box flexGrow={1} paddingLeft={1}><Text dimColor wrap="truncate-end">{phase}</Text></Box>
          {/* aria-hidden: a duration re-announced every second is unusable,
              and the phase word next to it already says the turn is alive. */}
          <Text dimColor aria-hidden>{clock}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={conv.color} paddingX={1} marginTop={1}
      aria-state={{ busy: true }}>
      {/* #id and spinner are fixed, the clock sits on the right edge, and the
          query takes everything between them — so panels stacked on top of each
          other have their clocks in a column instead of wherever each query
          happened to end. */}
      <Box>
        <Box flexShrink={0}>
          <Text color={conv.color} bold>#{conv.id} </Text>
          <Spinner />
        </Box>
        <Box flexGrow={1} paddingLeft={1}><Text dimColor wrap="truncate-end">{conv.query}</Text></Box>
        <Text dimColor aria-hidden>{clock}</Text>
      </Box>
      <ToolChips tools={conv.tools} limit={budget.chips} />
      {text ? <Text>{text}</Text> : null}
      {conv.notice ? <Text color="yellow">⚠ {conv.notice}</Text> : null}
      {conv.error ? <Text color="red">error: {conv.error}</Text> : null}
    </Box>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    if (turn.loop) {
      return (
        <Box marginTop={1}>
          <Text color="magenta" bold>{'↻ '}</Text>
          <Text dimColor>loop iteration continues…</Text>
        </Box>
      )
    }
    return (
      <Box marginTop={1}>
        <Box flexShrink={0}>
          <Text color={turn.color || 'cyan'} bold>{'❯ '}</Text>
          {turn.tag ? <Text dimColor>{turn.tag} </Text> : null}
        </Box>
        <Text color={turn.color || 'cyan'}>{turn.text}</Text>
        {/* Only worth saying once it's a wait the user felt — sub-2s is noise.
            Pushed to the right edge so a screenful of them reads as a column of
            durations rather than one trailing each question wherever it ended. */}
        {turn.ms && turn.ms >= 2000 ? (
          <>
            <Spacer />
            <Text dimColor>{formatElapsed(turn.ms)}</Text>
          </>
        ) : null}
      </Box>
    )
  }
  if (turn.render) {
    return <RenderBlock components={turn.render.components} title={turn.render.title} />
  }
  if (turn.mesh) {
    // Mesh activity is context, not conversation — one dim line, no blank
    // margin, so a chatty fleet reads as a quiet log rather than as answers.
    return <Text dimColor>{turn.text}</Text>
  }
  if (turn.shell) {
    // A left rule instead of an indent: command output is the one thing in the
    // transcript nobody said, and a gutter marks the whole block at a glance
    // however many lines it runs to. Ink draws one edge of a border as happily
    // as four, so this costs a prop rather than a hand-drawn column of bars.
    return (
      <Box flexDirection="column" marginLeft={1} paddingLeft={1}
        borderStyle="round" borderDimColor
        borderTop={false} borderRight={false} borderBottom={false}>
        <Text dimColor>{turn.text}</Text>
        {turn.error ? <Text color="red">✗ {turn.error}</Text> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <ToolChips tools={turn.tools} />
      {turn.text ? <Text>{renderMarkdown(turn.text)}</Text> : null}
      {turn.error && !turn.text ? <Text color="red">error: {turn.error}</Text> : null}
    </Box>
  )
}


/**
 * 💬 Inline interactive prompt — the Ink face of use_interact.
 * Arrow keys move, space toggles (multiselect), enter confirms, esc cancels.
 * Text/password/form build their buffer from raw keypresses so Ink keeps
 * owning stdin (no raw-mode fights with the composer, which is unfocused).
 *
 * Mounted with a key per question, so answering one and moving to the next
 * starts from a clean cursor and buffer instead of the previous question's.
 */
function InteractView({ req, waiting, onDone }: { req: InteractRequest; waiting: number; onDone: (r: InteractResult) => void }) {
  const opts = req.options || []
  const fields = req.fields || []
  const [cursor, setCursor] = useState(0)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [buf, setBuf] = useState(req.default || (fields[0]?.default ?? ''))
  const [fieldIdx, setFieldIdx] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const isChoice = req.type === 'select' || req.type === 'multiselect' || req.type === 'buttons'
  const isText = req.type === 'input' || req.type === 'password'
  const multi = req.type === 'multiselect'

  /**
   * The REPL path refuses these outright; without the same check here the TUI
   * renders an unanswerable question. A choice with no options gives arrow keys a
   * `% 0` cursor of NaN and resolves enter as `{ok:true, value:undefined}` — the
   * model reads that as an answer. A form with no fields throws on `f.name` at
   * the first enter and takes the render down with it. Better: the same sentence
   * the terminal fallback returns, which the model can actually act on.
   */
  const invalid = isChoice && !opts.length ? `no options provided for ${req.type}`
    : req.type === 'form' && !fields.length ? 'no fields provided for form'
    : null
  useEffect(() => {
    if (invalid) onDone({ ok: false, error: invalid })
  }, [invalid])

  useInput((char, key) => {
    if (invalid) return
    if (key.escape) { onDone({ ok: false, cancelled: true }); return }

    if (req.type === 'message') {
      if (key.return) onDone({ ok: true, value: 'acknowledged' })
      return
    }
    if (req.type === 'confirm') {
      const c = char?.toLowerCase()
      if (c === 'y') onDone({ ok: true, value: true })
      if (c === 'n') onDone({ ok: true, value: false })
      return
    }
    if (isChoice) {
      if (key.upArrow) setCursor((c) => (c - 1 + opts.length) % opts.length)
      else if (key.downArrow) setCursor((c) => (c + 1) % opts.length)
      else if (char === ' ' && multi) setChecked((s) => { const n = new Set(s); n.has(cursor) ? n.delete(cursor) : n.add(cursor); return n })
      else if (char?.toLowerCase() === 'a' && multi) setChecked((s) => s.size === opts.length ? new Set() : new Set(opts.map((_, i) => i)))
      else if (key.return) {
        onDone({ ok: true, value: multi ? [...checked].sort((a, b) => a - b).map((i) => opts[i].value) : opts[cursor]?.value })
      }
      return
    }
    if (isText || req.type === 'form') {
      if (key.return) {
        if (req.type === 'form') {
          const f = fields[fieldIdx]
          if (f?.required && !buf.trim()) return
          const next = { ...values, [f.name]: buf }
          if (fieldIdx + 1 >= fields.length) { onDone({ ok: true, value: next }); return }
          setValues(next)
          setFieldIdx(fieldIdx + 1)
          setBuf(fields[fieldIdx + 1]?.default ?? '')
        } else {
          onDone({ ok: true, value: buf })
        }
        return
      }
      if (key.backspace || key.delete) { setBuf((b) => b.slice(0, -1)); return }
      if (char && !key.ctrl && !key.meta) setBuf((b) => b + char)
    }
  })

  /**
   * A question asked mid-turn is very often "paste the token" or "which path?",
   * so the field takes a paste on Ink's paste channel like the composer does.
   * Only while a field is actually being typed into — a paste is not an answer to
   * a confirm or a select.
   */
  usePaste((text) => {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat) setBuf((b) => b + flat)
  }, { isActive: !invalid && (isText || req.type === 'form') })

  const mask = req.type === 'password' || (req.type === 'form' && fields[fieldIdx]?.type === 'password')
  const shownBuf = mask ? '•'.repeat(buf.length) : buf

  // The effect above is already resolving it — don't flash an empty box first.
  if (invalid) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Box>
        <Text color="cyan" bold>? </Text>
        <Text bold>{req.title ? `${req.title} — ` : ''}{req.text}</Text>
      </Box>
      {waiting > 0 && <Text dimColor>  +{waiting} more question{waiting === 1 ? '' : 's'} waiting</Text>}
      {req.type === 'message' && <Text dimColor>  press enter to continue · esc cancels</Text>}
      {req.type === 'confirm' && <Text dimColor>  y / n · esc cancels</Text>}
      {isChoice && (
        // The shared control (select.tsx): the ❯, the [x] ticks and the aria
        // roles a screen reader reads all live there now, so this question, the
        // onboarding pickers and the slash menu cannot drift apart again.
        <SelectList
          items={opts.map((o, i) => ({ key: String(i), label: o.label, ...(multi ? { checked: checked.has(i) } : {}) }))}
          cursor={cursor}
          maxRows={10}
          hint={`↑/↓ move${multi ? ' · space toggle · a all' : ''} · enter confirm · esc cancel`}
        />
      )}
      {(isText || req.type === 'form') && (
        <Box flexDirection="column">
          {req.type === 'form' && (
            <Text dimColor>  field {fieldIdx + 1}/{fields.length}: {fields[fieldIdx]?.label || fields[fieldIdx]?.name}{fields[fieldIdx]?.required ? ' *' : ''}</Text>
          )}
          <Box>
            <Text color="cyan">  › </Text>
            <Text>{shownBuf}</Text>
            <Text color="cyan">▌</Text>
          </Box>
          <Text dimColor>  enter {req.type === 'form' && fieldIdx + 1 < fields.length ? 'next field' : 'submit'} · esc cancel</Text>
        </Box>
      )}
    </Box>
  )
}
