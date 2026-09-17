/**
 * The async child-process seam every long tool now shares.
 *
 * These tests are about the four properties that made execFileSync safe to
 * replace — if any of them silently regresses, the symptom is not a failing
 * tool, it is a frozen TUI or a wedged daemon:
 *
 *   1. the event loop keeps running while a child is alive (the whole point)
 *   2. the timeout still KILLS the child (npm.ts's bound on a wedged install)
 *   3. a failure still carries stdout/stderr (npm/pypi turn stderr into hints)
 *   4. stdin is closed even with no input (a child that reads it must not hang)
 */
import { test } from 'node:test'
import assert from 'node:assert'

const { run, timedOut } = await import('../dist/agent/exec.js')

const NODE = process.execPath

test('resolves stdout on success', async () => {
  const out = await run(NODE, ['-e', 'process.stdout.write("hello")'], { timeoutMs: 10_000 })
  assert.strictEqual(out, 'hello')
})

test('the event loop keeps running while the child does — the reason this file exists', async () => {
  let ticks = 0
  const beat = setInterval(() => { ticks += 1 }, 5)
  await run(NODE, ['-e', 'setTimeout(()=>{},120)'], { timeoutMs: 10_000 })
  clearInterval(beat)
  assert.ok(ticks >= 5, `expected the loop to tick during the child; got ${ticks}`)
})

test('two runs overlap instead of queueing — concurrent conversations depend on it', async () => {
  const started = Date.now()
  await Promise.all([
    run(NODE, ['-e', 'setTimeout(()=>{},150)'], { timeoutMs: 10_000 }),
    run(NODE, ['-e', 'setTimeout(()=>{},150)'], { timeoutMs: 10_000 }),
  ])
  const elapsed = Date.now() - started
  assert.ok(elapsed < 400, `two 150ms children should overlap, took ${elapsed}ms`)
})

test('a non-zero exit rejects with stdout AND stderr attached', async () => {
  const e = await run(NODE, ['-e', 'process.stdout.write("partial");process.stderr.write("boom");process.exit(3)'], { timeoutMs: 10_000 })
    .then(() => null, (err) => err)
  assert.ok(e, 'must reject')
  assert.strictEqual(e.stdout, 'partial')
  assert.strictEqual(e.stderr, 'boom')
  assert.strictEqual(e.code, 3)
  assert.ok(!timedOut(e), 'a real failure must not be reported as a timeout')
})

test('the timeout kills the child, and timedOut() names it', async () => {
  const started = Date.now()
  const e = await run(NODE, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 250 })
    .then(() => null, (err) => err)
  assert.ok(e, 'a child past its leash must reject')
  assert.ok(timedOut(e), `expected a kill, got signal=${e.signal} killed=${e.killed}`)
  assert.ok(Date.now() - started < 5_000, 'the kill must be prompt, not the child finishing')
})

test('stdin is CLOSED with no input — a child reading it finishes instead of hanging', async () => {
  // Reads stdin to EOF: under an open pipe this never resolves and the run
  // would fail on its timeout instead. The short leash proves which happened.
  const out = await run(NODE, [
    '-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("eof:"+d.length))',
  ], { timeoutMs: 3_000 })
  assert.strictEqual(out, 'eof:0')
})

test('a child that exits before stdin closes does not kill this process', async () => {
  // The failure this pins down was NOT a rejected promise: closing the pipe of
  // an already-exited child raises EPIPE asynchronously on the stream, and with
  // no 'error' listener Node promotes it to an uncaught exception — which took
  // down a whole test process (and would take down the daemon) over a child
  // that merely answered fast. Found in the wild: `xattr -px` on a file with no
  // such attribute exits in about a millisecond.
  //
  // 40 of them, because the race needs the child to win, and it usually does.
  const runs = await Promise.all(Array.from({ length: 40 }, () =>
    run(NODE, ['-e', 'process.stdout.write("fast");process.exit(0)'], { timeoutMs: 5_000 })
      .catch((e) => `rejected: ${e.message}`)))
  for (const out of runs) assert.strictEqual(out, 'fast')
})

test('input the child never reads does not kill this process either', async () => {
  // The deterministic version of the test above. 2 MB is past the ~64 KB pipe
  // buffer, so the write CANNOT finish before the child exits — EPIPE is
  // guaranteed rather than raced. Verified by deleting the one-line 'error'
  // listener from exec.js: this test takes the whole process down with
  // `Unhandled 'error' event … write EPIPE`, exit code 1, no test results at all.
  const outs = await Promise.all(Array.from({ length: 8 }, () =>
    run(NODE, ['-e', 'process.stdout.write("fast");process.exit(0)'],
      { timeoutMs: 5_000, input: 'x'.repeat(2 * 1024 * 1024) })
      .catch((e) => `rejected: ${e.code}`)))
  for (const out of outs) assert.strictEqual(out, 'fast')
})

test('input reaches the child on stdin', async () => {
  const out = await run(NODE, [
    '-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))',
  ], { timeoutMs: 10_000, input: 'spoken text' })
  assert.strictEqual(out, 'SPOKEN TEXT')
})

test('cwd and env reach the child — the sandbox and venv rely on both', async () => {
  const cwd = await run(NODE, ['-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 10_000, cwd: process.cwd() })
  assert.strictEqual(cwd, process.cwd())
  const env = await run(NODE, ['-e', 'process.stdout.write(String(process.env.TINY_PROBE))'], {
    timeoutMs: 10_000, env: { ...process.env, TINY_PROBE: 'set' },
  })
  assert.strictEqual(env, 'set')
})

test('a missing binary rejects instead of throwing synchronously', async () => {
  const e = await run('tiny-definitely-not-a-binary-9f3a', [], { timeoutMs: 5_000 }).then(() => null, (err) => err)
  assert.ok(e instanceof Error)
  assert.ok(!timedOut(e))
})

test('never a shell — an argument that looks like one is data', async () => {
  const out = await run(NODE, ['-e', 'process.stdout.write(process.argv[1]||"")', '; rm -rf /'], { timeoutMs: 10_000 })
  assert.strictEqual(out, '; rm -rf /', 'the metacharacters arrived as an argument, unexecuted')
})

test('timedOut ignores errors that are not kills', () => {
  assert.ok(!timedOut(undefined))
  assert.ok(!timedOut(new Error('plain')))
  assert.ok(!timedOut({ signal: 'SIGTERM' }), 'a signal without killed is not our timeout')
  assert.ok(timedOut({ killed: true, signal: 'SIGTERM' }))
})
