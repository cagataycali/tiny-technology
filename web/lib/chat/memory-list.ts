/**
 * How many memories were asked for, how many came back, and what the header
 * is allowed to claim.
 *
 * Backlog v10 A1 (lens = "a NUMBER the UI shows about data it did not fully
 * receive"). The Memory Panel renders one line — `🧬 Memory · {total} {live|
 * total}` — from TWO different worker queries that nobody checks against each
 * other, and both readings are wrong:
 *
 *   1. **The list is silently capped and the header counts past the cap.**
 *      `MemoryPanel` fetches `/api/learnings?limit=500`, but the route clamped
 *      every `limit` to 100 (`Math.min(Math.max(Number(limit) || 30, 1), 100)`).
 *      `total` comes from `TOTALS_SQL` — a real `COUNT(*)` — so a user with 250
 *      memories saw "🧬 Memory · 250 live" above a list of 100, with nothing
 *      saying 150 were missing. The 150 also can't be closed or inspected: the
 *      only per-memory controls live on the rows that arrived.
 *
 *   2. **In history mode the label is a number smaller than what's on screen.**
 *      `TOTALS_SQL` is `WHERE owner = ?1 AND valid_to IS NULL` — LIVE facts,
 *      in every mode; the worker has no closed-inclusive total. But
 *      `include_closed=1` makes the LIST live+closed, and the header called
 *      that same live-only number "total". 40 live + 30 closed rendered as
 *      "🧬 Memory · 40 total" above 70 visible rows — the one defect a user can
 *      catch by counting. The in-code comment claiming `total` "reflects what
 *      was fetched: live+closed once show history is on" asserted a fact the
 *      other repo contradicts.
 *
 * And the clamp that caused (1) was justified by a cost that mostly isn't
 * there. The route's comment explains the 100 cap by Vectorize semantic
 * recall — but Vectorize only runs when `q` is present (`if (q) { … embed …
 * MEMORY.query }`), and the panel sends no `q`. A plain list is one indexed D1
 * read whose own cap is 500 (`LearningsListCall`: "0-500, default 100"). So
 * the route's cap protected nothing the worker hadn't already bounded, while
 * narrowing every honest caller: web asks 500, iOS `Panels.swift:1465` and
 * Android `MemoryUniverse.kt:72` both ask 200, and all three got 100.
 *
 * The floor was worse than the cap: `Math.max(…, 1)` turned `limit=0` into 30
 * rows. `0` is a DOCUMENTED mode ("0 = none") that our own `recall` tool uses
 * (`lib/chat/tools/memory.ts` fetches `&limit=0&q=…` to get only semantic
 * matches) — so the same call routed through `/api/learnings` came back with
 * 30 rows of unranked noise attached. Third sighting of c59's rule in a new
 * costume: **a clamp that reinterprets a MEANINGFUL value is a mode flip, not
 * a bound.**
 *
 * The rule, and it's a general one for a relay: **mirror the origin's own
 * clamp; tighten only where you pay a cost the origin doesn't.** A proxy that
 * invents a narrower bound is inventing a contract its callers can't read.
 *
 * Pure — no fetch, no React — so every rule here is a node test.
 */

/** The worker's own list cap (`LearningsListCall`: "0-500, default 100"). */
export const LEARNINGS_LIST_MAX = 500

/**
 * The cap for a `q` (semantic recall) call. Recall is the expensive path — it
 * embeds the query and runs Vectorize before joining D1 — and it's the reason
 * this route carries a 10s bound, so it keeps the tighter number a CLI/MCP
 * client can't talk it out of.
 */
export const LEARNINGS_RECALL_MAX = 100

/** What MemoryPanel asks for, tied to the cap so the two can't drift. */
export const MEMORY_PANEL_LIMIT = LEARNINGS_LIST_MAX

/**
 * The `limit` to forward to the worker, or `null` to forward nothing and let
 * the worker's documented default (100) apply.
 *
 * Mirrors the worker's clamp — floor 0, because `0` means "no list, recall
 * only" — and caps by what the call actually costs. Unparseable input forwards
 * nothing rather than inventing a number: this is a relay, so "no opinion" is
 * the honest translation of "I couldn't read that", and the worker's default
 * is a documented value while 30 was ours alone.
 */
export function learningsLimit(raw: string | null | undefined, hasQuery: boolean): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const max = hasQuery ? LEARNINGS_RECALL_MAX : LEARNINGS_LIST_MAX
  return String(Math.min(Math.max(Math.floor(n), 0), max))
}

export type MemoryHeaderInput = {
  /** The worker's `total` — a COUNT(*) of LIVE facts, in EVERY mode. */
  total: number
  /** Rows on screen with `freshness !== 'closed'`. */
  liveShown: number
  /** Rows on screen that are closed history (only ever > 0 in history mode). */
  closedShown: number
  showHistory: boolean
  /** The limit the fetch asked for — a full page means there may be more. */
  limit?: number
}

export type MemoryHeader = {
  /** The short header text after the 🧬 glyph. */
  label: string
  /** Longer explanation for `title`, when the label alone would mislead. */
  title?: string
  /** True when memories exist that are NOT on screen. */
  truncated: boolean
}

/**
 * What the panel header may say about the rows it actually received.
 *
 * Two rules, one per defect above: the label describes what is ON SCREEN, and
 * anything missing is named rather than folded into a bigger number.
 */
export function memoryHeader(input: MemoryHeaderInput): MemoryHeader {
  const total = Number.isFinite(input.total) ? Math.max(0, Math.floor(input.total)) : 0
  const liveShown = Math.max(0, Math.floor(input.liveShown) || 0)
  const closedShown = Math.max(0, Math.floor(input.closedShown) || 0)
  const shown = liveShown + closedShown
  const limit = Number.isFinite(input.limit) ? Number(input.limit) : undefined

  // Two independent proofs that rows are missing. The count comparison is
  // exact but only sees LIVE facts (that's all `total` covers); a full page is
  // the only evidence available for closed history, which nothing counts.
  const missingLive = liveShown < total
  const fullPage = limit !== undefined && shown >= limit
  const truncated = missingLive || fullPage

  if (!input.showHistory) {
    // Live-only mode: `total` and the list are the same population, so a
    // mismatch is provably omission and the label can state both numbers.
    return truncated
      ? {
          label: `${liveShown} of ${total} live`,
          title: `Showing the ${liveShown} most recent of ${total} live memories — ask your tiny to recall older ones by meaning.`,
          truncated: true,
        }
      : { label: `${total} live`, truncated: false }
  }

  // History mode: the list is live+closed but `total` counts only live, so the
  // two numbers describe different populations and must be labelled as such.
  // Saying "N total" made the header smaller than the visible row count.
  const parts = `${liveShown} live + ${closedShown} closed`
  return {
    label: `${shown} shown · ${total} live`,
    title: truncated
      ? `${shown} on screen (${parts}) — more exist than fit in one page. ${total} live memories in total; closed history isn't counted.`
      : `${shown} on screen (${parts}). ${total} live memories in total; closed history isn't counted.`,
    truncated,
  }
}
