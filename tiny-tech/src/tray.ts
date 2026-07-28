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
import { existsSync, unlinkSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

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

// ── commands ────────────────────────────────────────────────────────────────

export const TRAY_COMMANDS = ['ping', 'status', 'tasks', 'result', 'ask', 'cancel', 'logs', 'reload', 'share'] as const
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
  'device_result',                                // relay.ts (late device reply)
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
  if (k.startsWith('device')) return 'device'
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
        // Also the handshake: a helper reads `protocol` here before it renders.
        return reply({ pid: process.pid, commands: [...TRAY_COMMANDS] })

      case 'status':
        return reply({ status: await deps.status() })

      case 'tasks': {
        if (!deps.tasks) return unavailable(cmd)
        return reply({ tasks: deps.tasks() })
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

  const state = await probeSocket(path)
  if (state === 'live') {
    report(`tray: ${path} is already served by another tiny-tech daemon — not binding`)
    return null
  }
  if (state === 'dead') {
    try { unlinkSync(path) } catch (e: any) {
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
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return `[${r.state}]\n${r.result}`
  if (typeof r.message === 'string') return r.message
  if (typeof r.id === 'string') return `task ${r.id}`
  if (Array.isArray(r.commands)) return `tray protocol ${r.protocol} — ${(r.commands as string[]).join(', ')}`
  return JSON.stringify(r)
}
