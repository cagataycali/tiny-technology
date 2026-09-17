/**
 * 🔔 Native notifications and PROMPTS on this machine, behind a pluggable backend.
 *
 * Why a backend seam instead of just calling osascript: `display notification`
 * on macOS returns exit 0 while showing NOTHING when Notification Center
 * permission is missing (measured on studio-mac, 2026-08-14) — the worst
 * possible outcome for a confirmation. And `display dialog` cannot be styled at
 * all: a title, a text body, three buttons, one static icon. No layout, no
 * colour, no animation. tiny's logo is block-glyph terminal art, so there is no
 * image to show there even in principle.
 *
 * So the plan is two backends behind one tool surface: `osascript` lands today
 * and actually returns answers, and a SwiftUI panel in menubar/ (which already
 * speaks an `ask` protocol) registers itself later and takes over transparently.
 * Nothing that calls use_notify has to change when that happens.
 *
 * No dependencies: node-notifier ships three bundled helper binaries, and this
 * repo's rule is that `npx tiny-tech` stays install-free — nothing to compile
 * per Node ABI, nothing to sign.
 */
import { tool } from '@strands-agents/sdk'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:process'
import { hostname } from 'node:os'
import { trayNotifications, traySocketPath } from '../tray.js'

/** A question's answer, or why there isn't one. */
export interface NotifyResult {
  /** Did the human actually see it? False when the backend only *claimed* success. */
  shown: boolean
  /** Which backend served it — say this out loud so a silent drop is visible. */
  backend: string
  /** The button/choice/text they gave, when it was a question. */
  answer?: string
  /** They dismissed it, or it timed out. */
  cancelled?: boolean
  error?: string
  /**
   * INTERNAL: this backend could not serve the request after all (a tray that
   * stopped watching mid-prompt), so notify() should try the next one. Never
   * reaches a caller — notify() strips it.
   */
  fellThrough?: boolean
}

export interface NotifyRequest {
  title: string
  body: string
  /** A question turns this into a prompt that waits for an answer. */
  kind?: 'info' | 'confirm' | 'select' | 'text'
  /** Choices for kind=select, or the two button labels for confirm. */
  options?: string[]
  /** Extra context rendered as rows — a rich backend shows these properly. */
  context?: Record<string, string>
  /** System sound name (macOS /System/Library/Sounds) or 'none'. */
  sound?: string
  /** Seconds to wait for an answer before giving up. */
  timeoutSec?: number
}

export interface NotifyBackend {
  name: string
  /** Cheap check — is this backend usable on this machine right now? */
  available: () => boolean | Promise<boolean>
  /** Higher wins. The SwiftUI panel outranks osascript once it exists. */
  priority: number
  send: (req: NotifyRequest) => Promise<NotifyResult>
}

const backends: NotifyBackend[] = []
/** The backends this module ships with — what resetNotifyBackends() restores. */
const builtins: NotifyBackend[] = []

/**
 * Register a backend. The Swift panel calls this at startup to outrank
 * osascript; tests call it to replace both with something that records.
 */
export function registerNotifyBackend(b: NotifyBackend): void {
  const i = backends.findIndex((x) => x.name === b.name)
  if (i >= 0) backends[i] = b
  else backends.push(b)
  backends.sort((a, b2) => b2.priority - a.priority)
}

/**
 * Remove a backend by name. The counterpart to register: a registry you can
 * only add to is a leak, and a test that swaps a backend out has no way back —
 * which is exactly how a fake named 'osascript' silently disabled the real one
 * for a whole test process.
 */
export function unregisterNotifyBackend(name: string): boolean {
  const i = backends.findIndex((b) => b.name === name)
  if (i < 0) return false
  backends.splice(i, 1)
  return true
}

/** Back to a known state: only the built-in backends, in their own order. */
export function resetNotifyBackends(): void {
  backends.length = 0
  for (const b of builtins) registerNotifyBackend(b)
}

export function notifyBackends(): string[] {
  return backends.map((b) => b.name)
}

/** Highest-priority backend that says it can run here, or null. */
export async function pickNotifyBackend(): Promise<NotifyBackend | null> {
  for (const b of backends) {
    try {
      if (await b.available()) return b
    } catch { /* an unavailable backend must never break the next one */ }
  }
  return null
}

/** Run a binary with args as ARGV — never string-interpolated into a script. */
function run(cmd: string, args: string[], timeoutSec: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: Math.max(1, timeoutSec) * 1000 }, (e: any, stdout, stderr) => {
      resolve({ code: e?.code ?? 0, out: String(stdout || '').trim(), err: String(stderr || e?.message || '').trim() })
    })
    p.on('error', () => resolve({ code: -1, out: '', err: 'spawn failed' }))
  })
}

const SOUND_DIR = '/System/Library/Sounds'
export const DEFAULT_SOUND = 'Tink'

/**
 * Play a system sound. This is the ONLY part of a macOS notification that is
 * permission-free and verifiable, so it stays independent of the visual path:
 * even when a banner is silently dropped, the chime still lands.
 */
export async function playSound(name = DEFAULT_SOUND): Promise<boolean> {
  if (platform !== 'darwin' || !name || name === 'none') return false
  const file = name.startsWith('/') ? name : `${SOUND_DIR}/${name}.aiff`
  if (!existsSync(file)) return false
  const r = await run('afplay', [file], 10)
  return r.code === 0
}

/**
 * AppleScript, argv-safe. The script reads its text from `argv` rather than
 * having it pasted in, because a body containing a quote would otherwise be
 * AppleScript injection — and bodies here carry arbitrary tool output.
 */
async function osa(script: string, args: string[], timeoutSec: number) {
  return run('osascript', ['-e', script, ...args], timeoutSec)
}

/**
 * What the user actually READS. A dialog has nowhere to put context but the
 * body, so everything goes here — and the body is never allowed to be empty.
 *
 * Why: the tool only requires `title`, so an agent asking a quick yes/no sent
 * body:'' and the user got a box with nothing to read and two buttons. "yes no"
 * with no question is not a decision, it is a guess. If body is missing we fall
 * back to the title, so the question is always legible.
 *
 * The provenance line answers the other half of "no context": with a dozen mesh
 * peers and background loops on one machine, WHICH tiny is asking matters as
 * much as what it asks. A dialog that cannot say who opened it is a dialog you
 * should not trust.
 */
export function dialogBody(req: NotifyRequest): string {
  const rows = Object.entries(req.context || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  const asked = (req.body || '').trim() || req.title
  return [asked, rows, provenanceLine()].filter(Boolean).join('\n\n')
}

/** Who is asking, and from where — foreground turn or a background loop. */
export function provenanceLine(): string {
  const who = process.env.TINY_DEVICE_NAME || hostname().replace(/\.local$/, '')
  const loop = process.env.TINY_LOOP_ID
  return loop ? `— tiny on ${who}, background loop ${loop}` : `— tiny on ${who}`
}

const osascriptBackend: NotifyBackend = {
  name: 'osascript',
  priority: 10,
  available: () => platform === 'darwin',
  async send(req) {
    const timeout = Math.max(5, req.timeoutSec ?? 120)
    const body = dialogBody(req)
    void playSound(req.sound)

    if (req.kind === 'confirm' || req.kind === 'text') {
      const [no, yes] = req.options?.length === 2 ? req.options : ['No', 'Yes']
      const wantsText = req.kind === 'text'
      const script = wantsText
        ? 'on run {t, b} \n set r to display dialog b with title t default answer "" giving up after ' + timeout +
          ' \n if gave up of r then return "__TIMEOUT__" \n return text returned of r \n end run'
        : 'on run {t, b, n, y} \n set r to display dialog b with title t buttons {n, y} default button y giving up after ' + timeout +
          ' \n if gave up of r then return "__TIMEOUT__" \n return button returned of r \n end run'
      const r = await osa(script, wantsText ? [req.title, body] : [req.title, body, no, yes], timeout + 5)
      if (r.out === '__TIMEOUT__') return { shown: true, backend: 'osascript', cancelled: true }
      // User dismissed: osascript exits 1 with "User canceled".
      if (r.code !== 0) return { shown: true, backend: 'osascript', cancelled: true, error: r.err || undefined }
      return { shown: true, backend: 'osascript', answer: r.out }
    }

    if (req.kind === 'select') {
      const opts = (req.options || []).filter(Boolean)
      if (!opts.length) return { shown: false, backend: 'osascript', error: 'select needs options' }
      // The list is argv too, so a choice containing quotes stays intact.
      const script = 'on run argv \n set t to item 1 of argv \n set b to item 2 of argv \n' +
        ' set opts to items 3 thru -1 of argv \n' +
        ' set r to choose from list opts with title t with prompt b \n' +
        ' if r is false then return "__CANCELLED__" \n return item 1 of r \n end run'
      const r = await osa(script, [req.title, body, ...opts], timeout + 5)
      if (r.out === '__CANCELLED__' || r.code !== 0) return { shown: true, backend: 'osascript', cancelled: true }
      return { shown: true, backend: 'osascript', answer: r.out }
    }

    // Plain info. `display notification` is UNVERIFIABLE — it exits 0 while
    // showing nothing without permission — so `shown` is reported honestly as
    // unknown-at-best, and the sound is what actually reaches the human.
    const script = 'on run {t, b} \n display notification b with title t \n end run'
    const r = await osa(script, [req.title, body], 15)
    if (r.code !== 0) return { shown: false, backend: 'osascript', error: r.err || 'notification refused' }
    return { shown: false, backend: 'osascript(unverified banner + sound)' }
  },
}

builtins.push(osascriptBackend)
registerNotifyBackend(osascriptBackend)

/** How recently a tray must have polled for us to believe someone is watching. */
export const TRAY_FRESH_MS = 10_000
/** How long a tray prompt waits before we give up and open a dialog instead. */
export const TRAY_ANSWER_TIMEOUT_MS = 25_000

/**
 * The menu-bar push channel. Outranks osascript because a SwiftUI panel can
 * render what a `display dialog` cannot: context rows, colour, a real layout.
 *
 * available() is the whole safety story. A queued prompt is only useful if
 * something is DRAINING the queue, so a live socket is not enough evidence —
 * the daemon serving that socket may have no menu-bar helper attached at all,
 * and a confirm queued into that would hang until its timeout with the user
 * never seeing a thing. So the test is: the socket exists AND a tray drained
 * within TRAY_FRESH_MS. Nobody watching ⇒ unavailable ⇒ the dialog happens.
 *
 * The provenance line comes from dialogBody()/provenanceLine() rather than
 * being re-derived here, so a tray panel says who is asking in exactly the
 * words a dialog would.
 */
export const trayBackend: NotifyBackend = {
  name: 'tray',
  priority: 20,
  available: () => {
    const q = trayNotifications()
    if (!q.fresh(TRAY_FRESH_MS)) return false
    try { return existsSync(traySocketPath()) } catch { return false }
  },
  async send(req) {
    const q = trayNotifications()
    const item = q.enqueue({
      kind: req.kind || 'info',
      title: req.title,
      body: (req.body || '').trim() || req.title,
      options: req.options,
      // Same provenance a dialog shows, as a context row: a rich renderer gets
      // to lay it out instead of having it glued onto the end of the body.
      context: { ...(req.context || {}), asked_by: provenanceLine().replace(/^—\s*/, '') },
      sound: req.sound,
      needsAnswer: !!req.kind && req.kind !== 'info',
    })
    void playSound(req.sound)

    // Fire-and-forget: an info card needs no answer, and the tray has it.
    if (!item.needsAnswer) return { shown: true, backend: 'tray' }

    const waitMs = Math.max(1_000, Math.min((req.timeoutSec ?? 120) * 1000, TRAY_ANSWER_TIMEOUT_MS))
    const ans = await q.await(item.id, waitMs)
    // Nobody answered. NOT a cancellation — the user never saw it — so hand the
    // question to the next backend rather than reporting a decision that was
    // never made.
    if (!ans) return { shown: false, backend: 'tray', fellThrough: true, error: 'no answer from the tray in time' }
    if (ans.cancelled) return { shown: true, backend: 'tray', cancelled: true }
    return { shown: true, backend: 'tray', answer: ans.value ?? '' }
  },
}

builtins.push(trayBackend)
registerNotifyBackend(trayBackend)

/**
 * Send a notification / ask a question through the best available backend.
 * Never throws: a machine with no backend (Linux, CI, a headless daemon) gets a
 * result saying so, because a notification failing must not fail the work that
 * asked for it.
 */
export async function notify(req: NotifyRequest): Promise<NotifyResult> {
  let tried = 0
  let last: NotifyResult | null = null
  for (const b of backends) {
    let ok = false
    try { ok = await b.available() } catch { ok = false }
    if (!ok) continue
    tried++
    let r: NotifyResult
    try {
      r = await b.send(req)
    } catch (e: any) {
      r = { shown: false, backend: b.name, error: String(e?.message || e) }
    }
    // A backend may DECLINE after the fact — the tray took the prompt and
    // nobody ever looked at it. Falling through here is the difference between
    // "the user dismissed it" and "the question never reached a human".
    if (r.fellThrough) { last = r; continue }
    return r
  }
  if (!tried) return { shown: false, backend: 'none', error: `no notification backend on ${platform}` }
  const { fellThrough: _drop, ...rest } = last || { shown: false, backend: 'none' }
  return { ...rest, error: rest.error || 'every notification backend declined' } as NotifyResult
}

export const NOTIFY_DESCRIPTION = `🔔 Native notification on this machine — and the way to ASK the user something when they are not watching the terminal.
- kind='info' (default): a banner + sound. Fire-and-forget.
- kind='confirm': a real dialog, returns which button they pressed (options=['No','Yes'] to relabel).
ALWAYS send body= for confirm/select/text: it is the question itself, and it is the only
thing the user can read. A dialog whose body you left empty shows two buttons and nothing
else, which asks them to guess. Put the situation in context= rows — what you are about to
do, to which file or device, and what happens if they say no.
- kind='select': a picker, returns the chosen option (options required).
- kind='text': a dialog with a text field, returns what they typed.
- context: {label: value} rows shown alongside the body.
- sound: a macOS system sound name (Tink, Glass, Hero, Submarine, Ping…) or 'none'.
- timeout_sec: how long to wait for an answer (default 120).
Use this from BACKGROUND work — a loop that needs a decision, or one that just finished. The reply tells you which backend served it and whether it was actually verifiable, so a silently-dropped banner is visible to you rather than assumed delivered.`

export function makeNotifyTool() {
  return tool({
    name: 'use_notify',
    description: NOTIFY_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short headline' },
        body: { type: 'string', description: 'the message, or the question being asked — REQUIRED in practice for confirm/select/text; without it the user sees only buttons' },
        kind: { type: 'string', enum: ['info', 'confirm', 'select', 'text'], description: 'info (default), confirm, select or text' },
        options: { type: 'array', items: { type: 'string' }, description: 'choices for select; two button labels for confirm' },
        context: { type: 'object', description: 'extra {label: value} rows' },
        sound: { type: 'string', description: "system sound name, or 'none'" },
        timeout_sec: { type: 'number', description: 'seconds to wait for an answer (default 120)' },
      },
      required: ['title'],
    },
    callback: async (input: any) => {
      const title = String(input?.title || '').trim()
      if (!title) return 'need a title'
      const kind = String(input?.kind || 'info') as NotifyRequest['kind']
      const options = Array.isArray(input?.options) ? input.options.map((o: any) => String(o)) : undefined
      const context: Record<string, string> = {}
      for (const [k, v] of Object.entries(input?.context || {})) context[String(k)] = String(v)

      const r = await notify({
        title,
        body: String(input?.body || ''),
        kind,
        options,
        context,
        sound: input?.sound === undefined ? DEFAULT_SOUND : String(input.sound),
        timeoutSec: Number(input?.timeout_sec) || 120,
      })

      if (r.error && !r.answer) return `🔔 could not notify (${r.backend}): ${r.error}`
      if (r.cancelled) return `🔔 no answer — dismissed or timed out (${r.backend})`
      if (r.answer !== undefined) return `🔔 answered via ${r.backend}: ${r.answer}`
      // An unverifiable banner says so, rather than claiming delivery.
      return r.shown
        ? `🔔 shown via ${r.backend}`
        : `🔔 sent via ${r.backend} — the sound played, but macOS does not confirm the banner appeared (permission may be off). Say it in chat too if it matters.`
    },
  })
}

