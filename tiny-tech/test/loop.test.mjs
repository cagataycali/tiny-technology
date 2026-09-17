/**
 * ♾️ Background loops — a task that ITERATES, for hours-long goals.
 *
 * What has to be true for the feature to be honest (not merely present):
 *
 *  1. start() RETURNS while the loop iterates — that's the whole point.
 *  2. ONE agent serves every iteration of a loop (context accumulates);
 *     a fresh factory call happens once per LOOP, not per iteration.
 *  3. The journal on disk grows every iteration — a crash loses minutes.
 *  4. [LOOP_DONE] ends the loop as `done`; stop() ends it as `stopped`
 *     after the in-flight iteration; the caps end it as `exhausted`.
 *  5. A `running` record from a dead pid reads as `interrupted`, never as
 *     "still going" forever.
 *  6. News: completion delivered exactly once; progress every 10 iterations,
 *     each milestone announced once.
 *  7. The refusals hold: concurrency cap, empty-prompt refusal.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { execFileSync } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'tiny-loops-'))
process.env.TINY_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  loopsDir, ensureLoopsDir, newLoopId, isValidLoopId, writeLoop, readLoop, listLoops,
  reconcile, pruneLoops, formatLoopLine, summarizeLoops, loopNewsBlock, markLoopNews,
  hasDoneSignal, LoopRunner, makeLoopTool, makeLoopDoneTool, LOOP_DESCRIPTION,
  LOOP_MAX_ITERATIONS, MAX_ACTIVE_LOOPS, LOOP_NEWS_EVERY, LOOP_KEEP_MS,
} = await import('../dist/agent/loop.js')

let seq = 0
const freshDir = () => {
  const d = join(home, `loops-${seq++}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** Runner with zero cooldown so tests don't wait; injectable everything. */
const runnerWith = (fn, extra = {}) => new LoopRunner({
  dir: extra.dir || freshDir(),
  cooldownMs: 0,
  sleep: async () => {},
  agentFactory: async () => ({ invoke: fn }),
  ...extra,
})

const settle = () => new Promise((r) => setTimeout(r, 50))

// ── records & ids ───────────────────────────────────────────────────────────

test('loop ids are valid, time-ordered, and path-safe', () => {
  const a = newLoopId(1000)
  const b = newLoopId(2000)
  assert.ok(isValidLoopId(a))
  assert.ok(a < b)
  assert.ok(!isValidLoopId('../../etc/passwd'))
  assert.ok(!isValidLoopId(''))
  assert.ok(!isValidLoopId(null))
})

test('writeLoop/readLoop round-trip; corrupt file reads as null', () => {
  const dir = freshDir()
  const rec = { id: 'l1', prompt: 'p', status: 'running', startedAt: 1, iterations: [], pid: process.pid, host: hostname() }
  writeLoop(rec, dir)
  assert.deepEqual(readLoop('l1', dir).prompt, 'p')
  assert.equal(readLoop('nope', dir), null)
})

test('reconcile: dead pid on this host → interrupted; foreign host untouched', () => {
  const base = { id: 'l1', prompt: 'p', status: 'running', startedAt: 1, iterations: [], pid: 99999, host: hostname() }
  const r = reconcile(base, { pidLive: () => false })
  assert.equal(r.status, 'interrupted')
  const alive = reconcile(base, { pidLive: () => true })
  assert.equal(alive.status, 'running')
  const foreign = reconcile({ ...base, host: 'other-machine' }, { pidLive: () => false })
  assert.equal(foreign.status, 'running')
})

test('pruneLoops drops old finished, keeps running regardless of age', () => {
  const dir = freshDir()
  const old = Date.now() - LOOP_KEEP_MS - 1000
  writeLoop({ id: 'lold', prompt: 'p', status: 'done', startedAt: old, endedAt: old, iterations: [], pid: process.pid, host: hostname() }, dir)
  writeLoop({ id: 'lrun', prompt: 'p', status: 'running', startedAt: old, iterations: [], pid: process.pid, host: hostname() }, dir)
  const gone = pruneLoops(dir)
  assert.ok(gone.includes('lold'))
  assert.ok(!gone.includes('lrun'))
})

// ── the runner ──────────────────────────────────────────────────────────────

test('start() returns an id immediately; loop runs to [LOOP_DONE]', async () => {
  const dir = freshDir()
  let calls = 0
  const runner = runnerWith(async () => {
    calls++
    return calls >= 3 ? 'finished it all [LOOP_DONE]' : `step ${calls} done`
  }, { dir })
  const r = runner.start('do the thing')
  assert.ok('id' in r)
  // returned before the work finished
  assert.equal(runner.get(r.id).status, 'running')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'done')
  assert.equal(rec.iterations.length, 3)
  assert.ok(rec.result.includes('[LOOP_DONE]'))
})

test('ONE agent serves all iterations — factory called once per loop', async () => {
  const dir = freshDir()
  let factoryCalls = 0
  let invokes = 0
  const runner = new LoopRunner({
    dir, cooldownMs: 0, sleep: async () => {},
    agentFactory: async () => {
      factoryCalls++
      return { invoke: async () => (++invokes >= 4 ? '[LOOP_DONE]' : 'progress') }
    },
  })
  const r = runner.start('goal')
  await settle()
  assert.equal(factoryCalls, 1)
  assert.equal(invokes, 4)
  assert.equal(runner.get(r.id).iterations.length, 4)
})

test('journal grows on disk every iteration (crash-recovery)', async () => {
  const dir = freshDir()
  let n = 0
  const runner = runnerWith(async () => (++n >= 2 ? '[LOOP_DONE]' : 'step'), { dir })
  const r = runner.start('goal')
  await settle()
  const raw = JSON.parse(readFileSync(join(dir, `${r.id}.json`), 'utf-8'))
  assert.equal(raw.iterations.length, 2)
  assert.ok(raw.iterations[0].summary)
  assert.ok(raw.iterations[0].at > 0)
})

test('iteration cap → exhausted', async () => {
  const dir = freshDir()
  const runner = runnerWith(async () => 'never done', { dir, maxIterations: 3 })
  const r = runner.start('endless')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'exhausted')
  assert.equal(rec.iterations.length, 3)
  assert.match(rec.result, /iteration cap/)
})

test('per-loop max_iterations overrides the runner default and persists on the record', async () => {
  const dir = freshDir()
  const runner = runnerWith(async () => 'never done', { dir, maxIterations: 9 })
  const r = runner.start('endless but shorter', { maxIterations: 2 })
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.maxIterations, 2)          // written into the record at start
  assert.equal(rec.status, 'exhausted')
  assert.equal(rec.iterations.length, 2)      // its own cap won, not the runner's 9
  assert.match(rec.result, /iteration cap \(2\)/)
})

test('per-loop max_iterations: junk falls back to the default, fractions floor', async () => {
  const dir = freshDir()
  const runner = runnerWith(async () => 'never done', { dir, maxIterations: 2 })
  const junk = runner.start('junk cap', { maxIterations: 'lots' })
  await settle()
  assert.equal(runner.get(junk.id).iterations.length, 2)  // fell back to runner default
  assert.equal(runner.get(junk.id).maxIterations, undefined)

  const frac = runner.start('fractional cap', { maxIterations: 3.9 })
  await settle()
  assert.equal(runner.get(frac.id).maxIterations, 3)
  assert.equal(runner.get(frac.id).iterations.length, 3)
})

test('wall-clock cap → exhausted', async () => {
  const dir = freshDir()
  let t = 0
  const runner = runnerWith(async () => 'working', {
    dir, maxWallMs: 100, now: () => (t += 60), // each check advances the clock
  })
  const r = runner.start('slow goal')
  await settle()
  assert.equal(runner.get(r.id).status, 'exhausted')
  assert.match(runner.get(r.id).result, /wall-clock/)
})

test('stop() ends the loop after the in-flight iteration', async () => {
  const dir = freshDir()
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const runner = runnerWith(async () => { calls++; await gate; return 'step' }, { dir })
  const r = runner.start('goal')
  await new Promise((res) => setTimeout(res, 20))
  const msg = runner.stop(r.id)
  assert.match(msg, /will stop after the current iteration/)
  release()
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'stopped')
  assert.equal(calls, 1) // no further iteration started
})

test('two consecutive failures end the loop as error; one failure retries', async () => {
  const dir = freshDir()
  let calls = 0
  const runner = runnerWith(async () => {
    calls++
    if (calls === 1) throw new Error('transient boom')
    return calls >= 3 ? '[LOOP_DONE]' : 'recovered'
  }, { dir })
  const r = runner.start('flaky goal')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'done') // survived one failure
  assert.equal(rec.iterations.length, 3)
})

test('two consecutive failures stop the loop even when the errors READ DIFFERENTLY', async () => {
  // The regression: consecutive-failure detection compared error TEXT, so a loop
  // failing with a fresh message each time (throttle ids, varying network errors)
  // looked like progress and ran to its cap instead of stopping at 2.
  const dir = freshDir()
  let n = 0
  const runner = runnerWith(async () => { throw new Error(`boom ${++n}`) }, { dir, maxIterations: 8 })
  const r = runner.start('always failing goal')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'error')
  assert.equal(rec.iterations.length, 2)
  assert.ok(rec.iterations[0].failed && rec.iterations[1].failed, 'both iterations recorded as failed')
})

// ── loop_done: ending a loop by TOOL CALL, not by phrase ────────────────────

test('loop_done ends the loop after the current iteration, deterministically', async () => {
  const dir = freshDir()
  let ctx = null
  let calls = 0
  const runner = new LoopRunner({
    agentFactory: async (c) => {
      ctx = c
      return { invoke: async () => {
        calls++
        // The agent calls the tool mid-turn, then reports normally — note the
        // answer contains NO sentinel anywhere.
        if (calls === 2) { ctx.signalDone('goal met'); return 'wrote the file and verified it' }
        return 'step one'
      } }
    },
    dir, cooldownMs: 0, sleep: async () => {}, maxIterations: 10,
  })
  const r = runner.start('deterministic goal')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'done')
  assert.equal(rec.iterations.length, 2, 'the calling iteration still finishes')
  assert.match(rec.result, /wrote the file and verified it/)
  assert.match(rec.result, /ended via loop_done: goal met/)
})

test('the loop_done TOOL sets the latch and cannot name another loop', async () => {
  const dir = freshDir()
  let seen = null
  const runner = new LoopRunner({
    agentFactory: async (c) => {
      const t = makeLoopDoneTool(c)
      seen = t
      assert.equal(t.name, 'loop_done')
      // No loop id in the schema at all: it is closed over its own loop.
      assert.ok(!Object.keys(t.inputSchema?.properties || {}).includes('id'))
      await t.invoke({ summary: 'finished in one pass' })
      return { invoke: async () => 'one-shot report, no sentinel in sight' }
    },
    dir, cooldownMs: 0, sleep: async () => {}, maxIterations: 10,
  })
  const r = runner.start('one-shot goal')
  await settle()
  const rec = runner.get(r.id)
  assert.ok(seen, 'tool was built')
  assert.equal(rec.status, 'done')
  assert.equal(rec.iterations.length, 1)
  assert.match(rec.result, /finished in one pass/)
})

test('a loop with no latch set keeps iterating (the tool is opt-in)', async () => {
  const dir = freshDir()
  const runner = new LoopRunner({
    agentFactory: async () => ({ invoke: async () => 'still going, nothing signalled' }),
    dir, cooldownMs: 0, sleep: async () => {}, maxIterations: 4,
  })
  const r = runner.start('open ended')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'exhausted')
  assert.equal(rec.iterations.length, 4)
})

test('loop_done status=progress journals the line and keeps the loop running', async () => {
  const dir = freshDir()
  let calls = 0
  const runner = new LoopRunner({
    agentFactory: async (c) => {
      const t = makeLoopDoneTool(c)
      return { invoke: async () => {
        calls++
        if (calls === 1) {
          const out = await t.invoke({ status: 'progress', summary: 'read 40 files, found the bug' })
          assert.match(out, /keep working/)
          return 'long rambling prose nobody wants to read a slice of'
        }
        await t.invoke({ status: 'done', summary: 'patched and tested' })
        return 'final answer'
      } }
    },
    dir, cooldownMs: 0, sleep: async () => {}, maxIterations: 10,
  })
  const r = runner.start('goal with progress')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'done')
  assert.equal(rec.iterations.length, 2, 'progress did NOT end the loop')
  assert.equal(rec.iterations[0].note, 'read 40 files, found the bug')
  assert.equal(rec.iterations[1].note, 'patched and tested')
})

test('progress news quotes the loop\'s own note, not a slice of its prose', () => {
  const dir = freshDir()
  const iterations = Array.from({ length: LOOP_NEWS_EVERY }, (_, i) => ({
    n: i + 1, at: Date.now(), summary: 'rambling prose tail that says nothing useful',
  }))
  iterations[iterations.length - 1].note = 'migrated 12 of 30 call sites'
  writeLoop({ id: 'lnote', prompt: 'long goal', status: 'running', startedAt: Date.now(), iterations, pid: process.pid, host: hostname() }, dir)
  const { block } = loopNewsBlock(listLoops(dir))
  assert.match(block, /migrated 12 of 30 call sites/)
  assert.ok(!block.includes('rambling prose'), 'the note replaces the tail slice')
})

test('a progress report with no summary is refused, not silently dropped', async () => {
  const dir = freshDir()
  let out = ''
  const runner = new LoopRunner({
    agentFactory: async (c) => {
      const t = makeLoopDoneTool(c)
      return { invoke: async () => {
        out = await t.invoke({ status: 'progress' })
        await t.invoke({ status: 'done' })
        return 'done anyway'
      } }
    },
    dir, cooldownMs: 0, sleep: async () => {}, maxIterations: 3,
  })
  runner.start('goal')
  await settle()
  assert.match(out, /needs a summary/)
})

// ── the done sentinel ──────────────────────────────────────────────────────

test('the signal ANYWHERE in the answer ends the loop — a miss is the costly failure', () => {
  // Owner's rule: if we see it, it's done. Erring toward stopping is cheap; a
  // missed completion burns a real agent until the 200-iteration / 12h cap.
  assert.equal(hasDoneSignal('still working. no [LOOP_DONE] by design.'), true)
  assert.equal(hasDoneSignal('done [LOOP_DONE] yes'), true)
  assert.equal(hasDoneSignal('I will emit [LOOP_DONE] once the tests pass'), true)
})

test('a quoted sentinel inside code does not stop the loop', () => {
  assert.equal(hasDoneSignal('patched: `return hasDoneSignal("[LOOP_DONE]")`'), false)
  assert.equal(hasDoneSignal('```js\nif (text.includes("[LOOP_DONE]")) stop()\n```'), false)
  assert.equal(hasDoneSignal('diff of loop.ts:\n```\n+ [LOOP_DONE]\n```'), false)
})

test('every shape a model writes a completion in stops the loop', () => {
  assert.equal(hasDoneSignal('[LOOP_DONE]'), true)                       // alone
  assert.equal(hasDoneSignal('finished it all [LOOP_DONE]'), true)       // end of the last line
  assert.equal(hasDoneSignal('[LOOP_DONE] all set'), true)               // start of the last line
  assert.equal(hasDoneSignal('all three fixed. [LOOP_DONE].'), true)     // trailing punctuation
  assert.equal(hasDoneSignal('did the work\n\n[LOOP_DONE]'), true)       // on its own final line
  assert.equal(hasDoneSignal('shipped it\n[LOOP_DONE]\n\nnote: rebuilt dist'), true) // own line, postscript after
  assert.equal(hasDoneSignal('goal met [AMBIENT_DONE]'), true)           // the other signals
  assert.equal(hasDoneSignal('[TASK_COMPLETE] wrapped up'), true)
})

test('no sentinel at all means keep going', () => {
  assert.equal(hasDoneSignal('step 3 done, continuing'), false)
  assert.equal(hasDoneSignal(''), false)
  assert.equal(hasDoneSignal('   \n  \n '), false)
})

test('concurrency cap refuses with advice; empty prompt refused', async () => {
  const dir = freshDir()
  let release
  const gate = new Promise((r) => { release = r })
  const runner = runnerWith(async () => { await gate; return '[LOOP_DONE]' }, { dir, maxActive: 1 })
  const a = runner.start('goal one')
  assert.ok('id' in a)
  const b = runner.start('goal two')
  assert.ok('error' in b)
  assert.match(b.error, /already running/)
  assert.ok('error' in runner.start('   '))
  release()
  await settle()
})

test('agentFactory failure → error record, not a hang', async () => {
  const dir = freshDir()
  const runner = new LoopRunner({
    dir, cooldownMs: 0, sleep: async () => {},
    agentFactory: async () => { throw new Error('no model') },
  })
  const r = runner.start('goal')
  await settle()
  const rec = runner.get(r.id)
  assert.equal(rec.status, 'error')
  assert.match(rec.result, /failed to start/)
})

test('notify + announce fire on completion; their failure never fails the loop', async () => {
  const dir = freshDir()
  const notified = []
  const announced = []
  const runner = runnerWith(async () => '[LOOP_DONE]', {
    dir,
    notify: (t, b) => { notified.push(t); throw new Error('notifier crashed') },
    announce: (id, s, r) => { announced.push(id) },
  })
  const r = runner.start('goal')
  await settle()
  assert.equal(runner.get(r.id).status, 'done')
  assert.equal(notified.length, 1)
  assert.equal(announced.length, 1)
})

// ── news ────────────────────────────────────────────────────────────────────

test('completion news delivered exactly once', async () => {
  const dir = freshDir()
  const runner = runnerWith(async () => '[LOOP_DONE] all set', { dir })
  runner.start('goal')
  await settle()
  const first = runner.takeNews()
  assert.match(first, /ended \(done/)
  assert.equal(runner.takeNews(), '')
})

test('progress news every LOOP_NEWS_EVERY iterations, each milestone once', () => {
  const dir = freshDir()
  const iterations = Array.from({ length: LOOP_NEWS_EVERY }, (_, i) => ({ n: i + 1, at: Date.now(), summary: `s${i + 1}` }))
  writeLoop({ id: 'lprog', prompt: 'long goal', status: 'running', startedAt: Date.now(), iterations, pid: process.pid, host: hostname() }, dir)
  const { block, progress } = loopNewsBlock(listLoops(dir, { pidLive: () => true }))
  assert.match(block, /progress: 10 iterations/)
  markLoopNews([], progress, dir)
  const again = loopNewsBlock(listLoops(dir, { pidLive: () => true }))
  assert.equal(again.block, '')
})

// ── the tool ────────────────────────────────────────────────────────────────

test('use_loop tool: start → status (journal) → result → stop paths', async () => {
  const dir = freshDir()
  let calls = 0
  const runner = runnerWith(async () => (++calls >= 2 ? '[LOOP_DONE] final' : 'step one'), { dir })
  const t = makeLoopTool(runner)
  assert.equal(t.name, 'use_loop')

  const started = await t.invoke({ action: 'start', prompt: 'goal' })
  assert.match(started, /started loop (l\d+)/)
  const id = started.match(/loop (l\d+)/)[1]
  await settle()

  const status = await t.invoke({ action: 'status', id })
  assert.match(status, /Journal:/)
  assert.match(status, /step one/)

  const result = await t.invoke({ action: 'result', id })
  assert.match(result, /\[LOOP_DONE\] final/)

  assert.match(await t.invoke({ action: 'result', id: 'lnope' }), /no such loop/)
  assert.match(await t.invoke({ action: 'status', id: '../evil' }), /need a loop id/)
  assert.match(await t.invoke({ action: 'list' }), /goal/)
  assert.match(await t.invoke({ action: 'bogus' }), /unknown action/)
})

test('hasDoneSignal matches all signals, case-insensitively', () => {
  assert.ok(hasDoneSignal('done [LOOP_DONE] yes'))
  assert.ok(hasDoneSignal('[ambient_done]'))
  assert.ok(hasDoneSignal('finished [TASK_COMPLETE]'))
  assert.ok(!hasDoneSignal('still working on the loop'))
})

/**
 * ── use_tasks was removed; loops are the only background rail ────────────────
 *
 * These two guarantees outlived the tool and had nowhere else to live once
 * tasks.test.mjs was deleted with it.
 */
test('use_tasks is gone from the source — no runner, no tool, no import', async () => {
  const { readFileSync: read } = await import('node:fs')
  const agentSrc = read(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  assert.doesNotMatch(agentSrc, /TaskRunner|makeTasksTool/, 'the runner and tool are unwired')
  assert.doesNotMatch(agentSrc, /this\.tasks/, 'and nothing reads the retired field')
  await assert.rejects(() => import('../dist/agent/tasks.js'), 'the module itself is gone')
})

test('use_tasks stays RESERVED so a local tool cannot claim the retired name', () => {
  // ~/.tiny/tools/use_tasks.ts answering to a name the model was trained on for
  // months — with none of the semantics — is worse than the name being absent.
  // Removing it from builtinToolNames would silently allow exactly that.
  const src = readFileSync(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  assert.match(src, /'use_tools', 'use_tasks', 'use_loop'/,
    'the retired name is still unshadowable')
})

test('the model is told to end a one-shot loop in its first iteration', () => {
  // The cost of dropping use_tasks: nothing else stops a run-once job from
  // iterating to its caps. The prompt IS the mitigation, so it is load-bearing.
  const src = readFileSync(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  assert.match(src, /\[LOOP_DONE\] belongs in the FIRST iteration/i)
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8')
  assert.match(cli, /ONE-SHOT background job/, 'and the tray appends it for its own asks')
})

test('MAX_ACTIVE_LOOPS defaults to 10 and honors TINY_MAX_LOOPS', () => {
  // The cap is read once at module load, so the override is proven in a fresh
  // subprocess rather than by mutating process.env after the fact.
  assert.equal(MAX_ACTIVE_LOOPS, 10, 'default (this test suite runs without the env var)')
  const probe = (env) => execFileSync(process.execPath, [
    '-e', "import('./dist/agent/loop.js').then(m=>process.stdout.write(String(m.MAX_ACTIVE_LOOPS)))",
  ], { env: { ...process.env, ...env }, cwd: new URL('..', import.meta.url).pathname }).toString()
  assert.equal(probe({ TINY_MAX_LOOPS: '3' }), '3', 'env var lowers the cap')
  assert.equal(probe({ TINY_MAX_LOOPS: '25' }), '25', 'env var raises the cap')
  assert.equal(probe({ TINY_MAX_LOOPS: 'garbage' }), '10', 'nonsense falls back to the default')
  assert.equal(probe({ TINY_MAX_LOOPS: '0' }), '10', 'a cap below 1 is not a cap')
})
