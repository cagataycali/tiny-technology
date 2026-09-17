/**
 * 🖼️ loopStripRows — pure formatter for the picture-in-picture loop strip.
 *
 * `loopStripRows(records, now, width)` is the isolated, testable half of the
 * strip: what to draw, given the records on disk. Testing it means never
 * standing up an Ink render — same shape as the layout.ts tests and the
 * voice-call.tsx split for the same reason.
 *
 * Covers the three deltas from the D lane:
 *   1. Prefer LoopIteration.note over .summary (the loop_done tool call's
 *      self-reported progress beats a blind tail-slice of the model's prose).
 *   2. Recently-ended loops linger for ENDED_LINGER_MS then fall out — a
 *      completion is a state transition the eye can see, not a snap-cut.
 *   3. Terminal states are surfaced via `endedAs` so the component can style
 *      them (green ✓ for done, red ✗ for anything that didn't finish).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { loopStripRows, ROWS_PER_LOOP, ENDED_LINGER_MS } = await import('../dist/tui/loop-strip.js')
const { LOOP_COOLDOWN_MS, LOOP_MAX_ITERATIONS } = await import('../dist/agent/loop.js')

/** Build a minimal LoopRecord shape the formatter accepts. */
function rec(overrides = {}) {
  return {
    id: 'l0',
    prompt: 'do a thing',
    status: 'running',
    startedAt: 1000,
    iterations: [],
    ...overrides,
  }
}
const iter = (n, at, summary, note) => ({ n, at, summary, ...(note ? { note } : {}) })

test('ROWS_PER_LOOP is 3 — matches the layout.ts arithmetic', () => {
  // If this constant changes, panelBudget's `c.loops * 3 + 1` breaks. The
  // constant is exported so a test can hold the two sides to the same
  // number without either duplicating the value.
  assert.equal(ROWS_PER_LOOP, 3)
})

test('running loops render with `working…` when the last iteration is stale', () => {
  const now = 100_000
  const r = rec({
    iterations: [iter(1, now - LOOP_COOLDOWN_MS - 5000, 'first step')],
  })
  const rows = loopStripRows([r], now, 80)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].phase, 'working…', 'cooldown expired → not cooling any more')
  assert.equal(rows[0].endedAs, undefined, 'a running loop has no endedAs')
})

test('running loops render `next step in Ns` during the cooldown window', () => {
  const now = 100_000
  const r = rec({
    iterations: [iter(1, now - 5000, 'first step')],   // 5s into 30s cooldown
  })
  const rows = loopStripRows([r], now, 80)
  assert.match(rows[0].phase, /next step in \d+s/, 'phase names why nothing is happening')
})

test('step prefers LoopIteration.note over .summary — the agent\'s own words win', () => {
  // loop_done status='progress' writes into `note`. Every other surface (news
  // block, /loops journal) already prefers note; this test locks that same
  // choice for the strip. Without it the strip stayed on a tail-slice of the
  // model's prose while the agent's clear one-line progress note was ignored.
  const r = rec({
    iterations: [iter(1, 1000, 'the model went on at great length about what it did', 'wrote the tests')],
  })
  const rows = loopStripRows([r], 2000, 80)
  assert.match(rows[0].step, /wrote the tests/, 'note wins')
  assert.doesNotMatch(rows[0].step, /great length/, 'summary is not the fallback when note exists')
})

test('step falls back to summary when the note is absent', () => {
  const r = rec({
    iterations: [iter(1, 1000, 'a summary sentence')],
  })
  const rows = loopStripRows([r], 2000, 80)
  assert.match(rows[0].step, /a summary sentence/)
})

test('a done loop lingers for ENDED_LINGER_MS with endedAs="done"', () => {
  const now = 100_000
  const r = rec({ status: 'done', endedAt: now - 2000 })   // ended 2s ago
  const rows = loopStripRows([r], now, 80)
  assert.equal(rows.length, 1, 'still visible during the linger window')
  assert.equal(rows[0].endedAs, 'done')
  assert.equal(rows[0].phase, 'done', 'the phase names the terminal state')
})

test('an errored/stopped/interrupted/exhausted loop lingers with a matching endedAs', () => {
  // Symmetry: everything terminal that is not `done` should surface the same
  // way so the component can style it as failure without a per-state ladder.
  const now = 100_000
  const states = ['error', 'stopped', 'interrupted', 'exhausted']
  const records = states.map((s, i) => rec({ id: `l${i}`, status: s, endedAt: now - 1000 }))
  const rows = loopStripRows(records, now, 80)
  assert.equal(rows.length, 4, 'all four ended states are visible during the linger')
  assert.deepEqual(rows.map((r) => r.endedAs), states, 'endedAs mirrors the record status')
  assert.deepEqual(rows.map((r) => r.phase), states, 'so does the phase — the strip says WHY it ended')
})

test('a loop that ended more than ENDED_LINGER_MS ago is dropped', () => {
  const now = 100_000
  const r = rec({ status: 'done', endedAt: now - ENDED_LINGER_MS - 100 })
  const rows = loopStripRows([r], now, 80)
  assert.equal(rows.length, 0, 'no tombstone left in the strip')
})

test('a loop with no endedAt (older record shape) does not linger — treated as long-gone', () => {
  // Backwards-compat guard: LoopRecord.endedAt is optional. Without a timestamp
  // we have no way to compute the linger window, so the honest thing is to
  // drop the row rather than pin it up permanently.
  const r = rec({ status: 'done', endedAt: undefined })
  const rows = loopStripRows([r], 100_000, 80)
  assert.equal(rows.length, 0)
})

test('a mixed set orders correctly and preserves both running and lingering rows', () => {
  const now = 100_000
  const running = rec({ id: 'run', iterations: [iter(1, now - 1000, 'still going')] })
  const lingerDone = rec({ id: 'done', status: 'done', endedAt: now - 500 })
  const lingerErr = rec({ id: 'err', status: 'error', endedAt: now - 200 })
  const stale = rec({ id: 'stale', status: 'done', endedAt: now - 60_000 })
  const rows = loopStripRows([running, lingerDone, lingerErr, stale], now, 80)
  assert.deepEqual(rows.map((r) => r.id), ['run', 'done', 'err'], 'stale dropped, order preserved')
})

test('phase for a done loop is the status word, not a cooldown from its last iteration', () => {
  // Regression: an early draft computed cooldown from `last.at` for all rows,
  // so a loop that finished at iter 3 briefly said "next step in 24s" — as if
  // it were about to keep going. Terminal state must win over cooldown math.
  const now = 100_000
  const r = rec({
    status: 'done',
    endedAt: now - 500,
    iterations: [iter(1, now - 500, 's1'), iter(2, now - 300, 's2')],
  })
  const rows = loopStripRows([r], now, 80)
  assert.equal(rows[0].phase, 'done', 'no phantom cooldown on a finished loop')
})

test('step line is truncated to fit the terminal width', () => {
  // The strip's height is exactly ROWS_PER_LOOP per row and Ink would wrap
  // an over-long line into two, blowing the layout budget. The formatter
  // truncates so the layout stays honest.
  const long = 'x'.repeat(500)
  const r = rec({ iterations: [iter(1, 1000, long)] })
  const rows = loopStripRows([r], 2000, 40)
  // room = max(20, 40 - 6) = 34, so step ends with ellipsis and is bounded.
  assert.ok(rows[0].step.length <= 40, `step fit width (${rows[0].step.length})`)
  assert.match(rows[0].step, /…/, 'truncation ellipsis present on an oversized step')
})

test('meta line names iter n / max and the elapsed time', () => {
  const r = rec({
    startedAt: 1000,
    iterations: [iter(1, 5000, 's1'), iter(2, 6000, 's2'), iter(3, 7000, 's3')],
  })
  const rows = loopStripRows([r], 8000, 80)
  assert.match(rows[0].meta, /iter 3\/\d+/, `iter count matches (${rows[0].meta})`)
  assert.ok(rows[0].meta.includes(`/${LOOP_MAX_ITERATIONS}`), 'cap is the exported one')
  assert.match(rows[0].meta, /7s/, 'elapsed since startedAt')
})

test('goal and step are flattened to one line each — no newlines in the strip', () => {
  // The strip's height contract is ROWS_PER_LOOP; a newline in the source
  // would split into two rows on render.
  const r = rec({
    prompt: 'line one\nline two\nline three',
    iterations: [iter(1, 1000, 'multi\nline\nsummary')],
  })
  const rows = loopStripRows([r], 2000, 80)
  assert.doesNotMatch(rows[0].goal, /\n/, 'goal is a single line')
  assert.doesNotMatch(rows[0].step, /\n/, 'step is a single line')
})
