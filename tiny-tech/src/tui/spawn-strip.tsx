/**
 * ⭐ spawn_agents batches, picture-in-picture.
 *
 * A batch used to run dark: the tool call chip appears, and then nothing
 * until the aggregate lands — worst for wait:false, where "nothing" could be
 * minutes. This is the loop strip's remedy applied to batches: a row per
 * active batch above the composer, saying how many tasks settled, how many
 * are still spinning, and for how long.
 *
 * Data comes off disk (~/.tiny/spawns, spawn-state.ts) for the reason
 * loop-strip.tsx reads ~/.tiny/loops: the batch may be running in a DIFFERENT
 * process than the TUI drawing it, so disk is the only truth, and a 2s poll
 * of a handful of small JSON files is cheaper than one Ink repaint.
 *
 * Split like loop-strip.tsx: `spawnStripRows` is pure (testable without a TTY
 * or a filesystem), the hook owns the timer, the component is props in /
 * elements out. One row per batch — a batch has no goal text or journal step,
 * so it earns one line, not loop's three.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { SpawnBatchRecord } from '../agent/spawn-state.js'

/**
 * How long a finished batch lingers, muted, before it leaves the strip.
 * Same figure and same reasoning as loop-strip's ENDED_LINGER_MS: a snap-cut
 * the moment the record closes reads like a silent failure; a longer stay
 * makes the strip about the past instead of what is running right now.
 */
export const SPAWN_ENDED_LINGER_MS = 5000

export interface SpawnStripRow {
  /** The batch_* ticket — already short, already the id the reply quoted. */
  id: string
  /** `2/3 ✓ · 1 ⟳` — settled over total, spinners, failures if any. */
  status: string
  /** `12s` while running (grows), frozen at the batch's span once ended. */
  elapsed: string
  /** Terminal state for styling — `undefined` = still running. */
  endedAs?: 'done' | 'error' | 'interrupted'
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${(s / 3600).toFixed(1)}h`
}

/**
 * The active batches as rows — running ones plus batches that ended in the
 * last SPAWN_ENDED_LINGER_MS, muted, so a completion is a visible transition.
 * Past the linger they are dropped: the aggregate reached the transcript /
 * history on its own, and a stale row would be a second, worse copy of it.
 *
 * The status text counts states rather than listing tasks: at one row per
 * batch, `2/3 ✓ · 1 ⟳` is the whole story, and failures only appear when
 * they exist (`· 1 ✗`) so the common all-green case stays quiet.
 */
export function spawnStripRows(records: SpawnBatchRecord[], now: number = Date.now()): SpawnStripRow[] {
  const visible = records.filter((r) => {
    if (r.endedAt == null) return true
    return now - r.endedAt < SPAWN_ENDED_LINGER_MS
  })
  return visible.map((r) => {
    const total = r.tasks.length
    const ok = r.tasks.filter((t) => t.status === 'ok').length
    const err = r.tasks.filter((t) => t.status === 'error').length
    const running = total - ok - err
    const parts = [`${ok}/${total} ✓`]
    if (running > 0) parts.push(`${running} ⟳`)
    if (err > 0) parts.push(`${err} ✗`)
    const ended = r.endedAt != null
    // Interrupted wins over the ✓/✗ arithmetic: reconcile() already stamped
    // the open tasks as errors, and "the process died" is the truer headline.
    const endedAs = !ended ? undefined
      : r.interrupted ? 'interrupted' as const
      : err > 0 ? 'error' as const
      : 'done' as const
    return {
      id: r.batchId,
      status: parts.join(' · '),
      elapsed: dur((ended ? r.endedAt! : now) - r.startedAt),
      ...(endedAs ? { endedAs } : {}),
    }
  })
}

/**
 * Poll the batch records — interval, not subscription, exactly as
 * useRunningLoops does and for the same reason (the writer may be another
 * process; disk is the channel). The import is dynamic so the TUI does not
 * pull the agent's spawn machinery into its startup path, and the whole read
 * is wrapped: a torn record or a missing dir must never take a render down.
 */
export function useSpawnBatches(intervalMs = 2000): SpawnBatchRecord[] {
  const [records, setRecords] = useState<SpawnBatchRecord[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const mod = await import('../agent/spawn-state.js')
        const all = (mod as any).listSpawnBatches() as SpawnBatchRecord[]
        if (alive) {
          const now = Date.now()
          setRecords(all.filter((r) => r.endedAt == null || now - r.endedAt < SPAWN_ENDED_LINGER_MS))
        }
      } catch {
        if (alive) setRecords([])
      }
      if (alive) timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [intervalMs])
  return records
}

/**
 * The strip itself — loop-strip's visual vocabulary at one row per batch:
 * a colored glyph + bold id while running, the whole row muted once ended
 * (green ✓ for all-ok, red ✗ for anything else), elapsed right-aligned where
 * the loop strip puts its phase. No spinner — the ⟳ count in the status text
 * already says "in flight", and animation next to the composer competes with
 * the keystrokes going into it.
 */
export function SpawnStrip({ rows }: { rows: SpawnStripRow[] }) {
  if (!rows.length) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((r) => {
        const ended = !!r.endedAs
        const glyphColor = r.endedAs === 'done' ? 'green' : ended ? 'red' : 'cyan'
        const glyph = r.endedAs === 'done' ? '✓' : ended ? '✗' : '🤖'
        return (
          <Box key={r.id}>
            <Box flexShrink={0}>
              <Text color={glyphColor} dimColor={ended}>{`${glyph} `}</Text>
              <Text color={glyphColor} bold={!ended} dimColor={ended}>{r.id}</Text>
              <Text dimColor>{'  '}{r.status}</Text>
              {r.endedAs === 'interrupted' ? <Text color="red" dimColor>{'  interrupted'}</Text> : null}
            </Box>
            <Box flexGrow={1} justifyContent="flex-end">
              <Text dimColor>{r.elapsed}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
