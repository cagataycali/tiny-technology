/**
 * 🌙 Ambient mode (devduck port) — the semantics that make it trustworthy:
 *
 *  1. Standard mode WAITS for idle; autonomous doesn't.
 *  2. Findings inject exactly once (drain), and typing DISCARDS the
 *     in-flight thought instead of injecting half of one later.
 *  3. It never overlaps the foreground agent, never spins on errors
 *     (cooldown applies to failures too), and respects iteration caps.
 *  4. '[AMBIENT_DONE]' stops autonomous mode and keeps the final result.
 *
 * The clock and the tick are injected — no timers, no sleeps, no flakes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { AmbientMode, hasCompletionSignal, COMPLETION_SIGNALS } =
  await import('../dist/agent/ambient.js')

/** An ambient with a driveable clock and a scripted agent. */
function make({ answers = ['finding'], busy = () => false, opts = {} } = {}) {
  let t = 0
  const calls = []
  const a = new AmbientMode({
    invoke: async (prompt) => { calls.push(prompt); return answers[Math.min(calls.length - 1, answers.length - 1)] },
    busy,
    log: () => {},
    idleThresholdMs: 30_000,
    cooldownMs: 60_000,
    maxIterations: 3,
    autonomousCooldownMs: 10_000,
    autonomousMaxIterations: 5,
    now: () => t,
    ...opts,
  })
  return { a, calls, advance: (ms) => { t += ms } }
}

test('standard: no run before the idle threshold', async () => {
  const { a, calls, advance } = make()
  a.running = true // drive tick() directly; start() would arm a real interval
  a.recordInteraction('research zenoh')
  advance(10_000)
  await a.tick()
  assert.equal(calls.length, 0)
})

test('standard: runs after idle, stores a finding, drains exactly once', async () => {
  const { a, calls, advance } = make({ answers: ['deep insight'] })
  a.running = true
  a.recordInteraction('research zenoh')
  advance(61_000) // past idle AND cooldown
  await a.tick()
  assert.equal(calls.length, 1)
  const injected = a.getAndClearFindings()
  assert.match(injected, /deep insight/)
  assert.equal(a.getAndClearFindings(), '') // drained — never re-injected
})

test('standard: cooldown gates consecutive runs; iteration cap holds', async () => {
  const { a, calls, advance } = make()
  a.running = true
  a.recordInteraction('topic')
  advance(61_000); await a.tick()
  await a.tick() // same instant — cooldown not elapsed
  assert.equal(calls.length, 1)
  advance(61_000); await a.tick()
  advance(61_000); await a.tick()
  advance(61_000); await a.tick() // 4th attempt — over maxIterations 3
  assert.equal(calls.length, 3)
})

test('a new interaction resets standard iterations and clears stale findings', async () => {
  const { a, advance } = make()
  a.running = true
  a.recordInteraction('old topic')
  advance(61_000); await a.tick()
  assert.equal(a.findings.length, 1)
  a.recordInteraction('new topic') // stale exploration of the old topic is dropped
  assert.equal(a.findings.length, 0)
  assert.equal(a.iterations, 0)
})

test('interrupt() discards the in-flight result — half a thought is not injected', async () => {
  let resolveInvoke
  const a = new AmbientMode({
    invoke: () => new Promise((res) => { resolveInvoke = res }),
    log: () => {},
    idleThresholdMs: 0, cooldownMs: 0, maxIterations: 3,
    now: (() => { let t = 1; return () => (t += 1000) })(),
  })
  a.running = true
  a.recordInteraction('topic')
  const running = a.tick()
  a.interrupt()              // user started typing mid-thought
  resolveInvoke('too late')
  await running
  assert.equal(a.findings.length, 0)
})

test('never overlaps the foreground agent', async () => {
  const { a, calls, advance } = make({ busy: () => true })
  a.running = true
  a.recordInteraction('topic')
  advance(61_000)
  await a.tick()
  assert.equal(calls.length, 0)
})

test('an erroring run honors the cooldown — no hot spin', async () => {
  let t = 0
  let attempts = 0
  const a = new AmbientMode({
    invoke: async () => { attempts++; throw new Error('model down') },
    log: () => {},
    idleThresholdMs: 0, cooldownMs: 60_000, maxIterations: 3,
    now: () => t,
  })
  a.running = true
  a.recordInteraction('topic')
  t = 61_000; await a.tick()
  await a.tick() // immediately again — cooldown must gate the retry
  assert.equal(attempts, 1)
})

test('autonomous: ignores idle, [AMBIENT_DONE] stops and keeps the final result', async () => {
  const { a, calls, advance } = make({ answers: ['progress', 'all wrapped up [AMBIENT_DONE]'] })
  a.running = true; a.autonomous = true
  a.recordInteraction('build the thing')
  advance(10_001); await a.tick()   // no idle wait in autonomous
  assert.equal(calls.length, 1)
  advance(10_001); await a.tick()
  assert.equal(calls.length, 2)
  assert.equal(a.running, false)    // completion signal stopped the loop
  assert.match(a.getAndClearFindings(), /final iteration/)
})

test('autonomous survives recordInteraction without resetting (one continuous job)', async () => {
  const { a, advance } = make()
  a.running = true; a.autonomous = true
  a.recordInteraction('task')
  advance(10_001); await a.tick()
  assert.equal(a.iterations, 1)
  a.recordInteraction('checking in') // user talks mid-job
  assert.equal(a.iterations, 1)      // NOT reset
  assert.equal(a.findings.length, 1) // NOT cleared
})

test('completion signals match case-insensitively, all forms', () => {
  for (const s of COMPLETION_SIGNALS) {
    assert.equal(hasCompletionSignal(`blah ${s.toUpperCase()} blah`), true)
  }
  assert.equal(hasCompletionSignal('still working on it'), false)
})
