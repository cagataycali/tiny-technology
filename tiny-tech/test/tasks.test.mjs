/**
 * ⏳ Background tasks — work that outlives the turn that asked for it.
 *
 * The four things that make this feature honest rather than merely present:
 *
 *  1. start() RETURNS while the work runs. If it awaited, nothing changed: the
 *     relay envelope still times out at 45s and the long job is still unaskable.
 *  2. A result reaches the user WITHOUT being asked for, exactly once. A result
 *     you have to remember to collect is a result you never see; a result
 *     re-announced every turn is noise the user learns to ignore.
 *  3. A record on disk never LIES. `running` written by a process that has since
 *     died must not read as "still going" forever, and a partially written file
 *     must never be readable at all.
 *  4. The refusals hold: depth 1, a concurrency cap, and a cancel that admits it
 *     only stopped watching.
 *
 * Real files in a real temp dir and a real (fake-agent) runner — the races here
 * are between a writer and a reader, which a mocked filesystem cannot have.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-tasks-'))
process.env.TINY_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  tasksDir, ensureTasksDir, newTaskId, isValidTaskId, writeTask, readTask, listTasks,
  reconcile, prunable, pruneTasks, formatTaskLine, summarizeTasks, finishedNewsBlock,
  markSeen, TaskRunner, makeTasksTool, TASKS_DESCRIPTION,
  TASK_TIMEOUT_MS, MAX_ACTIVE_TASKS, TASK_RESULT_MAX, TASK_KEEP_MS,
} = await import('../dist/agent/tasks.js')

let seq = 0
const freshDir = () => {
  const d = join(home, `tasks-${seq++}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** A runner whose agent answers whatever the factory was told to answer. */
const runnerWith = (fn, extra = {}) => new TaskRunner({
  dir: extra.dir || freshDir(),
  agentFactory: async () => ({ invoke: fn }),
  ...extra,
})

/**
 * A promise the test releases by hand. Built BEFORE the runner: `start()` is
 * synchronous but `run()` awaits agentFactory() first, so `invoke` is not called
 * until a microtask later — a resolver assigned inside the executor is still
 * undefined at the moment start() returns.
 */
function gate() {
  let release
  const promise = new Promise((r) => { release = r })
  return { promise, release }
}

/** Wait until `check()` holds, or fail — a background task settles when it settles. */
async function until(check, label, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for: ${label}`)
}

const rec = (over = {}) => ({
  id: 't1', prompt: 'p', status: 'done', startedAt: 1000, endedAt: 2000,
  pid: process.pid, host: 'thishost', ...over,
})

// ── where records live ──────────────────────────────────────────────────────

test('task records are user state, beside device.json', () => {
  assert.equal(tasksDir(), join(home, 'tasks'))
})

test('TINY_TASKS_DIR overrides', () => {
  process.env.TINY_TASKS_DIR = '/tmp/somewhere-else'
  try { assert.equal(tasksDir(), '/tmp/somewhere-else') } finally { delete process.env.TINY_TASKS_DIR }
})

test('a missing dir lists as empty rather than throwing', () => {
  assert.deepEqual(listTasks(join(home, 'never-created')), [])
})

test('an unwritable dir does not throw at construction', () => {
  assert.doesNotThrow(() => ensureTasksDir('/proc/nope/tiny-tasks'))
})

// ── ids ─────────────────────────────────────────────────────────────────────

test('ids are time-ordered so filename sort is chronological', () => {
  const a = newTaskId(Date.parse('2026-07-25T10:00:00Z'))
  const b = newTaskId(Date.parse('2026-07-25T11:00:00Z'))
  assert.ok(a < b, `${a} should sort before ${b}`)
  assert.match(a, /^t\d{14}\d{3}$/)
})

test('two ids in the same millisecond still differ', () => {
  const t = Date.parse('2026-07-25T10:00:00Z')
  assert.notEqual(newTaskId(t), newTaskId(t))
})

test('a task id can never escape the tasks dir', () => {
  // The id reaches readTask straight from model output, and it becomes a path.
  for (const bad of ['../../.ssh/id_rsa', 'a/b', '', '.', 'x'.repeat(65), null, 42, 't1.json']) {
    assert.ok(!isValidTaskId(bad), `${String(bad)} must be rejected`)
  }
  assert.ok(isValidTaskId('t20260725100000001'))
  assert.equal(readTask('../../etc/passwd', freshDir()), null)
})

// ── records never lie ───────────────────────────────────────────────────────

test('a record is written atomically — a reader never sees a partial file', () => {
  // list() and the writer race by construction; half a JSON file would read as
  // a corrupt task rather than a running one.
  const dir = freshDir()
  writeTask(rec({ id: 'tatomic' }), dir)
  const files = readdirSync(dir)
  assert.deepEqual(files, ['tatomic.json'], 'no .tmp left behind')
  assert.equal(readTask('tatomic', dir).id, 'tatomic')
})

test('a corrupt record is skipped, not fatal, and does not hide the others', () => {
  const dir = freshDir()
  writeTask(rec({ id: 'tgood' }), dir)
  writeFileSync(join(dir, 'tbroken.json'), '{"id": "tbro')
  assert.deepEqual(listTasks(dir).map((r) => r.id), ['tgood'])
})

test('stray files in the dir are ignored', () => {
  const dir = freshDir()
  writeTask(rec({ id: 'treal' }), dir)
  writeFileSync(join(dir, 'notes.txt'), 'hi')
  writeFileSync(join(dir, 'tpartial.json.tmp'), '{')
  assert.deepEqual(listTasks(dir).map((r) => r.id), ['treal'])
})

test('a `running` record from a DEAD process reads as interrupted, not running', () => {
  // The daemon restarts (launchd KeepAlive, a crash, `daemon restart`) and
  // nothing in the dead process updates its rows — so without this the user
  // waits forever on a task that died weeks ago.
  const r = reconcile(rec({ status: 'running', endedAt: undefined, pid: 999999 }), {
    pidLive: () => false, host: 'thishost',
  })
  assert.equal(r.status, 'interrupted')
  assert.ok(r.endedAt, 'interrupted tasks get an end time so they can be pruned')
})

test('a `running` record from a LIVE process is left alone', () => {
  const r = reconcile(rec({ status: 'running', endedAt: undefined }), { pidLive: () => true, host: 'thishost' })
  assert.equal(r.status, 'running')
})

test('a running record from ANOTHER host is never declared dead', () => {
  // pids aren't comparable across machines; a synced ~/.tiny would otherwise
  // make each host confidently report the other's live tasks as interrupted.
  const r = reconcile(rec({ status: 'running', endedAt: undefined, host: 'other-laptop' }), {
    pidLive: () => false, host: 'thishost',
  })
  assert.equal(r.status, 'running')
})

test('a finished record is never reconsidered', () => {
  for (const status of ['done', 'error', 'cancelled', 'interrupted']) {
    assert.equal(reconcile(rec({ status }), { pidLive: () => false, host: 'thishost' }).status, status)
  }
})

test('listTasks returns oldest first', () => {
  const dir = freshDir()
  writeTask(rec({ id: 'tb', startedAt: 2000 }), dir)
  writeTask(rec({ id: 'ta', startedAt: 1000 }), dir)
  assert.deepEqual(listTasks(dir).map((r) => r.id), ['ta', 'tb'])
})

// ── pruning ─────────────────────────────────────────────────────────────────

test('old finished records are pruned; a running one never is', () => {
  // A `running` row may belong to a live process about to write to it — age
  // alone must not delete the destination of a result still in flight.
  const now = 10_000_000_000
  const old = now - TASK_KEEP_MS - 1
  const records = [
    rec({ id: 'told', status: 'done', endedAt: old }),
    rec({ id: 'trecent', status: 'done', endedAt: now - 1000 }),
    rec({ id: 'tstuck', status: 'running', endedAt: undefined, startedAt: old }),
  ]
  assert.deepEqual(prunable(records, now).map((r) => r.id), ['told'])
})

test('pruneTasks deletes the files it names', () => {
  const dir = freshDir()
  const now = 10_000_000_000
  writeTask(rec({ id: 'told', endedAt: now - TASK_KEEP_MS - 1 }), dir)
  writeTask(rec({ id: 'tnew', endedAt: now }), dir)
  assert.deepEqual(pruneTasks(dir, now), ['told'])
  assert.deepEqual(listTasks(dir).map((r) => r.id), ['tnew'])
})

// ── the news reaches the user, once ─────────────────────────────────────────

test('finished-but-unseen tasks become a context block', () => {
  const block = finishedNewsBlock([
    rec({ id: 'tdone', status: 'done', result: 'the deploy is green' }),
    rec({ id: 'trun', status: 'running', endedAt: undefined }),
  ])
  assert.match(block, /tdone/)
  assert.match(block, /the deploy is green/)
  assert.ok(!block.includes('trun'), 'a running task is not news')
  assert.match(block, /tell the user/i, 'the block has to instruct, not just inform')
})

test('an already-seen task is not news again', () => {
  assert.equal(finishedNewsBlock([rec({ status: 'done', seen: true, result: 'x' })]), '')
  assert.equal(finishedNewsBlock([]), '')
})

test('a finished task with no output still gets announced', () => {
  // "It finished and produced nothing" is information; silence is a bug report.
  assert.match(finishedNewsBlock([rec({ status: 'done', result: '' })]), /no output/)
})

test('an errored task is news too', () => {
  assert.match(finishedNewsBlock([rec({ status: 'error', result: 'boom' })]), /error/)
})

test('takeNews delivers exactly once, and the record survives for later lookup', async () => {
  // Re-announcing every turn is how a user learns to ignore the block; deleting
  // the record instead would break `use_tasks result` five minutes later.
  const dir = freshDir()
  const runner = runnerWith(async () => 'done!', { dir })
  const { id } = runner.start('do a thing')
  await until(() => runner.get(id)?.status === 'done', 'task finishes')

  const first = runner.takeNews()
  assert.match(first, new RegExp(id))
  assert.equal(runner.takeNews(), '', 'the same news is not delivered twice')
  assert.equal(runner.get(id).result, 'done!', 'the record is still there')
})

test('markSeen only touches the ids it was given', () => {
  const dir = freshDir()
  writeTask(rec({ id: 'ta', status: 'done', result: 'a' }), dir)
  writeTask(rec({ id: 'tb', status: 'done', result: 'b' }), dir)
  markSeen(['ta'], dir)
  assert.equal(readTask('ta', dir).seen, true)
  assert.ok(!readTask('tb', dir).seen)
})

// ── start returns immediately ───────────────────────────────────────────────

test('start() returns an id BEFORE the work is done — the whole point', async () => {
  // If this awaited, the 45s relay timeout still kills the long job and nothing
  // was gained. The task must be observably running at the moment start returns.
  const g = gate()
  const dir = freshDir()
  const runner = runnerWith(() => g.promise, { dir })
  const started = runner.start('long thing')
  assert.ok(started.id, 'an id, immediately')
  assert.equal(runner.get(started.id).status, 'running')
  assert.equal(runner.activeCount, 1)

  g.release('finished later')
  await until(() => runner.get(started.id)?.status === 'done', 'the task lands')
  assert.equal(runner.get(started.id).result, 'finished later')
  assert.equal(runner.activeCount, 0, 'the slot is freed')
})

test('a record exists before the work starts, so a task that dies with its process is explainable', () => {
  const dir = freshDir()
  // timeoutMs is short in every never-settling test on purpose: the task timer is
  // deliberately NOT unref'd (see the child-process test below), so a default
  // 900s timer here would hold this test FILE open for fifteen minutes.
  const runner = runnerWith(() => new Promise(() => {}), { dir, timeoutMs: 100 })
  const { id } = runner.start('work')
  const onDisk = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8'))
  assert.equal(onDisk.status, 'running')
  assert.equal(onDisk.pid, process.pid, 'the pid is what makes a stale row detectable')
  assert.equal(onDisk.prompt, 'work')
})

test('a task whose agent throws is recorded as error, not lost', async () => {
  const runner = runnerWith(async () => { throw new Error('the repo is gone') })
  const { id } = runner.start('doomed')
  await until(() => runner.get(id)?.status === 'error', 'the failure lands')
  assert.match(runner.get(id).result, /the repo is gone/)
})

test('a task whose agent cannot even be built is recorded as error', async () => {
  const runner = new TaskRunner({ dir: freshDir(), agentFactory: async () => { throw new Error('no model key') } })
  const { id } = runner.start('doomed')
  await until(() => runner.get(id)?.status === 'error', 'the failure lands')
  assert.match(runner.get(id).result, /no model key/)
})

test('a wedged task times out and says so instead of holding its slot forever', async () => {
  const runner = runnerWith(() => new Promise(() => {}), { timeoutMs: 40 })
  const { id } = runner.start('never finishes')
  await until(() => runner.get(id)?.status === 'error', 'the timeout fires')
  assert.match(runner.get(id).result, /timed out/)
  assert.equal(runner.activeCount, 0)
})

test('a wedged task keeps the process alive long enough to RECORD the timeout', async () => {
  // The c18 lesson, and the reason every never-settling test above passes a short
  // timeoutMs: the task timer must NOT be unref'd. An unref'd timer cannot hold
  // the event loop open, so a one-shot `tiny-tech "…"` run would exit the moment
  // the main turn ended — leaving the record on disk still claiming `running`
  // forever, which is precisely the lie reconcile() exists to catch. Only a real
  // child process can observe "did the loop stay open", so: a real child process.
  const dir = freshDir()
  const script = `
    const { TaskRunner } = await import(${JSON.stringify(new URL('../dist/agent/tasks.js', import.meta.url).href)})
    const runner = new TaskRunner({
      dir: ${JSON.stringify(dir)},
      timeoutMs: 300,
      agentFactory: async () => ({ invoke: () => new Promise(() => {}) }),
    })
    runner.start('never settles')
    // Nothing else keeps this process alive — no server, no stdin, no interval.
  `
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 })

  const [rec] = listTasks(dir)
  assert.equal(rec.status, 'error', 'the child stayed alive to write the timeout, rather than exiting mid-`running`')
  assert.match(rec.result, /timed out/)
})

test('an empty prompt is refused rather than started', () => {
  const runner = runnerWith(async () => 'x')
  assert.match(runner.start('   ').error, /needs a prompt/)
  assert.match(runner.start(undefined).error, /needs a prompt/)
  assert.equal(runner.list().length, 0, 'no phantom record')
})

test('a huge result is clamped AND says it was clamped', async () => {
  // The relay clamps again at 8KB downstream; a silent truncation upstream of a
  // silent truncation is how "the file was empty" gets reported.
  const runner = runnerWith(async () => 'x'.repeat(TASK_RESULT_MAX + 5000))
  const { id } = runner.start('verbose')
  await until(() => runner.get(id)?.status === 'done', 'lands')
  const r = runner.get(id).result
  assert.ok(r.length < TASK_RESULT_MAX + 200)
  assert.match(r, /truncated/)
})

// ── the refusals ────────────────────────────────────────────────────────────

test('the concurrency cap refuses a fourth task and says what to do instead', () => {
  // Each task is a full agent with shell access; the person whose laptop this is
  // did not agree to eight of them. A model told to "check these 200 repos" hits
  // this, so the message has to name the alternative.
  const runner = runnerWith(() => new Promise(() => {}), { maxActive: 2, timeoutMs: 100 })
  assert.ok(runner.start('a').id)
  assert.ok(runner.start('b').id)
  const third = runner.start('c')
  assert.match(third.error, /max 2/)
  assert.match(third.error, /batch/)
  assert.equal(runner.list().length, 2, 'the refused task leaves no record')
  assert.equal(MAX_ACTIVE_TASKS, 3)
})

test('a finished task frees its slot for the next one', async () => {
  const runner = runnerWith(async () => 'quick', { maxActive: 1 })
  const a = runner.start('a')
  await until(() => runner.get(a.id)?.status === 'done', 'a lands')
  assert.ok(runner.start('b').id, 'the cap is about CONCURRENT tasks, not lifetime')
})

test('cancel stops the waiting and admits it cannot stop the work', async () => {
  // Nothing in Node can abort a model turn in flight or the shell command it
  // spawned. Saying "cancelled" about work still running on the user's laptop
  // is a lie, so the message says which of the two happened.
  const g = gate()
  const runner = runnerWith(() => g.promise)
  const { id } = runner.start('long')
  const msg = runner.cancel(id)
  assert.match(msg, /cancelled/)
  assert.match(msg, /still be finishing|nothing can abort/i)
  assert.equal(runner.get(id).status, 'cancelled')

  g.release('came back anyway')
  await until(() => (runner.get(id).result || '').includes('anyway'), 'the late result lands')
  assert.equal(runner.get(id).status, 'cancelled', 'a late result must NOT relabel it done')
  assert.match(runner.get(id).result, /cancelled/, 'and the record says the work arrived after the fact')
})

test('a cancelled task is not announced as fresh news twice', async () => {
  const runner = runnerWith(async () => 'x')
  const { id } = runner.start('t')
  runner.cancel(id)
  assert.match(runner.takeNews(), new RegExp(id))
  assert.equal(runner.takeNews(), '')
})

test('cancelling an unknown or already-finished task says so', async () => {
  const runner = runnerWith(async () => 'x')
  assert.match(runner.cancel('tnope'), /no such task/)
  const { id } = runner.start('t')
  await until(() => runner.get(id)?.status === 'done', 'lands')
  assert.match(runner.cancel(id), /already done/)
})

test('a cancelled slot is released so the cap is not leaked', async () => {
  const g = gate()
  const runner = runnerWith(() => g.promise, { maxActive: 1 })
  const { id } = runner.start('a')
  runner.cancel(id)
  assert.match(runner.start('b').error, /max 1/, 'still occupied until the work actually returns')
  g.release('done')
  await until(() => runner.activeCount === 0, 'the slot frees')
  assert.ok(runner.start('c').id)
})

// ── notification ────────────────────────────────────────────────────────────

test('a finished task notifies the human, because the daemon is headless', async () => {
  const seen = []
  const runner = runnerWith(async () => 'the build is green', {
    notify: (title, body) => seen.push({ title, body }),
  })
  const { id } = runner.start('watch the build')
  await until(() => seen.length === 1, 'the notification fires')
  assert.match(seen[0].title, new RegExp(id))
  assert.match(seen[0].body, /green/)
})

test('a notifier that throws does not damage the finished task', async () => {
  const runner = runnerWith(async () => 'ok', { notify: () => { throw new Error('no notifier') } })
  const { id } = runner.start('t')
  await until(() => runner.get(id)?.status === 'done', 'lands')
  assert.equal(runner.get(id).result, 'ok')
})

test('a failed task notifies too — a silent failure is the worst outcome', async () => {
  const seen = []
  const runner = runnerWith(async () => { throw new Error('nope') }, { notify: (t) => seen.push(t) })
  runner.start('t')
  await until(() => seen.length === 1, 'the failure notification fires')
  assert.match(seen[0], /error/)
})

// ── presentation ────────────────────────────────────────────────────────────

test('a running task shows elapsed time, a finished one shows its answer', () => {
  const now = 100_000
  const running = formatTaskLine(rec({ id: 'tr', status: 'running', startedAt: now - 90_000, endedAt: undefined }), now)
  assert.match(running, /⏳/)
  assert.match(running, /so far/)
  const done = formatTaskLine(rec({ id: 'td', status: 'done', startedAt: 0, endedAt: 5000, result: 'all green' }), now)
  assert.match(done, /✅/)
  assert.match(done, /all green/)
})

test('every status has an icon — an unlabelled row is unreadable in a list', () => {
  for (const status of ['running', 'done', 'error', 'cancelled', 'interrupted']) {
    const line = formatTaskLine(rec({ status }))
    assert.ok(!line.startsWith('•'), `${status} needs its own icon`)
    assert.match(line, new RegExp(status))
  }
})

test('an empty list explains how to start one', () => {
  assert.match(summarizeTasks([]), /use_tasks start/)
})

test('multi-line prompts and results stay one line each', () => {
  const line = formatTaskLine(rec({ prompt: 'a\nb\nc', result: 'x\ny' }))
  assert.equal(line.split('\n').length, 2, 'header + one result line')
})

// ── the tool surface ────────────────────────────────────────────────────────

test('use_tasks start returns the id and tells the model to say it out loud', async () => {
  const runner = runnerWith(() => new Promise(() => {}), { timeoutMs: 100 })
  const t = makeTasksTool(runner)
  const out = await t.invoke({ action: 'start', prompt: 'reindex my notes' })
  assert.match(out, /started task t\d+/)
  assert.match(out, /tell the user the id/i)
  assert.equal(runner.list().length, 1)
})

test('use_tasks result refuses a bad id and reports a still-running one honestly', async () => {
  const runner = runnerWith(() => new Promise(() => {}), { timeoutMs: 100 })
  const t = makeTasksTool(runner)
  assert.match(await t.invoke({ action: 'result' }), /need a task id/)
  assert.match(await t.invoke({ action: 'result', id: '../etc/passwd' }), /need a task id/)
  assert.match(await t.invoke({ action: 'result', id: 'tmissing' }), /no such task/)
  const { id } = runner.start('slow')
  assert.match(await t.invoke({ action: 'result', id }), /still running/)
})

test('use_tasks result returns the full answer once it exists', async () => {
  const runner = runnerWith(async () => 'line one\nline two')
  const t = makeTasksTool(runner)
  const { id } = runner.start('t')
  await until(() => runner.get(id)?.status === 'done', 'lands')
  const out = await t.invoke({ action: 'result', id })
  assert.match(out, /line one\nline two/, 'the FULL result, not the one-line summary')
})

test('use_tasks list and an unknown action', async () => {
  const runner = runnerWith(async () => 'x')
  const t = makeTasksTool(runner)
  assert.match(await t.invoke({ action: 'list' }), /no background tasks/)
  assert.match(await t.invoke({ action: 'explode' }), /unknown action/)
  assert.match(await t.invoke({}), /no background tasks/, 'defaults to the harmless action')
})

test('the description tells the model WHEN to reach for a task', () => {
  // Without the timeout rationale the model runs the 10-minute job inline and
  // the caller abandons it half-done — the exact bug this feature exists for.
  assert.match(TASKS_DESCRIPTION, /45s|timeout/)
  assert.match(TASKS_DESCRIPTION, /returns a task id immediately/)
  assert.match(TASKS_DESCRIPTION, /injected into your next turn/i)
  assert.equal(TASK_TIMEOUT_MS, 900_000)
})

// ── depth 1 ─────────────────────────────────────────────────────────────────

test('a background agent gets NO use_tasks, and use_tasks stays reserved anyway', async () => {
  // Recursion here isn't a slow loop, it's an invisible fan-out: nobody reads a
  // task's output, so the only symptom of a runaway is the user's fan. The name
  // stays reserved in background mode too — a local tool that means one thing in
  // the foreground and another inside a task is worse than an unavailable name.
  const { TinyAgent } = await import('../dist/agent/agent.js')
  const bg = new TinyAgent({ api: { authenticated: false }, printer: false, background: true })
  assert.equal(bg.tasks, null, 'a background agent owns no runner')

  const src = readFileSync(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  assert.match(src, /if \(!this\.opts\.background\)/, 'the guard is a construction-time branch, not a runtime check')
  assert.match(src, /'use_tools', 'use_tasks'/, 'both names reserved regardless of mode')
})
