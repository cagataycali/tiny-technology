/**
 * ⭐ spawn_agents — parallel sub-agents, the web tool's semantics on this
 * machine (reference: app/api/chat/route.ts spawnAgentsTool +
 * lib/chat/tools/spawn.ts batch aggregation).
 *
 * Fan-out work: each task gets a FRESH background TinyAgent (same factory
 * pattern as loop.ts) with its own context, all running concurrently; the
 * results come back as ONE aggregated text with fair per-task budgets, so a
 * talkative sub-agent cannot evict its siblings' answers.
 *
 * Depth 1 by construction — the exact rationale as use_loop's absence inside
 * a loop: sub-agents are built with background:true, so they get neither
 * use_loop nor spawn_agents, and a fan-out that fans out again (with nobody
 * reading the output) cannot be expressed. The name is RESERVED even where
 * the tool is unregistered (agent.ts builtinToolNames) for the same reason
 * use_loop is: a local tool answering to this name with none of the
 * semantics is worse than the name being unavailable.
 *
 * wait:false is the local translation of the web's batch deposit: return a
 * ticket immediately, keep running, and when the batch lands deliver the
 * aggregate through the SAME rails a finished loop uses — notify() for
 * whoever is at this machine, announce() (the platform task-result rail) for
 * whoever is not, and a ~/.tiny_history notice so the next agent turn's
 * context carries the result even if both notifications missed.
 */
import { tool } from '@strands-agents/sdk'
import { randomBytes } from 'node:crypto'
import { appendHistory } from './history.js'
import { makeSpawnReporter, type SpawnReporter } from './spawn-state.js'

// ── contract constants ───────────────────────────────────────────────────────

/** Local fan-out cap. The web allows 64 behind a concurrency pool; locally
 *  every sub-agent is a FULL TinyAgent (its own tool mounts, its own model
 *  conversation), so five at once is the honest ceiling before this machine
 *  is the bottleneck rather than the model. */
export const SPAWN_MAX_TASKS = 5

/** Per-batch wall clock. One number, not a knob — a sub-agent that needs
 *  longer than this wants to be a loop, which has journals and caps. */
export const SPAWN_TIMEOUT_MS = 240_000

/** Aggregate budget — same figure as the web's deposit rule (worker relay
 *  PAYLOAD_MAX headroom). Kept identical so a batch result reads the same
 *  whether it came from the cloud tool or this one. */
export const SPAWN_RESULT_BUDGET = 7000

export interface SpawnTaskResult {
  task: number
  ok: boolean
  result?: string
  error?: string
}

/** What the tool needs from a sub-agent — loop.ts's LoopAgent, same shape. */
export interface SpawnAgent { invoke: (prompt: string) => Promise<string> }

export interface SpawnToolOptions {
  /** ONE fresh background agent per task. Must be background:true — that is
   *  what keeps use_loop and spawn_agents out of its registry (depth 1). */
  agentFactory: (taskIndex: number, taskCount: number) => Promise<SpawnAgent>
  /** Local notification rail — a wait:false batch finishing while the user
   *  watches this machine. Same hook shape as LoopRunner's. */
  notify?: (title: string, body: string) => void
  /** Platform rail for whoever ISN'T at this keyboard (announceTaskResult). */
  announce?: (batchId: string, summary: string, result: string) => void
  /** Injectable for tests. */
  timeoutMs?: number
  now?: () => number
}

// ── pure pieces (ported from lib/chat/tools/spawn.ts, tested directly) ──────

/** Ticket namespace mirrors the web's batch_* rule — recognisable in history. */
export function batchTicket(now: number = Date.now()): string {
  return `batch_${now.toString(36)}${randomBytes(4).toString('hex')}`
}

/**
 * Flatten the batch into the one string the user reads. Every task gets a
 * marker (✅/❌) and a FAIR share of the budget — one talkative sub-agent must
 * not evict its siblings' answers from the aggregate. Ported 1:1 from
 * lib/chat/tools/spawn.ts buildBatchResultText.
 */
export function buildBatchResultText(results: SpawnTaskResult[], elapsedMs: number): string {
  const done = results.filter((r) => r?.ok).length
  const header = `🤖 Agent batch finished: ${done}/${results.length} tasks completed in ${Math.round(elapsedMs / 1000)}s.`
  const share = Math.max(200, Math.floor(SPAWN_RESULT_BUDGET / Math.max(results.length, 1)) - 40)
  const sections = results.map((r) =>
    r?.ok
      ? `✅ Task ${r.task}:\n${String(r.result || '').slice(0, share)}`
      : `❌ Task ${r?.task}: ${String(r?.error || 'failed').slice(0, 200)}`,
  )
  return [header, ...sections].join('\n\n').slice(0, SPAWN_RESULT_BUDGET)
}

/**
 * Validate the tasks array without throwing — the model reads the refusal.
 * 1..SPAWN_MAX_TASKS non-empty strings; anything else is a sentence, not an
 * exception, because a thrown schema error ends the turn instead of teaching.
 */
export function validateTasks(input: unknown): { tasks: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'spawn_agents needs tasks: a non-empty array of task prompts (strings)' }
  }
  if (input.length > SPAWN_MAX_TASKS) {
    return { error: `too many tasks (${input.length}) — max ${SPAWN_MAX_TASKS} per batch; fold related items into one task or run a second batch` }
  }
  const tasks: string[] = []
  for (let i = 0; i < input.length; i++) {
    const t = typeof input[i] === 'string' ? input[i].trim() : ''
    if (!t) return { error: `task ${i + 1} is empty — every task needs a prompt` }
    tasks.push(t)
  }
  return { tasks }
}

/**
 * Run every task CONCURRENTLY on its own fresh agent; failures are isolated
 * per task (a ❌ section, never a thrown batch — the MaxTokensError self-heal
 * lives inside TinyAgent.invoke and has already done its work by the time an
 * error reaches here). Results land in task order regardless of finish order.
 */
export async function runSpawnBatch(
  tasks: string[],
  factory: SpawnToolOptions['agentFactory'],
  opts: { timeoutMs?: number; now?: () => number; reporter?: SpawnReporter } = {},
): Promise<{ results: SpawnTaskResult[]; elapsedMs: number }> {
  const now = opts.now || Date.now
  const timeoutMs = opts.timeoutMs ?? SPAWN_TIMEOUT_MS
  const started = now()
  const reporter = opts.reporter
  const runOne = async (prompt: string, i: number): Promise<SpawnTaskResult> => {
    let timer: NodeJS.Timeout | undefined
    try {
      const agent = await factory(i, tasks.length)
      const text = await Promise.race([
        agent.invoke(prompt),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`task timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        }),
      ])
      try { reporter?.taskEnded(i, true) } catch { /* progress is an enhancement */ }
      return { task: i + 1, ok: true, result: String(text ?? '') }
    } catch (e: any) {
      try { reporter?.taskEnded(i, false) } catch { /* progress is an enhancement */ }
      return { task: i + 1, ok: false, error: String(e?.message || e).slice(0, 500) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const results = await Promise.all(tasks.map(runOne))
  try { reporter?.batchEnded() } catch { /* progress is an enhancement */ }
  return { results, elapsedMs: now() - started }
}

// ── the tool ─────────────────────────────────────────────────────────────────

export const SPAWN_DESCRIPTION =
  `⭐ Run 1-${SPAWN_MAX_TASKS} sub-agent tasks IN PARALLEL, each a fresh agent with its own context and this machine's tools. ` +
  `Use for fan-out work: research several angles at once, compare options, process independent items. ` +
  `Each task is one prompt; results come back merged, one ✅/❌ section per task. ` +
  `wait:false returns a batch id immediately and delivers ONE notification when the batch lands — use it for slow sweeps or an explicit "in the background". ` +
  `Sub-agents cannot spawn further agents or loops (depth 1). ` +
  `For a goal that ITERATES over hours, use use_loop instead — this is one concurrent pass, not a journal.`

export function makeSpawnAgentsTool(opts: SpawnToolOptions) {
  return tool({
    name: 'spawn_agents',
    description: SPAWN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: `Independent task prompts to run in parallel (1-${SPAWN_MAX_TASKS})`,
        },
        wait: {
          type: 'boolean',
          description: 'default true: wait for the batch and return the merged results. false = return a batch id now; the aggregate arrives as a notification + history notice.',
        },
      },
      required: ['tasks'],
    },
    callback: async (raw: unknown) => {
      const input = (raw ?? {}) as { tasks?: unknown; wait?: boolean }
      const v = validateTasks(input?.tasks)
      if ('error' in v) return v.error
      const { tasks } = v

      // Every batch gets a ticket up front (wait:true included): the ticket
      // names the progress record the TUI's spawn strip polls while the
      // batch runs — visibility must not depend on which wait mode ran.
      const ticket = batchTicket(opts.now ? opts.now() : Date.now())
      const reporter = makeSpawnReporter(ticket, tasks.length, { now: opts.now })
      const run = () => runSpawnBatch(tasks, opts.agentFactory, { timeoutMs: opts.timeoutMs, now: opts.now, reporter })

      // 🔥 Fire-and-forget: the batch keeps running past this reply. Every
      // path delivers — an exception that skipped the announcement would be
      // the silent-discard bug the web design exists to close.
      if (input?.wait === false) {
        void (async () => {
          let text: string
          let completed = 0
          let failed = tasks.length
          try {
            const { results, elapsedMs } = await run()
            completed = results.filter((r) => r.ok).length
            failed = results.length - completed
            text = buildBatchResultText(results, elapsedMs)
          } catch (e: any) {
            text = `🤖 Agent batch ${ticket} failed before finishing: ${String(e?.message || e).slice(0, 500)}`
            try { reporter.batchEnded() } catch { /* record ends via reconcile */ }
          }
          const summary = `agent batch ${completed}/${tasks.length} done${failed ? ` (${failed} failed)` : ''}`
          // History notice FIRST (disk is the rail that cannot miss), then the
          // human rails. None of them may fail the batch that finished.
          try { appendHistory(`spawn_agents batch ${ticket}`, text) } catch { /* enhancement */ }
          try { opts.notify?.(`🤖 ${summary}`, text.slice(0, 500)) } catch { /* never fatal */ }
          try { opts.announce?.(ticket, summary, text) } catch { /* best-effort */ }
        })()
        return {
          ok: true, pending: true, batch_id: ticket, tasks: tasks.length,
          note: `Batch launched in the background (${tasks.length} task${tasks.length === 1 ? '' : 's'}). ` +
            `The aggregate arrives as a notification and lands in this machine's history as "spawn_agents batch ${ticket}". Tell the user it's off and running.`,
        } as any
      }

      const { results, elapsedMs } = await run()
      return {
        ok: results.some((r) => r.ok),
        batch_id: ticket,
        elapsed_ms: elapsedMs,
        completed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        text: buildBatchResultText(results, elapsedMs),
        results,
      } as any
    },
  })
}
