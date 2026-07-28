/**
 * 🌙 Ambient mode — the daemon keeps thinking while the user is idle.
 *
 * Direct port of devduck's AmbientMode (devduck/__init__.py) — the single
 * biggest "devduck feels alive, tiny doesn't" gap: devduck keeps exploring
 * the last topic when the user goes quiet and injects its findings into the
 * next turn; tiny just sat there. Two modes, same as the original:
 *
 *  - standard:   after `idleThresholdMs` of silence, run up to `maxIterations`
 *                exploration turns (one per `cooldownMs`), store the results,
 *                inject them into the next real query.
 *  - autonomous: `auto` in the REPL — keep working continuously (short
 *                cooldown, high iteration cap) until the agent includes a
 *                completion signal ('[AMBIENT_DONE]' et al) or is stopped.
 *
 * Ported semantics that matter (each one was a deliberate devduck decision):
 *  - Typing interrupts ambient work; the interrupted result is DISCARDED
 *    (half a thought injected later reads as a non sequitur).
 *  - Standard mode resets iterations on every real interaction; autonomous
 *    does NOT (it's one continuous job, not per-idle bursts).
 *  - getAndClearFindings() drains: findings inject exactly once.
 *  - The loop never overlaps the foreground agent — `busy()` is consulted
 *    before every run, and ambient marks itself busy while running.
 *
 * Node-shaped changes (not drift, adaptation):
 *  - One `setInterval` tick instead of a thread; all state is single-threaded.
 *  - The agent is a factory-provided `invoke(prompt)` — the SAME TinyAgent
 *    instance the REPL uses, so ambient work shares conversation memory
 *    (exactly like devduck, where ambient calls `self.devduck.agent`).
 *  - Everything is injectable (clock, timers) so the tests can drive time.
 */

export const COMPLETION_SIGNALS = [
  '[AMBIENT_DONE]',
  '[TASK_COMPLETE]',
  '[NOTHING_MORE_TO_DO]',
  "i've completed my exploration",
  'nothing more to explore',
]

export interface AmbientOptions {
  /** Run one agent turn; the REPL passes its own agent's invoke. */
  invoke: (prompt: string) => Promise<string>
  /** Is the foreground agent mid-turn? Ambient never overlaps it. */
  busy?: () => boolean
  /** Called with a line to surface to the terminal (🌙-prefixed). */
  log?: (line: string) => void
  idleThresholdMs?: number      // standard: idle before first ambient run (30s)
  cooldownMs?: number           // standard: between runs (60s)
  maxIterations?: number        // standard: per idle period (3)
  autonomousCooldownMs?: number // autonomous: between runs (10s)
  autonomousMaxIterations?: number // autonomous cap (100)
  tickMs?: number               // loop granularity (2s)
  now?: () => number            // injectable clock (tests)
}

export class AmbientMode {
  running = false
  autonomous = false
  iterations = 0
  findings: string[] = []

  private lastInteraction: number
  private lastRun = 0
  private lastQuery: string | null = null
  private interrupted = false
  private ambientBusy = false
  private timer: ReturnType<typeof setInterval> | null = null

  private readonly invoke: (prompt: string) => Promise<string>
  private readonly busy: () => boolean
  private readonly log: (line: string) => void
  private readonly idleThresholdMs: number
  private readonly cooldownMs: number
  private readonly maxIterations: number
  private readonly autoCooldownMs: number
  private readonly autoMaxIterations: number
  private readonly tickMs: number
  private readonly now: () => number

  constructor(opts: AmbientOptions) {
    this.invoke = opts.invoke
    this.busy = opts.busy ?? (() => false)
    this.log = opts.log ?? ((l) => process.stderr.write(l + '\n'))
    this.idleThresholdMs = opts.idleThresholdMs ?? 30_000
    this.cooldownMs = opts.cooldownMs ?? 60_000
    this.maxIterations = opts.maxIterations ?? 3
    this.autoCooldownMs = opts.autonomousCooldownMs ?? 10_000
    this.autoMaxIterations = opts.autonomousMaxIterations ?? 100
    this.tickMs = opts.tickMs ?? 2_000
    this.now = opts.now ?? Date.now
    this.lastInteraction = this.now()
  }

  start(autonomous = false): void {
    if (this.running) {
      // devduck: switching a running standard loop to autonomous is a mode
      // flip, not a restart — accumulated context stays.
      if (autonomous && !this.autonomous) {
        this.autonomous = true
        this.log('🌙 switched to AUTONOMOUS mode — runs until stopped or [AMBIENT_DONE]')
      }
      return
    }
    this.running = true
    this.autonomous = autonomous
    this.interrupted = false
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    // A daemon-friendly loop must not hold the process open by itself.
    this.timer.unref?.()
    this.log(autonomous
      ? '🌙 ambient started (AUTONOMOUS — until stopped or [AMBIENT_DONE])'
      : '🌙 ambient started (explores when you go idle; findings join your next message)')
  }

  stop(): void {
    this.running = false
    this.autonomous = false
    this.interrupted = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Every real user turn lands here — resets idle, feeds the topic. */
  recordInteraction(query: string): void {
    this.lastInteraction = this.now()
    this.lastQuery = query
    if (!this.autonomous) {
      this.iterations = 0
      this.findings = []
    }
    this.interrupted = false
  }

  /** User started typing — abandon the in-flight thought. */
  interrupt(): void { this.interrupted = true }

  /** Drain findings for injection into the next query. Empty string = none. */
  getAndClearFindings(): string {
    if (!this.findings.length) return ''
    const n = this.findings.length
    const out = this.findings.join('\n\n')
    this.findings = []
    return `[Ambient background work — ${n} iteration${n === 1 ? '' : 's'} while you were away]:\n${out}`
  }

  /** One scheduler tick — exposed for tests; the interval calls it. */
  async tick(): Promise<void> {
    if (!this.running || this.ambientBusy) return
    const t = this.now()
    const cooldown = this.autonomous ? this.autoCooldownMs : this.cooldownMs
    const cap = this.autonomous ? this.autoMaxIterations : this.maxIterations

    if (!this.autonomous && t - this.lastInteraction < this.idleThresholdMs) return
    if (t - this.lastRun < cooldown) return
    if (this.iterations >= cap) return
    if (!this.lastQuery) return
    if (this.busy() || this.interrupted) return

    const prompt = this.buildPrompt()
    const label = this.autonomous ? 'AUTONOMOUS' : 'ambient'
    this.log(`\n🌙 [${label}] thinking… (iteration ${this.iterations + 1}/${cap})`)

    this.ambientBusy = true
    try {
      const result = await this.invoke(prompt)
      if (this.interrupted) {
        this.log('🌙 interrupted by user input — result discarded')
        return
      }
      if (this.autonomous && hasCompletionSignal(result)) {
        this.findings.push(`[final iteration ${this.iterations + 1}]:\n${result.slice(0, 2000)}`)
        this.log('🌙 [AUTONOMOUS] agent signaled completion — stopping')
        this.stop()
        return
      }
      this.findings.push(`[iteration ${this.iterations + 1}]:\n${result.slice(0, 2000)}`)
      this.iterations += 1
      this.lastRun = this.now()
      this.log(`🌙 [${label}] stored — will join your next message (${this.findings.length} pending)`)
    } catch (e: any) {
      this.log(`🌙 ambient error: ${String(e?.message || e).slice(0, 200)}`)
      // An erroring loop must not spin: honor the cooldown before retrying.
      this.lastRun = this.now()
    } finally {
      this.ambientBusy = false
    }
  }

  private buildPrompt(): string {
    const topic = (this.lastQuery || '').slice(0, 300)
    if (this.autonomous) {
      if (this.iterations === 0) {
        return `You're in AUTONOMOUS mode. Work on this task until complete: '${topic}'\n\n` +
          `Take action, make progress, explore deeply. When you're truly done with nothing ` +
          `more to do, include '[AMBIENT_DONE]' in your response. Otherwise, keep working.`
      }
      return `Continue working on: '${topic.slice(0, 200)}'\n\n` +
        `Iteration ${this.iterations + 1}. What's the next step? Take action.\n` +
        `If truly complete, say '[AMBIENT_DONE]'. Otherwise, keep making progress.`
    }
    // Standard prompts rotate — same three angles devduck uses.
    const prompts = [
      `Continue exploring the topic from the last interaction. Last query was: '${topic.slice(0, 200)}'. ` +
        `Think deeper, find connections, validate assumptions, or explore related areas. Be proactive and useful.`,
      `Based on our recent work on '${topic.slice(0, 100)}', what else should be considered? ` +
        `Are there edge cases, improvements, or related topics worth exploring?`,
      `Reflect on the last task: '${topic.slice(0, 100)}'. ` +
        `What would make the solution better? Any risks or opportunities missed?`,
    ]
    return prompts[this.iterations % prompts.length]
  }
}

export function hasCompletionSignal(text: string): boolean {
  const lower = String(text).toLowerCase()
  return COMPLETION_SIGNALS.some((s) => lower.includes(s.toLowerCase()))
}
