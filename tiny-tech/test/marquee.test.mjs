/**
 * 💬 The marquee blackboard — pure-function tests, no Ink render.
 *
 * TINY_MARQUEE_FILE is pinned to a temp path BEFORE the dist modules load,
 * the same trick test/tui.test.mjs plays with TINY_LOOPS_DIR: a real
 * blackboard on this machine (someone may actually be using the feature)
 * must never leak entries into these assertions, and these tests must never
 * write into the real file.
 *
 * The rules under test are the whole contract:
 *   - append+read roundtrip through the JSONL file
 *   - supersedes replaces an earlier entry of the SAME author
 *   - a cross-author supersede is refused: original kept, superseder dropped
 *   - marqueeRowFor picks the newest entry; LINGER mutes but does not hide
 *   - torn/malformed lines are skipped, not fatal
 *   - the marquee costs exactly ONE row in panelBudget's arithmetic
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'tiny-marquee-'))
process.env.TINY_MARQUEE_FILE = join(DIR, 'marquee.jsonl')

const { appendMarquee, readMarquee, marqueeFile, marqueeAuthor } = await import('../dist/agent/marquee.js')
const { marqueeRowFor, MARQUEE_LINGER_MS } = await import('../dist/tui/marquee.js')
const { panelBudget } = await import('../dist/tui/layout.js')

/** A fresh file per test — entries from one test must not bleed into the next. */
let n = 0
const freshFile = () => join(DIR, `mq-${++n}.jsonl`)

test('marqueeFile honours TINY_MARQUEE_FILE', () => {
  assert.equal(marqueeFile(), join(DIR, 'marquee.jsonl'))
})

test('append + read roundtrip', () => {
  const f = freshFile()
  const e = appendMarquee({ text: 'hello room', author: 'alice' }, f)
  assert.ok(e.id.startsWith('mq'))
  assert.equal(e.author, 'alice')
  const back = readMarquee(f)
  assert.equal(back.length, 1)
  assert.equal(back[0].id, e.id)
  assert.equal(back[0].text, 'hello room')
})

test('append flattens whitespace to one line — the file is line-framed', () => {
  const f = freshFile()
  appendMarquee({ text: 'two\nlines\tand   gaps', author: 'alice' }, f)
  const back = readMarquee(f)
  assert.equal(back[0].text, 'two lines and gaps')
})

test('append refuses empty text', () => {
  assert.throws(() => appendMarquee({ text: '   ' }, freshFile()))
})

test('supersede by the SAME author replaces the original', () => {
  const f = freshFile()
  const first = appendMarquee({ text: 'v1', author: 'alice' }, f)
  const second = appendMarquee({ text: 'v2', supersedes: first.id, author: 'alice' }, f)
  const back = readMarquee(f)
  assert.equal(back.length, 1)
  assert.equal(back[0].id, second.id)
  assert.equal(back[0].text, 'v2')
})

test('cross-author supersede is refused: original kept, superseder dropped', () => {
  const f = freshFile()
  const alice = appendMarquee({ text: 'my words', author: 'alice' }, f)
  appendMarquee({ text: 'rewritten', supersedes: alice.id, author: 'bob' }, f)
  const back = readMarquee(f)
  assert.equal(back.length, 1)
  assert.equal(back[0].id, alice.id)
  assert.equal(back[0].text, 'my words')
})

test('supersede of an unknown id is dropped too', () => {
  const f = freshFile()
  appendMarquee({ text: 'real', author: 'alice' }, f)
  appendMarquee({ text: 'ghost ref', supersedes: 'mq-no-such', author: 'alice' }, f)
  const back = readMarquee(f)
  assert.equal(back.length, 1)
  assert.equal(back[0].text, 'real')
})

test('malformed lines are skipped, valid neighbours survive', () => {
  const f = freshFile()
  const good = appendMarquee({ text: 'good', author: 'alice' }, f)
  appendFileSync(f, '{torn json\n', 'utf8')
  appendFileSync(f, JSON.stringify({ id: 'x' }) + '\n', 'utf8') // missing fields
  appendFileSync(f, '\n', 'utf8')
  const good2 = appendMarquee({ text: 'also good', author: 'bob' }, f)
  const back = readMarquee(f)
  assert.deepEqual(back.map((e) => e.id).sort(), [good.id, good2.id].sort())
})

test('missing file reads as empty, not an error', () => {
  assert.deepEqual(readMarquee(join(DIR, 'never-written.jsonl')), [])
})

test('marqueeRowFor picks the newest entry by ts', () => {
  const now = 1_000_000
  const row = marqueeRowFor([
    { id: 'a', ts: now - 5000, author: 'alice', text: 'older' },
    { id: 'b', ts: now - 1000, author: 'bob', text: 'newest' },
    { id: 'c', ts: now - 9000, author: 'carol', text: 'oldest' },
  ], now)
  assert.equal(row.id, 'b')
  assert.equal(row.author, 'bob')
  assert.equal(row.text, 'newest')
})

test('marqueeRowFor: empty blackboard → null (row costs no height)', () => {
  assert.equal(marqueeRowFor([], 123), null)
})

test('linger cutoff: fresh within MARQUEE_LINGER_MS, muted past it', () => {
  const now = 1_000_000_000
  const fresh = marqueeRowFor([{ id: 'a', ts: now - (MARQUEE_LINGER_MS - 1), author: 'x', text: 't' }], now)
  assert.equal(fresh.fresh, true)
  const stale = marqueeRowFor([{ id: 'a', ts: now - (MARQUEE_LINGER_MS + 1), author: 'x', text: 't' }], now)
  assert.equal(stale.fresh, false) // muted, not hidden — old news still reads
})

test('layout: the marquee costs exactly one row', () => {
  const base = { rows: 40, panels: 1 }
  const without = panelBudget(base)
  const withRow = panelBudget({ ...base, marquee: true })
  assert.equal(without.text - withRow.text, 1)
  // and absent (or false) it costs nothing
  assert.deepEqual(panelBudget({ ...base, marquee: false }), without)
})

test('marqueeAuthor: env override wins, hostname fallback otherwise', () => {
  const prev = process.env.TINY_MARQUEE_AUTHOR
  process.env.TINY_MARQUEE_AUTHOR = 'peer-abc123'
  try {
    assert.equal(marqueeAuthor(), 'peer-abc123')
  } finally {
    if (prev === undefined) delete process.env.TINY_MARQUEE_AUTHOR
    else process.env.TINY_MARQUEE_AUTHOR = prev
  }
  assert.ok(marqueeAuthor().length > 0) // hostname fallback is never empty
})

test('multi-writer file: interleaved authors all resolve', () => {
  const f = freshFile()
  const a1 = appendMarquee({ text: 'a says 1', author: 'alice' }, f)
  appendMarquee({ text: 'b says 1', author: 'bob' }, f)
  appendMarquee({ text: 'a says 2', supersedes: a1.id, author: 'alice' }, f)
  const back = readMarquee(f)
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((e) => e.text).sort(), ['a says 2', 'b says 1'])
})

test('v2: appendMarquee mints a uint32 seed and stores the emotion', () => {
  const f = freshFile()
  const e = appendMarquee({ text: 'seeded', author: 'alice', emotion: 'nervous' }, f)
  assert.ok(Number.isInteger(e.seed) && e.seed >= 0 && e.seed <= 0xffffffff)
  assert.equal(e.emotion, 'nervous')
  const back = readMarquee(f)
  assert.equal(back[0].seed, e.seed) // the seed travels — every terminal replays the same tape
  assert.equal(back[0].emotion, 'nervous')
})

test('v2: an explicit seed is honoured, emotion optional', () => {
  const f = freshFile()
  const e = appendMarquee({ text: 'pinned', author: 'alice', seed: 12345 }, f)
  assert.equal(e.seed, 12345)
  assert.equal(e.emotion, undefined)
})

test('v2: marqueeRowFor passes seed + emotion through to the row', () => {
  const now = 1_000_000
  const row = marqueeRowFor([
    { id: 'a', ts: now - 100, author: 'alice', text: 'performed', seed: 777, emotion: 'excited' },
  ], now)
  assert.equal(row.seed, 777)
  assert.equal(row.emotion, 'excited')
})

test('v2 backwards compat: a v1 entry (no seed/emotion) rows without them', () => {
  const now = 1_000_000
  const row = marqueeRowFor([{ id: 'old', ts: now - 100, author: 'bob', text: 'v1 words' }], now)
  assert.equal(row.seed, undefined) // the component falls back to hashSeed(id)
  assert.equal(row.emotion, undefined)
})

test.after(() => { rmSync(DIR, { recursive: true, force: true }) })

// ── v4: the queue ──────────────────────────────────────────────────────────
// Multiple fresh entries play oldest→newest; none dropped; '+N queued' comes
// from the same pure pick. Once everything has played, newest-wins returns —
// the linger/mute grammar is untouched.

const { marqueeQueue } = await import('../dist/tui/marquee.js')

test('v4: marqueeQueue picks the OLDEST unplayed fresh entry, counts the rest', () => {
  const now = 1_000_000
  const entries = [
    { id: 'c', ts: now - 100, author: 'x', text: 'third' },
    { id: 'a', ts: now - 300, author: 'x', text: 'first' },
    { id: 'b', ts: now - 200, author: 'x', text: 'second' },
  ]
  const { row, queued } = marqueeQueue(entries, new Set(), now)
  assert.equal(row.id, 'a')          // oldest first — not newest-wins
  assert.equal(queued, 2)            // two more performances waiting
  assert.equal(row.fresh, true)
})

test('v4: played entries are skipped — the queue advances in order', () => {
  const now = 1_000_000
  const entries = [
    { id: 'a', ts: now - 300, author: 'x', text: 'first' },
    { id: 'b', ts: now - 200, author: 'x', text: 'second' },
  ]
  const one = marqueeQueue(entries, new Set(['a']), now)
  assert.equal(one.row.id, 'b')
  assert.equal(one.queued, 0)
})

test('v4: everything played → newest-wins fallback, zero queued (linger preserved)', () => {
  const now = 1_000_000
  const entries = [
    { id: 'a', ts: now - 300, author: 'x', text: 'first' },
    { id: 'b', ts: now - 200, author: 'x', text: 'second' },
  ]
  const done = marqueeQueue(entries, new Set(['a', 'b']), now)
  assert.equal(done.row.id, 'b')     // same pick marqueeRowFor makes
  assert.equal(done.queued, 0)
  assert.equal(done.row.fresh, true)
})

test('v4: stale entries never queue — they only appear via the fallback, muted', () => {
  const now = 1_000_000
  const entries = [
    { id: 'old', ts: now - MARQUEE_LINGER_MS - 5, author: 'x', text: 'ancient' },
  ]
  const { row, queued } = marqueeQueue(entries, new Set(), now)
  assert.equal(row.id, 'old')        // still shown (mute, don't hide)
  assert.equal(row.fresh, false)
  assert.equal(queued, 0)            // but it never counts as queued work
})

test('v4: empty blackboard → null row, zero queued', () => {
  assert.deepEqual(marqueeQueue([], new Set(), 123), { row: null, queued: 0 })
})

test('v4: ts tie breaks by id — deterministic order across terminals', () => {
  const now = 1_000_000
  const entries = [
    { id: 'zz', ts: now - 100, author: 'x', text: 'two' },
    { id: 'aa', ts: now - 100, author: 'x', text: 'one' },
  ]
  const { row } = marqueeQueue(entries, new Set(), now)
  assert.equal(row.id, 'aa')
})

test('v4: seed + emotion ride through the queue pick', () => {
  const now = 1_000_000
  const { row } = marqueeQueue(
    [{ id: 'a', ts: now - 100, author: 'x', text: 'hi', seed: 42, emotion: 'excited' }],
    new Set(), now,
  )
  assert.equal(row.seed, 42)
  assert.equal(row.emotion, 'excited')
})

// ── v5: context injection ──────────────────────────────────────────────────
// Unseen blackboard lines become turn news: cap 5, ~120 chars each, plain
// text only, per-process cursor so nothing ever repeats.

const { marqueeNewsBlock, makeMarqueeNews, MARQUEE_NEWS_CAP, MARQUEE_NEWS_CHARS } =
  await import('../dist/agent/marquee.js')

test('v5: unseen entries inject oldest→newest, seen advances, never repeats', () => {
  const now = 2_000_000
  const entries = [
    { id: 'b', ts: now - 100, author: 'ann', text: 'second' },
    { id: 'a', ts: now - 200, author: 'bob', text: 'first' },
  ]
  const r1 = marqueeNewsBlock(entries, { ts: 0, ids: [] })
  assert.ok(r1.block.includes('[Marquee'))
  assert.ok(r1.block.indexOf('bob: first') < r1.block.indexOf('ann: second'))
  const r2 = marqueeNewsBlock(entries, r1.seen)
  assert.equal(r2.block, '')            // spent — nothing repeats
})

test('v5: cap keeps the NEWEST entries and counts the earlier ones', () => {
  const now = 2_000_000
  const entries = Array.from({ length: MARQUEE_NEWS_CAP + 2 }, (_, i) => (
    { id: `e${i}`, ts: now - 1000 + i, author: 'x', text: `line ${i}` }
  ))
  const { block, seen } = marqueeNewsBlock(entries, { ts: 0, ids: [] })
  assert.ok(block.includes('(+2 earlier)'))
  assert.ok(!block.includes('line 0'))  // the two oldest fell off
  assert.ok(!block.includes('line 1'))
  assert.ok(block.includes(`line ${MARQUEE_NEWS_CAP + 1}`))
  // the cursor advanced over the hidden ones too — spent, not deferred
  assert.equal(marqueeNewsBlock(entries, seen).block, '')
})

test('v5: lines are clipped to ~chars with an ellipsis', () => {
  const long = 'x'.repeat(MARQUEE_NEWS_CHARS + 50)
  const { block } = marqueeNewsBlock(
    [{ id: 'a', ts: 10, author: 'x', text: long }], { ts: 0, ids: [] })
  const line = block.split('\n')[1]
  assert.ok(line.length <= MARQUEE_NEWS_CHARS + '- x: '.length)
  assert.ok(line.endsWith('…'))
})

test('v5: markup is stripped — the model reads plain words', () => {
  const { block } = marqueeNewsBlock(
    [{ id: 'a', ts: 10, author: 'x', text: 'suite {green}1310 pass{/} on {cyan}beb7bb8{/}' }],
    { ts: 0, ids: [] })
  assert.ok(block.includes('suite 1310 pass on beb7bb8'))
  assert.ok(!block.includes('{green}'))
  assert.ok(!block.includes('{/}'))
})

test('v5: ts-tie boundary — ids disambiguate entries sharing a millisecond', () => {
  const entries = [
    { id: 'a', ts: 500, author: 'x', text: 'one' },
    { id: 'b', ts: 500, author: 'x', text: 'two' },
  ]
  const { block } = marqueeNewsBlock(entries, { ts: 500, ids: ['a'] })
  assert.ok(!block.includes('one'))     // already seen at the mark
  assert.ok(block.includes('two'))      // same ts, unseen id — still news
})

test('v5: makeMarqueeNews is primed at creation — old chatter is not news', () => {
  // The pinned blackboard file already holds entries from the tests above;
  // a cursor primed NOW must not deliver any of them.
  const news = makeMarqueeNews()
  assert.equal(news.take(), '')
  appendMarquee({ text: 'fresh {red}line{/} for v5', author: 'tester' })
  const block = news.take()
  assert.ok(block.includes('tester: fresh line for v5'))
  assert.equal(news.take(), '')         // delivered exactly once
})

test('v5: empty blackboard and read errors surface as empty string, not throws', () => {
  assert.equal(marqueeNewsBlock([], { ts: 0, ids: [] }).block, '')
})

// ── v6: /marquee viewer + /say composer shortcut ───────────────────────────
// The viewer's rows are pure (SelectItem-shaped, newest first, plain words);
// the command lives in the ONE vocabulary table so /help and the menu agree;
// the modal frame is accounted in layout's arithmetic like every other row.

const { marqueeHistoryItems, ageLabel } = await import('../dist/tui/marquee.js')
const { COMMANDS, COMMAND_NAMES, helpText } = await import('../dist/tui/commands.js')
const { MARQUEE_VIEW_ROWS } = await import('../dist/tui/layout.js')

test('v6: marqueeHistoryItems — newest first, markup stripped, author+age detail', () => {
  const now = 3_000_000
  const items = marqueeHistoryItems([
    { id: 'a', ts: now - 90_000, author: 'ann', text: 'older {red}line{/}' },
    { id: 'b', ts: now - 5_000, author: 'bob', text: 'newer {green}line{/}' },
  ], now)
  assert.equal(items.length, 2)
  assert.equal(items[0].key, 'b')                 // newest first
  assert.equal(items[0].label, 'newer line')      // plain words, no braces
  assert.equal(items[0].detail, 'bob · 5s')
  assert.equal(items[1].detail, 'ann · 2m')       // 90s rounds to minutes
})

test('v6: marqueeHistoryItems — ts tie breaks by id, deterministic', () => {
  const items = marqueeHistoryItems([
    { id: 'zz', ts: 100, author: 'x', text: 'two' },
    { id: 'aa', ts: 100, author: 'x', text: 'one' },
  ], 200)
  assert.equal(items[0].key, 'aa')
})

test('v6: ageLabel — the shortest honest unit at each scale', () => {
  assert.equal(ageLabel(12_000), '12s')
  assert.equal(ageLabel(5 * 60_000), '5m')
  assert.equal(ageLabel(3 * 3_600_000), '3h')
  assert.equal(ageLabel(2 * 86_400_000), '2d')
  assert.equal(ageLabel(-50), '0s')               // clock skew never goes negative
})

test('v6: /marquee is in the vocabulary — menu, /help, and local (no model turn)', () => {
  const cmd = COMMANDS.find((c) => c.name === '/marquee')
  assert.ok(cmd, '/marquee missing from COMMANDS')
  assert.equal(cmd.local, true)
  assert.ok(COMMAND_NAMES.includes('/marquee'))   // not hidden
  assert.ok(helpText().includes('/marquee'))      // one table, so /help agrees
})

test('v6: /say now describes the marquee, call behaviour preserved in words', () => {
  const say = COMMANDS.find((c) => c.name === '/say')
  assert.ok(say.description.includes('marquee'))
  assert.ok(say.description.includes('call'))
})

test('v6: the viewer frame is accounted — MARQUEE_VIEW_ROWS in the budget', () => {
  const base = { rows: 60, panels: 1 }
  const without = panelBudget(base)
  const withView = panelBudget({ ...base, marqueeView: true })
  assert.equal(without.text - withView.text, MARQUEE_VIEW_ROWS)
})

/* ── v7: the one-line invariant ─────────────────────────────────────────────
 * The row must NEVER display wider than the terminal. Ink's flex truncation
 * over the marquee's nest (emoji prefix + author + styled runs + cursor +
 * queued hint) came out 1-2 columns over — the terminal hard-wrapped the
 * line, Ink's eraser counted one row where the terminal printed two, and
 * every cursor blink scrolled the UI up a line. marqueeFit owns the
 * arithmetic now; these tests hold the invariant at every width. */
const { marqueeFit, fitToWidth } = await import('../dist/tui/marquee.js')
const stringWidth = (await import('string-width')).default

/** The full visible row, exactly as the component composes it. */
const composedWidth = (fit, queued = 0) =>
  stringWidth('💬 ' + fit.author + ': ' + fit.text + '▎' + (queued > 0 ? ` +${queued} queued` : ''))

test('v7: fitToWidth cuts by DISPLAY width and never splits a wide char', () => {
  assert.equal(fitToWidth('hello', 10), 'hello')            // fits — untouched
  assert.equal(fitToWidth('hello', 3), 'hel')
  assert.equal(fitToWidth('a💬b', 2), 'a')                  // 💬 is 2 wide; no half-emoji
  assert.equal(fitToWidth('a💬b', 3), 'a💬')
  assert.ok(stringWidth(fitToWidth('🚀🚀🚀', 5)) <= 5)
})

test('v7: marqueeFit — the composed row never exceeds the terminal width', () => {
  const long = 'deploying firmware 0.18.3 to sticky — glance-wake 2496ms, paint-first bought 600ms, 496 over target'
  for (const columns of [20, 40, 60, 80, 120]) {
    for (const queued of [0, 3]) {
      const fit = marqueeFit('cagatays-Mac-mini-28865a', long, columns, queued)
      assert.ok(composedWidth(fit, queued) < columns,
        `width ${composedWidth(fit, queued)} must stay under ${columns} cols (queued=${queued})`)
    }
  }
})

test('v7: marqueeFit — short text is untouched, long text ends in …', () => {
  const short = marqueeFit('tiny', 'hi room', 80)
  assert.equal(short.text, 'hi room')
  assert.equal(short.truncated, false)
  const long = marqueeFit('tiny', 'x'.repeat(300), 80)
  assert.ok(long.truncated)
  assert.ok(long.text.endsWith('…'))
  assert.ok(composedWidth(long) < 80)
})

test('v7: marqueeFit — a huge author yields to the text but keeps ≥8 columns', () => {
  const fit = marqueeFit('m'.repeat(100), 'the message matters more', 60)
  assert.ok(stringWidth(fit.author) >= 8)
  assert.ok(stringWidth(fit.author) < 60)
  assert.ok(fit.text.length > 0)
  assert.ok(composedWidth(fit) < 60)
})

test('v7: marqueeFit — emoji in the TEXT is measured, not counted as 1', () => {
  const fit = marqueeFit('tiny', '🚀'.repeat(80), 60)
  assert.ok(composedWidth(fit) < 60)
})
