/**
 * ⏳ Background tasks — work that outlives the turn that asked for it
 * (loop item d-f, the "see the task results a bit later" gap).
 *
 * Every path into this agent is synchronous today: a turn holds the caller until
 * the answer exists. That's right for "what's on my calendar" and wrong for
 * "reindex my notes", "watch the deploy and tell me when it's green", "summarise
 * these 40 files" — the exact work a machine that's always on should be doing.
 * Worse, the caller is often a RELAY envelope: `use_device` gives up after 45s,
 * so a 10-minute job was unaskable from the web agent at all, no matter that the
 * daemon would happily have run it.
 *
 * So: `use_tasks start` returns an id immediately, the work runs on a FRESH
 * agent, and the result is stored under ~/.tiny/tasks/<id>.json. The next turn
 * on this daemon sees "these finished while you were away" injected into its
 * context, and `use_tasks result` can fetch one any time after.
 *
 * ── the decisions ───────────────────────────────────────────────────────────
 *
 *  - **A fresh agent per task, never the caller's.** Two turns interleaving
 *    messages into one `agent.messages` array produces a conversation that
 *    happened in no order — the same rule relay-poller and the mesh already
 *    follow. A task is an independent conversation that happens to have been
 *    started by one.
 *
 *  - **A background agent must NOT be able to start tasks.** Depth-1, enforced
 *    by the caller passing `background: true` (TinyAgent then withholds the
 *    tool). Recursion here isn't a slow loop, it's an invisible fan-out: nobody
 *    is watching the output, so a task that spawns two tasks fills the machine
 *    and the only symptom is the fan slowing down. Plus a hard cap on how many
 *    run at once, because a model asked to "check each of these 200 repos" will
 *    cheerfully try.
 *
 *  - **A record is written before the work starts, and updated atomically.**
 *    Written first, because a task that dies with its process must still be
 *    explainable; atomically (temp file + rename), because `use_tasks list` and
 *    the writer race by construction and half a JSON file reads as a corrupt
 *    task rather than a running one.
 *
 *  - **`running` on disk is a CLAIM, not a fact.** The daemon restarts (launchd
 *    KeepAlive, a crash, `daemon restart`), and nothing in the dead process
 *    updates its records — so a stale `running` row is a task the user waits for
 *    forever. A record whose `pid` is gone on this same host is reported as
 *    `interrupted`, which is the truth and is actionable ("start it again").
 *
 *  - **Cancel stops the WAITING, not the work.** Nothing in Node can abort an
 *    arbitrary in-flight model turn or the shell command it spawned. So cancel
 *    marks the record and drops the result when it lands, and the tool says so
 *    in those words — an honest "I stopped watching" beats a "cancelled" the
 *    user reads as "nothing is still running on my laptop".
 *
 *  - **Finished-task news is delivered ONCE.** The unseen flag flips when the
 *    news is injected, or every turn for the rest of the day reopens the same
 *    completion; the record itself stays, so `result` still works later.
 */
import { tool } from '@strands-agents/sdk'
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** Where task records live — beside device.json, because they're user state. */
export function tasksDir(): string {
  if (process.env.TINY_TASKS_DIR) return process.env.TINY_TASKS_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'tasks')
}

/**
 * How long one task may run. devduck's number, and it's the right order of
 * magnitude: long enough that "summarise this repo" finishes, short enough that
 * a wedged task doesn't hold a slot until the daemon restarts.
 */
export const TASK_TIMEOUT_MS = 900_000

/**
 * How many run at once. The cap is about the MACHINE, not politeness: each task
 * is a full agent with shell access, and the person whose laptop this is didn't
 * agree to eight of them. A model asked to fan out over 200 items hits this and
 * is told to batch.
 */
export const MAX_ACTIVE_TASKS = 3

/** Stored result cap. Same reasoning as local tools: the relay clamps at 8KB
 * downstream, so clamp here where we can still SAY the text was cut. */
export const TASK_RESULT_MAX = 20_000

/** Records older than this are pruned on the next start — a task from last
 * month is history, not a result anyone is waiting for. */
export const TASK_KEEP_MS = 7 * 24 * 60 * 60 * 1000

export type TaskStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'

export interface TaskRecord {
  id: string
  prompt: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  /** The answer (or the failure), clamped. */
  result?: string
  /** Has the news of this task finishing been delivered to a turn yet? */
  seen?: boolean
  /** Whose process claimed it — how a stale `running` row is detected. */
  pid: number
  host: string
}

const clamp = (s: string): string =>
  s.length > TASK_RESULT_MAX
    ? `${s.slice(0, TASK_RESULT_MAX)}\n… [result truncated at ${TASK_RESULT_MAX} chars]`
    : s

/**
 * Ids are time-ordered and human-sayable: a user reads them off a notification
 * and types them back, and `list` sorting by name is then chronological. The
 * counter disambiguates two starts in the same millisecond.
 */
let idSeq = 0
export function newTaskId(now: number = Date.now()): string {
  idSeq = (idSeq + 1) % 1000
  return `t${new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '')}${String(idSeq).padStart(3, '0')}`
}

/** A task id may only ever name a file inside the tasks dir. */
export function isValidTaskId(id: unknown): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

export function ensureTasksDir(dir: string = tasksDir()): string {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch { /* an unwritable dir means tasks can't persist — start() reports it */ }
  return dir
}

function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

/**
 * Write a record so no reader can ever see it half-written: a full file next to
 * it, then rename (atomic within a filesystem). `list` runs while a task is
 * finishing by construction, and a truncated read is indistinguishable from a
 * corrupt task.
 */
export function writeTask(rec: TaskRecord, dir: string = tasksDir()): void {
  ensureTasksDir(dir)
  const target = recordPath(dir, rec.id)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
}

export function readTask(id: string, dir: string = tasksDir()): TaskRecord | null {
  if (!isValidTaskId(id)) return null
  try {
    const rec = JSON.parse(readFileSync(recordPath(dir, id), 'utf-8'))
    return rec && typeof rec.id === 'string' ? rec : null
  } catch { return null }
}

/** Is that pid still alive? Signal 0 asks without delivering anything. */
export type PidLive = (pid: number) => boolean
export const realPidLive: PidLive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e: any) {
    // EPERM = alive but owned by someone else; only ESRCH means gone.
    return e?.code === 'EPERM'
  }
}

/**
 * A `running` record from a process that no longer exists is `interrupted`.
 * Only judged for THIS host: pids aren't comparable across machines, and a
 * ~/.tiny synced between two of them would otherwise declare the other's live
 * tasks dead — the one failure mode that turns a status display into a liar.
 */
export function reconcile(rec: TaskRecord, opts: { pidLive?: PidLive; host?: string } = {}): TaskRecord {
  if (rec.status !== 'running') return rec
  const host = opts.host ?? hostname()
  if (rec.host !== host) return rec
  const live = (opts.pidLive ?? realPidLive)(rec.pid)
  if (live) return rec
  return { ...rec, status: 'interrupted', endedAt: rec.endedAt ?? Date.now() }
}

/** Every record on disk, oldest first, with stale `running` rows reconciled. */
export function listTasks(dir: string = tasksDir(), opts: { pidLive?: PidLive; host?: string } = {}): TaskRecord[] {
  let files: string[] = []
  try { files = readdirSync(dir) } catch { return [] }
  const out: TaskRecord[] = []
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue // skips our own .tmp files too
    const rec = readTask(f.slice(0, -5), dir)
    if (rec) out.push(reconcile(rec, opts))
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Which records to delete: finished, and older than the keep window. A
 * still-`running` record is never pruned regardless of age — the process
 * holding it may be alive and about to write to it.
 */
export function prunable(records: TaskRecord[], now: number, keepMs = TASK_KEEP_MS): TaskRecord[] {
  return records.filter((r) => r.status !== 'running' && now - (r.endedAt ?? r.startedAt) > keepMs)
}

export function pruneTasks(dir: string = tasksDir(), now: number = Date.now()): string[] {
  const gone: string[] = []
  for (const r of prunable(listTasks(dir), now)) {
    try { unlinkSync(recordPath(dir, r.id)); gone.push(r.id) } catch { /* already gone */ }
  }
  return gone
}

// ── presentation ────────────────────────────────────────────────────────────

const ICON: Record<TaskStatus, string> = {
  running: '⏳', done: '✅', error: '❌', cancelled: '🚫', interrupted: '⚠️',
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export function formatTaskLine(r: TaskRecord, now: number = Date.now()): string {
  const dur = r.endedAt ? `${ago(r.endedAt - r.startedAt)}` : `${ago(now - r.startedAt)} so far`
  const head = `${ICON[r.status] || '•'} ${r.id} [${r.status}, ${dur}] ${r.prompt.replace(/\s+/g, ' ').slice(0, 80)}`
  if (r.status === 'running') return head
  const first = (r.result || '').replace(/\s+/g, ' ').slice(0, 100)
  return first ? `${head}\n     → ${first}` : head
}

export function summarizeTasks(records: TaskRecord[], now: number = Date.now()): string {
  if (!records.length) return '⏳ no background tasks (start one with use_tasks start)'
  return records.map((r) => formatTaskLine(r, now)).join('\n')
}

/**
 * The block injected into the next turn's context: tasks that finished while
 * nobody was looking. This is the whole point of the feature — a result the
 * user has to remember to ask for is a result they never see.
 */
export function finishedNewsBlock(records: TaskRecord[]): string {
  const fresh = records.filter((r) => r.status !== 'running' && !r.seen)
  if (!fresh.length) return ''
  const lines = fresh.map((r) => {
    const body = (r.result || '(no output)').replace(/\s+/g, ' ').slice(0, 600)
    return `- ${r.id} (${r.status}, "${r.prompt.replace(/\s+/g, ' ').slice(0, 60)}"): ${body}`
  })
  return `[Background tasks that finished since the last turn — tell the user, they asked for these]\n${lines.join('\n')}\n\n`
}

/** Flip the delivered flag. Separate from reading, so a failed injection
 * doesn't silently consume the news. */
export function markSeen(ids: string[], dir: string = tasksDir()): void {
  for (const id of ids) {
    const rec = readTask(id, dir)
    if (rec && !rec.seen) { try { writeTask({ ...rec, seen: true }, dir) } catch { /* best effort */ } }
  }
}

// ── the runner ──────────────────────────────────────────────────────────────

/** What a task needs to do its work: one fresh agent, one text answer. */
export interface TaskAgent { invoke: (prompt: string) => Promise<string> }

export interface TaskRunnerOptions {
  /** A FRESH agent per task — never the caller's, and it must not itself have use_tasks. */
  agentFactory: () => Promise<TaskAgent>
  dir?: string
  timeoutMs?: number
  maxActive?: number
  /** Reach the human at this machine when a task finishes (use_desktop notify). */
  notify?: (title: string, body: string) => void
  now?: () => number
}

export class TaskRunner {
  private opts: TaskRunnerOptions
  private active = new Map<string, Promise<void>>()
  /** Cancelled ids whose work may still land — its result is dropped. */
  private cancelled = new Set<string>()

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts
    ensureTasksDir(this.dir)
  }

  private get dir(): string { return this.opts.dir || tasksDir() }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  get activeCount(): number { return this.active.size }

  /**
   * Start a task. Returns the id the caller can hand back to the user
   * immediately — the point of the whole exercise.
   */
  start(prompt: string): { id: string } | { error: string } {
    const text = String(prompt || '').trim()
    if (!text) return { error: 'a task needs a prompt' }
    const max = this.opts.maxActive ?? MAX_ACTIVE_TASKS
    if (this.active.size >= max) {
      return { error: `${this.active.size} tasks already running (max ${max}) — wait for one to finish, or batch this work into a running task's next step` }
    }
    const id = newTaskId(this.now())
    const rec: TaskRecord = {
      id, prompt: text, status: 'running', startedAt: this.now(),
      pid: process.pid, host: hostname(),
    }
    try {
      writeTask(rec, this.dir)
    } catch (e: any) {
      // No record means no result anyone could ever collect — refuse loudly
      // instead of running work whose answer has nowhere to go.
      return { error: `cannot persist task: ${String(e?.message || e).slice(0, 200)}` }
    }
    const p = this.run(rec).finally(() => { this.active.delete(id) })
    this.active.set(id, p)
    return { id }
  }

  private async run(rec: TaskRecord): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? TASK_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    let status: TaskStatus = 'done'
    let result: string
    try {
      const agent = await this.opts.agentFactory()
      result = await Promise.race([
        agent.invoke(rec.prompt),
        // Not unref'd, for the same reason the local-tool timer isn't: an
        // unref'd timer can't hold the loop open, so a wedged task would let a
        // short-lived process exit with the record still claiming `running`.
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`task timed out after ${Math.round(timeoutMs / 60000)}min`)), timeoutMs)
        }),
      ]).then((r) => String(r))
    } catch (e: any) {
      status = 'error'
      result = String(e?.message || e).slice(0, 2000)
    } finally {
      if (timer) clearTimeout(timer)
    }

    // A task cancelled mid-flight keeps its cancelled status: the user was told
    // we stopped watching, and re-labelling it `done` afterwards contradicts the
    // message they already have.
    if (this.cancelled.has(rec.id)) {
      this.cancelled.delete(rec.id)
      const current = readTask(rec.id, this.dir)
      if (current) writeTask({ ...current, endedAt: this.now(), result: clamp(`(cancelled; work finished anyway)\n${result}`) }, this.dir)
      return
    }

    const done: TaskRecord = { ...rec, status, endedAt: this.now(), result: clamp(result) }
    try { writeTask(done, this.dir) } catch { /* the answer is lost; nothing better to do */ }
    // The daemon is headless: without this the person at the keyboard has no
    // idea their 12-minute job landed.
    try {
      this.opts.notify?.(
        status === 'done' ? `tiny: task ${rec.id} done` : `tiny: task ${rec.id} ${status}`,
        `${rec.prompt.slice(0, 80)}\n${clamp(result).slice(0, 200)}`,
      )
    } catch { /* a notification is never worth failing a finished task over */ }
  }

  /**
   * Stop waiting on a task. Deliberately NOT "kill it": nothing here can abort
   * a model turn already in flight or a shell command it spawned, and saying
   * "cancelled" about work still running on the user's laptop is a lie.
   */
  cancel(id: string): string {
    const rec = readTask(id, this.dir)
    if (!rec) return `no such task: ${id}`
    if (rec.status !== 'running') return `task ${id} is already ${rec.status}`
    this.cancelled.add(id)
    writeTask({ ...rec, status: 'cancelled', endedAt: this.now(), result: '(cancelled by user)' }, this.dir)
    return this.active.has(id)
      ? `task ${id} cancelled — its result will be discarded. Note it may still be finishing in the background; nothing can abort a model turn already in flight.`
      : `task ${id} marked cancelled (it was not running in this process)`
  }

  list(): TaskRecord[] { return listTasks(this.dir) }
  get(id: string): TaskRecord | null {
    const rec = readTask(id, this.dir)
    return rec ? reconcile(rec) : null
  }

  /** Finished-task news for the next turn, marked delivered. */
  takeNews(): string {
    const records = this.list()
    const block = finishedNewsBlock(records)
    if (block) markSeen(records.filter((r) => r.status !== 'running' && !r.seen).map((r) => r.id), this.dir)
    return block
  }

  /** Old finished records, dropped. Called at startup. */
  prune(): string[] { return pruneTasks(this.dir, this.now()) }
}

export const TASKS_DESCRIPTION = `⏳ Background work on this machine that outlives the current turn. Actions:
- start (prompt) — run a job on a fresh agent in the background; returns a task id immediately. Use this for anything that will take more than a minute: reindexing, watching a build, summarising many files. The caller is often waiting on a 45s timeout, so a long job MUST go here.
- list — every task and its status (running / done / error / cancelled / interrupted)
- result (id) — the full answer of a finished task
- cancel (id) — stop waiting on a task and discard its result

Results are also injected into your next turn automatically, so you can tell the user without them asking. Say the task id out loud when you start one — it's how they refer to it later.`

export function makeTasksTool(runner: TaskRunner) {
  return tool({
    name: 'use_tasks',
    description: TASKS_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'result', 'cancel'], description: 'start, list, result or cancel' },
        prompt: { type: 'string', description: 'what the background task should do (action=start)' },
        id: { type: 'string', description: 'task id (action=result|cancel)' },
      },
      required: ['action'],
    },
    callback: async (input: any) => {
      const action = String(input?.action || 'list')
      switch (action) {
        case 'start': {
          const r = runner.start(String(input?.prompt || ''))
          if ('error' in r) return r.error
          return `started task ${r.id} — it runs in the background; tell the user the id. Its result will appear in a later turn, or ask for it with use_tasks result id=${r.id}.`
        }
        case 'list':
          return summarizeTasks(runner.list())
        case 'result': {
          const id = String(input?.id || '')
          if (!isValidTaskId(id)) return 'need a task id (see use_tasks list)'
          const rec = runner.get(id)
          if (!rec) return `no such task: ${id}`
          if (rec.status === 'running') return `task ${id} is still running (${formatTaskLine(rec)})`
          return `${formatTaskLine(rec)}\n\n${rec.result || '(no output)'}`
        }
        case 'cancel': {
          const id = String(input?.id || '')
          if (!isValidTaskId(id)) return 'need a task id (see use_tasks list)'
          return runner.cancel(id)
        }
        default:
          return `unknown action: ${action} (start|list|result|cancel)`
      }
    },
  })
}
