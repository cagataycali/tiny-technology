/**
 * ⚡ The slash-command table, the menu's filtering, the list window, and the loop
 * strip's rows — all the parts of the new TUI surface that are pure.
 *
 * Deliberately no TTY here: tui.test.mjs drives the real Ink app with a fake
 * stdin and is the right place for "does Esc reach the right handler"; this file
 * is the rules those handlers apply.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  COMMANDS, COMMAND_NAMES, filterCommands, fuzzyScore, ghostFor, helpText, commandLabel,
} = await import('../dist/tui/commands.js')
const { windowFor } = await import('../dist/tui/select.js')
const { loopStripRows, ROWS_PER_LOOP } = await import('../dist/tui/loop-strip.js')
const { panelBudget, MENU_ROWS } = await import('../dist/tui/layout.js')
const { LOOP_COOLDOWN_MS, LOOP_MAX_ITERATIONS } = await import('../dist/agent/loop.js')

// ─── the table ──────────────────────────────────────────────────────────────

test('every command is a slash name with a description', () => {
  for (const c of COMMANDS) {
    assert.match(c.name, /^\/[a-z]+$/, `${c.name} is not a bare slash name`)
    assert.ok(c.description.length > 5, `${c.name} needs a description`)
    assert.ok(!/\.$/.test(c.description), `${c.name} description should not end in a period`)
  }
})

test('/help renders FROM the table — one vocabulary, not two', () => {
  const text = helpText()
  for (const c of COMMANDS.filter((c) => !c.hidden)) {
    assert.ok(text.includes(c.name), `/help is missing ${c.name}`)
    assert.ok(text.includes(c.description), `/help is missing the description of ${c.name}`)
  }
  // The keys have no slash, so they cannot live in COMMANDS — but they belong in
  // the same answer, and this is the assertion that keeps them there.
  for (const key of ['!cmd', '↑/↓', 'Esc', '^C']) {
    assert.ok(text.includes(key), `/help is missing ${key}`)
  }
})

test('a retired name still works but is never advertised', () => {
  const tasks = COMMANDS.find((c) => c.name === '/tasks')
  assert.equal(tasks.hidden, true)
  assert.ok(!COMMAND_NAMES.includes('/tasks'))
  assert.ok(!helpText().includes('/tasks'))
  assert.ok(!filterCommands('/tasks').some((c) => c.name === '/tasks'))
})

// ─── filtering ──────────────────────────────────────────────────────────────

test('the menu opens on a bare slash and lists everything', () => {
  const all = filterCommands('/')
  assert.equal(all.length, COMMANDS.filter((c) => !c.hidden).length)
  // The old behaviour: '/' produced ONE dim '/clear' and nothing else.
  assert.ok(all.length > 1)
})

test('the menu is closed for anything that is not a bare command', () => {
  assert.equal(filterCommands(''), null)
  assert.equal(filterCommands('what is the mesh'), null)
  // An argument being written is not a command being chosen.
  assert.equal(filterCommands('/loop refactor the parser'), null)
  assert.equal(filterCommands('/say '), null)
  assert.equal(filterCommands('!ls'), null)
})

test('filtering is fuzzy, and a substring beats a scattered match', () => {
  assert.deepEqual(filterCommands('/loo').map((c) => c.name), ['/loop', '/loops'])
  assert.equal(filterCommands('/vo')[0].name, '/voice')
  // 'lp' matches loop/loops only as a subsequence — still found.
  assert.ok(filterCommands('/lp').some((c) => c.name === '/loop'))
  // A prefix hit must outrank a mid-word hit.
  assert.equal(filterCommands('/pe')[0].name, '/peers')
  assert.equal(fuzzyScore('help', 'help'), 0)
  assert.equal(fuzzyScore('zzz', 'help'), null)
  assert.ok(fuzzyScore('hp', 'help') > fuzzyScore('he', 'help'))
})

test('no match returns an empty list, NOT null — the menu stays open to say so', () => {
  const none = filterCommands('/zzzz')
  assert.ok(Array.isArray(none))
  assert.equal(none.length, 0)
})

test('the ghost suggestion completes only real prefixes', () => {
  assert.equal(ghostFor('/vo'), '/voice')
  assert.equal(ghostFor('/voice'), '')          // already complete
  assert.equal(ghostFor('/lp'), '')             // fuzzy hit is not a completion
  assert.equal(ghostFor('hello'), '')
})

test('a command that takes an argument says so in its label', () => {
  assert.equal(commandLabel(COMMANDS.find((c) => c.name === '/loop')), '/loop [task]')
  assert.equal(commandLabel(COMMANDS.find((c) => c.name === '/peers')), '/peers')
})

// ─── the list window ────────────────────────────────────────────────────────

test('a list shorter than the window shows whole', () => {
  assert.deepEqual(windowFor(0, 3, 8), { start: 0, end: 3 })
})

test('the window follows the cursor and never runs past the ends', () => {
  // A long list, cursor at the top: the window starts at the top.
  assert.deepEqual(windowFor(0, 20, 5), { start: 0, end: 5 })
  // Cursor in the middle: centred.
  const mid = windowFor(10, 20, 5)
  assert.ok(mid.start <= 10 && 10 < mid.end)
  // Cursor at the very bottom: the last row is visible and no blank rows follow.
  assert.deepEqual(windowFor(19, 20, 5), { start: 15, end: 20 })
  // Whatever the cursor, the window is exactly maxRows tall — the fixed height
  // is the promise that keeps the composer from hopping while you type.
  for (let c = 0; c < 20; c++) {
    const w = windowFor(c, 20, 5)
    assert.equal(w.end - w.start, 5, `cursor ${c} produced ${w.end - w.start} rows`)
    assert.ok(w.start <= c && c < w.end, `cursor ${c} fell outside its own window`)
  }
})

test('a window with no room, or nothing to show, is empty rather than negative', () => {
  assert.deepEqual(windowFor(0, 0, 5), { start: 0, end: 0 })
  assert.deepEqual(windowFor(3, 10, 0), { start: 0, end: 0 })
})

// ─── the loop strip ─────────────────────────────────────────────────────────

const rec = (over = {}) => ({
  id: 'l20260814040640001',
  prompt: 'TRACK A — CAD: design the two-layer sandwich case\nfor the Nicla Vision',
  status: 'running',
  startedAt: 1000,
  iterations: [],
  pid: 1,
  host: 'mac',
  ...over,
})

test('only RUNNING loops reach the strip', () => {
  const rows = loopStripRows([
    rec(),
    rec({ id: 'b', status: 'done' }),
    rec({ id: 'c', status: 'error' }),
    rec({ id: 'd', status: 'interrupted' }),
  ], 1000)
  assert.deepEqual(rows.map((r) => r.id), ['l20260814040640001'])
})

test('a row carries iteration count, elapsed, the goal and the last step — each on ONE line', () => {
  const now = 1000 + 4 * 60_000 + 12_000
  const [row] = loopStripRows([rec({
    iterations: [
      { n: 1, at: 1000, summary: 'read the repo' },
      { n: 2, at: now - 1000, summary: 'measured MOUNT_PITCH,\n22.0mm still unverified' },
    ],
  })], now)
  assert.equal(row.meta, `iter 2/${LOOP_MAX_ITERATIONS} · 4m12s`)
  assert.ok(!row.goal.includes('\n'), 'the goal must be flattened')
  assert.ok(!row.step.includes('\n'), 'the step must be flattened')
  assert.ok(row.step.includes('measured MOUNT_PITCH'))
  assert.ok(row.step.startsWith('↳'))
})

test('a loop between iterations says when the next one lands, not nothing', () => {
  const now = 100_000
  const [cooling] = loopStripRows([rec({ iterations: [{ n: 1, at: now - 6000, summary: 's' }] })], now)
  assert.match(cooling.phase, /next step in \d+s/)
  const [working] = loopStripRows([rec({ iterations: [{ n: 1, at: now - LOOP_COOLDOWN_MS - 1, summary: 's' }] })], now)
  assert.equal(working.phase, 'working…')
})

test('a loop with no iterations yet has no step line to draw', () => {
  const [row] = loopStripRows([rec()], 2000)
  assert.equal(row.step, '')
  assert.equal(row.phase, 'working…')
})

test('long text is truncated to the terminal width, so the strip cannot grow', () => {
  const [row] = loopStripRows([rec({
    prompt: 'x'.repeat(500),
    iterations: [{ n: 1, at: 0, summary: 'y'.repeat(500) }],
  })], 5000, 60)
  assert.ok(row.goal.length <= 60, `goal was ${row.goal.length} columns`)
  assert.ok(row.step.length <= 62, `step was ${row.step.length} columns`)
  assert.ok(row.goal.endsWith('…'))
})

// ─── the budget ─────────────────────────────────────────────────────────────

test('the strip and the menu take their rows from the panels, not from the composer', () => {
  const base = panelBudget({ rows: 40, panels: 1 })
  const withLoops = panelBudget({ rows: 40, panels: 1, loops: 2 })
  const withMenu = panelBudget({ rows: 40, panels: 1, menu: true })
  assert.ok(withLoops.text < base.text, 'two running loops must cost the panel rows')
  assert.ok(withMenu.text < base.text, 'an open menu must cost the panel rows')
  // Two loops = 2×3 rows + the footer.
  assert.equal(base.text - panelBudget({ rows: 40, panels: 1, loops: 1 }).text, ROWS_PER_LOOP + 1)
  assert.ok(MENU_ROWS > 0)
})

test('even with everything on screen a panel keeps the two-row floor', () => {
  const b = panelBudget({ rows: 24, panels: 3, question: true, call: true, status: true, loop: true, loops: 2, menu: true, meshFooter: true })
  assert.ok(b.text >= 2)
  assert.ok(b.chips >= 2)
})
