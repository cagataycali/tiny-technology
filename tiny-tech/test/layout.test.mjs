/**
 * 📐 panelBudget / tailRows — the arithmetic that keeps the composer on screen.
 *
 * These two functions replaced a pair of constants (12 text lines, 6 tool chips)
 * that were right for exactly one terminal. The rule they encode is a promise to
 * the user: however many turns are running, the input line stays visible. That
 * promise is arithmetic, so it can be checked exhaustively here rather than
 * guessed at through a rendered frame.
 *
 * tui.test.mjs asserts the PROPERTY end-to-end (every chip drawn or counted);
 * this file pins the numbers. Neither duplicates the other.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'

const { panelBudget, tailRows } = await import('../dist/tui/layout.js')

/** What one panel costs beyond its content — border+header framed, blank+echo+status bare. */
const overhead = (panels) => 3

/** Rows a whole live area occupies at a given budget, chrome included. */
const consumed = (c, b) => {
  const panels = Math.max(1, c.panels)
  return panels * (b.text + b.chips + overhead(panels)) + 5
    + (c.question ? 7 : 0) + (c.call ? 6 : 0) + (c.status ? 1 : 0) + (c.loop ? 1 : 0)
}

test('a roomy terminal spends its rows on the answer, not on tool chips', () => {
  // One panel at 40 rows: chips hit their cap of 8 and the remaining 25 go to the
  // text, because the text is the answer and a chip is only a receipt.
  assert.deepEqual(panelBudget({ rows: 40, panels: 1 }), { chips: 8, text: 24 })
  assert.deepEqual(panelBudget({ rows: 60, panels: 1 }), { chips: 8, text: 44 })
})

test('every extra concurrent turn shrinks the others rather than scrolling them off', () => {
  const one = panelBudget({ rows: 40, panels: 1 })
  const two = panelBudget({ rows: 40, panels: 2, status: true })
  const three = panelBudget({ rows: 40, panels: 3, status: true })
  assert.ok(two.text < one.text && three.text < two.text,
    `text budget must fall as panels are added, got ${one.text}/${two.text}/${three.text}`)
  assert.deepEqual(two, { chips: 7, text: 7 })
  assert.deepEqual(three, { chips: 4, text: 4 })
})

test('chrome on screen is charged to the panels, not to the composer', () => {
  // The old constants had no idea a question box or a call strip existed, so the
  // composer went off the bottom exactly when the user had something to answer.
  const bare = panelBudget({ rows: 40, panels: 1 })
  const busy = panelBudget({ rows: 40, panels: 1, question: true, call: true, status: true, loop: true })
  assert.equal(bare.text - busy.text, 15, 'question 7 + call 6 + status 1 + loop 1')
  assert.ok(busy.text >= 2, 'and the panel still shows something')
})

test('the spawn strip is charged one row per batch plus its margin, only when active', () => {
  // Same lesson as the loop strip and the marquee: a strip that draws rows the
  // budget never subtracted pushes the composer off the bottom.
  const bare = panelBudget({ rows: 40, panels: 1 })
  assert.deepEqual(panelBudget({ rows: 40, panels: 1, spawns: 0 }), bare, 'no batches, no charge')
  const one = panelBudget({ rows: 40, panels: 1, spawns: 1 })
  const two = panelBudget({ rows: 40, panels: 1, spawns: 2 })
  assert.equal(bare.text - one.text, 2, 'one batch: its row + the strip margin')
  assert.equal(bare.text - two.text, 3, 'second batch adds exactly one row')
})

test('the live area fits the terminal for every size worth fitting', () => {
  // The promise, checked exhaustively: composer visible, nothing scrolls.
  for (let rows = 10; rows <= 80; rows++) {
    for (let panels = 1; panels <= 4; panels++) {
      for (const status of [false, true]) {
        const c = { rows, panels, status }
        const b = panelBudget(c)
        assert.ok(b.text >= 2 && b.chips >= 2, `${rows}×${panels}: a running turn must show something`)
        // Below the floor (2 text + 2 chips + overhead per panel) no honest layout
        // exists — the terminal is genuinely too small — so overflow is allowed
        // there and nowhere else.
        const floor = 5 + (status ? 1 : 0) + panels * (4 + overhead(panels))
        if (rows > floor) {
          assert.ok(consumed(c, b) <= rows,
            `${rows}×${panels} overflows: needs ${consumed(c, b)} rows`)
        }
      }
    }
  }
})

test('a terminal too small to be honest keeps the floor instead of hiding a turn', () => {
  // Showing nothing about a turn that IS running is worse than scrolling: the
  // user would have no way to know it exists, let alone /cancel it.
  for (const rows of [0, 1, 6, 8]) {
    const b = panelBudget({ rows, panels: 1 })
    assert.deepEqual(b, { chips: 2, text: 2 }, `rows=${rows}`)
  }
})

test('panels: 0 is treated as one — no division by zero, no Infinity', () => {
  const b = panelBudget({ rows: 40, panels: 0 })
  assert.ok(Number.isFinite(b.text) && Number.isFinite(b.chips))
  assert.deepEqual(b, panelBudget({ rows: 40, panels: 1 }))
})

// ── tailRows ────────────────────────────────────────────────────────────────

test('the tail is the last DISPLAYED rows, not the last newlines', () => {
  assert.equal(tailRows('a\nb\nc\nd', 2, 80), 'c\nd')
  assert.equal(tailRows('a\nb\nc\nd', 10, 80), 'a\nb\nc\nd', 'a short answer is shown whole')
  assert.equal(tailRows('one\ntwo', 1, 80), 'two')
})

test('a line that wraps costs every row it wraps onto', () => {
  // The bug this exists for: a 200-character stack-trace line counted as ONE line
  // of a 3-line budget and then drew three rows, pushing the composer off screen.
  const long = 'x'.repeat(200)
  assert.equal(tailRows(`${long}\nlast`, 3, 80), 'last',
    'the 3-row-tall line does not fit alongside `last`, so it is dropped')
  assert.equal(tailRows(`short\n${long}`, 3, 80), long, 'and it evicts what came before it')
  assert.equal(tailRows(`short\n${long}`, 4, 80), `short\n${long}`, 'one more row and both fit')
})

test('the newest line is never dropped, even when it alone overflows', () => {
  // Truncating it would be a lie about what the model just said; overflowing is
  // visible and recoverable, and Ink wraps it the same way the terminal would.
  const huge = 'y'.repeat(400)
  assert.equal(tailRows(huge, 3, 80), huge)
})

test('widths come from columns, so the same text tails differently per terminal', () => {
  const text = 'a'.repeat(100)
  assert.equal(tailRows(`keep\n${text}`, 2, 200), `keep\n${text}`, 'one row wide at 200 columns')
  assert.equal(tailRows(`keep\n${text}`, 2, 50), text, 'two rows wide at 50, so `keep` goes')
})

test('ANSI colour does not count as width', () => {
  // The text has already been through marked-terminal by the time it gets here,
  // so a 40-character coloured line carries ~10 invisible characters of escapes;
  // measuring those would tail away lines that fit perfectly.
  const coloured = `\x1b[31m${'z'.repeat(70)}\x1b[39m`
  assert.ok(stringWidth(coloured) === 70 && coloured.length > 70, 'the fixture is what it claims')
  assert.equal(tailRows(`keep\n${coloured}`, 2, 80), `keep\n${coloured}`)
})

test('empty input and a zero budget are answered with nothing, not a crash', () => {
  assert.equal(tailRows('', 5, 80), '')
  assert.equal(tailRows('something', 0, 80), '')
  assert.equal(tailRows('something', -3, 80), '')
  assert.equal(tailRows('something', 5, 0), 'something', 'a zero-column terminal still tails')
})
