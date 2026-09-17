/**
 * 🎛 Tray control socket — the daemon's local IPC surface.
 *
 * The daemon is headless (launchd/systemd), so the person whose machine it runs
 * on has no way to see what it's doing without opening a terminal. devduck
 * solved this with a two-process shape: a rumps menu-bar app talking to the
 * daemon over a Unix socket. That shape ports 1:1 and this is the daemon half —
 * a newline-delimited JSON server whose client can be a Swift menu-bar helper,
 * `tiny-tech tray status`, a shell script, or `nc`.
 *
 * Deliberately NOT copied from devduck: the socket PATH. devduck binds
 * `/tmp/devduck_tray.sock`, and `/tmp` is world-writable and shared between
 * every account on a multi-user Mac — so any other local user could connect and
 * issue `ask`, which runs a full agent turn (bash, files, the user's tiny
 * account, their integration keys). That's a local privilege escalation, not a
 * detail. The socket lives in `~/.tiny` (mode 0700) at mode 0600, and the
 * FILESYSTEM is the whole authentication story: Node has no portable
 * SO_PEERCRED, so nothing in this protocol proves who is on the other end. Every
 * decision below follows from that: the surface is small, `status` carries no
 * secrets, and long work goes through the task runner rather than running inline.
 */
import { createServer, connect, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync, statSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bumped whenever a reply's SHAPE changes. It rides in every reply because the
 * menu-bar helper is a separate binary a user installs once and forgets: a
 * helper built against a newer protocol can say "update tiny-tech" instead of
 * rendering an empty menu, and an older one can refuse rather than misread.
 */
export const TRAY_PROTOCOL = 1

/**
 * A request line is capped because anyone who can reach the socket can write to
 * it: an unbounded accumulator is a memory DoS, and a line that never ends never
 * dispatches (so the tray hangs waiting for a reply that can't come). 64 KB is
 * far above any real command — `ask` prompts are sentences.
 */
export const TRAY_LINE_MAX = 64 * 1024

/** Text bodies (logs, task results) are clamped AND say so — same rule as the
 * relay reply and the local-tool output: a silent truncation upstream of another
 * silent truncation is how "the file was empty" gets reported. */
export const TRAY_TEXT_MAX = 20_000

/** A buggy helper in a restart loop shouldn't be able to exhaust the daemon's
 * fds. A tray legitimately holds ONE connection open and polls on it. */
export const TRAY_MAX_CONNS = 8

/** Client-side deadline. A menu that hangs is worse than a menu that says the
 * daemon isn't answering. */
export const TRAY_TIMEOUT_MS = 2_000

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and the OS TRUNCATES rather
 * than failing — so a long TINY_HOME would silently bind (and connect to) a
 * different path than the one printed in the logs. Refuse with an actionable
 * message instead.
 */
export const SOCKET_PATH_MAX = 103

/**
 * Our own package version, rebroadcast in every `ping`.
 *
 * The protocol number answers "can you decode my replies"; it does NOT answer
 * "is the brain behind this socket the current one". Those came apart in the
 * field: a tiny-tech 0.8.3 daemon left over from an `npx` run owned
 * ~/.tiny/tray.sock for two days, speaking protocol 1 perfectly while missing
 * three releases of commands — so the menu bar rendered, and rendered the wrong
 * daemon. Version is the field that makes that visible, hence
 * `decideSocketOwnership` below can prefer the newer brain instead of
 * first-daemon-wins.
 */
export const TRAY_VERSION: string = (() => {
  try {
    // dist/tray.js and src/tray.ts both sit one level below package.json.
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

function tinyDir(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

export function traySocketPath(): string {
  return process.env.TINY_TRAY_SOCK || join(tinyDir(), 'tray.sock')
}

export function socketPathError(path: string): string | null {
  if (!path) return 'empty socket path'
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) {
    return `socket path is ${Buffer.byteLength(path)} bytes, over the ${SOCKET_PATH_MAX}-byte OS limit (it would be silently truncated) — set TINY_TRAY_SOCK to something shorter`
  }
  return null
}

// ── the notification PUSH channel ───────────────────────────────────────────

/**
 * How many notifications may wait for a tray that is not looking. Bounded on
 * purpose: an agent in a loop can ask a question every few seconds, and an
 * unbounded queue turns "nobody opened the menu" into a memory leak that later
 * floods the user with a hundred stale prompts. The OLDEST go first — the most
 * recent question is the one still worth answering — and the drops are COUNTED
 * so the tray can say "3 missed" instead of quietly lying by omission.
 */
export const TRAY_NOTIFY_MAX = 50

/** How many answered/abandoned ids we remember, so "already answered" can be
 *  told apart from "never existed". Bounded for the same reason as the queue. */
const TRAY_NOTIFY_MEMORY = 200

export type TrayNotifyKind = 'info' | 'confirm' | 'select' | 'text'

export interface TrayNotification {
  id: string
  kind: TrayNotifyKind
  title: string
  body: string
  context?: Record<string, string>
  options?: string[]
  sound?: string
  createdAt: number
  /** A question: the tray must post an `answer` back or the asker times out. */
  needsAnswer: boolean
  /** Set once a tray has drained it — a second poll must not re-render it. */
  delivered?: boolean
}

/** What a tray posts back. `cancelled` is a dismissal, and a dismissal is NOT
 *  consent, so it never carries a value (enforced in answer(), not trusted). */
export interface TrayNotifyAnswer {
  value?: string
  cancelled?: boolean
}

export interface TrayNotifyDrain {
  notifications: TrayNotification[]
  /** Dropped since the last drain — reported once, then cleared. */
  dropped: number
  /** Still waiting for an answer after this drain. */
  pending: number
}

type TrayNotifyWaiter = (a: TrayNotifyAnswer | null) => void

/**
 * The push channel's core: enqueue → drain → answer, with no socket, no agent
 * and no UI in it. The socket handler and the notify backend are both thin
 * shells over this, which is why the interesting behaviour (the cap, delivery
 * marking, refusing a stale id) is testable without binding anything.
 */
export class TrayNotifyQueue {
  private items: TrayNotification[] = []
  private waiters = new Map<string, TrayNotifyWaiter>()
  private resolved: string[] = []
  private droppedCount = 0
  private seq = 0
  /** When a tray last DRAINED. This is the freshness signal a notify backend
   *  needs: a socket that exists proves a daemon, not a human watching a menu. */
  lastPollAt = 0

  constructor(private readonly max: number = TRAY_NOTIFY_MAX) { }

  enqueue(n: Partial<TrayNotification> & { title: string }): TrayNotification {
    const kind: TrayNotifyKind = (['info', 'confirm', 'select', 'text'] as string[]).includes(String(n.kind))
      ? (n.kind as TrayNotifyKind)
      : 'info'
    const item: TrayNotification = {
      id: n.id || `n${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      kind,
      title: clampText(String(n.title || '')),
      body: clampText(String(n.body ?? '')),
      createdAt: n.createdAt ?? Date.now(),
      needsAnswer: n.needsAnswer ?? kind !== 'info',
    }
    if (n.options?.length) item.options = n.options.slice(0, 32).map((o) => clampText(String(o)))
    if (n.context && Object.keys(n.context).length) {
      item.context = Object.fromEntries(
        Object.entries(n.context).slice(0, 32).map(([k, v]) => [String(k).slice(0, 200), clampText(String(v))]),
      )
    }
    if (n.sound) item.sound = String(n.sound).slice(0, 100)

    this.items.push(item)
    while (this.items.length > this.max) {
      const gone = this.items.shift()!
      this.droppedCount++
      // A dropped question must not leave its asker waiting for a tray that
      // will never see it: release it now so the asker falls through.
      // NOT { cancelled: true }: the user never saw this question, so calling it
      // a cancellation would report a refusal they never made. null means "no
      // answer exists", which is what makes the asker fall through to a dialog.
      this.waiters.get(gone.id)?.(null)
      this.waiters.delete(gone.id)
      this.remember(gone.id)
    }
    return item
  }

  /** Everything a tray has not seen yet, marked delivered as it goes out. */
  drain(now = Date.now()): TrayNotifyDrain {
    this.lastPollAt = now
    const out = this.items.filter((i) => !i.delivered)
    for (const i of out) i.delivered = true
    const dropped = this.droppedCount
    this.droppedCount = 0
    // A delivered info-only entry has nothing left to happen to it.
    this.items = this.items.filter((i) => i.needsAnswer)
    return { notifications: out, dropped, pending: this.items.length }
  }

  answer(id: string, a: TrayNotifyAnswer): { ok: true } | { ok: false; error: string } {
    if (!id) return { ok: false, error: 'need id' }
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx < 0) {
      return this.resolved.includes(id)
        ? { ok: false, error: `notification ${id} was already answered or expired` }
        : { ok: false, error: `no such notification: ${id}` }
    }
    this.items.splice(idx, 1)
    this.remember(id)
    // Dismissal is not consent: a cancelled answer carries no value, whatever
    // the caller put in the field.
    const clean: TrayNotifyAnswer = a.cancelled
      ? { cancelled: true }
      : { value: clampText(String(a.value ?? '')) }
    const w = this.waiters.get(id)
    this.waiters.delete(id)
    w?.(clean)
    return { ok: true }
  }

  /**
   * Wait for a tray to answer, or give up. Giving up RETURNS null rather than a
   * cancelled answer, so the caller can tell "the user said no" from "nobody
   * was there" — the first is a decision, the second means try another backend.
   */
  await(id: string, timeoutMs: number): Promise<TrayNotifyAnswer | null> {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.abandon(id)
        resolve(null)
      }, Math.max(1, timeoutMs))
      // Deliberately NOT unref'd. Someone is awaiting this promise, and an unref'd
      // deadline in a process with nothing else pending never fires: the await
      // hangs forever instead of falling through to a dialog, which is the very
      // failure this timeout exists to prevent. It is bounded by
      // TRAY_ANSWER_TIMEOUT_MS, so holding the loop open is cheap and finite.
      this.waiters.set(id, (ans) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(ans)
      })
    })
  }

  /** Drop an entry nobody is waiting for any more (its asker gave up). */
  abandon(id: string): void {
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx >= 0) this.items.splice(idx, 1)
    this.waiters.delete(id)
    this.remember(id)
  }

  pending(): number { return this.items.length }
  dropped(): number { return this.droppedCount }
  fresh(windowMs: number, now = Date.now()): boolean {
    return this.lastPollAt > 0 && now - this.lastPollAt <= windowMs
  }

  clear(): void {
    for (const [, w] of this.waiters) w({ cancelled: true })
    this.items = []
    this.waiters.clear()
    this.resolved = []
    this.droppedCount = 0
    this.lastPollAt = 0
  }

  private remember(id: string): void {
    this.resolved.push(id)
    if (this.resolved.length > TRAY_NOTIFY_MEMORY) {
      this.resolved.splice(0, this.resolved.length - TRAY_NOTIFY_MEMORY)
    }
  }
}

/**
 * The process-wide queue. In-process on purpose: the thing that enqueues (a
 * notify backend inside the agent) and the thing that serves the socket are the
 * same daemon. A CLI in some other process therefore never records a tray poll,
 * its tray backend reports itself unavailable, and the question goes to a
 * dialog — the honest outcome, rather than a prompt queued into the void.
 */
let sharedNotifyQueue = new TrayNotifyQueue()
export function trayNotifications(): TrayNotifyQueue { return sharedNotifyQueue }
/** Tests only: a fresh queue with no cross-test residue. */
export function resetTrayNotifications(): TrayNotifyQueue {
  sharedNotifyQueue = new TrayNotifyQueue()
  return sharedNotifyQueue
}
/** When a tray last drained this process's queue (0 = never). */
export function lastTrayPollAt(): number { return sharedNotifyQueue.lastPollAt }

// ── commands ────────────────────────────────────────────────────────────────

export const TRAY_COMMANDS = ['ping', 'status', 'tasks', 'loops', 'result', 'ask', 'cancel', 'logs', 'reload', 'share', 'notifications', 'answer'] as const
export type TrayCommandName = (typeof TRAY_COMMANDS)[number]

// ── event kinds ─────────────────────────────────────────────────────────────

/**
 * ⚡ EVERY EVENT KIND THE WORKER CAN EMIT, as the tray sees them.
 *
 * The menu bar is the ONLY tiny surface with no scrollback: four lines, a glyph
 * each, and then it closes. So a kind the tray doesn't understand isn't merely
 * unstyled — it is the whole news.
 *
 * Hand-kept, because the worker is a separate deploy and this is a separate repo
 * (no shared type to import). Mirrors `EMITTED_KINDS` in the web repo's
 * `lib/chat/event-icons.ts`. But a hand-kept roster is the same defect class as
 * the map it replaces, so it is not left on trust: `test/event-kinds.test.mjs`
 * re-derives the kinds from the worker's own `emitEvent(` call sites whenever
 * that repo is checked out beside this one, and fails BOTH ways — a kind the
 * worker emits and this list omits, and a name here the worker no longer sends.
 * `trayEventKindGaps()` below covers the rest: an omission is a failing test
 * rather than a bullet in a menu.
 */
export const WORKER_EVENT_KINDS = [
  'job_result', 'job_error', 'job_missed',        // scheduler.ts
  'dm',                                           // messages.ts
  'follow',                                       // learnings.ts
  'tiny_visit',                                   // visit.ts
  'device_result',                                // relay.ts (late device reply via LATE_REPLY_KIND)
  'device_task_result',                           // relay.ts (a background job on a device finished — use_loop)
  'device_ask',                                   // ask.ts (POST /api/devices/ask — a device asked the owner agent)
  'nicla_transcript',                             // transcripts.ts (device event)
  'tool-update',                                  // tool-updates.ts
  'telegram', 'telegram_out', 'telegram_button',  // telegram.ts, telegram-api.ts
  'pay_alarm',                                    // reconcile-alarm.ts (🚨 needs a human)
  'pay_earned', 'pay_received', 'pay_withdrawn', 'pay_refunded',  // money-events.ts
] as const

/**
 * The tray's short vocabulary — the values the Swift helper switches on. Kept
 * as a list here so a normalization that returns something OUTSIDE it is
 * detectable, which is how `share_view` survived for so long: the Swift side had
 * a `case "share_view"` and this side produced it, so both halves agreed with
 * each other and neither agreed with the worker, which has never emitted it.
 */
export const TRAY_EVENT_TYPES = [
  'job', 'job_error', 'job_missed', 'telegram', 'message', 'visit', 'device', 'tool', 'money', 'alarm', 'follow',
] as const
export type TrayEventType = (typeof TRAY_EVENT_TYPES)[number]

/**
 * Worker event kind → the tray's short vocabulary.
 *
 * ⚠️ ORDER MATTERS, and the old version got it wrong in a way that inverted
 * meaning rather than just losing detail. It tested `k.includes('job')` and
 * returned `'job'` for BOTH `job_result` and `job_error`, and the Swift helper
 * draws `'job'` as ⏳ / `clock.badge.checkmark` — a CHECKMARK. So a scheduled job
 * that failed (the scheduler emits `job_error` with the exception message as the
 * detail, and it is the one event a user must act on) appeared in the menu bar as
 * a completed job. Substring matching also meant `pay_alarm` — "🚨 x402
 * reconciliation needs a human" — fell to `default:` and drew •, the same bullet
 * as everything else unrecognised.
 *
 * So: exact matches first, for the kinds whose MEANING differs from their
 * family; prefix/substring fallbacks after, for the families where collapsing is
 * genuinely right (all three `telegram_*` really are one thing to a menu).
 */
export function normalizeEventKind(kind: string): string {
  const k = String(kind || '').toLowerCase()
  // Exact, because these must NOT inherit their family's glyph.
  if (k === 'job_error') return 'job_error'          // ❗ not a finished job
  // ⛔ A one-shot the scheduler GAVE UP on. Third member of the same trap: it
  // contains 'job', so the family branch below would have collapsed it to 'job'
  // — a checkmark for a run that never happened and never will.
  if (k === 'job_missed') return 'job_missed'
  if (k === 'pay_alarm') return 'alarm'              // 🚨 a human must intervene
  if (k.startsWith('pay_')) return 'money'           // earned/received/withdrawn/refunded
  // Families where one glyph for all of them is the right answer.
  if (k.includes('visit')) return 'visit'
  if (k.includes('job') || k.includes('schedule')) return 'job'
  if (k.includes('telegram')) return 'telegram'
  if (k.startsWith('device') || k.startsWith('nicla_')) return 'device'  // nicla_wake / nicla_sentry / nicla_transcript
  if (k.startsWith('tool')) return 'tool'
  if (k.includes('message') || k.includes('dm') || k.includes('chat')) return 'message'
  // Fall through as-is. Two things ride on this line: `follow` is already spelled
  // the way the tray spells it (so it needs no branch — `trayEventKindGaps()` is
  // what proves that, not a comment), and a kind the worker adds TOMORROW reaches
  // the menu under its own name instead of being renamed to something wrong.
  return k
}

/**
 * The roster check, as data rather than prose: which worker kinds normalize to
 * something the tray has no case for. Exported so BOTH test suites (this repo's
 * node tests and the menubar's XCTest, via the JSON below) assert on the same
 * answer instead of two hand-written lists drifting apart.
 */
export function trayEventKindGaps(): string[] {
  const known = new Set<string>(TRAY_EVENT_TYPES)
  return WORKER_EVENT_KINDS.filter(k => !known.has(normalizeEventKind(k)))
}

/**
 * A single ambient data card for the rotating menu-bar ticker.
 * Cards are CACHED data — the daemon never makes a live API call to build them.
 * The bar rotates through normal cards; urgent cards stop rotation and stay
 * until replaced or acknowledged.
 */
export interface TrayTickerCard {
  /** Short display text, fits in ~28 chars next to the glyph */
  text: string
  /** Single emoji or symbol prefix, e.g. "🎵" "💰" "📬" "📅" */
  icon?: string
  /** normal = rotates; urgent = stays, shown with ◉ glyph */
  priority?: 'normal' | 'urgent'
  /** Seconds this card stays visible before rotating. Default 5. */
  ttl?: number
}

/**
 * One recent activity-feed event ("push"), summarised for the menu. The daemon
 * already polls /api/events for the ticker's unread count; carrying the
 * summaries too costs nothing and lets the menu SHOW what arrived instead of
 * only counting it. Cached like every other ticker input — never fetched live
 * from inside status().
 */
export interface TrayEventCard {
  id?: number
  /** job | telegram | message | share_view | visit | … */
  type?: string
  summary: string
  at?: number
}

/**
 * Daemon mood — drives the menu-bar glyph and tint.
 *   idle      → ◍  (system label color)
 *   working   → ◐  (system label color, badge = task count)
 *   attention → ◑  (orange tint)
 *   urgent    → ◉  (red tint, stops ticker rotation)
 *   offline   → ○
 */
export type TrayMood = 'idle' | 'working' | 'attention' | 'urgent' | 'offline'

/**
 * What a menu bar needs to paint itself, in ONE round trip. A tray repaints
 * every few seconds; making it issue five commands per paint would multiply that
 * poll by five for no gain. Everything here is a fact about the daemon —
 * deliberately no token, no env, no device secret: the socket has no
 * authentication beyond file permissions, so `status` must stay safe to hand to
 * anything that can open it.
 */
export interface TrayStatus {
  device?: { name?: string; id?: string; online?: boolean } | null
  peers?: number
  senses?: string[]
  tools?: { loaded?: number; failed?: number }
  tasks?: { running?: number; finished?: number }
  relay?: boolean
  logPath?: string
  startedAt?: number
  version?: string
  /** Computed mood — drives glyph + tint in v2+ helpers. Omitted = 'idle'. */
  mood?: TrayMood
  /** Rotating ambient data cards for the menu-bar title strip. */
  ticker?: TrayTickerCard[]
  /** Active Spotify track, for the now-playing card. Null = nothing playing. */
  nowPlaying?: { title: string; artist: string } | null
  /** Recent activity-feed events (pushes), newest first. */
  events?: TrayEventCard[]
}

/** The shape the tray needs per task — NOT the full record: `result` bodies are
 * up to 20 KB each and a poll shouldn't ship them. Fetch one with `result`. */
export interface TraySummary {
  id: string
  status: string
  prompt: string
  startedAt?: number
  endedAt?: number
}

export interface TrayDeps {
  status: () => TrayStatus | Promise<TrayStatus>
  tasks?: () => TraySummary[]
  /** Background LOOPS (use_loop) — hours-long iterating jobs. `iterations`
   *  rides in `prompt`'s summary line; a dedicated field keeps Swift decoding
   *  one Codable per list. */
  loops?: () => Array<TraySummary & { iterations?: number }>
  /** Full record for ONE task (its `result` is what the tray wants to show). */
  taskResult?: (id: string) => { status: string; result?: string } | null
  startTask?: (prompt: string) => { id: string } | { error: string }
  cancelTask?: (id: string) => string
  logs?: (lines: number) => string
  reloadTools?: () => string | Promise<string>
  /**
   * Share a local file (a screenshot) with the user's tiny. MUST return fast:
   * the tray client's deadline is 2s, so the implementation validates + kicks
   * off the upload and reports completion out-of-band (desktop notification),
   * never holding the socket for a model turn.
   */
  shareFile?: (path: string, note: string) => string | Promise<string>
  /**
   * The push channel's queue. Defaults to this process's shared queue — a dep
   * only so a test can hand in its own without touching module state.
   */
  notifications?: TrayNotifyQueue
}

export interface TrayReply {
  ok: boolean
  protocol: number
  [k: string]: unknown
}

const clampText = (s: string): string =>
  s.length > TRAY_TEXT_MAX ? `${s.slice(0, TRAY_TEXT_MAX)}\n… [truncated at ${TRAY_TEXT_MAX} chars]` : s

const reply = (fields: Record<string, unknown>): TrayReply =>
  ({ ok: true, protocol: TRAY_PROTOCOL, ...fields } as TrayReply)

const fail = (error: string, fields: Record<string, unknown> = {}): TrayReply =>
  ({ ok: false, protocol: TRAY_PROTOCOL, error, ...fields } as TrayReply)

/**
 * One command → one reply. Pure with respect to the daemon: everything it can
 * touch arrives in `deps`, so the whole protocol is testable without a socket,
 * a daemon, or an agent.
 *
 * NEVER throws. A tray that gets no reply cannot tell a crashed daemon from a
 * slow one, so every failure — bad JSON, unknown command, a dep that throws —
 * comes back as `{ok:false, error}` and the connection stays usable.
 */
export async function handleTrayCommand(raw: unknown, deps: TrayDeps): Promise<TrayReply> {
  const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cmd = String(msg.cmd ?? '').trim()
  if (!cmd) return fail(`need a cmd (${TRAY_COMMANDS.join('|')})`)

  try {
    switch (cmd) {
      case 'ping':
        // Also the handshake: a helper reads `protocol` here before it renders,
        // and a SECOND daemon reads `version` here to decide whether the socket's
        // current owner is a newer brain than itself (see decideSocketOwnership).
        return reply({ pid: process.pid, version: TRAY_VERSION, commands: [...TRAY_COMMANDS] })

      case 'status':
        return reply({ status: await deps.status() })

      case 'tasks': {
        if (!deps.tasks) return unavailable(cmd)
        return reply({ tasks: deps.tasks() })
      }

      case 'loops': {
        if (!deps.loops) return unavailable(cmd)
        return reply({ loops: deps.loops() })
      }

      case 'result': {
        if (!deps.taskResult) return unavailable(cmd)
        const id = String(msg.id ?? '')
        if (!id) return fail('need id')
        const rec = deps.taskResult(id)
        if (!rec) return fail(`no such task: ${id}`)
        // `state`, NOT `status`: a top-level `status` key already means the
        // status OBJECT. One key with two types decodes in JavaScript and fails
        // in Swift, where the helper's reply struct is a single Codable.
        return reply({ id, state: rec.status, result: clampText(String(rec.result ?? '')) })
      }

      case 'ask': {
        // Deliberately a BACKGROUND task, never an inline agent turn: the caller
        // is a UI thread painting a menu, and a 10-minute turn on this socket
        // would freeze the menu bar for 10 minutes. It also means a question
        // asked from the menu inherits the task runner's cap, its disk record,
        // and its next-turn news — so the answer reaches the user's chat too,
        // not only whoever happened to be watching the tray.
        if (!deps.startTask) return unavailable(cmd)
        const prompt = String(msg.prompt ?? '').trim()
        if (!prompt) return fail('need prompt')
        const r = deps.startTask(prompt)
        if ('error' in r) return fail(r.error)
        return reply({ id: r.id })
      }

      case 'cancel': {
        if (!deps.cancelTask) return unavailable(cmd)
        const id = String(msg.id ?? '')
        if (!id) return fail('need id')
        return reply({ id, message: deps.cancelTask(id) })
      }

      case 'logs': {
        if (!deps.logs) return unavailable(cmd)
        // Clamped BOTH ends: 0 or a negative would ask for nothing, and an
        // unbounded `lines` reads a log that grows forever into one JSON line.
        const asked = Number(msg.lines)
        const lines = Number.isFinite(asked) ? Math.min(500, Math.max(1, Math.floor(asked))) : 80
        return reply({ lines, text: clampText(deps.logs(lines)) })
      }

      case 'reload': {
        if (!deps.reloadTools) return unavailable(cmd)
        return reply({ message: String(await deps.reloadTools()) })
      }

      case 'share': {
        // A screenshot the user just took, on its way to their tiny. The path
        // arrives from the helper (same user, same machine — the socket's file
        // permissions are the auth story here as everywhere else), and the dep
        // answers in a sentence immediately; the actual upload+turn completes
        // in the background.
        if (!deps.shareFile) return unavailable(cmd)
        const path = String(msg.path ?? '').trim()
        if (!path) return fail('need path')
        const note = String(msg.note ?? '').trim()
        return reply({ message: clampText(String(await deps.shareFile(path, note))) })
      }

      case 'notifications': {
        // The PUSH half of the channel. A tray polls this; everything pending
        // comes back at once, marked delivered so the next poll doesn't
        // re-render the same prompt. `dropped` is reported exactly once, and
        // draining is also the freshness signal the notify backend reads — a
        // socket proves a daemon, a DRAIN proves someone is watching the menu.
        const q = deps.notifications ?? trayNotifications()
        const d = q.drain()
        return reply({ notifications: d.notifications, dropped: d.dropped, pending: d.pending })
      }

      case 'answer': {
        // The RETURN half: the user clicked something in the menu bar. Caps
        // apply in this direction too — the value is arbitrary typed text from
        // a kind=text prompt, and it ends up in an agent's context.
        const q = deps.notifications ?? trayNotifications()
        const id = String(msg.id ?? '').trim()
        if (!id) return fail('need id')
        const cancelled = msg.cancelled === true
        const r = q.answer(id, cancelled ? { cancelled: true } : { value: clampText(String(msg.value ?? '')) })
        // An id the daemon has never heard of, or one already answered, is a
        // stale menu — a real condition to report, not an exception to throw.
        if (!r.ok) return fail(r.error, { id })
        return reply({ id, accepted: true, cancelled })
      }

      default:
        // Named, not ignored: a helper built against a newer protocol should be
        // able to tell "this daemon is old" from "I sent nonsense".
        return fail(`unknown cmd: ${cmd}`, { commands: [...TRAY_COMMANDS] })
    }
  } catch (e: any) {
    return fail(`${cmd} failed: ${String(e?.message || e).slice(0, 300)}`)
  }
}

/**
 * A command the daemon knows but this instance can't serve (no task runner, no
 * log file). Distinct from `unknown cmd` on purpose: the tray greys the item out
 * rather than telling the user to upgrade.
 */
function unavailable(cmd: string): TrayReply {
  return fail(`${cmd} is not available on this daemon`, { unavailable: true })
}

// ── the socket ──────────────────────────────────────────────────────────────

export type SocketState = 'absent' | 'live' | 'dead'

/**
 * Is the socket file at `path` a LIVE server, a leftover inode, or absent?
 *
 * This is why a stale socket can't just be unlinked: a crash leaves the inode
 * behind and `listen()` then fails EADDRINUSE forever, but blind-unlinking would
 * let a second daemon STEAL the socket from a first one that is happily serving
 * it — the tray would then talk to whichever won the race. So: connect first. A
 * refused connection means nobody is listening and the file is garbage; a
 * successful one means someone owns it.
 */
export function probeSocket(path: string, timeoutMs = 300): Promise<SocketState> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve('absent')
    let settled = false
    const done = (s: SocketState) => { if (!settled) { settled = true; try { c.destroy() } catch { } resolve(s) } }
    const c = connect(path)
    c.setTimeout(timeoutMs, () => done('dead'))
    c.on('connect', () => done('live'))
    // ECONNREFUSED / ENOENT on a path that exists = nothing is listening.
    c.on('error', () => done('dead'))
  })
}

// ── who owns the socket ─────────────────────────────────────────────────────

/**
 * Is `pid` a process that still exists?
 *
 * `process.kill(pid, 0)` sends no signal — it only asks the kernel whether the
 * pid is addressable. Two failure modes, and they mean OPPOSITE things:
 *   ESRCH  → no such process. Dead. Its socket file is garbage.
 *   EPERM  → the process EXISTS but belongs to another user (or another
 *            security context), so we may not signal it. That is ALIVE.
 * Treating EPERM as dead is how a cleanup routine deletes a running program's
 * socket, so the ambiguity is resolved conservatively: anything that is not a
 * definite ESRCH counts as alive.
 */
export function pidAlive(pid: unknown): boolean {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/**
 * Compare two dotted versions. Returns -1 / 0 / 1, or null when either side
 * isn't a version at all — null is a real answer here, not an error: "I cannot
 * tell" must never be rounded to "mine is newer", because that would authorise
 * unlinking a live socket.
 */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const parse = (v: string | undefined): number[] | null => {
    if (typeof v !== 'string') return null
    // Drop any -beta.1 / +build tail: prerelease ordering is not a distinction
    // the tray needs, and pretending otherwise invents precision.
    const core = v.trim().split(/[-+]/)[0]
    if (!/^\d+(\.\d+)*$/.test(core)) return null
    return core.split('.').map((n) => Number(n))
  }
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/** What a handshake with the current socket owner found out. */
export interface SocketOwnerFacts {
  /** Does the socket path exist at all? */
  exists: boolean
  /** Did a `ping` come back `ok`? */
  pingOk: boolean
  ownerPid?: number
  ownerProtocol?: number
  ownerVersion?: string
  /** Result of `pidAlive(ownerPid)`. Undefined = no pid to test. */
  ownerAlive?: boolean
  /** Ours, injectable so the decision stays a pure function under test. */
  ourProtocol?: number
  ourVersion?: string
}

export type SocketOwnershipAction = 'bind' | 'takeover' | 'yield'

export interface SocketOwnershipDecision {
  action: SocketOwnershipAction
  /** One sentence, meant to be logged verbatim: it names what was replaced. */
  reason: string
}

/**
 * ⚖️ THE ONLY PLACE that decides whether a second daemon may take the tray
 * socket. Pure — facts in, verdict out — because the alternative is deciding it
 * inline in `startTrayServer`, where the branch that unlinks another process's
 * socket can only be tested by actually running two daemons.
 *
 * Three outcomes:
 *   bind      — nothing is there. Just listen.
 *   takeover  — what is there is NOT a working current daemon: no reply, a dead
 *               owner pid, an older protocol, or an older version. Unlink, bind,
 *               and say what was displaced.
 *   yield     — a live owner speaking our protocol or better, at our version or
 *               newer. Run without a tray and say who has it.
 *
 * The asymmetry is deliberate. Stealing from a live equal-or-newer daemon splits
 * the machine in two (both serve, the tray reaches one, the user's commands land
 * in the other), and that is worse than having no menu bar. Whereas leaving a
 * three-releases-old brain in charge is the bug this function exists for: it is
 * indistinguishable from a working tray until a command is missing.
 *
 * A ping that answers WITHOUT a version is treated as older, not as unknown:
 * `version` ships in the same release as this check, so a daemon that omits it
 * necessarily predates it.
 */
export function decideSocketOwnership(facts: SocketOwnerFacts): SocketOwnershipDecision {
  const ourProtocol = facts.ourProtocol ?? TRAY_PROTOCOL
  const ourVersion = facts.ourVersion ?? TRAY_VERSION
  const who = `pid ${facts.ownerPid ?? '?'}, protocol ${facts.ownerProtocol ?? '?'}, version ${facts.ownerVersion ?? 'unknown'}`

  if (!facts.exists) return { action: 'bind', reason: 'no socket at that path yet' }

  if (!facts.pingOk) {
    return { action: 'takeover', reason: 'socket file exists but nothing answered a ping — reclaiming a leftover inode' }
  }

  // A reply proves SOMETHING is listening, but the listener can still be a
  // zombie inode served by a process that has since exited on some platforms —
  // and more usefully, the pid it reports is checkable. Only a DEFINITE ESRCH
  // counts against it (pidAlive treats EPERM as alive).
  if (facts.ownerPid !== undefined && facts.ownerAlive === false) {
    return { action: 'takeover', reason: `socket owner ${who} is no longer running — reclaiming` }
  }

  const ownerProtocol = Number(facts.ownerProtocol)
  if (Number.isFinite(ownerProtocol) && ownerProtocol < ourProtocol) {
    return { action: 'takeover', reason: `replacing an older tray protocol (${who}) with protocol ${ourProtocol} — its replies can no longer be rendered` }
  }
  if (!Number.isFinite(ownerProtocol)) {
    return { action: 'takeover', reason: `socket owner (${who}) answered without a protocol number — it predates the handshake, replacing it` }
  }
  if (ownerProtocol > ourProtocol) {
    // A protocol ABOVE ours cannot have come from a build older than ours,
    // whatever its version string says (a fork, a dev build, a hand-rolled
    // helper). We would also be unable to decode its replies, so evicting it on
    // a version comparison we do not understand is the wrong way round.
    return { action: 'yield', reason: `another daemon owns the tray socket (${who}) and speaks a NEWER protocol than ours (${ourProtocol})` }
  }

  const cmp = compareVersions(facts.ownerVersion, ourVersion)
  if (facts.ownerVersion === undefined || cmp === null) {
    // No version at all → predates this release. An UNPARSEABLE version is the
    // same evidence: it is not a claim to be newer, and it cannot have been
    // produced by a build that ships this function.
    return { action: 'takeover', reason: `replacing a stale tray brain (${who}) with version ${ourVersion} — it predates the version handshake` }
  }
  if (cmp < 0) {
    return { action: 'takeover', reason: `replacing a stale tray brain (${who}) with version ${ourVersion} — the menu bar would otherwise talk to the older daemon` }
  }

  return { action: 'yield', reason: `another daemon owns the tray socket (${who})` }
}

/**
 * Do the handshake: connect to whatever is at `path` and ask it who it is.
 * Never throws; a socket that refuses, times out or answers garbage all come
 * back as `pingOk: false`, which `decideSocketOwnership` reads as reclaimable.
 */
export async function inspectSocketOwner(path: string, timeoutMs = 500): Promise<SocketOwnerFacts> {
  if (!existsSync(path)) return { exists: false, pingOk: false }
  const r = await trayRequest({ cmd: 'ping' }, { path, timeoutMs })
  if (!r.ok) return { exists: true, pingOk: false }
  const ownerPid = Number.isInteger(Number(r.pid)) && Number(r.pid) > 0 ? Number(r.pid) : undefined
  return {
    exists: true,
    pingOk: true,
    ownerPid,
    ownerProtocol: Number.isFinite(Number(r.protocol)) ? Number(r.protocol) : undefined,
    ownerVersion: typeof r.version === 'string' ? r.version : undefined,
    // No pid to check = the reply itself is the only evidence, and it proves a
    // listener. Undefined, not false: absence of a pid is not proof of death.
    ownerAlive: ownerPid === undefined ? undefined : pidAlive(ownerPid),
  }
}

export interface TrayServerOptions {
  path?: string
  deps: TrayDeps
  /** Reported, never thrown: the daemon must run with or without a tray. */
  onError?: (message: string) => void
}

export interface TrayServer {
  path: string
  close: () => void
  connections: () => number
}

/**
 * Start the control socket. Returns null (never throws) when it can't bind:
 * the daemon's job is the mesh + relay + heartbeat, and losing the menu bar must
 * not cost the user any of those.
 */
export async function startTrayServer(opts: TrayServerOptions): Promise<TrayServer | null> {
  const path = opts.path || traySocketPath()
  const report = opts.onError || (() => { })

  const pathErr = socketPathError(path)
  if (pathErr) { report(pathErr); return null }

  try {
    // 0700: the directory permission IS the access control for this socket.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch (e: any) {
    report(`tray: cannot create ${dirname(path)}: ${e?.message || e}`)
    return null
  }

  // Who, if anyone, has this socket — and may we have it? The old code asked
  // only "is something listening" (probeSocket) and yielded to anything that
  // was, which is first-daemon-wins: an `npx tiny-tech` from three releases ago
  // kept the menu bar for two days because it happened to start first.
  const facts = await inspectSocketOwner(path)
  const decision = decideSocketOwnership(facts)
  if (decision.action === 'yield') {
    report(`tray: ${path} is already served by another tiny-tech daemon — ${decision.reason} — not binding`)
    return null
  }
  if (decision.action === 'takeover' && facts.exists) {
    // Unlink ONLY, never a signal: the other process may be doing real work and
    // ending it is not this function's business. What we remove is whatever is
    // sitting at OUR path inside a 0700 directory (a socket after a crash, or a
    // zero-byte file when something got interrupted mid-bind) — refusing a
    // non-socket here would lock the daemon out of its own menu bar forever, and
    // unlinkSync on a directory fails loudly rather than destroying anything.
    try {
      unlinkSync(path)
      report(`tray: took over ${path} — ${decision.reason}`)
    } catch (e: any) {
      report(`tray: cannot remove stale socket ${path}: ${e?.message || e}`)
      return null
    }
  }

  let conns = 0
  const server: Server = createServer((sock: Socket) => {
    if (conns >= TRAY_MAX_CONNS) {
      // Answer before hanging up: a tray that gets silence retries in a loop.
      try { sock.end(JSON.stringify(fail(`too many tray connections (max ${TRAY_MAX_CONNS})`)) + '\n') } catch { }
      return
    }
    conns++
    sock.on('close', () => { conns-- })
    sock.on('error', () => { /* a client that vanishes is not an error here */ })
    serveConnection(sock, opts.deps)
  })

  server.on('error', (e: any) => report(`tray: ${e?.message || e}`))

  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(path, () => resolve(true))
  })
  if (!listening) return null

  // The socket inherits the umask, so tighten it explicitly — 0700 on the dir
  // already gates it, but a socket a group can write to is not something to
  // leave to whatever umask launchd happened to have.
  try { chmodSync(path, 0o600) } catch { }

  const cleanup = () => {
    // Node unlinks the path it bound on close(), but only if close() got that far.
    // This removes a SOCKET only — never a file that replaced ours meanwhile.
    try { if (existsSync(path) && statSync(path).isSocket()) unlinkSync(path) } catch { }
  }

  // The socket must not outlive the process, and the daemon's own SIGTERM handler
  // is NOT a reliable place to guarantee that: `TinyAgent.init()` installs its own
  // signal handler that calls process.exit(0), so whichever handler was registered
  // first wins the race and the loser's cleanup never runs. A leaked inode makes
  // the NEXT daemon probe-and-reclaim (and a tray then reports a dead socket as a
  // missing daemon). `exit` fires synchronously however the process leaves —
  // signal handler, process.exit(), or falling off the end of the event loop.
  const onExit = () => cleanup()
  process.once('exit', onExit)

  return {
    path,
    connections: () => conns,
    close: () => {
      try { server.close() } catch { }
      process.removeListener('exit', onExit)
      cleanup()
    },
  }
}

/** Newline-delimited JSON, one reply per request line, connection stays open. */
export function serveConnection(sock: Socket, deps: TrayDeps): void {
  let buf = ''
  // Replies are ORDERED, because nothing in the protocol pairs a reply with its
  // request. Some handlers await (`status` calls into the daemon, `reload` walks
  // a tools dir) and some return synchronously, so dispatching concurrently
  // would answer a pipelined `ping`+`status`+`tasks` as ping, tasks, status —
  // and a client counting replies would read the task list as its status. One
  // command at a time, in arrival order.
  let queue: Promise<void> = Promise.resolve()
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    if (buf.length > TRAY_LINE_MAX) {
      // Over the cap there is no way to find the frame boundary any more, so the
      // connection is unusable — say why, then drop it.
      try { sock.end(JSON.stringify(fail(`request line over ${TRAY_LINE_MAX} bytes`)) + '\n') } catch { }
      buf = ''
      return
    }
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      queue = queue.then(() => dispatch(sock, line, deps))
    }
  })
}

async function dispatch(sock: Socket, line: string, deps: TrayDeps): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    write(sock, fail('malformed JSON'))
    return
  }
  write(sock, await handleTrayCommand(parsed, deps))
}

function write(sock: Socket, obj: TrayReply): void {
  // One line per reply — JSON.stringify escapes every newline inside strings, so
  // a task result full of them can never be read as two replies.
  try { if (sock.writable) sock.write(JSON.stringify(obj) + '\n') } catch { }
}

// ── the client half (used by `tiny-tech tray`, and by any helper) ────────────

/**
 * Send one command, read one reply. Used by the CLI so a user — and the Swift
 * helper's own tests — can drive the daemon without writing socket code.
 * Resolves to `{ok:false, error}` rather than rejecting: every caller here is a
 * UI that needs a sentence to render.
 */
export function trayRequest(
  cmd: Record<string, unknown>,
  opts: { path?: string; timeoutMs?: number } = {},
): Promise<TrayReply> {
  const path = opts.path || traySocketPath()
  const timeoutMs = opts.timeoutMs ?? TRAY_TIMEOUT_MS
  return new Promise((resolve) => {
    if (!existsSync(path)) {
      return resolve(fail(`no tray socket at ${path} — is the daemon running? (tiny-tech daemon status)`))
    }
    let buf = ''
    let settled = false
    const finish = (r: TrayReply) => { if (!settled) { settled = true; try { sock.destroy() } catch { } resolve(r) } }
    const sock = connect(path)
    sock.setEncoding('utf8')
    sock.setTimeout(timeoutMs, () => finish(fail(`tray did not answer within ${timeoutMs}ms`)))
    sock.on('connect', () => sock.write(JSON.stringify(cmd) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) {
        if (buf.length > TRAY_LINE_MAX) finish(fail('tray reply too large'))
        return
      }
      try { finish({ ...(JSON.parse(buf.slice(0, nl)) as TrayReply) }) } catch { finish(fail('malformed reply from tray socket')) }
    })
    // A closed connection with nothing read is a daemon that died mid-request.
    sock.on('close', () => finish(fail('tray socket closed without a reply')))
    sock.on('error', (e: any) => finish(fail(`tray socket: ${e?.message || e}`)))
  })
}

/** Render a reply for a terminal — `tiny-tech tray status` shouldn't print JSON
 * at a human unless they asked for it. */
export function formatTrayReply(r: TrayReply): string {
  if (!r.ok) return `✗ ${r.error ?? 'failed'}`
  const s = r.status as TrayStatus | undefined
  if (s) {
    const lines = [
      `device:  ${s.device?.name ?? '(not enrolled)'}${s.device?.online ? ' — online' : ''}`,
      `peers:   ${s.peers ?? 0}`,
      `relay:   ${s.relay ? 'polling' : 'off'}`,
      `tasks:   ${s.tasks?.running ?? 0} running, ${s.tasks?.finished ?? 0} finished`,
      `tools:   ${s.tools?.loaded ?? 0} local${s.tools?.failed ? `, ${s.tools.failed} failed` : ''}`,
      `senses:  ${s.senses?.length ? s.senses.join(', ') : 'none'}`,
    ]
    if (s.logPath) lines.push(`logs:    ${s.logPath}`)
    return lines.join('\n')
  }
  const tasks = r.tasks as TraySummary[] | undefined
  if (tasks) {
    return tasks.length
      ? tasks.map((t) => `${t.id}  ${t.status.padEnd(11)} ${t.prompt.slice(0, 60)}`).join('\n')
      : '(no tasks)'
  }
  const loops = r.loops as Array<TraySummary & { iterations?: number }> | undefined
  if (loops) {
    return loops.length
      ? loops.map((t) => `${t.id}  ${t.status.padEnd(11)} ${String(t.iterations ?? 0).padStart(3)} iters  ${t.prompt.slice(0, 50)}`).join('\n')
      : '(no loops)'
  }
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return `[${r.state}]\n${r.result}`
  if (typeof r.message === 'string') return r.message
  if (typeof r.id === 'string') return `task ${r.id}`
  if (Array.isArray(r.commands)) return `tray protocol ${r.protocol} — ${(r.commands as string[]).join(', ')}`
  return JSON.stringify(r)
}
