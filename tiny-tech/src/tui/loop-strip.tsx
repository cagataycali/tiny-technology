/**
 * ♾️ Background loops, picture-in-picture.
 *
 * A loop already reports itself two ways: `/loops` when asked, and the news block
 * injected into a later turn (loopNewsBlock, every LOOP_NEWS_EVERY iterations).
 * Neither is ambient — which is how two loops died at iteration 2 one night and
 * were only discovered because someone happened to ask. This is the third
 * surface: a permanent strip above the composer that says what is running right
 * now, in the shape the call strip established.
 *
 * Where the data comes from matters. A loop's record is a JSON file in
 * ~/.tiny/loops written by whichever process runs it — possibly a different
 * process, possibly the server while this machine was asleep — so there is no
 * in-process event to subscribe to. Disk is the only truth, listLoops() runs each
 * record through reconcile() (a record whose pid is gone becomes `interrupted`),
 * and a 2s poll of a handful of small JSON files is cheaper than one Ink repaint.
 *
 * Split like voice-call.tsx: `loopStripRows` is pure (testable without a TTY or a
 * filesystem), the hook owns the timer, the component is props in / elements out.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { LoopRecord } from '../agent/loop.js'
import { LOOP_COOLDOWN_MS, LOOP_MAX_ITERATIONS } from '../agent/loop.js'

/** Rows the strip draws per loop: the head line, the goal, the last step. */
export const ROWS_PER_LOOP = 3

/**
 * How long a just-ended loop lingers in the strip before it disappears.
 *
 * A loop that finished at iteration 3 with useful output deserves the eye's
 * transition — a strip that snapped it off the moment it ended read like a
 * silent failure. Long enough to notice the state change, short enough that
 * the strip is still about what's running RIGHT NOW.
 */
export const ENDED_LINGER_MS = 5000

export interface LoopStripRow {
  id: string
  /** `iter 3/200 · 4m12s` */
  meta: string
  /** The goal, flattened to one line. */
  goal: string
  /** What the last iteration reported, flattened. Empty before the first one. */
  step: string
  /** `next step in 24s` / `working…` / `done` / `stopped` — never a spinner's job to say. */
  phase: string
  /** Terminal state for styling — `undefined` = still running. */
  endedAs?: 'done' | 'error' | 'stopped' | 'interrupted' | 'exhausted'
}

const flat = (s: string, max: number): string => {
  const one = (s || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${(s / 3600).toFixed(1)}h`
}

/**
 * The running loops, as rows — plus loops that ended in the last ENDED_LINGER_MS,
 * so a completion is a state transition the eye can see instead of a snap-cut
 * that reads like a silent failure. Loops that ended longer ago than the linger
 * window are dropped: news reaches the transcript on its own and a stale strip
 * entry would be a second, worse copy of the same fact.
 *
 * `width` is the terminal's columns — the step line is the one field that can be
 * arbitrarily long, and truncating it here (rather than letting Ink wrap it)
 * keeps the strip's height exactly ROWS_PER_LOOP per loop.
 */
export function loopStripRows(records: LoopRecord[], now: number = Date.now(), width = 80): LoopStripRow[] {
  const room = Math.max(20, width - 6)
  const visible = records.filter((r) => {
    if (r.status === 'running') return true
    // Ended-loop grace: show for a short window after endedAt (or now-ish if
    // the record predates the field), then let it fall out of the strip.
    const endedAt = r.endedAt
    if (endedAt == null) return false   // no timestamp; treat as long-gone
    return now - endedAt < ENDED_LINGER_MS
  })
  return visible.map((r) => {
    const last = r.iterations[r.iterations.length - 1]
    const n = r.iterations.length
    // Cooldown is the honest answer to "why is nothing happening?" — between
    // iterations a loop is deliberately idle, and without this the strip looks
    // stalled for 30 seconds at a time.
    const since = last ? now - last.at : 0
    const cooling = r.status === 'running' && !!last && since < LOOP_COOLDOWN_MS
    // Terminal state wins over cooldown/working — a stopped loop that happens
    // to have last-iteration-just-happened shouldn't say "next step in 24s".
    const phase = r.status === 'running'
      ? (cooling ? `next step in ${dur(LOOP_COOLDOWN_MS - since)}` : 'working…')
      : r.status   // 'done' | 'error' | 'stopped' | 'interrupted' | 'exhausted'
    // The agent's own words beat a blind tail-slice of its prose: loop_done
    // status='progress' writes into note. Every existing surface (news block,
    // /loops journal) already prefers note over summary — this is that same
    // choice, ported into the strip.
    const stepText = last ? (last.note || last.summary) : ''
    return {
      id: r.id,
      meta: `iter ${n}/${r.maxIterations ?? LOOP_MAX_ITERATIONS} · ${dur(now - r.startedAt)}`,
      goal: flat(r.prompt, room),
      step: stepText ? `↳ ${flat(stepText, room)}` : '',
      phase,
      ...(r.status !== 'running' ? { endedAs: r.status } : {}),
    }
  })
}

/**
 * Poll the loop records. Interval, not subscription — see the header.
 *
 * The read is wrapped: a record being written while we read it is a normal race
 * (writeLoop is not atomic across processes), and a JSON parse error must not
 * take the TUI's render down. listLoops already tolerates a bad file; this is the
 * belt for the import itself, which is dynamic so the TUI does not pull the loop
 * runner into its startup path.
 *
 * Returned set includes RUNNING loops plus loops that ENDED in the last
 * ENDED_LINGER_MS — loopStripRows() takes care of the second filter with a
 * fresh `now`, so a poll cycle that lands mid-linger still shows the ending
 * transition. Everything older is dropped here.
 */
export function useRunningLoops(intervalMs = 2000): LoopRecord[] {
  const [records, setRecords] = useState<LoopRecord[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const mod = await import('../agent/loop.js')
        const all = (mod as any).listLoops() as LoopRecord[]
        if (alive) {
          const now = Date.now()
          setRecords(all.filter((r) => {
            if (r.status === 'running') return true
            const endedAt = r.endedAt
            return endedAt != null && now - endedAt < ENDED_LINGER_MS
          }))
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
 * The strip itself. One block per running (or just-ended) loop, fixed height,
 * no spinner: the panels above already carry the spinners, and a second
 * animated thing next to the composer competes with the keystrokes going into
 * it (FRAME_MS in voice-call.tsx exists for exactly that reason).
 *
 * An ended loop lingers briefly with its whole row muted (green for done, red
 * for the failure states, both without bold) so the transition is a visible
 * event without stealing the eye from the running loops next to it. A strip
 * that snapped a completed loop off the instant the record flipped read like
 * a silent failure; one that kept the finished row as bright as the running
 * ones read like the loop was still going.
 */
export function LoopStrip({ rows }: { rows: LoopStripRow[] }) {
  if (!rows.length) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((r) => {
        const ended = !!r.endedAs
        // A finished loop's colour signals its outcome without a second glance.
        // `done` is the only success shape; everything else is a form of "did
        // not finish", and reading them as red keeps that plain. Ended rows
        // drop `bold` on both the glyph and the id — a completed row that
        // shouts as loudly as a running one buries the actually-live work.
        const glyphColor = r.endedAs === 'done' ? 'green'
          : ended ? 'red'
          : 'magenta'
        const glyph = r.endedAs === 'done' ? '✓' : ended ? '✗' : '♾'
        return (
          <Box key={r.id} flexDirection="column">
            <Box>
              <Box flexShrink={0}>
                <Text color={glyphColor} dimColor={ended}>{`${glyph} `}</Text>
                <Text color={glyphColor} bold={!ended} dimColor={ended}>{r.id}</Text>
                <Text dimColor>{'  '}{r.meta}</Text>
              </Box>
              <Box flexGrow={1} justifyContent="flex-end">
                <Text dimColor>{r.phase}</Text>
              </Box>
            </Box>
            <Text dimColor wrap="truncate-end">{'   '}{r.goal}</Text>
            {r.step ? <Text dimColor wrap="truncate-end">{'   '}{r.step}</Text> : null}
          </Box>
        )
      })}
      <Text dimColor>{'   /loops for the journals'}</Text>
    </Box>
  )
}
