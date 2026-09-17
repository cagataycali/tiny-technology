/**
 * 💬 The marquee row — the blackboard's one line above the composer.
 *
 * Same split as loop-strip.tsx, for the same reasons: the file in ~/.tiny is
 * the only truth (any process may have appended — a loop, a mesh peer, this
 * TUI's own agent), so the hook polls it every 2s; `marqueeRowFor` is pure so
 * the picking/muting rules are testable without a TTY; and the component is
 * props in / elements out.
 *
 * v2: the reveal is a HUMAN keystroke performance, not a metronome. The pure
 * planner in human-type.ts turns {text, emotion, seed} into a tape of
 * char/backspace/wait ops — jittered timing, thinking pauses at punctuation,
 * the occasional qwerty typo that gets noticed and corrected. The seed lives
 * in the entry, so every terminal watching the blackboard sees the SAME
 * performance; v1 entries without a seed fall back to hash(id). One timer
 * chain per new entry (each op schedules the next), then the row is still —
 * the FRAME_MS lesson from voice-call.tsx still applies, we just spend the
 * repaints on personality instead of a fixed 30ms grid.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'
import { readMarquee, type MarqueeEntry } from '../agent/marquee.js'
import { hashSeed, humanPlan } from './human-type.js'
import { parseMarkup, spansFor, styleAt, type StyleSpan } from './marquee-markup.js'

/** How long an entry stays bright. Past this it renders muted — old news. */
export const MARQUEE_LINGER_MS = 60_000

/** Cursor blink cadence while the row is idle. */
export const CURSOR_BLINK_MS = 500

/** How long a finished performance holds the row before the queue advances. */
export const QUEUE_ADVANCE_MS = 1500

export interface MarqueeRow {
  id: string
  author: string
  text: string
  /** Said within MARQUEE_LINGER_MS — bright. Older — muted. */
  fresh: boolean
  /** Keystroke-tape seed from the entry; absent on v1 entries. */
  seed?: number
  /** Typing personality from the entry; absent means calm. */
  emotion?: string
}

/**
 * The newest resolved entry, as the one row the strip shows. Nothing on the
 * blackboard → null → the row costs zero height (layout.ts counts it only
 * when it exists).
 */
export function marqueeRowFor(entries: MarqueeEntry[], now: number = Date.now()): MarqueeRow | null {
  if (!entries.length) return null
  let newest = entries[0]
  for (const e of entries) if (e.ts > newest.ts) newest = e
  return toRow(newest, now)
}

function toRow(e: MarqueeEntry, now: number): MarqueeRow {
  return {
    id: e.id,
    author: e.author,
    text: e.text,
    fresh: now - e.ts < MARQUEE_LINGER_MS,
    ...(Number.isFinite(e.seed) ? { seed: e.seed } : {}),
    ...(e.emotion ? { emotion: e.emotion } : {}),
  }
}

/**
 * v4: the queue. When several entries land inside one linger window, they
 * PLAY IN ORDER — oldest unplayed fresh entry first — instead of the newest
 * silently swallowing the rest. `queued` counts the fresh entries still
 * waiting behind the pick, for the '+N queued' hint at the row's end.
 *
 * Nothing is dropped: every fresh entry gets its performance before the row
 * settles. Once everything has played (or nothing is fresh), the pick falls
 * back to marqueeRowFor's newest-wins — so the linger/mute grammar is exactly
 * v3's: the newest line stays on the row, muting once it outlives LINGER.
 */
export function marqueeQueue(
  entries: MarqueeEntry[],
  played: ReadonlySet<string>,
  now: number = Date.now(),
): { row: MarqueeRow | null; queued: number } {
  if (!entries.length) return { row: null, queued: 0 }
  const fresh = entries
    .filter((e) => now - e.ts < MARQUEE_LINGER_MS && !played.has(e.id))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  if (fresh.length) return { row: toRow(fresh[0], now), queued: fresh.length - 1 }
  return { row: marqueeRowFor(entries, now), queued: 0 }
}

/**
 * Poll the blackboard. Interval, not subscription — other PROCESSES write the
 * file, so there is no in-process event to hear. The read is cheap (one small
 * file) and already tolerates torn lines, but the belt goes on anyway: a read
 * error must never take the TUI's render down.
 */
export function useMarquee(intervalMs = 2000): MarqueeEntry[] {
  const [entries, setEntries] = useState<MarqueeEntry[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      try {
        const all = readMarquee()
        if (alive) setEntries(all)
      } catch {
        if (alive) setEntries([])
      }
      if (alive) timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [intervalMs])
  return entries
}

/**
 * The longest prefix of `s` that DISPLAYS in at most `max` columns — measured
 * with the same string-width Ink layouts with, walked by code point so a wide
 * char (emoji, CJK) is never split in half.
 */
export function fitToWidth(s: string, max: number): string {
  if (stringWidth(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = stringWidth(ch)
    if (w + cw > max) break
    out += ch
    w += cw
  }
  return out
}

export interface MarqueeFit {
  author: string
  text: string
  truncated: boolean
}

/**
 * Fit the row into ONE terminal line, by our own arithmetic.
 *
 * Why not Ink's wrap="truncate-end"? Because the row mixes an emoji prefix,
 * a shrinkable author, a Text made of MANY styled runs (the auto-highlight
 * pass splits the buffer per style), a blinking cursor and a queued hint —
 * and Ink's flex truncation across that nest comes out 1-2 columns WIDE of
 * the terminal. An over-wide line hard-wraps in the terminal, Ink's eraser
 * counts one line where the terminal printed two, and every repaint (the
 * 500ms cursor blink!) leaves one stale line behind — the row "scrolls up"
 * a newline a second. So the component pre-fits everything here, leaving one
 * column of slack so the last cell never triggers the terminal's autowrap,
 * and hands Ink content that cannot overflow.
 *
 * Budget: '💬 '(3) + author + ': '(2) + text + cursor(1) [+ ' +N queued'].
 * A long author yields to the text (never below 8 columns of itself); the
 * text truncates with '…'. Pure, so the invariant lives in tests.
 */
export function marqueeFit(author: string, text: string, columns: number, queued = 0): MarqueeFit {
  const suffix = queued > 0 ? ` +${queued} queued` : ''
  // 3 prefix + 2 separator + 1 cursor + 1 slack column against autowrap.
  const avail = Math.max(2, columns - 3 - 2 - 1 - 1 - stringWidth(suffix))
  // The author may take up to half the room (a generous 8 when the room
  // allows), but ALWAYS leaves at least one column for the text — the
  // invariant is the line, not either part's comfort.
  const authorCap = Math.min(Math.max(8, Math.floor(avail / 2)), Math.max(1, avail - 1))
  const a = stringWidth(author) > authorCap ? fitToWidth(author, authorCap) : author
  const budget = Math.max(1, avail - stringWidth(a))
  if (stringWidth(text) <= budget) return { author: a, text, truncated: false }
  return { author: a, text: fitToWidth(text, Math.max(0, budget - 1)) + '…', truncated: true }
}

/**
 * One row: `💬 author: text▎ +N queued`. A NEW entry performs its keystroke
 * tape — buffer grows on 'char', shrinks on 'bs' (there goes the typo), holds
 * on 'wait'. The tape keys on the entry id, so a poll cycle can't restart the
 * performance; a re-render of the same entry shows whatever the buffer holds.
 * The cursor is solid while typing and blinks (~500ms) once the tape ends.
 * Stale rows go dim wholesale — same muting grammar as ended loops.
 *
 * v4: the component owns the queue. `played` remembers every entry that got
 * its performance (a ref — replaying on re-render would be noise), and when a
 * tape ends with entries still waiting, a short hold (QUEUE_ADVANCE_MS) lets
 * the line be read before the next one starts typing. The pick itself is the
 * pure marqueeQueue above, so ordering rules live in tests, not in JSX.
 */
export function Marquee({ entries }: { entries: MarqueeEntry[] }) {
  const [buf, setBuf] = useState('')
  const [typing, setTyping] = useState(false)
  const [blinkOn, setBlinkOn] = useState(true)
  const [, setBump] = useState(0)          // re-pick after a hold expires
  const lastId = useRef<string | null>(null)
  const played = useRef<Set<string>>(new Set())
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { columns } = useWindowSize()

  const { row, queued } = marqueeQueue(entries, played.current)

  useEffect(() => {
    if (!row) { lastId.current = null; return }
    if (lastId.current === row.id) return
    lastId.current = row.id
    // The entry carries its seed so every terminal replays the same tape;
    // v1 entries (no seed) hash their id — still deterministic everywhere.
    const seed = Number.isFinite(row.seed) ? (row.seed as number) : hashSeed(row.id)
    // The planner types PLAIN text — markup is a render-time overlay, so the
    // keystroke tape is identical whether or not the entry carries colors.
    const plan = humanPlan(parseMarkup(row.text).plain, { emotion: row.emotion, seed })
    let cur = ''
    let i = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    setBuf('')
    setTyping(true)
    const step = () => {
      if (i >= plan.length) {
        setTyping(false)
        // Performance over — this entry has been said. Mark it played and,
        // after a beat long enough to read the line, wake the queue.
        played.current.add(row.id)
        holdTimer.current = setTimeout(() => setBump((n) => n + 1), QUEUE_ADVANCE_MS)
        return
      }
      const op = plan[i++]
      if (op.op === 'char') { cur += op.ch; setBuf(cur) }
      else if (op.op === 'bs') { cur = cur.slice(0, -1); setBuf(cur) }
      timer = setTimeout(step, op.ms)
    }
    step()
    return () => {
      if (timer) clearTimeout(timer)
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    }
  }, [row?.id])

  // Idle cursor blink. One interval, only while something is on the row and
  // the tape has finished — a blinking cursor over active typing reads wrong.
  useEffect(() => {
    if (!row || typing) { setBlinkOn(true); return }
    const t = setInterval(() => setBlinkOn((b) => !b), CURSOR_BLINK_MS)
    return () => clearInterval(t)
  }, [row?.id, typing])

  if (!row) return null
  const cursor = typing ? '▎' : blinkOn ? '▎' : ' '
  // Fit the whole row into one line by our own width arithmetic — Ink's flex
  // truncation over this nest of styled runs overflows by a column or two,
  // and an over-wide line is the scroll-a-newline-per-blink bug (see
  // marqueeFit's note). The buffer is cut from the END, so buffer indices
  // still ARE plain indices and every kept char wears the style of its own
  // position; the '…' simply inherits the style where it lands.
  const fit = marqueeFit(row.author, buf, columns, queued)
  const spans: StyleSpan[] = spansFor(parseMarkup(row.text))
  const runs: Array<{ text: string; style?: string }> = []
  const shown = [...fit.text]
  for (let i = 0; i < shown.length; i++) {
    const style = styleAt(spans, i)
    const last = runs[runs.length - 1]
    if (last && last.style === style) last.text += shown[i]
    else runs.push({ text: shown[i], ...(style ? { style } : {}) })
  }
  return (
    <Box marginTop={0}>
      <Text color="cyan" dimColor={!row.fresh}>{'💬 '}</Text>
      <Text color="cyan" bold={row.fresh} dimColor={!row.fresh}>{fit.author}</Text>
      <Text wrap="truncate-end">
        <Text dimColor>{': '}</Text>
        {runs.map((r, idx) => {
          if (!r.style) return <Text key={idx} dimColor>{r.text}</Text>
          if (r.style === 'bold') return <Text key={idx} bold dimColor={!row.fresh}>{r.text}</Text>
          if (r.style === 'dim') return <Text key={idx} dimColor>{r.text}</Text>
          return <Text key={idx} color={r.style} dimColor={!row.fresh}>{r.text}</Text>
        })}
        <Text dimColor>{cursor}</Text>
      </Text>
      {queued > 0 ? <Text dimColor>{` +${queued} queued`}</Text> : null}
    </Box>
  )
}

/**
 * v6: the /marquee viewer's rows — SelectItem-shaped for the shared control
 * (select.tsx). Newest first: the question the command answers is "what just
 * happened on the ticker", not "how did it begin". Markup is stripped the
 * same way v5 strips it for the model — the label column is plain words —
 * and the detail column carries author + age, the two facts that make a
 * line attributable. Resolved entries only (readMarquee already applied
 * supersedes), capped by the caller's frame via windowFor, not here.
 */
export function marqueeHistoryItems(
  entries: MarqueeEntry[],
  now: number = Date.now(),
): Array<{ key: string; label: string; detail: string }> {
  const byNewest = [...entries].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))
  return byNewest.map((e) => ({
    key: e.id,
    label: parseMarkup(e.text).plain.replace(/\s+/g, ' ').trim(),
    detail: `${e.author} · ${ageLabel(now - e.ts)}`,
  }))
}

/** '12s' / '5m' / '3h' / '2d' — the shortest honest age. */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}
