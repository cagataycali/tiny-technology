/**
 * When does a "5m ago" label stop being true?
 *
 * relative-time.ts formats an age; this file answers the question that keeps it
 * honest on a page nothing else re-renders. It is the third instance of the v11
 * lens (a value the UI computed from the clock and then never recomputed), and
 * deliberately the LAST bespoke one — quote-expiry and faucet-countdown each
 * owned a single deadline, so each could hold "the answer" in state. A ledger
 * holds N rows whose labels change at N different moments, so the answer here is
 * the CLOCK, and the only interesting number is when to read it again.
 *
 * The naive version of that is a fixed interval. It is also wrong in both
 * directions at once: a 30s tick re-renders a ledger of week-old rows 2,880
 * times a day to change nothing, while still being able to show "just now" for
 * 30s past the minute. The next moment ANY row's label changes is computable
 * exactly, from the rows themselves — so that is what gets computed.
 *
 * Everything here is pure and takes `nowMs`, so the whole schedule is testable
 * without a timer. The React half is use-relative-tick.ts.
 */

/**
 * Ceiling on a computed delay.
 *
 * A ledger of old rows genuinely has no boundary to cross for the next hour, so
 * this clamp is REACHABLE and does real work — it is not the unreachable kind
 * (a bound sitting above a tighter bound). What it buys is recovery: a `setTimeout`
 * armed for an hour survives a suspend or a wall-clock change by firing late and
 * recomputing, but until it fires the page shows ages measured against an old
 * clock. Waking up once a minute bounds that staleness to a minute, at the cost
 * of one render per minute on a tab nobody is looking at.
 */
export const RELATIVE_TICK_MAX_MS = 60_000

/** A timestamp relativeAgo() will actually format (seconds since 1970). */
function usable(sec: unknown): number | null {
  const n = Number(sec)
  // Same guard as relativeAgo, and for the same reason: Number(null) and
  // Number("") are 0 — finite, and ~20,000 days "ago". A row that renders the
  // fallback has no label to keep true, so it must not arm a timer either.
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * How long until `relativeAgo(sec)` would return a DIFFERENT string.
 *
 * Mirrors relativeAgo's own buckets, and has to keep mirroring them: the
 * boundaries are its thresholds (60s → "just now" ends, 3600s → minutes become
 * hours, 86400s → hours become days). Anything else schedules a wake-up that
 * changes nothing, or misses one that would have.
 */
export function nextRelativeChangeMs(sec: unknown, nowMs: number): number | null {
  const n = usable(sec)
  if (n === null) return null
  // relativeAgo floors the clock to whole seconds before subtracting, so the
  // boundary lands on a second, not on nowMs's millisecond.
  const d = Math.max(0, Math.floor(nowMs / 1000) - n)
  // The width of the bucket `d` currently sits in. "just now" is a 60-wide
  // bucket too — it just has no visible number inside it.
  const step = d < 3600 ? 60 : d < 86400 ? 3600 : 86400
  const nextD = (Math.floor(d / step) + 1) * step
  const ms = (n + nextD) * 1000 - nowMs
  // A future timestamp (clock skew between worker and browser) reads as "just
  // now" and its first boundary can be arbitrarily far out; the caller's clamp
  // handles that.
  //
  // ⚠️ The floor below is REACHABLE, and only on a FRACTIONAL timestamp — which
  //    is why it needs saying. `d` is computed against a floored clock but keeps
  //    n's fraction, so bucketing `d` can land `n + nextD` a few hundred
  //    milliseconds BEFORE nowMs (e.g. n=863078576.016 at nowMs=863080736806
  //    gives -790ms). A negative delay fires immediately and immediately again;
  //    a 0 is the same busy loop. Worker rows are integer seconds today and
  //    validated nowhere — the same reason relative-time.ts guards its own input.
  return Math.max(1, ms)
}

/**
 * When to re-read the clock for a whole list — the EARLIEST boundary any row
 * will cross, clamped.
 *
 * null means there is nothing to wait for: an empty ledger, or every row's
 * timestamp unusable. Arming a timer for either is how an idle tab ticks
 * forever over rows that render a constant.
 */
export function nextRelativeTickMs(
  stamps: ReadonlyArray<number>,
  nowMs: number,
  maxMs: number = RELATIVE_TICK_MAX_MS,
): number | null {
  let soonest: number | null = null
  for (const s of stamps) {
    const ms = nextRelativeChangeMs(s, nowMs)
    if (ms === null) continue
    if (soonest === null || ms < soonest) soonest = ms
  }
  if (soonest === null) return null
  return Math.min(soonest, Math.max(1, maxMs))
}

/**
 * The canonical, render-stable identity of a list of timestamps.
 *
 * Two jobs. It is the effect dependency — a new array with the same contents
 * must NOT re-arm the chain, and `history.map(e => e.created)` builds a new
 * array on every render — and it is the payload: the effect parses the stamps
 * back out of it, so the closure can never disagree with the dep that triggered
 * it (no ref, no exhaustive-deps escape hatch).
 *
 * Sorted so a re-ordered ledger is the same key, deduped because a hundred rows
 * in the same minute cross one boundary together.
 */
export function relativeTickKey(timestamps: ReadonlyArray<unknown>): string {
  const seen = new Set<number>()
  for (const t of timestamps) {
    const n = usable(t)
    if (n !== null) seen.add(n)
  }
  // Array.from, not a spread: this repo's tsconfig target predates
  // downlevelIteration, so spreading a Set is a compile error here.
  return Array.from(seen).sort((a, b) => a - b).join(',')
}

/** The inverse of relativeTickKey. "" → [] (nothing to schedule). */
export function parseRelativeTickKey(key: string): number[] {
  if (!key) return []
  return key.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
}
