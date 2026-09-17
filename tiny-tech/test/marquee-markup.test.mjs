/**
 * 🎨 Marquee markup — pure-function tests, no Ink render.
 *
 * The contract under test is the one that keeps the keystroke engine honest:
 * parseMarkup produces the PLAIN text humanPlan types (the planner never sees
 * a brace) plus spans that index into that plain text. So the assertions
 * cover the syntax (escape, unclosed, unknown-tag, stray-close), the span
 * invariants (in bounds, never overlapping), the auto-highlight pass and its
 * explicit-markup kill switch, and the integration: a plan built over
 * parseMarkup(x).plain still replays to exactly that plain text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseMarkup, styleAt, autoSpans, spansFor, MARKUP_STYLES } =
  await import('../dist/tui/marquee-markup.js')
const { humanPlan, replayPlan } = await import('../dist/tui/human-type.js')

/** Every span must sit inside plain and never overlap a sibling. */
function assertSpanInvariants({ plain, spans }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let prevEnd = -1
  for (const s of sorted) {
    assert.ok(s.start >= 0 && s.end <= plain.length, `span in bounds: ${JSON.stringify(s)} vs len ${plain.length}`)
    assert.ok(s.end > s.start, `span non-empty: ${JSON.stringify(s)}`)
    assert.ok(s.start >= prevEnd, `spans do not overlap: ${JSON.stringify(sorted)}`)
    prevEnd = s.end
  }
}

test('parse roundtrip: plain stripped, span covers the styled word', () => {
  const p = parseMarkup('build {green}passed{/} on main')
  assert.equal(p.plain, 'build passed on main')
  assert.deepEqual(p.spans, [{ start: 6, end: 12, style: 'green' }])
  assert.equal(p.plain.slice(6, 12), 'passed')
  assertSpanInvariants(p)
})

test('text without markup comes back untouched, zero spans', () => {
  const raw = 'nothing fancy here'
  const p = parseMarkup(raw)
  assert.equal(p.plain, raw)
  assert.deepEqual(p.spans, [])
})

test('escaped braces become literal braces, not tags', () => {
  const p = parseMarkup('a {{cyan}} literal and {red}hot{/}')
  assert.equal(p.plain, 'a {cyan} literal and hot')
  assert.deepEqual(p.spans, [{ start: 21, end: 24, style: 'red' }])
  assertSpanInvariants(p)
})

test('unclosed tag runs to the end of the text', () => {
  const p = parseMarkup('ok then {yellow}everything from here')
  assert.equal(p.plain, 'ok then everything from here')
  assert.deepEqual(p.spans, [{ start: 8, end: p.plain.length, style: 'yellow' }])
})

test('unknown tag stays literal text', () => {
  const p = parseMarkup('a {chartreuse} day')
  assert.equal(p.plain, 'a {chartreuse} day')
  assert.deepEqual(p.spans, [])
})

test('opening a new tag closes the previous one — one style at a time', () => {
  const p = parseMarkup('{cyan}one{green}two{/}')
  assert.equal(p.plain, 'onetwo')
  assert.deepEqual(p.spans, [
    { start: 0, end: 3, style: 'cyan' },
    { start: 3, end: 6, style: 'green' },
  ])
  assertSpanInvariants(p)
})

test('stray close and lone braces are forgiven', () => {
  assert.equal(parseMarkup('{/} nothing open').plain, ' nothing open')
  assert.equal(parseMarkup('lone { brace').plain, 'lone { brace')
  assert.equal(parseMarkup('lone } brace').plain, 'lone } brace')
  assert.equal(parseMarkup('trailing {').plain, 'trailing {')
})

test('empty text and empty tags produce empty results, no throw', () => {
  assert.deepEqual(parseMarkup(''), { plain: '', spans: [] })
  const p = parseMarkup('{cyan}{/}x') // zero-width span is dropped
  assert.equal(p.plain, 'x')
  assert.deepEqual(p.spans, [])
})

test('styleAt answers per index, undefined outside spans', () => {
  const spans = [{ start: 2, end: 5, style: 'red' }, { start: 7, end: 9, style: 'bold' }]
  assert.equal(styleAt(spans, 1), undefined)
  assert.equal(styleAt(spans, 2), 'red')
  assert.equal(styleAt(spans, 4), 'red')
  assert.equal(styleAt(spans, 5), undefined)
  assert.equal(styleAt(spans, 8), 'bold')
  assert.equal(styleAt(spans, 99), undefined)
})

test('auto-highlight: loop ids and shas cyan, pass green, fail red, numbers yellow', () => {
  const plain = 'loop l20260814072556002 landed e6fbed7: 19 tests pass, 0 fail — 100%'
  const spans = autoSpans(plain)
  assertSpanInvariants({ plain, spans })
  const styleOf = (word) => styleAt(spans, plain.indexOf(word))
  assert.equal(styleOf('l20260814072556002'), 'cyan')
  assert.equal(styleOf('e6fbed7'), 'cyan')
  assert.equal(styleOf('pass'), 'green')
  assert.equal(styleOf('fail'), 'red')
  assert.equal(styleOf('19'), 'yellow')
  assert.equal(styleOf('100%'), 'yellow')
  // the % sign is inside the number span
  assert.equal(styleAt(spans, plain.indexOf('100%') + 3), 'yellow')
})

test('auto-highlight: checkmarks and crosses, bare numbers not mistaken for shas', () => {
  const plain = '✓ built ❌ deploy 1234567 files'
  const spans = autoSpans(plain)
  assert.equal(styleAt(spans, plain.indexOf('✓')), 'green')
  assert.equal(styleAt(spans, plain.indexOf('❌')), 'red')
  // 1234567 is 7 hex-ish chars but all digits — a count, not a commit
  assert.equal(styleAt(spans, plain.indexOf('1234567')), 'yellow')
})

test('explicit markup disables the auto pass entirely', () => {
  const withMarkup = parseMarkup('{magenta}shipped{/} e6fbed7 with 19 tests')
  const auto = parseMarkup('shipped e6fbed7 with 19 tests')
  assert.deepEqual(spansFor(withMarkup), [{ start: 0, end: 7, style: 'magenta' }])
  const autoResolved = spansFor(auto)
  assert.ok(autoResolved.length >= 2, 'plain entry gets auto spans')
  assert.ok(autoResolved.some((s) => s.style === 'cyan'))
})

test('integration: humanPlan types the PLAIN text, markup-blind', () => {
  const raw = 'suite {green}1270 pass{/} on {cyan}e6fbed7{/} — {{braces}} survive'
  const { plain } = parseMarkup(raw)
  for (const emotion of ['calm', 'rushed', 'nervous']) {
    const plan = humanPlan(plain, { emotion, seed: 42 })
    assert.equal(replayPlan(plan), plain, `replay(${emotion}) === plain`)
  }
  assert.ok(!plain.includes('{green}') && plain.includes('{braces}'))
})

test('every documented style parses; MARKUP_STYLES is the render contract', () => {
  for (const style of ['cyan', 'green', 'yellow', 'magenta', 'red', 'blue', 'gray', 'bold', 'dim']) {
    assert.ok(MARKUP_STYLES.has(style), style)
    const p = parseMarkup(`{${style}}x{/}`)
    assert.deepEqual(p.spans, [{ start: 0, end: 1, style }])
  }
})

test('fuzz: 30 random markup strings — parse never throws, invariants hold', () => {
  // Deterministic LCG so a failure reproduces.
  let s = 0xdecafbad
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  const pieces = ['{cyan}', '{/}', '{{', '}}', '{bogus}', '{green}', 'word ', 'l20260814072556002 ',
    'e6fbed7 ', '✓ ', '❌ ', '42% ', '{', '}', 'pass ', 'fail ', '{bold}', '{dim}', 'né ']
  for (let n = 0; n < 30; n++) {
    let raw = ''
    const len = 1 + Math.floor(rnd() * 12)
    for (let k = 0; k < len; k++) raw += pieces[Math.floor(rnd() * pieces.length)]
    const p = parseMarkup(raw)
    assertSpanInvariants(p)
    assertSpanInvariants({ plain: p.plain, spans: spansFor(p) })
    // The typer contract survives every mutation of the syntax:
    assert.equal(replayPlan(humanPlan(p.plain, { seed: n })), p.plain)
  }
})
