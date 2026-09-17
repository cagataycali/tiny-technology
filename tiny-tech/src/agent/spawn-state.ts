/**
 * ⭐ spawn_agents batch progress — the strip's data source.
 *
 * A spawn batch used to be invisible while it ran: the tool returns (or, for
 * wait:false, deposits a ticket) and the TUI showed NOTHING until the
 * aggregate landed. This is the same gap the loop strip closed for loops, so
 * it is closed the same way: a JSON record per batch under ~/.tiny/spawns,
 * written by whichever process runs the batch, polled off disk by the TUI.
 *
 * Disk, not an in-proc emitter, deliberately — the batch may run in a
 * different process than the TUI that wants to draw it (a daemon's agent, a
 * second terminal), exactly the reason loop-strip.tsx reads ~/.tiny/loops.
 * One convention, one mental model, one test shape.
 *
 * Everything that decides is pure (startBatch/markTask/endBatch/reconcile);
 * the file I/O mirrors loop.ts verbatim: atomic tmp+rename writes so a reader
 * never sees half a record, best-effort reads that treat a torn file as
 * absent, and a pid liveness check so a crashed process's batch becomes
 * `interrupted` instead of spinning in the strip forever.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── contract ─────────────────────────────────────────────────────────────────

export type SpawnTaskStatus = 'running' | 'ok' | 'error'

export interface SpawnTaskState {
  /** 0-based task index — stable, matches the tasks array order. */
  index: number
  status: SpawnTaskStatus
  startedAt: number
  endedAt?: number
}

export interface SpawnBatchRecord {
  batchId: string
  startedAt: number
  /** Set when every task has settled (or the batch was reconciled dead). */
  endedAt?: number
  /** The process running the batch — liveness is reconcile()'s evidence. */
  pid?: number
  /** True when reconcile() declared the owning process gone mid-batch. */
  interrupted?: boolean
  tasks: SpawnTaskState[]
}

/** Ended records older than this are deleted by prune — the strip's linger
 *  window is seconds, and the aggregate already lives in history. */
export const SPAWN_STATE_PRUNE_MS = 10 * 60 * 1000

// ── where records live (loopsDir's rule, different leaf) ────────────────────

export function spawnsDir(): string {
  if (process.env.TINY_SPAWNS_DIR) return process.env.TINY_SPAWNS_DIR
  const home = process.env.TINY_HOME || join(homedir(), '.tiny')
  return join(home, 'spawns')
}

export function ensureSpawnsDir(dir: string = spawnsDir()): string {
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* writes report */ }
  return dir
}

/** batch_* tickets only — the id becomes a filename, so validate before join. */
export function isValidBatchId(id: string): boolean {
  return /^batch_[a-z0-9]{1,64}$/.test(id)
}

function recordPath(dir: string, id: string): string { return join(dir, `${id}.json`) }

// ── pure transitions ─────────────────────────────────────────────────────────

/** A fresh record: every task `running` from the batch's first breath — tasks
 *  are dispatched concurrently (Promise.all), so one start time is the truth. */
export function startBatch(batchId: string, taskCount: number, now: number = Date.now(), pid?: number): SpawnBatchRecord {
  const n = Math.max(1, taskCount)
  return {
    batchId,
    startedAt: now,
    ...(pid != null ? { pid } : {}),
    tasks: Array.from({ length: n }, (_, index) => ({ index, status: 'running' as const, startedAt: now })),
  }
}

/** One task settled. Returns a NEW record; unknown index is a no-op copy. */
export function markTask(rec: SpawnBatchRecord, index: number, ok: boolean, now: number = Date.now()): SpawnBatchRecord {
  return {
    ...rec,
    tasks: rec.tasks.map((t) =>
      t.index === index && t.status === 'running'
        ? { ...t, status: ok ? 'ok' as const : 'error' as const, endedAt: now }
        : t,
    ),
  }
}

/** The batch is over. Any task still `running` is stamped as error — a batch
 *  cannot end with work outstanding, and a row frozen at ⟳ forever would lie. */
export function endBatch(rec: SpawnBatchRecord, now: number = Date.now()): SpawnBatchRecord {
  return {
    ...rec,
    endedAt: now,
    tasks: rec.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'error' as const, endedAt: now } : t)),
  }
}

// ── disk (loop.ts's exact shape) ─────────────────────────────────────────────

/** Atomic write — tmp file + rename, so a reader never sees half a record. */
export function writeSpawnBatch(rec: SpawnBatchRecord, dir: string = spawnsDir()): void {
  if (!isValidBatchId(rec.batchId)) return
  ensureSpawnsDir(dir)
  const target = recordPath(dir, rec.batchId)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
}

export function readSpawnBatch(id: string, dir: string = spawnsDir()): SpawnBatchRecord | null {
  if (!isValidBatchId(id)) return null
  try {
    const rec = JSON.parse(readFileSync(recordPath(dir, id), 'utf-8'))
    return rec && typeof rec.batchId === 'string' && Array.isArray(rec.tasks) ? rec : null
  } catch { return null }
}

export type PidLive = (pid: number) => boolean

const defaultPidLive: PidLive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * A running record whose process is gone becomes `interrupted` — ended now,
 * open tasks marked error, so the strip shows a visible failure once and then
 * lets it linger out, instead of an eternal spinner for a batch nobody is
 * running. Records without a pid can't be checked and are left alone (the
 * prune window bounds how long they can haunt).
 */
export function reconcile(rec: SpawnBatchRecord, opts: { pidLive?: PidLive; now?: number } = {}): SpawnBatchRecord {
  if (rec.endedAt != null) return rec
  if (rec.pid == null) return rec
  const live = (opts.pidLive || defaultPidLive)(rec.pid)
  if (live) return rec
  return { ...endBatch(rec, opts.now ?? Date.now()), interrupted: true }
}

export function listSpawnBatches(dir: string = spawnsDir(), opts: { pidLive?: PidLive; now?: number } = {}): SpawnBatchRecord[] {
  let files: string[] = []
  try { files = readdirSync(dir) } catch { return [] }
  const out: SpawnBatchRecord[] = []
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue
    const rec = readSpawnBatch(f.slice(0, -5), dir)
    if (rec) out.push(reconcile(rec, opts))
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/** Delete ended records older than the prune window. Called opportunistically
 *  when a batch ends — the dir stays a handful of files, never a landfill. */
export function pruneSpawnBatches(dir: string = spawnsDir(), now: number = Date.now()): string[] {
  const gone: string[] = []
  for (const r of listSpawnBatches(dir)) {
    if (r.endedAt != null && now - r.endedAt > SPAWN_STATE_PRUNE_MS) {
      try { unlinkSync(recordPath(dir, r.batchId)); gone.push(r.batchId) } catch { /* next prune */ }
    }
  }
  return gone
}

// ── the reporter runSpawnBatch drives ───────────────────────────────────────

export interface SpawnReporter {
  taskEnded: (index: number, ok: boolean) => void
  batchEnded: () => void
}

/**
 * Bind the pure transitions to disk. Every write is wrapped: progress
 * reporting is an enhancement, and a full disk must not fail the batch that
 * is otherwise finishing fine (same rule as the wait:false delivery rails).
 */
export function makeSpawnReporter(
  batchId: string,
  taskCount: number,
  opts: { dir?: string; now?: () => number; pid?: number } = {},
): SpawnReporter {
  const dir = opts.dir || spawnsDir()
  const now = opts.now || Date.now
  let rec = startBatch(batchId, taskCount, now(), opts.pid ?? process.pid)
  try { writeSpawnBatch(rec, dir) } catch { /* enhancement */ }
  return {
    taskEnded(index, ok) {
      rec = markTask(rec, index, ok, now())
      try { writeSpawnBatch(rec, dir) } catch { /* enhancement */ }
    },
    batchEnded() {
      rec = endBatch(rec, now())
      try { writeSpawnBatch(rec, dir) } catch { /* enhancement */ }
      try { pruneSpawnBatches(dir, now()) } catch { /* next batch prunes */ }
    },
  }
}
