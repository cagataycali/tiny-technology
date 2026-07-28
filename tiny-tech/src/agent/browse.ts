/**
 * use_browse — a REAL browser this agent drives, so the web it reads is the web
 * a person sees.
 *
 * `httpRequest` already fetches URLs, and for an API that's the right tool. It
 * is the wrong tool for the modern web: a single-page app returns an empty
 * `<div id="root">`, a docs site returns a loader, a search page returns
 * nothing. The agent then reports "the page was empty" about a page that is
 * full of text — the same class of silent failure as a truncation nobody
 * announces. A browser runs the JavaScript, so `text` returns what rendered.
 *
 * TWO REFUSALS, both against the gaps report's own suggestion:
 *
 *  1. **No `playwright-core`.** It exists to abstract three engines and to
 *     download its own browsers; we need one engine that is already installed
 *     on this machine, and `npx tiny-tech` must stay install-free (the rule the
 *     rest of device-tools follows: shell out to what the OS ships). Chrome
 *     speaks CDP, CDP is JSON, and Node 18+ has everything needed to speak it.
 *     So this file is the client — ~1 dependency-free transport instead of a
 *     100MB dependency tree plus a browser download.
 *
 *  2. **No TCP debugging port.** `--remote-debugging-port` is the shape every
 *     tutorial uses, and it opens an UNAUTHENTICATED full-control channel on
 *     localhost: any process under any account on this machine can attach,
 *     read every cookie, and drive the session. Same judgement as the tray
 *     socket (tray.ts): the daemon's local surfaces don't get world-reachable
 *     endpoints. `--remote-debugging-pipe` hands the protocol to fds 3 and 4 of
 *     OUR child process, so the parent-child relationship IS the access
 *     control, and there is nothing for anything else to connect to.
 *
 * THE PROFILE. devduck attached to the user's own Chrome profile, so its browse
 * tool inherited every logged-in session. That is no longer possible: current
 * Chrome refuses outright — "DevTools remote debugging requires a non-default
 * data directory" — and a second instance on a profile that is already open
 * dies on the SingletonLock (exit 21) regardless. So this launches its OWN
 * persistent profile under `~/.tiny/browser`. Persistent, not throwaway, is the
 * point: the user can `use_browse open` with `visible:true` once, log into the
 * site they want the agent to read, and every later headless call still has
 * that session.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import { imageBlock } from './computer.js'

// ── clamps ──────────────────────────────────────────────────────────────────

/**
 * Cap on text handed back from a page. Deliberately says so when it clips, for
 * the reason the whole codebase repeats: relay-poller clamps a device reply
 * again at 8000 chars, and a silent truncation upstream of a silent truncation
 * is how "the page was empty" gets reported.
 */
export const BROWSE_TEXT_MAX = 20_000

/** How long any single CDP call may take before the tool gives up on it. */
export const CDP_TIMEOUT_MS = 20_000

/** How long a navigation waits for the load event before answering anyway. */
export const NAV_TIMEOUT_MS = 20_000

/**
 * Idle reap. A headless Chrome left running forever is a few hundred MB the
 * user never asked for, and the daemon may live for weeks. Five minutes is long
 * enough that a multi-step read → click → read sequence never loses its page,
 * short enough that a forgotten browser doesn't outlive the conversation.
 */
export const BROWSE_IDLE_MS = 5 * 60_000

/** Links returned by `links` — enough to navigate with, not a sitemap dump. */
export const MAX_LINKS = 80

// ── where Chrome is ─────────────────────────────────────────────────────────

/**
 * Candidate browser binaries, in preference order. Chrome first because CDP is
 * its native protocol and it's what the vast majority of machines have; the
 * Chromium/Edge/Brave builds speak the identical protocol, so a machine without
 * Chrome still gets a browser rather than a "not supported".
 */
export function browserCandidates(
  plat: string = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // An explicit override is EXCLUSIVE, not merely first: a user who names a
  // browser has named it, and quietly driving a different one because their
  // path had a typo is how "why is it logged into the wrong account?" happens.
  // A missing override should say so — see findBrowser's message.
  if (env.TINY_BROWSER_BIN) return [env.TINY_BROWSER_BIN]
  const override: string[] = []
  if (plat === 'darwin') {
    return [
      ...override,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (plat === 'win32') {
    const pf = env['PROGRAMFILES'] || 'C:\\Program Files'
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = env['LOCALAPPDATA'] || 'C:\\Users\\Default\\AppData\\Local'
    return [
      ...override,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
  }
  return [
    ...override,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ]
}

export function findBrowser(
  plat: string = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const c of browserCandidates(plat, env)) if (exists(c)) return c
  return null
}

/** Register the tool only when a browser is actually installed here. */
export function hasBrowser(): boolean {
  return findBrowser() !== null
}

/** The dedicated profile — see the header: it can never be the user's own. */
export function browserProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TINY_BROWSER_PROFILE) return env.TINY_BROWSER_PROFILE
  const home = env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'browser')
}

/**
 * The launch argv.
 *
 * `--remote-debugging-pipe` (never `-port`) is the security decision from the
 * header. `--user-data-dir` is mandatory: current Chrome refuses remote
 * debugging on the default data directory, so omitting it doesn't degrade to
 * "uses the real profile", it fails to start the protocol at all.
 *
 * `--no-first-run`/`--no-default-browser-check` suppress dialogs that would
 * otherwise block the first launch of a fresh profile, and `--disable-*`
 * background work keeps a browser we only read from from doing housekeeping in
 * the background of someone's laptop.
 */
export function launchArgs(profileDir: string, opts: { visible?: boolean } = {}): string[] {
  return [
    ...(opts.visible ? [] : ['--headless=new']),
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--disable-component-update',
    '--metrics-recording-only',
    '--no-service-autorun',
    'about:blank',
  ]
}

/**
 * http(s) only. A browse tool that accepts any scheme is a way to turn a URL
 * string — which can arrive from a relay envelope, i.e. from ANOTHER user's
 * tiny — into `file:///Users/…/.ssh/id_rsa` rendered into a page this agent
 * then reads and summarizes back over the network. The daemon has fileEditor
 * for files the user meant to share; the browser gets the web.
 */
export function isBrowsableUrl(url: string): boolean {
  const u = String(url || '').trim()
  if (!u || /[\r\n]/.test(u)) return false
  return /^https?:\/\/[^/?#\s]+/i.test(u)
}

/** Bare `example.com` is what a model types; make it a URL rather than refusing. */
export function normalizeUrl(url: string): string {
  const u = String(url || '').trim()
  if (!u) return u
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u
  return `https://${u}`
}

// ── the wire ────────────────────────────────────────────────────────────────

/**
 * The pipe transport is NUL-delimited JSON, not newline-delimited — the one
 * detail that silently breaks a client copied from the WebSocket examples,
 * because a JSON message containing an escaped `\n` is still one message here.
 *
 * Framing gets its own pure decoder because every real bug in a stream reader
 * is a chunk-boundary bug: a message split across two reads, three messages in
 * one read, a trailing partial. None of those are reachable through a live
 * browser on demand, all of them are trivial to construct here.
 */
export function makeNulDecoder(
  onMessage: (msg: any) => void,
  onBadLine?: (line: string, err: Error) => void,
): (chunk: Buffer | string) => void {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))])
    let i: number
    while ((i = buf.indexOf(0)) >= 0) {
      const line = buf.subarray(0, i).toString('utf-8')
      buf = buf.subarray(i + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch (e: any) {
        // One unparseable frame must not kill the stream: the remaining bytes
        // are still a valid message sequence, and dropping them would strand
        // every pending call on a browser that is actually fine.
        onBadLine?.(line, e)
      }
    }
  }
}

export interface CdpTransport {
  send(line: string): void
  onMessage(cb: (msg: any) => void): void
  onClose(cb: (reason: string) => void): void
  close(): void
}

/**
 * A CDP client: request/reply pairing by id, plus events.
 *
 * Two properties matter more than the surface:
 *
 *  - **A pending call must never outlive the browser.** If Chrome dies (crash,
 *    OOM, the user quitting a visible window), the reply never arrives, and a
 *    promise that never settles hangs the agent's TURN — which may be a relay
 *    envelope with a web agent waiting on it. So transport close rejects
 *    everything outstanding.
 *  - **Every call has a timeout, and that timer is NOT unref'd.** Same lesson
 *    the local-tools and tasks work paid for: an unref'd timer cannot hold the
 *    event loop open, so a one-shot `tiny-tech "query"` would exit silently
 *    instead of reporting that the browser stopped answering.
 */
export class CdpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>()
  private closed: string | null = null

  constructor(private transport: CdpTransport, private timeoutMs = CDP_TIMEOUT_MS) {
    transport.onMessage((msg) => this.dispatch(msg))
    transport.onClose((reason) => this.fail(reason || 'browser closed'))
  }

  private dispatch(msg: any): void {
    if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(String(msg.error.message || 'cdp error')))
      else p.resolve(msg.result ?? {})
      return
    }
    if (msg && typeof msg.method === 'string') {
      for (const cb of this.listeners.get(msg.method) || []) {
        try { cb(msg.params || {}, msg.sessionId) } catch { /* a listener must not break the stream */ }
      }
    }
  }

  private fail(reason: string): void {
    this.closed = reason
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  get isClosed(): boolean {
    return this.closed !== null
  }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.closed))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(this.timeoutMs / 1000)}s`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.transport.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
      } catch (e: any) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(String(e?.message || e)))
      }
    })
  }

  on(method: string, cb: (params: any, sessionId?: string) => void): void {
    const list = this.listeners.get(method) || []
    list.push(cb)
    this.listeners.set(method, list)
  }

  /**
   * Wait for one event, or give up. Resolves `null` on timeout rather than
   * throwing: "the load event never fired" is information to report alongside
   * whatever DID render, not a reason to fail a navigation that may well have
   * worked (see the SPA note on `navigate`).
   */
  waitFor(method: string, ms: number): Promise<any | null> {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
      this.on(method, (params) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(params)
      })
    })
  }

  close(): void {
    this.fail('browser closed')
    this.transport.close()
  }
}

/** CDP transport over a child process's fd 3 (write) / fd 4 (read). */
export function pipeTransport(child: ChildProcess): CdpTransport {
  const w: any = child.stdio[3]
  const r: any = child.stdio[4]
  if (!w || !r) throw new Error('browser was not started with --remote-debugging-pipe (no fd 3/4)')
  let closeCb: (reason: string) => void = () => {}
  return {
    send: (line) => { w.write(line + '\0') },
    onMessage: (cb) => { r.on('data', makeNulDecoder(cb)) },
    onClose: (cb) => {
      closeCb = cb
      // Any of these means the protocol is gone: the browser exited, or the
      // pipe broke under us. Whichever fires first, pending calls must reject.
      child.once('exit', (code) => closeCb(`browser exited (code ${code})`))
      r.once('close', () => closeCb('browser pipe closed'))
      r.once('error', (e: any) => closeCb(`browser pipe error: ${String(e?.message || e)}`))
      w.once('error', (e: any) => closeCb(`browser pipe error: ${String(e?.message || e)}`))
    },
    close: () => { try { w.end() } catch { /* already gone */ } },
  }
}

// ── page-side expressions ───────────────────────────────────────────────────

/**
 * The rect of an element, for clicking.
 *
 * The obvious CDP route — `DOM.querySelector` then `DOM.getBoxModel` — does not
 * work: the nodeId from a querySelector is not valid for the box model call
 * without keeping the DOM agent's node map alive, and it fails with "Could not
 * find node with given id" on a perfectly present element. Measuring in the
 * page with `getBoundingClientRect` needs no node map, and is also what makes
 * `scrollIntoView` free — an element below the fold has viewport coordinates
 * that are off-screen, so a click at them lands on whatever IS there.
 *
 * `JSON.stringify` around the selector is load-bearing: the selector is
 * interpolated into JavaScript, so a raw `'` would end the string and the rest
 * would execute. Model-authored selectors are not hostile, but a selector
 * copied out of page content can be.
 */
export function rectExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, tag: el.tagName };
})()`
}

/** Visible text of the page, with runs of blank lines collapsed. */
export function textExpression(max: number = BROWSE_TEXT_MAX): string {
  // `innerText` and not `textContent`: textContent includes <script> bodies and
  // hidden nodes, which is how a "page text" answer becomes 40k of minified JS.
  // +1 so the caller can tell "exactly max" from "clipped".
  return `(() => {
  const t = (document.body && document.body.innerText) || '';
  return t.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${max + 1});
})()`
}

/**
 * Visible links, deduped by href. This is how an agent with no vision
 * navigates: a screenshot costs image tokens and still leaves it guessing at
 * coordinates, while "the label and the href" is directly actionable.
 */
export function linksExpression(max: number = MAX_LINKS): string {
  return `(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
    const r = a.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    seen.add(href);
    out.push({ text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100), href });
    if (out.length >= ${max}) break;
  }
  return out;
})()`
}

/**
 * CDP key parameters. `Input.insertText` handles typing, so this table only
 * needs the keys that MEAN something rather than produce a character — the ones
 * that submit a form, move focus, or dismiss an overlay.
 *
 * An unknown key returns null instead of guessing: dispatching a keystroke with
 * a wrong keyCode silently does nothing, which reads to the model as "the site
 * ignored Enter" and sends it down a debugging path that has no bug in it.
 */
export function keyDescriptor(key: string): Record<string, any> | null {
  const k = String(key || '').toLowerCase()
  const table: Record<string, { key: string; code: string; vk: number; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
    escape: { key: 'Escape', code: 'Escape', vk: 27 },
    esc: { key: 'Escape', code: 'Escape', vk: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    delete: { key: 'Delete', code: 'Delete', vk: 46 },
    up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    home: { key: 'Home', code: 'Home', vk: 36 },
    end: { key: 'End', code: 'End', vk: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  }
  const d = table[k]
  if (!d) return null
  return { key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, ...(d.text ? { text: d.text } : {}) }
}

/** Clamp page text and SAY it was clamped (never a silent shear). */
export function clampText(s: string, max: number = BROWSE_TEXT_MAX): string {
  const t = String(s ?? '')
  return t.length > max ? `${t.slice(0, max)}\n…[clipped at ${max} chars]` : t
}

export function formatLinks(links: Array<{ text: string; href: string }>): string {
  if (!links?.length) return 'no links on this page'
  return links.map((l) => `- ${l.text || '(no label)'} → ${l.href}`).join('\n')
}

// ── the browser ─────────────────────────────────────────────────────────────

interface Session {
  child: ChildProcess
  cdp: CdpClient
  sessionId: string
  visible: boolean
  lastUsed: number
  reaper: NodeJS.Timeout
}

let session: Session | null = null

/** Test seam: pretend a browser is (or isn't) running without launching one. */
export function __setSessionForTest(s: any): void {
  session = s
}

function touch(): void {
  if (session) session.lastUsed = Date.now()
}

function shutdown(): void {
  if (!session) return
  const s = session
  session = null
  clearTimeout(s.reaper)
  try { s.cdp.close() } catch { /* already gone */ }
  // Closing the pipe is enough — a Chrome started with --remote-debugging-pipe
  // exits when its protocol pipe closes (verified). SIGKILL is the backstop for
  // a build that doesn't, so a reaped session can never leak a process.
  setTimeout(() => { try { s.child.kill('SIGKILL') } catch { /* gone */ } }, 1500).unref()
}

let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // On `exit`, not on a signal: TinyAgent.init() registers its own SIGTERM
  // handler that calls process.exit(0), so a signal handler added here may
  // never run — the exact bug the tray socket shipped with. `exit` fires
  // however the process leaves.
  process.on('exit', () => {
    if (session) { try { session.child.kill('SIGKILL') } catch { /* gone */ } }
  })
}

async function launch(visible: boolean): Promise<Session> {
  const bin = findBrowser()
  if (!bin) {
    // Distinguish the two failures: "nothing installed" is the user's cue to
    // install Chrome, while "your override doesn't exist" is a typo they can
    // only fix if we name the path we actually tried.
    throw new Error(
      process.env.TINY_BROWSER_BIN
        ? `no Chrome/Chromium/Edge found — TINY_BROWSER_BIN points at ${process.env.TINY_BROWSER_BIN}, which does not exist`
        : 'no Chrome/Chromium/Edge found — install Google Chrome, or set TINY_BROWSER_BIN to a Chromium-based browser',
    )
  }
  const profile = browserProfileDir()
  mkdirSync(profile, { recursive: true })
  const child = spawn(bin, launchArgs(profile, { visible }), {
    // fds 3 and 4 are the CDP pipe. stderr is ignored: Chrome writes pages of
    // GPU/font warnings there, and a piped stderr nobody drains fills its
    // buffer and blocks the browser.
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  })

  // A spawned child and its pipes HOLD THE EVENT LOOP OPEN. Without these
  // unrefs, `tiny-tech "read this page"` would print its answer and then hang
  // forever with a live browser attached — the mirror image of the local-tools
  // lesson (there an unref'd timer let the process exit too EARLY). The
  // per-call timeout timers are deliberately NOT unref'd, so the loop is held
  // exactly while a call is in flight and released when the agent is idle.
  child.unref()
  ;(child.stdio[3] as any)?.unref?.()
  ;(child.stdio[4] as any)?.unref?.()
  installExitHook()

  const cdp = new CdpClient(pipeTransport(child))
  const targets = await cdp.send('Target.getTargets')
  const page = (targets.targetInfos || []).find((t: any) => t.type === 'page')
  if (!page) throw new Error('browser started but exposed no page target')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)

  /**
   * A JavaScript dialog BLOCKS the renderer, and with it every later
   * Runtime.evaluate — verified: a page calling `alert()` makes the next
   * evaluate hang until the tool's timeout, forever, on every subsequent call.
   * There is no human to click OK on a headless browser, so the only correct
   * behaviour is to dismiss dialogs ourselves. `accept: true` because the
   * common case is a cookie/consent `confirm()` where dismissing means the page
   * never proceeds; `Page.enable` above is what makes the event arrive at all.
   */
  cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid || sessionId).catch(() => {})
  })

  const reaper = setInterval(() => {
    if (session && Date.now() - session.lastUsed > BROWSE_IDLE_MS) shutdown()
  }, 30_000)
  // THIS timer is unref'd, and that's the opposite call from the per-call
  // timeout on purpose: a background reaper must never be the reason a process
  // stays alive, while a pending call must be.
  reaper.unref()

  session = { child, cdp, sessionId, visible, lastUsed: Date.now(), reaper }
  return session
}

/**
 * The live session, launching one if needed. A mode change relaunches: a
 * headless browser cannot be made visible in place, and silently ignoring
 * `visible:true` would leave the user waiting for a window that never opens.
 */
async function ensure(visible = false): Promise<Session> {
  if (session && session.cdp.isClosed) shutdown()
  if (session && session.visible !== visible) shutdown()
  if (!session) return launch(visible)
  touch()
  return session
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(s: Session, expression: string, awaitPromise = false): Promise<any> {
  const r = await s.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise, userGesture: true },
    s.sessionId,
  )
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error(String(d.exception?.description || d.text || 'page threw').split('\n')[0])
  }
  return r.result?.value
}

async function currentUrl(s: Session): Promise<string> {
  try { return String(await evaluate(s, 'location.href')) } catch { return '(unknown)' }
}

// ── the tool ────────────────────────────────────────────────────────────────

export interface BrowseArgs {
  action: string
  url?: string
  selector?: string
  text?: string
  key?: string
  expression?: string
  x?: number
  y?: number
  amount?: number
  visible?: boolean
  full_page?: boolean
}

/**
 * Everything that can be refused WITHOUT a browser, refused before one exists.
 *
 * Written as its own pure function because the ordering is the point, and the
 * test suite caught it the wrong way round: launching costs ~300MB of RAM and a
 * second of latency, so a hostile `file:///…` URL or a missing argument must
 * never get that far. A refusal that spends a browser process first is a
 * refusal an attacker can use as a resource-exhaustion primitive.
 */
export function refuseBeforeLaunch(a: BrowseArgs): string | null {
  switch (a.action) {
    case 'open':
    case 'goto': {
      if (!a.url) return 'need url'
      const url = normalizeUrl(a.url)
      if (!isBrowsableUrl(url)) return `refused: use_browse takes http(s) URLs, not ${String(a.url).slice(0, 60)}`
      return null
    }
    case 'type':
      return a.text == null ? 'need text' : null
    case 'key':
      if (!a.key) return 'need key (enter, tab, escape, up, down, …)'
      return keyDescriptor(a.key) ? null : `unknown key: ${a.key}`
    case 'eval':
      return a.expression ? null : 'need expression'
    case 'click':
      return a.selector || (a.x != null && a.y != null) ? null : 'need selector, or x + y'
    default:
      return null
  }
}

export async function runBrowse(a: BrowseArgs): Promise<any> {
  try {
    // `close` and `status` must work without launching anything — a status
    // action that starts a browser to tell you no browser is running is a joke
    // the user pays for in RAM.
    if (a.action === 'close') {
      if (!session) return '🌐 no browser was running'
      shutdown()
      return '🌐 browser closed'
    }
    if (a.action === 'status') {
      if (!session) return `🌐 no browser running (profile: ${browserProfileDir()})`
      const url = await currentUrl(session)
      const idle = Math.round((Date.now() - session.lastUsed) / 1000)
      return `🌐 ${session.visible ? 'visible' : 'headless'} browser at ${url} — idle ${idle}s (reaped after ${Math.round(BROWSE_IDLE_MS / 60000)}min)`
    }

    const refusal = refuseBeforeLaunch(a)
    if (refusal) return refusal

    const s = await ensure(a.visible === true)

    switch (a.action) {
      case 'open':
      case 'goto': {
        const url = normalizeUrl(a.url!)
        // Arm the load wait BEFORE navigating: the event for a cached page can
        // arrive before the navigate call's own reply does.
        const loaded = s.cdp.waitFor('Page.loadEventFired', NAV_TIMEOUT_MS)
        const nav = await s.cdp.send('Page.navigate', { url }, s.sessionId)
        if (nav.errorText) return `🌐 could not load ${url}: ${nav.errorText}`
        const fired = await loaded
        const title = await evaluate(s, 'document.title')
        const text = await evaluate(s, textExpression())
        const here = await currentUrl(s)
        return (
          `🌐 ${title || '(untitled)'} — ${here}` +
          (fired ? '' : `\n⚠️ the load event did not fire within ${NAV_TIMEOUT_MS / 1000}s; this is what had rendered by then`) +
          `\n\n${clampText(String(text || '')) || '(no text — the page may be canvas/image only; try screenshot)'}`
        )
      }

      case 'text': {
        const text = await evaluate(s, textExpression())
        return `🌐 ${await currentUrl(s)}\n\n${clampText(String(text || '')) || '(no text on this page)'}`
      }

      case 'links': {
        const links = await evaluate(s, linksExpression())
        return `🔗 ${await currentUrl(s)}\n${formatLinks(links || [])}`
      }

      case 'html': {
        const html = await evaluate(s, `document.documentElement.outerHTML.slice(0, ${BROWSE_TEXT_MAX + 1})`)
        return `🌐 ${await currentUrl(s)}\n\n${clampText(String(html || ''))}`
      }

      case 'screenshot': {
        const shot = await s.cdp.send(
          'Page.captureScreenshot',
          { format: 'png', ...(a.full_page ? { captureBeyondViewport: true } : {}) },
          s.sessionId,
        )
        if (!shot.data) return 'screenshot failed (no image data)'
        return [
          { text: `🌐 screenshot of ${await currentUrl(s)} — coordinates on this image are page coordinates you can click directly.` },
          imageBlock(Buffer.from(shot.data, 'base64')),
        ]
      }

      case 'click': {
        let x = a.x
        let y = a.y
        if (a.selector) {
          const rect = await evaluate(s, rectExpression(a.selector))
          if (!rect) return `no element matches ${a.selector}`
          x = rect.x
          y = rect.y
        }
        if (x == null || y == null) return 'need selector, or x + y'
        // (refuseBeforeLaunch already rejected a call with neither; this catches
        // the case where a selector matched an element with no usable rect.)
        // A click that navigates gives no reply of its own, so the caller finds
        // out by asking for text afterwards; racing a load event here would
        // stall every click that DOESN'T navigate for the full timeout.
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await s.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s.sessionId)
        }
        return `🖱️ clicked ${a.selector || `${x},${y}`}`
      }

      case 'type': {
        if (a.selector) {
          const rect = await evaluate(s, rectExpression(a.selector))
          if (!rect) return `no element matches ${a.selector}`
          for (const type of ['mousePressed', 'mouseReleased'] as const) {
            await s.cdp.send(
              'Input.dispatchMouseEvent',
              { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
              s.sessionId,
            )
          }
        }
        // insertText, not per-character key events: it is layout-independent,
        // it handles emoji, and it's one round trip instead of one per char.
        await s.cdp.send('Input.insertText', { text: a.text }, s.sessionId)
        return `⌨️ typed ${a.text!.length} chars${a.selector ? ` into ${a.selector}` : ''}`
      }

      case 'key': {
        const d = keyDescriptor(a.key!)!
        const loaded = s.cdp.waitFor('Page.loadEventFired', 3000)
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...d }, s.sessionId)
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d, text: undefined }, s.sessionId)
        // Enter on a form submits, and reporting the new URL saves the model a
        // round trip. A 3s wait, not the full nav timeout: most keys navigate
        // nothing, and a single-page app fires no load event at ALL (verified —
        // history.pushState does not), so this can only ever be a hint.
        const fired = await loaded
        return `⌨️ ${a.key}${fired ? ` — navigated to ${await currentUrl(s)}` : ''}`
      }

      case 'scroll': {
        const amount = a.amount ?? 600
        await evaluate(s, `window.scrollBy(0, ${Number(amount) || 0}); String(window.scrollY)`)
        return `📜 scrolled ${amount}px`
      }

      case 'eval': {
        const v = await evaluate(s, a.expression!, true)
        const out = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
        return `🧪 ${clampText(out)}`
      }

      case 'back':
      case 'forward': {
        await evaluate(s, a.action === 'back' ? 'history.back()' : 'history.forward()')
        // No load event to wait on for a same-document entry, so settle briefly
        // and report where we ended up rather than claiming success blindly.
        await new Promise((r) => setTimeout(r, 600))
        return `🌐 ${a.action} → ${await currentUrl(s)}`
      }

      default:
        return `unknown action: ${a.action}`
    }
  } catch (e: any) {
    // A thrown tool aborts the agent's turn; a returned failure lets it adapt —
    // and a dead browser should cost one action, not the conversation.
    return `browse error: ${String(e?.message || e).slice(0, 500)}`
  }
}

export const BROWSE_DESCRIPTION = `🌐 A REAL browser on this machine — use it when httpRequest isn't enough: JavaScript apps, pages behind a login, anything where the HTML source isn't what a person sees.
- open (url) — navigate and return the page's title + rendered text
- text / html — re-read the current page
- links — visible links as label → href (cheaper and more precise than a screenshot for navigating)
- screenshot (full_page optional) — the actual image, when layout matters
- click (selector, or x + y) / type (text, selector optional) / key (enter, tab, escape, …)
- scroll (amount) / back / forward / eval (expression — runs in the page, awaits promises)
- status / close — close when you're done with a task; it also closes itself after 5 idle minutes

The browser keeps ONE persistent profile of its own, so logins survive between calls: if a site needs a login, ask the user to run open with visible:true once and sign in — after that headless calls stay signed in. Prefer selectors over coordinates (they survive layout changes), and re-read text after anything that changes the page.`

export function makeBrowseTool() {
  return tool({
    name: 'use_browse',
    description: BROWSE_DESCRIPTION,
    inputSchema: z.object({
      action: z.string(),
      url: z.string().optional(),
      selector: z.string().optional().describe('CSS selector for click/type.'),
      text: z.string().optional().describe('Text to type (action:type).'),
      key: z.string().optional(),
      expression: z.string().optional().describe('JavaScript to run in the page (action:eval).'),
      x: z.number().optional(),
      y: z.number().optional(),
      amount: z.number().optional().describe('Pixels to scroll (action:scroll).'),
      visible: z.boolean().optional().describe('Open a real window instead of headless — for the user to log in.'),
      full_page: z.boolean().optional(),
    }),
    callback: async (a) => runBrowse(a as BrowseArgs),
  })
}

/**
 * The system-prompt line. The tool description teaches the actions, but the
 * agent needs to know this exists BEFORE it reaches for httpRequest on a
 * JavaScript-rendered page — that mistake doesn't error, it returns an empty
 * shell that the model then reports as an empty page.
 */
export function browseBlock(): string {
  return (
    '\nYou have a real browser (use_browse): pages that need JavaScript, a login, or a click. ' +
    'httpRequest is still right for APIs and static files — but if a fetched page looks empty or ' +
    'like a loading shell, open it in use_browse instead of reporting it as empty.'
  )
}
