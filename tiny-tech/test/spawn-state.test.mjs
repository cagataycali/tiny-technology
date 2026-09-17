/**
 * ⭐ spawn batch progress state — the spawn strip's data source.
 *
 * What has to be true:
 *  1. Pure transitions: startBatch → all running; markTask settles exactly
 *     one; endBatch stamps stragglers as error (no eternal ⟳).
 *  2. Disk mirrors loop.ts: atomic write, torn/absent file reads as null,
 *     invalid batch ids never touch the filesystem.
 *  3. reconcile: a running record whose pid is dead becomes interrupted+ended;
 *     a live pid or an already-ended record passes through untouched.
 *  4. prune deletes only ended records older than the window.
 *  5. makeSpawnReporter drives all of it from runSpawnBatch's callbacks and
 *     never throws — progress is an enhancement, not a dependency.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'tiny-spawn-state-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const {
  startBatch, markTask, endBatch, reconcile,
  writeSpawnBatch, readSpawnBatch, listSpawnBatches, pruneSpawnBatches,
  makeSpawnReporter, isValidBatchId, spawnsDir, SPAWN_STATE_PRUNE_MS,
} = await import('../dist/agent/spawn-state.js')

// ── pure transitions ─────────────────────────────────────────────────────────

test('startBatch: every task running, one shared start time', () => {
  const rec = startBatch('batch_abc123', 3, 1000, 42)
  assert.equal(rec.batchId, 'batch_abc123')
  assert.equal(rec.startedAt, 1000)
  assert.equal(rec.pid, 42)
  assert.equal(rec.endedAt, undefined)
  assert.equal(rec.tasks.length, 3)
  for (const [i, t] of rec.tasks.entries()) {
    assert.deepEqual(t, { index: i, status: 'running', startedAt: 1000 })
  }
})

test('markTask settles exactly one task; unknown index is a no-op', () => {
  let rec = startBatch('batch_abc123', 3, 1000)
  rec = markTask(rec, 1, true, 2000)
  assert.equal(rec.tasks[1].status, 'ok')
  assert.equal(rec.tasks[1].endedAt, 2000)
  assert.equal(rec.tasks[0].status, 'running')
  assert.equal(rec.tasks[2].status, 'running')
  rec = markTask(rec, 2, false, 3000)
  assert.equal(rec.tasks[2].status, 'error')
  // Settled tasks don't flip back, unknown indexes change nothing.
  const same = markTask(markTask(rec, 1, false, 4000), 99, true, 4000)
  assert.equal(same.tasks[1].status, 'ok')
  assert.equal(same.tasks[1].endedAt, 2000)
})

test('endBatch stamps stragglers as error — a batch cannot end with ⟳', () => {
  let rec = startBatch('batch_abc123', 2, 1000)
  rec = markTask(rec, 0, true, 2000)
  rec = endBatch(rec, 5000)
  assert.equal(rec.endedAt, 5000)
  assert.equal(rec.tasks[0].status, 'ok')      // settled result untouched
  assert.equal(rec.tasks[0].endedAt, 2000)
  assert.equal(rec.tasks[1].status, 'error')   // straggler stamped
  assert.equal(rec.tasks[1].endedAt, 5000)
})

// ── ids + disk ───────────────────────────────────────────────────────────────

test('isValidBatchId: batch_* tickets only — ids become filenames', () => {
  assert.ok(isValidBatchId('batch_mabc1234deadbeef'))
  assert.ok(!isValidBatchId('batch_'))
  assert.ok(!isValidBatchId('loop_abc'))
  assert.ok(!isValidBatchId('batch_../../etc/passwd'))
  assert.ok(!isValidBatchId('batch_ABC'))
})

test('write/read roundtrip; torn file and invalid id read as null', () => {
  const rec = markTask(startBatch('batch_roundtrip1', 2, 1000), 0, true, 1500)
  writeSpawnBatch(rec, dir)
  assert.deepEqual(readSpawnBatch('batch_roundtrip1', dir), rec)
  assert.equal(readSpawnBatch('batch_missing0', dir), null)
  writeFileSync(join(dir, 'batch_torn0.json'), '{"batchId": "batch_t')
  assert.equal(readSpawnBatch('batch_torn0', dir), null)
  // invalid id: no write happens, no read attempted
  writeSpawnBatch({ ...rec, batchId: 'nope' }, dir)
  assert.ok(!readdirSync(dir).includes('nope.json'))
})

test('spawnsDir: env override wins, TINY_HOME second', () => {
  const prev = { s: process.env.TINY_SPAWNS_DIR, h: process.env.TINY_HOME }
  process.env.TINY_SPAWNS_DIR = '/tmp/x-spawns'
  assert.equal(spawnsDir(), '/tmp/x-spawns')
  delete process.env.TINY_SPAWNS_DIR
  process.env.TINY_HOME = '/tmp/x-home'
  assert.equal(spawnsDir(), join('/tmp/x-home', 'spawns'))
  if (prev.s != null) process.env.TINY_SPAWNS_DIR = prev.s
  if (prev.h != null) process.env.TINY_HOME = prev.h; else delete process.env.TINY_HOME
})

// ── reconcile + list + prune ─────────────────────────────────────────────────

test('reconcile: dead pid → interrupted + ended; live pid and ended records untouched', () => {
  const running = startBatch('batch_recon1', 2, 1000, 12345)
  const dead = reconcile(running, { pidLive: () => false, now: 9000 })
  assert.equal(dead.interrupted, true)
  assert.equal(dead.endedAt, 9000)
  assert.equal(dead.tasks[0].status, 'error')
  const alive = reconcile(running, { pidLive: () => true, now: 9000 })
  assert.equal(alive, running)
  const ended = endBatch(running, 2000)
  assert.equal(reconcile(ended, { pidLive: () => false, now: 9000 }), ended)
  // no pid: nothing to check, left alone
  const noPid = startBatch('batch_recon2', 1, 1000)
  assert.equal(reconcile(noPid, { pidLive: () => false, now: 9000 }), noPid)
})

test('listSpawnBatches: sorted by startedAt, reconciled, tolerant of junk files', () => {
  const d = mkdtempSync(join(tmpdir(), 'tiny-spawn-list-'))
  writeSpawnBatch(startBatch('batch_late00', 1, 2000, 1), d)
  writeSpawnBatch(startBatch('batch_early0', 1, 1000, 1), d)
  writeFileSync(join(d, 'notes.txt'), 'not a record')
  const got = listSpawnBatches(d, { pidLive: () => false, now: 5000 })
  assert.deepEqual(got.map((r) => r.batchId), ['batch_early0', 'batch_late00'])
  assert.ok(got.every((r) => r.interrupted === true))
  rmSync(d, { recursive: true, force: true })
})

test('prune deletes only ended records past the window', () => {
  const d = mkdtempSync(join(tmpdir(), 'tiny-spawn-prune-'))
  const now = 1000 + SPAWN_STATE_PRUNE_MS + 1
  writeSpawnBatch(endBatch(startBatch('batch_old000', 1, 0), 1000), d)          // past window → pruned
  writeSpawnBatch(endBatch(startBatch('batch_fresh0', 1, 0), now - 1000), d)    // recent → kept
  writeSpawnBatch(startBatch('batch_live00', 1, 0, process.pid), d)             // running → kept
  const gone = pruneSpawnBatches(d, now)
  assert.deepEqual(gone, ['batch_old000'])
  const left = listSpawnBatches(d, { pidLive: () => true }).map((r) => r.batchId).sort()
  assert.deepEqual(left, ['batch_fresh0', 'batch_live00'])
  rmSync(d, { recursive: true, force: true })
})

// ── the reporter ─────────────────────────────────────────────────────────────

test('makeSpawnReporter: start→taskEnded→batchEnded lands on disk in order', () => {
  const d = mkdtempSync(join(tmpdir(), 'tiny-spawn-rep-'))
  let t = 1000
  const rep = makeSpawnReporter('batch_reporter0', 2, { dir: d, now: () => t, pid: process.pid })
  let rec = readSpawnBatch('batch_reporter0', d)
  assert.equal(rec.tasks.length, 2)
  assert.ok(rec.tasks.every((x) => x.status === 'running'))
  t = 2000
  rep.taskEnded(0, true)
  rec = readSpawnBatch('batch_reporter0', d)
  assert.equal(rec.tasks[0].status, 'ok')
  assert.equal(rec.tasks[1].status, 'running')
  t = 3000
  rep.taskEnded(1, false)
  rep.batchEnded()
  rec = readSpawnBatch('batch_reporter0', d)
  assert.equal(rec.endedAt, 3000)
  assert.equal(rec.tasks[1].status, 'error')
  rmSync(d, { recursive: true, force: true })
})

test('runSpawnBatch drives the reporter: per-task settle + batch end', async () => {
  const { runSpawnBatch } = await import('../dist/agent/spawn-tools.js')
  const events = []
  const reporter = {
    taskEnded: (i, ok) => events.push(['task', i, ok]),
    batchEnded: () => events.push(['end']),
  }
  const factory = async (i) => ({
    invoke: async () => {
      if (i === 1) throw new Error('boom')
      return `answer ${i}`
    },
  })
  const { results } = await runSpawnBatch(['a', 'b', 'c'], factory, { reporter })
  assert.equal(results.filter((r) => r.ok).length, 2)
  assert.equal(events.filter(([k]) => k === 'task').length, 3)
  assert.deepEqual(events.find(([k, i]) => k === 'task' && i === 1), ['task', 1, false])
  assert.deepEqual(events[events.length - 1], ['end'])
})

test('spawn_agents tool writes a progress record for a wait:true batch', async () => {
  const d = mkdtempSync(join(tmpdir(), 'tiny-spawn-tool-'))
  const prev = process.env.TINY_SPAWNS_DIR
  process.env.TINY_SPAWNS_DIR = d
  try {
    const { makeSpawnAgentsTool } = await import('../dist/agent/spawn-tools.js')
    const t = makeSpawnAgentsTool({ agentFactory: async () => ({ invoke: async () => 'ok' }) })
    const out = await t.invoke({ tasks: ['one', 'two'] })
    assert.ok(out.batch_id?.startsWith('batch_'))
    const rec = readSpawnBatch(out.batch_id, d)
    assert.ok(rec, 'progress record exists')
    assert.equal(rec.tasks.length, 2)
    assert.ok(rec.endedAt != null, 'record closed when the batch returned')
    assert.ok(rec.tasks.every((x) => x.status === 'ok'))
  } finally {
    if (prev != null) process.env.TINY_SPAWNS_DIR = prev; else delete process.env.TINY_SPAWNS_DIR
    rmSync(d, { recursive: true, force: true })
  }
})
