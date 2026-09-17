/**
 * ⭐ spawn strip rows — the pure selector behind <SpawnStrip>.
 *
 * What has to be true:
 *  1. No batches → no rows; N in flight → N rows, record order preserved.
 *  2. Status text counts states: `ok/total ✓`, spinners only while running,
 *     failures only when they exist.
 *  3. A finished batch lingers (muted, endedAs set) for SPAWN_ENDED_LINGER_MS,
 *     then is gone — same transition contract as the loop strip.
 *  4. endedAs: interrupted beats the ✓/✗ arithmetic; any error → 'error';
 *     all ok → 'done'.
 *  5. Elapsed grows while running and freezes at the batch's span once ended.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { spawnStripRows, SPAWN_ENDED_LINGER_MS } = await import('../dist/tui/spawn-strip.js')
const { startBatch, markTask, endBatch } = await import('../dist/agent/spawn-state.js')

const T0 = 100_000

test('no batches → no rows', () => {
  assert.deepEqual(spawnStripRows([], T0), [])
})

test('N in flight → N rows, order preserved, all-running status', () => {
  const a = startBatch('batch_aaa000', 3, T0)
  const b = startBatch('batch_bbb000', 1, T0 + 500)
  const rows = spawnStripRows([a, b], T0 + 1000)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.id), ['batch_aaa000', 'batch_bbb000'])
  assert.equal(rows[0].status, '0/3 ✓ · 3 ⟳')
  assert.equal(rows[0].endedAs, undefined)
  assert.equal(rows[0].elapsed, '1s')
  assert.equal(rows[1].elapsed, '1s')  // 500ms rounds to 1s
})

test('mixed progress: settled, spinning and failed all counted', () => {
  let rec = startBatch('batch_mix000', 4, T0)
  rec = markTask(rec, 0, true, T0 + 1000)
  rec = markTask(rec, 1, true, T0 + 2000)
  rec = markTask(rec, 2, false, T0 + 3000)
  const [row] = spawnStripRows([rec], T0 + 4000)
  assert.equal(row.status, '2/4 ✓ · 1 ⟳ · 1 ✗')
  assert.equal(row.endedAs, undefined)
})

test('all-green running batch shows no ✗ term', () => {
  let rec = startBatch('batch_green0', 2, T0)
  rec = markTask(rec, 0, true, T0 + 1000)
  const [row] = spawnStripRows([rec], T0 + 1000)
  assert.equal(row.status, '1/2 ✓ · 1 ⟳')
})

test('finished within linger → muted row with endedAs; past linger → gone', () => {
  let rec = startBatch('batch_lin000', 2, T0)
  rec = markTask(rec, 0, true, T0 + 1000)
  rec = markTask(rec, 1, true, T0 + 2000)
  rec = endBatch(rec, T0 + 2000)
  const inLinger = spawnStripRows([rec], T0 + 2000 + SPAWN_ENDED_LINGER_MS - 1)
  assert.equal(inLinger.length, 1)
  assert.equal(inLinger[0].endedAs, 'done')
  assert.equal(inLinger[0].status, '2/2 ✓')
  const past = spawnStripRows([rec], T0 + 2000 + SPAWN_ENDED_LINGER_MS)
  assert.deepEqual(past, [])
})

test('endedAs: any task error → error; interrupted beats the arithmetic', () => {
  let rec = startBatch('batch_err000', 2, T0)
  rec = markTask(rec, 0, true, T0 + 1000)
  rec = markTask(rec, 1, false, T0 + 1000)
  rec = endBatch(rec, T0 + 1000)
  assert.equal(spawnStripRows([rec], T0 + 1500)[0].endedAs, 'error')

  const dead = { ...endBatch(startBatch('batch_dead00', 2, T0), T0 + 1000), interrupted: true }
  const [row] = spawnStripRows([dead], T0 + 1500)
  assert.equal(row.endedAs, 'interrupted')
  // reconcile stamped the open tasks as errors — the counts still tell it
  assert.equal(row.status, '0/2 ✓ · 2 ✗')
})

test('elapsed grows while running, freezes at the span once ended', () => {
  const run = startBatch('batch_time00', 1, T0)
  assert.equal(spawnStripRows([run], T0 + 65_000)[0].elapsed, '1m05s')
  const ended = endBatch(markTask(run, 0, true, T0 + 10_000), T0 + 10_000)
  // observed 3s into the linger: elapsed stays the batch's own 10s
  assert.equal(spawnStripRows([ended], T0 + 13_000)[0].elapsed, '10s')
})

test('running and just-ended batches coexist; only the ended one is styled', () => {
  const run = startBatch('batch_run000', 2, T0)
  const done = endBatch(markTask(startBatch('batch_done00', 1, T0), 0, true, T0 + 1000), T0 + 1000)
  const rows = spawnStripRows([run, done], T0 + 2000)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].endedAs, undefined)
  assert.equal(rows[1].endedAs, 'done')
})
