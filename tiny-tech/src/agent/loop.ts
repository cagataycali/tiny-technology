/**
 * ♾️ Background loops — the one rail for work that outlives its turn.
 *
 * Built for work with no single answer, only progress: "keep refactoring until
 * the tests pass", "monitor this deploy all afternoon", "work through these 200
 * files". The /loop TUI mode has the right MOTION (iterate until [LOOP_DONE])
 * but the wrong LIFETIME: it lives inside the foreground turn loop of a
 * terminal the user has to keep open and keep their hands off.
 *
 * It also carries the one-shot jobs that use_tasks used to ("summarise this
 * repo", 15-minute timeout, fresh agent, run once). That tool is gone; a loop
 * covers the same ground by emitting [LOOP_DONE] on its first iteration, which
 * the system prompt asks for explicitly. Worth knowing: one-shots now share the
 * MAX_ACTIVE_LOOPS slots, and a loop that never says [LOOP_DONE] keeps working
 * to its caps rather than stopping after one pass.
 *
 * So: `use_loop start` returns an id immediately, and ONE fresh agent iterates
 * in the background — invoke → check for [LOOP_DONE] → cooldown → invoke again
 * — for hours if it has to. Not one agent per iteration: the SAME agent, so
 * iteration 12 remembers what iteration 3 learned. Context overflow is the
 * agent's own problem to heal (TinyAgent already clears + retries), and each
 * iteration's tail is journaled to disk so a crash loses minutes, not hours.
 *
 * ── the decisions ───────────────────────────────────────────────────────────
 *
 *  - **One agent across iterations, fresh per LOOP.** The whole value over
 *    a one-shot job is accumulated context: "continue" means something. Two
 *    loops never share an agent (same interleaving rule as forks/mesh).
 *
 *  - **A loop agent cannot start loops.** Depth 1, the same
 *    invisible-fan-out reasoning that governs forks and relay envelopes — but
 *    it matters more here, because a loop that spawns a loop runs *forever* by
 *    default.
 *
 *  - **The journal is the source of truth, written every iteration.** A loop
 *    is hours of state in a process that restarts (launchd, crash, deploy).
 *    Each iteration appends {n, at, summary} atomically; `interrupted` on a
 *    dead pid tells the user exactly how far it got and lets them resume with
 *    the journal as context.
 *
 *  - **Wall-clock and iteration caps, both.** An iteration cap alone is
 *    gameable by a model that answers fast and burns 500 iterations in ten
 *    minutes; a wall-clock cap alone lets a wedged model call hold a slot all
 *    day. Defaults: 1000 iterations / 365 days / 30s cooldown — the iteration
 *    cap and the per-iteration timeout do the real bounding; the wall cap is
 *    a backstop, not a budget.
 *
 *  - **stop() stops the LOOP, not the iteration in flight** — an honest
 *    contract: nothing can abort a model turn mid-flight.
 *    The in-flight iteration finishes, its summary lands in the journal, and
 *    no further iteration starts.
 *
 *  - **News is delivered once, per finished loop AND per progress milestone.**
 *    A loop running for 6 hours with zero surface until the end is
 *    indistinguishable from a hung one; every Nth iteration (default 10)
 *    flags a progress line for the next foreground turn.
 */
import { tool } from '@strands-agents/sdk'
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export function loopsDir(): string {
  if (process.env.TINY_LOOPS_DIR) return process.env.TINY_LOOPS_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'loops')
}

/** Iteration cap — the "model answers fast" bound. Default 1000; overridable
 *  per machine with TINY_LOOP_MAX_ITERATIONS, and per LOOP via
 *  `use_loop start max_iterations=N`. */
const envMaxIters = Number(process.env.TINY_LOOP_MAX_ITERATIONS)
export const LOOP_MAX_ITERATIONS =
  Number.isFinite(envMaxIters) && envMaxIters >= 1 ? Math.floor(envMaxIters) : 1000
/** Wall-clock cap. 365 days by default — effectively "run until done".
 *  It used to be 12h, which only ever killed HEALTHY multi-day runs: a wedged
 *  iteration is already bounded by LOOP_ITER_TIMEOUT_MS, and a loop making
 *  no progress is bounded by the iteration cap, so a short wall cap guarded
 *  against nothing and cost real work. Overridable per machine with
 *  TINY_LOOP_MAX_WALL_HOURS (minimum 1). */
const envMaxWallHours = Number(process.env.TINY_LOOP_MAX_WALL_HOURS)
export const LOOP_MAX_WALL_MS =
  (Number.isFinite(envMaxWallHours) && envMaxWallHours >= 1 ? envMaxWallHours : 365 * 24) * 60 * 60 * 1000
/** Pause between iterations — lets the foreground breathe, meters spend. */
export const LOOP_COOLDOWN_MS = 30_000
/** One iteration may run this long before it's declared wedged. 1 hour —
 *  a real firmware build/flash/verify pass regularly outlives 15 minutes,
 *  and a timeout kills the iteration's work mid-flight. Overridable per
 *  machine with TINY_LOOP_ITER_TIMEOUT_MS (floor 1h: shorter values are
 *  the historical foot-gun this bump removes). */
const envIterTimeout = Number(process.env.TINY_LOOP_ITER_TIMEOUT_MS)
export const LOOP_ITER_TIMEOUT_MS =
  Number.isFinite(envIterTimeout) && envIterTimeout >= 3_600_000
    ? Math.floor(envIterTimeout)
    : 3_600_000
/** How many loops run at once. Each is a full agent with shell access,
 *  iterating for hours. Overridable per machine with TINY_MAX_LOOPS. */
const envMaxLoops = Number(process.env.TINY_MAX_LOOPS)
export const MAX_ACTIVE_LOOPS =
  Number.isFinite(envMaxLoops) && envMaxLoops >= 1 ? Math.floor(envMaxLoops) : 10
/** Journal entries keep this much of each iteration's answer. */
export const LOOP_SUMMARY_MAX = 2_000
/** Surface progress news every N iterations. */
export const LOOP_NEWS_EVERY = 10
/** Finished records older than this are pruned at startup. */
export const LOOP_KEEP_MS = 7 * 24 * 60 * 60 * 1000

export const LOOP_DONE_SIGNALS = ['[LOOP_DONE]', '[AMBIENT_DONE]', '[TASK_COMPLETE]']

export type LoopStatus = 'running' | 'done' | 'error' | 'stopped' | 'interrupted' | 'exhausted'

export interface LoopIteration {
  n: number
  at: number
  /** Tail of the iteration's answer — enough to resume from, not a transcript. */
  summary: string
  /**
   * Did this iteration THROW? Recorded rather than re-derived: the runner used to
   * infer "the previous one failed" by string-comparing summaries, so two failures
   * only counted as consecutive when their messages happened to be identical.
   */
  failed?: boolean
  /**
   * What the agent SAID it did this step, via loop_done status=progress. Beats a
   * blind tail-slice of its prose: the progress news and the journal show this
   * when it exists, so a long-running loop reports itself in its own words.
   */
  note?: string
}

export interface LoopRecord {
  id: string
  prompt: string
  status: LoopStatus
  startedAt: number
  endedAt?: number
  iterations: LoopIteration[]
  /** Final answer (or failure) once the loop ends. */
  result?: string
  /** Per-loop iteration cap chosen at start (use_loop max_iterations).
   *  Absent = the machine default (LOOP_MAX_ITERATIONS). */
  maxIterations?: number
  /** Finished-news delivered? Exactly once. */
  seen?: boolean
  /** Progress news high-water mark — last iteration count announced. */
  newsAt?: number
  pid: number
  host: string
}

const clampSummary = (s: string): string =>
  s.length > LOOP_SUMMARY_MAX ? `${s.slice(-LOOP_SUMMARY_MAX)}` : s

let idSeq = 0
export function newLoopId(now: number = Date.now()): string {
  idSeq = (idSeq + 1) % 1000
  return `l${new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '')}${String(idSeq).padStart(3, '0')}`
}

export function isValidLoopId(id: unknown): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

export function ensureLoopsDir(dir: string = loopsDir()): string {
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* start() reports */ }
  return dir
}

function recordPath(dir: string, id: string): string { return join(dir, `${id}.json`) }

/** Atomic write — tmp file + rename, so a reader never sees half a record. */
export function writeLoop(rec: LoopRecord, dir: string = loopsDir()): void {
  ensureLoopsDir(dir)
  const target = recordPath(dir, rec.id)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
}

export function readLoop(id: string, dir: string = loopsDir()): LoopRecord | null {
  if (!isValidLoopId(id)) return null
  try {
    const rec = JSON.parse(readFileSync(recordPath(dir, id), 'utf-8'))
    return rec && typeof rec.id === 'string' ? rec : null
  } catch { return null }
}

export type PidLive = (pid: number) => boolean
export const realPidLive: PidLive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Stale `running` from a dead pid on THIS host → `interrupted`. */
export function reconcile(rec: LoopRecord, opts: { pidLive?: PidLive; host?: string } = {}): LoopRecord {
  if (rec.status !== 'running') return rec
  const host = opts.host ?? hostname()
  if (rec.host !== host) return rec
  if ((opts.pidLive ?? realPidLive)(rec.pid)) return rec
  return { ...rec, status: 'interrupted', endedAt: rec.endedAt ?? Date.now() }
}

export function listLoops(dir: string = loopsDir(), opts: { pidLive?: PidLive; host?: string } = {}): LoopRecord[] {
  let files: string[] = []
  try { files = readdirSync(dir) } catch { return [] }
  const out: LoopRecord[] = []
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue
    const rec = readLoop(f.slice(0, -5), dir)
    if (rec) out.push(reconcile(rec, opts))
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

export function pruneLoops(dir: string = loopsDir(), now: number = Date.now()): string[] {
  const gone: string[] = []
  for (const r of listLoops(dir)) {
    if (r.status === 'running') continue
    if (now - (r.endedAt ?? r.startedAt) <= LOOP_KEEP_MS) continue
    try { unlinkSync(recordPath(dir, r.id)); gone.push(r.id) } catch { /* gone */ }
  }
  return gone
}

// ── presentation ────────────────────────────────────────────────────────────

const ICON: Record<LoopStatus, string> = {
  running: '♾️', done: '✅', error: '❌', stopped: '⏹', interrupted: '⚠️', exhausted: '⏱',
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

export function formatLoopLine(r: LoopRecord, now: number = Date.now()): string {
  const dur = r.endedAt ? ago(r.endedAt - r.startedAt) : `${ago(now - r.startedAt)} so far`
  const iters = r.iterations.length
  const head = `${ICON[r.status] || '•'} ${r.id} [${r.status}, ${iters} iter${iters === 1 ? '' : 's'}, ${dur}] ${r.prompt.replace(/\s+/g, ' ').slice(0, 80)}`
  const last = r.iterations[r.iterations.length - 1]
  const tail = r.status === 'running' && last
    ? `\n     ↳ iter ${last.n}: ${last.summary.replace(/\s+/g, ' ').slice(0, 100)}`
    : r.result ? `\n     → ${r.result.replace(/\s+/g, ' ').slice(0, 100)}` : ''
  return head + tail
}

export function summarizeLoops(records: LoopRecord[], now: number = Date.now()): string {
  if (!records.length) return '♾️ no background loops (start one with use_loop start)'
  return records.map((r) => formatLoopLine(r, now)).join('\n')
}

/**
 * News for the next foreground turn: finished loops (once), plus progress
 * milestones on running ones (every LOOP_NEWS_EVERY iterations).
 */
export function loopNewsBlock(records: LoopRecord[]): { block: string; finishedIds: string[]; progress: Array<{ id: string; at: number }> } {
  const lines: string[] = []
  const finishedIds: string[] = []
  const progress: Array<{ id: string; at: number }> = []
  for (const r of records) {
    if (r.status !== 'running' && !r.seen) {
      finishedIds.push(r.id)
      const body = (r.result || r.iterations[r.iterations.length - 1]?.summary || '(no output)').replace(/\s+/g, ' ').slice(0, 600)
      lines.push(`- ${r.id} ended (${r.status}, ${r.iterations.length} iterations, "${r.prompt.replace(/\s+/g, ' ').slice(0, 60)}"): ${body}`)
    } else if (r.status === 'running') {
      const n = r.iterations.length
      const announced = r.newsAt ?? 0
      if (n - announced >= LOOP_NEWS_EVERY) {
        progress.push({ id: r.id, at: n })
        const last = r.iterations[n - 1]
        // The loop's own progress line when it wrote one, else a tail of its prose.
        const latest = (last?.note || last?.summary || '').replace(/\s+/g, ' ').slice(0, 300)
        lines.push(`- ${r.id} progress: ${n} iterations ("${r.prompt.replace(/\s+/g, ' ').slice(0, 60)}") — latest: ${latest}`)
      }
    }
  }
  if (!lines.length) return { block: '', finishedIds: [], progress: [] }
  return {
    block: `[Background loop activity since the last turn — tell the user]\n${lines.join('\n')}\n\n`,
    finishedIds, progress,
  }
}

export function markLoopNews(finishedIds: string[], progress: Array<{ id: string; at: number }>, dir: string = loopsDir()): void {
  for (const id of finishedIds) {
    const rec = readLoop(id, dir)
    if (rec && !rec.seen) { try { writeLoop({ ...rec, seen: true }, dir) } catch { /* best effort */ } }
  }
  for (const p of progress) {
    const rec = readLoop(p.id, dir)
    if (rec) { try { writeLoop({ ...rec, newsAt: p.at }, dir) } catch { /* best effort */ } }
  }
}

/**
 * Did this iteration DECLARE the goal complete?
 *
 * The rule is deliberately blunt, per the owner: if the signal APPEARS in the
 * answer, the loop is done. A missed completion is the expensive failure — the
 * loop keeps burning a real agent until it hits its iteration cap — so this
 * errs toward stopping, and any cleverness about "was it really meant?" is a
 * false-negative machine.
 *
 * The ONE exception is a signal inside a fenced block or backticks: a loop that
 * prints a diff of this file, or quotes a journal entry, is showing code, not
 * signalling. Without this, a loop pointed at THIS repo kills itself the moment
 * it displays the token — observed live 2026-08-14.
 */
export function hasDoneSignal(text: string): boolean {
  const lower = String(text)
    .replace(/```[\s\S]*?```/g, ' ')   // fenced blocks: quoting, not signalling
    .replace(/`[^`\n]*`/g, ' ')        // inline code spans, same reason
    .toLowerCase()
  return LOOP_DONE_SIGNALS.some((s) => lower.includes(s.toLowerCase()))
}

// ── the runner ──────────────────────────────────────────────────────────────

export interface LoopAgent { invoke: (prompt: string) => Promise<string> }

/**
 * What the runner tells the agent it just built about the loop it belongs to.
 * `signalDone` is that loop's off switch, closed over the loop it came from —
 * see makeLoopDoneTool().
 */
export interface LoopAgentContext {
  loopId: string
  signalDone: (note?: string) => void
  /** Record a progress line for the CURRENT iteration without ending the loop. */
  report: (note: string) => void
}

export interface LoopRunnerOptions {
  /** ONE fresh agent per loop (not per iteration) — context accumulates.
   *  Must not have use_loop itself (background: true). */
  agentFactory: (ctx?: LoopAgentContext) => Promise<LoopAgent>
  dir?: string
  cooldownMs?: number
  iterTimeoutMs?: number
  maxIterations?: number
  maxWallMs?: number
  maxActive?: number
  notify?: (title: string, body: string) => void
  announce?: (loopId: string, summary: string, result: string) => void
  now?: () => number
  /** Injectable sleep so tests drive time. */
  sleep?: (ms: number) => Promise<void>
}

export class LoopRunner {
  private opts: LoopRunnerOptions
  private active = new Map<string, Promise<void>>()
  private stopping = new Set<string>()

  constructor(opts: LoopRunnerOptions) {
    this.opts = opts
    ensureLoopsDir(this.dir)
  }

  private get dir(): string { return this.opts.dir || loopsDir() }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  get activeCount(): number { return this.active.size }

  start(prompt: string, opts: { maxIterations?: number } = {}): { id: string } | { error: string } {
    const text = String(prompt || '').trim()
    if (!text) return { error: 'a loop needs a goal' }
    const max = this.opts.maxActive ?? MAX_ACTIVE_LOOPS
    if (this.active.size >= max) {
      return { error: `${this.active.size} loop(s) already running (max ${max}) — a loop is hours of a full agent; stop one first (use_loop stop) or fold this goal into the running one` }
    }
    // Per-loop cap: floored, at least 1. Anything unparseable falls back to the default.
    const reqIters = Number(opts.maxIterations)
    const maxIterations = Number.isFinite(reqIters) && reqIters >= 1 ? Math.floor(reqIters) : undefined
    const id = newLoopId(this.now())
    const rec: LoopRecord = {
      id, prompt: text, status: 'running', startedAt: this.now(),
      iterations: [], pid: process.pid, host: hostname(),
      ...(maxIterations ? { maxIterations } : {}),
    }
    try { writeLoop(rec, this.dir) } catch (e: any) {
      return { error: `cannot persist loop: ${String(e?.message || e).slice(0, 200)}` }
    }
    const p = this.run(rec).finally(() => { this.active.delete(id) })
    this.active.set(id, p)
    return { id }
  }

  private buildIterPrompt(rec: LoopRecord): string {
    const n = rec.iterations.length
    if (n === 0) {
      return `You are a BACKGROUND LOOP working autonomously on: "${rec.prompt}"\n\n` +
        `Take the first concrete step now. You will be called again after each step — ` +
        `make real progress each time. When the goal is truly complete, end your response with [LOOP_DONE] on a line of its own.`
    }
    return `Background loop iteration ${n + 1} on: "${rec.prompt.slice(0, 300)}"\n\n` +
      `Continue from where you left off — your conversation history has everything so far. ` +
      `Take the next concrete step. If the goal is truly complete, end your response with [LOOP_DONE] on a line of its own — mentioning it mid-sentence does not end the loop.`
  }

  private async run(rec: LoopRecord): Promise<void> {
    const cooldown = this.opts.cooldownMs ?? LOOP_COOLDOWN_MS
    const iterTimeout = this.opts.iterTimeoutMs ?? LOOP_ITER_TIMEOUT_MS
    // The loop's own cap wins; then the runner's; then the machine default.
    const maxIters = rec.maxIterations ?? this.opts.maxIterations ?? LOOP_MAX_ITERATIONS
    const maxWall = this.opts.maxWallMs ?? LOOP_MAX_WALL_MS

    let agent: LoopAgent
    // The DETERMINISTIC end: a tool call, not a phrase. hasDoneSignal() reads
    // prose and always will be a guess — an agent that means to stop can say so
    // structurally instead, and this latch is what it sets. Kept as the primary
    // check, with the sentinel as the fallback for a model that just writes it.
    const latch: { done: boolean; note?: string } = { done: false }
    // Progress the agent declares mid-iteration, drained onto that iteration's
    // journal entry when it lands. Buffered because the entry does not exist yet
    // while the agent is still working.
    const pendingNotes: string[] = []
    try {
      agent = await this.opts.agentFactory({
        loopId: rec.id,
        signalDone: (note?: string) => {
          latch.done = true
          if (note) latch.note = String(note).slice(0, 2000)
        },
        report: (note: string) => {
          const n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300)
          if (n && pendingNotes.length < 20) pendingNotes.push(n)
        },
      })
    } catch (e: any) {
      this.finish(rec, 'error', `loop agent failed to start: ${String(e?.message || e).slice(0, 500)}`)
      return
    }

    let status: LoopStatus = 'done'
    let finalResult = ''

    while (true) {
      if (this.stopping.has(rec.id)) { status = 'stopped'; finalResult = finalResult || '(stopped by user)'; break }
      if (rec.iterations.length >= maxIters) { status = 'exhausted'; finalResult = `hit iteration cap (${maxIters}) — goal not signalled complete`; break }
      if (this.now() - rec.startedAt >= maxWall) { status = 'exhausted'; finalResult = `hit wall-clock cap (${maxWall >= 48 * 3600000 ? Math.round(maxWall / 86400000) + 'd' : Math.round(maxWall / 3600000) + 'h'}) — goal not signalled complete`; break }

      let timer: NodeJS.Timeout | undefined
      let iterResult: string
      let iterFailed = false
      try {
        iterResult = await Promise.race([
          agent.invoke(this.buildIterPrompt(rec)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`iteration timed out after ${Math.round(iterTimeout / 60000)}min`)), iterTimeout)
          }),
        ]).then((r) => String(r))
      } catch (e: any) {
        iterFailed = true
        iterResult = String(e?.message || e).slice(0, 2000)
      } finally {
        if (timer) clearTimeout(timer)
      }

      // Journal EVERY iteration, success or failure — the crash-recovery story.
      const note = pendingNotes.splice(0).join(' · ').slice(0, 500)
      rec.iterations.push({
        n: rec.iterations.length + 1, at: this.now(), summary: clampSummary(iterResult),
        ...(iterFailed ? { failed: true } : {}), ...(note ? { note } : {}),
      })
      try { writeLoop(rec, this.dir) } catch { /* next write may succeed */ }

      if (iterFailed) {
        // One failed iteration isn't a failed loop (transient throttles, tool
        // hiccups) — but two IN A ROW is a loop making no progress. Read from the
        // journal's `failed` flag: comparing error TEXT let a loop that failed
        // differently every time (throttle ids, varying network errors) look like
        // it was progressing, and burn all its iterations before stopping.
        const prev = rec.iterations[rec.iterations.length - 2]
        if (prev?.failed || /timed out/.test(iterResult)) {
          status = 'error'; finalResult = iterResult; break
        }
      } else if (latch.done) {
        // Declared complete by TOOL CALL — no parsing involved.
        finalResult = latch.note ? `${iterResult}\n\n— ended via loop_done: ${latch.note}` : iterResult
        break
      } else if (hasDoneSignal(iterResult)) {
        finalResult = iterResult; break
      }

      if (this.stopping.has(rec.id)) { status = 'stopped'; finalResult = iterResult || '(stopped by user)'; break }
      await this.sleep(cooldown)
    }

    this.stopping.delete(rec.id)
    this.finish(rec, status, finalResult)
  }

  private finish(rec: LoopRecord, status: LoopStatus, result: string): void {
    const done: LoopRecord = { ...rec, status, endedAt: this.now(), result: result.slice(0, 20_000) }
    try { writeLoop(done, this.dir) } catch { /* the journal survives */ }
    try {
      this.opts.notify?.(
        `tiny: loop ${rec.id} ${status} (${rec.iterations.length} iterations)`,
        `${rec.prompt.slice(0, 80)}\n${result.slice(0, 200)}`,
      )
    } catch { /* never fail a finished loop over a notification */ }
    try {
      this.opts.announce?.(rec.id, rec.prompt,
        status === 'done' ? result.slice(0, 20_000) : `Loop ${status} after ${rec.iterations.length} iterations: ${result.slice(0, 20_000)}`)
    } catch { /* same contract */ }
  }

  /** Stop after the in-flight iteration lands. Honest about what that means. */
  stop(id: string): string {
    const rec = readLoop(id, this.dir)
    if (!rec) return `no such loop: ${id}`
    if (rec.status !== 'running') return `loop ${id} is already ${rec.status}`
    if (!this.active.has(id)) {
      // Claimed running but not ours — reconcile() will flip it if the pid died.
      const r = reconcile(rec)
      if (r.status !== 'running') { writeLoop(r, this.dir); return `loop ${id} was ${r.status} (its process is gone)` }
      return `loop ${id} is running in another process (pid ${rec.pid}) — stop it there`
    }
    this.stopping.add(id)
    return `loop ${id} will stop after the current iteration finishes (a model turn in flight cannot be aborted). ${rec.iterations.length} iterations journaled so far.`
  }

  list(): LoopRecord[] { return listLoops(this.dir) }
  get(id: string): LoopRecord | null {
    const rec = readLoop(id, this.dir)
    return rec ? reconcile(rec) : null
  }

  /** News for the next turn — finished loops once, progress every 10 iters. */
  takeNews(): string {
    const { block, finishedIds, progress } = loopNewsBlock(this.list())
    if (block) markLoopNews(finishedIds, progress, this.dir)
    return block
  }

  prune(): string[] { return pruneLoops(this.dir, this.now()) }
}

export const LOOP_DESCRIPTION = `♾️ THE background rail on this machine — anything that outlives the turn asking for it. A loop ITERATES: one persistent agent takes a step, cools down, takes the next step — until it says [LOOP_DONE], you stop it, or it hits its caps (${LOOP_MAX_ITERATIONS} iterations by default — settable per loop with max_iterations — / 365d wall clock). Best for goals with no single answer, only progress (hours of refactoring, monitoring, working through many items), but it carries one-shot background jobs too — for those, emit [LOOP_DONE] in the FIRST iteration so it stops after one pass instead of running to its caps. Only ${MAX_ACTIVE_LOOPS} run at once, so don't spend a slot on work you can finish inline. Actions:
- start (prompt, max_iterations?) — begin a loop; returns its id immediately. Say the id out loud. max_iterations overrides the ${LOOP_MAX_ITERATIONS}-iteration default for this loop.
- list — every loop, its status and iteration count
- status (id) — full journal of a loop's iterations
- result (id) — final answer of a finished loop
- stop (id) — stop after the current iteration lands (in-flight work cannot be aborted)

Progress news is injected into your turns automatically every ~10 iterations, and completion news once at the end.`

/**
 * A loop's own OFF SWITCH, handed to the background agent running it and to
 * nobody else.
 *
 * It takes NO loop id: the callback is closed over the one loop this agent is
 * iterating, so `loop_done` structurally cannot end anybody else's work. That
 * is the whole reason this is a separate tool rather than another action on
 * `use_loop` — a background agent has no `use_loop` on purpose (depth 1 by
 * construction), and a name that means "manage every loop" in the foreground
 * and "end my own" inside one is worse than a name that isn't there.
 *
 * The loop still finishes the CURRENT iteration after this is called: the
 * agent's final answer becomes the loop's result, so calling it early in a turn
 * and then reporting is the normal shape.
 */
export function makeLoopDoneTool(ctx: LoopAgentContext) {
  return tool({
    name: 'loop_done',
    description: `Report on THIS background loop — the deterministic alternative to writing [LOOP_DONE] in your answer.\n` +
      `- status='done' (default): end the loop. Call it the moment the goal is met; for a one-shot job that is your FIRST iteration. ` +
      `Finish the iteration normally afterwards — your final message becomes the loop's reported result.\n` +
      `- status='progress': write summary into this iteration's journal entry and KEEP GOING. This is the line the user sees in ` +
      `progress news and in use_loop status, so say what you actually did and what is next — otherwise they get a blind slice of your prose.\n` +
      `Either way it only touches the loop you are running, and can neither start nor stop any other.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'progress'], description: "'done' ends the loop (default), 'progress' journals a line and continues" },
        summary: { type: 'string', description: 'one line: what you did (progress), or why the goal is complete (done)' },
      },
    },
    callback: async (input: any) => {
      const summary = String(input?.summary || '').trim().slice(0, 2000)
      const status = String(input?.status || 'done').toLowerCase()
      if (status === 'progress') {
        if (!summary) return 'a progress report needs a summary — one line on what you just did'
        ctx.report(summary)
        return `noted on loop ${ctx.loopId} — keep working; call again with status='done' when the goal is met.`
      }
      if (summary) ctx.report(summary)
      ctx.signalDone(summary || undefined)
      return `loop ${ctx.loopId} will end after this iteration — give your final answer now; it becomes the result.`
    },
  })
}

export function makeLoopTool(runner: LoopRunner) {
  return tool({
    name: 'use_loop',
    description: LOOP_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'status', 'result', 'stop'], description: 'start, list, status, result or stop' },
        prompt: { type: 'string', description: 'the goal the loop works toward (action=start)' },
        max_iterations: { type: 'number', description: `iteration cap for THIS loop (action=start, default ${LOOP_MAX_ITERATIONS})` },
        id: { type: 'string', description: 'loop id (action=status|result|stop)' },
      },
      required: ['action'],
    },
    callback: async (input: any) => {
      const action = String(input?.action || 'list')
      switch (action) {
        case 'start': {
          const r = runner.start(String(input?.prompt || ''), { maxIterations: input?.max_iterations })
          if ('error' in r) return r.error
          return `started loop ${r.id} — it iterates in the background (up to hours); tell the user the id. Progress appears in later turns; check any time with use_loop status id=${r.id}.`
        }
        case 'list':
          return summarizeLoops(runner.list())
        case 'status': {
          const id = String(input?.id || '')
          if (!isValidLoopId(id)) return 'need a loop id (see use_loop list)'
          const rec = runner.get(id)
          if (!rec) return `no such loop: ${id}`
          const journal = rec.iterations.map((it) => {
            // The loop's own progress line first when it wrote one; ✗ marks a failed step.
            const body = (it.note || it.summary).replace(/\s+/g, ' ').slice(0, 200)
            return `  ${it.n}. [${new Date(it.at).toISOString().slice(11, 19)}]${it.failed ? ' ✗' : ''} ${body}`
          }).join('\n')
          return `${formatLoopLine(rec)}\n\nJournal:\n${journal || '  (no iterations yet)'}`
        }
        case 'result': {
          const id = String(input?.id || '')
          if (!isValidLoopId(id)) return 'need a loop id (see use_loop list)'
          const rec = runner.get(id)
          if (!rec) return `no such loop: ${id}`
          if (rec.status === 'running') return `loop ${id} is still running (${rec.iterations.length} iterations so far — use_loop status for the journal)`
          return `${formatLoopLine(rec)}\n\n${rec.result || '(no output)'}`
        }
        case 'stop': {
          const id = String(input?.id || '')
          if (!isValidLoopId(id)) return 'need a loop id (see use_loop list)'
          return runner.stop(id)
        }
        default:
          return `unknown action: ${action} (start|list|status|result|stop)`
      }
    },
  })
}
