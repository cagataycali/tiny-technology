/**
 * ⭐ spawn_agents — parallel sub-agents (web tool semantics, local plumbing).
 *
 * What has to be true for the port to be honest:
 *
 *  1. Schema refuses bad input with a SENTENCE (0 tasks, >5 tasks, empty
 *     task) — a refusal teaches the model; a thrown error ends the turn.
 *  2. Tasks run CONCURRENTLY, each on its OWN fresh agent, and results land
 *     in task order regardless of finish order.
 *  3. A failed task is a ❌ section — never a thrown batch.
 *  4. Aggregation shares the budget FAIRLY: one talkative sub-agent cannot
 *     evict its siblings from the aggregate.
 *  5. wait:false returns a ticket immediately and delivers the aggregate
 *     exactly once through notify + announce + a history notice.
 *  6. The name is reserved in agent.ts even where the tool is unregistered,
 *     and registration is foreground-only (depth 1 by construction).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-spawn-'))
process.env.TINY_HOME = home
// history.js computes ~/.tiny_history from os.homedir() at module load, which
// reads $HOME on POSIX — set it BEFORE the dist import so the wait:false
// history notice lands in the temp dir, never the developer's real history.
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  batchTicket, buildBatchResultText, validateTasks, runSpawnBatch,
  makeSpawnAgentsTool, SPAWN_MAX_TASKS, SPAWN_RESULT_BUDGET, SPAWN_DESCRIPTION,
} = await import('../dist/agent/spawn-tools.js')

const settle = () => new Promise((r) => setTimeout(r, 50))

// ── schema / validation ──────────────────────────────────────────────────────

test('validateTasks: accepts 1..MAX non-empty strings, trims them', () => {
  const ok = validateTasks(['  research A  ', 'research B'])
  assert.ok('tasks' in ok)
  assert.deepEqual(ok.tasks, ['research A', 'research B'])
})

test('validateTasks: refusals are sentences, not exceptions', () => {
  assert.match(validateTasks(undefined).error, /non-empty array/)
  assert.match(validateTasks([]).error, /non-empty array/)
  assert.match(validateTasks('do stuff').error, /non-empty array/)
  const six = Array.from({ length: SPAWN_MAX_TASKS + 1 }, (_, i) => `t${i}`)
  assert.match(validateTasks(six).error, new RegExp(`max ${SPAWN_MAX_TASKS}`))
  assert.match(validateTasks(['fine', '   ']).error, /task 2 is empty/)
  assert.match(validateTasks(['fine', 42]).error, /task 2 is empty/)
})

test('the tool itself refuses bad input via the callback (no throw)', async () => {
  const t = makeSpawnAgentsTool({ agentFactory: async () => ({ invoke: async () => 'x' }) })
  assert.equal(t.name, 'spawn_agents')
  const r = await t.invoke({ tasks: [] })
  assert.match(String(r), /non-empty array/)
})

// ── aggregation (pure) ───────────────────────────────────────────────────────

test('buildBatchResultText: header counts, ✅/❌ markers, task order', () => {
  const text = buildBatchResultText([
    { task: 1, ok: true, result: 'alpha' },
    { task: 2, ok: false, error: 'boom' },
    { task: 3, ok: true, result: 'gamma' },
  ], 4200)
  assert.match(text, /^🤖 Agent batch finished: 2\/3 tasks completed in 4s\./)
  assert.match(text, /✅ Task 1:\nalpha/)
  assert.match(text, /❌ Task 2: boom/)
  assert.match(text, /✅ Task 3:\ngamma/)
  assert.ok(text.indexOf('Task 1') < text.indexOf('Task 2'))
  assert.ok(text.indexOf('Task 2') < text.indexOf('Task 3'))
})

test('budget is shared fairly — a talkative task cannot evict its siblings', () => {
  const loud = 'x'.repeat(SPAWN_RESULT_BUDGET * 2)
  const text = buildBatchResultText([
    { task: 1, ok: true, result: loud },
    { task: 2, ok: true, result: 'the quiet answer survives' },
    { task: 3, ok: true, result: 'so does this one' },
  ], 1000)
  assert.ok(text.length <= SPAWN_RESULT_BUDGET)
  assert.match(text, /the quiet answer survives/)
  assert.match(text, /so does this one/)
})

test('error text is capped so a stack trace cannot flood the aggregate', () => {
  const text = buildBatchResultText([
    { task: 1, ok: false, error: 'e'.repeat(5000) },
    { task: 2, ok: true, result: 'fine' },
  ], 1000)
  assert.match(text, /fine/)
  assert.ok(text.indexOf('fine') < SPAWN_RESULT_BUDGET)
  assert.ok(/❌ Task 1: e{200}[^e]/.test(text.replace(/\n/g, ' ')))
})

test('batchTicket: namespaced, unique', () => {
  const a = batchTicket()
  const b = batchTicket()
  assert.match(a, /^batch_/)
  assert.notEqual(a, b)
})

// ── concurrency (fake agents, loop.test.mjs harness pattern) ────────────────

test('tasks run CONCURRENTLY on fresh agents; results in task order', async () => {
  let live = 0
  let peak = 0
  const factories = []
  const factory = async (i) => {
    factories.push(i)
    return {
      invoke: async (prompt) => {
        live++; peak = Math.max(peak, live)
        // task 1 finishes LAST so completion order ≠ task order
        await new Promise((r) => setTimeout(r, i === 0 ? 60 : 10))
        live--
        return `answer ${i + 1} to: ${prompt.slice(-20)}`
      },
    }
  }
  const { results, elapsedMs } = await runSpawnBatch(['a', 'b', 'c'], factory)
  assert.equal(peak, 3, 'all three ran at once')
  assert.deepEqual(factories.sort(), [0, 1, 2], 'one fresh agent per task')
  assert.deepEqual(results.map((r) => r.task), [1, 2, 3], 'task order regardless of finish order')
  assert.ok(results.every((r) => r.ok))
  assert.ok(elapsedMs < 200, 'parallel, not serial (serial would be ≥80ms anyway; this guards pathology)')
})

test('a failed task is a ❌ result — never a thrown batch', async () => {
  const factory = async (i) => ({
    invoke: async () => {
      if (i === 1) throw new Error('sub-agent exploded')
      return 'ok'
    },
  })
  const { results } = await runSpawnBatch(['a', 'b', 'c'], factory)
  assert.deepEqual(results.map((r) => r.ok), [true, false, true])
  assert.match(results[1].error, /sub-agent exploded/)
})

test('a factory that fails to build is that task\'s failure, not the batch\'s', async () => {
  const factory = async (i) => {
    if (i === 0) throw new Error('no model')
    return { invoke: async () => 'fine' }
  }
  const { results } = await runSpawnBatch(['a', 'b'], factory)
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /no model/)
  assert.equal(results[1].ok, true)
})

test('a hung task times out as ❌ while its siblings complete', async () => {
  const factory = async (i) => ({
    invoke: () => i === 0 ? new Promise(() => {}) : Promise.resolve('quick'),
  })
  const { results } = await runSpawnBatch(['hang', 'quick'], factory, { timeoutMs: 30 })
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /timeout/)
  assert.equal(results[1].ok, true)
})

// ── the tool: wait paths ─────────────────────────────────────────────────────

test('wait (default): returns merged results with counts + aggregate text', async () => {
  const t = makeSpawnAgentsTool({
    agentFactory: async (i) => ({ invoke: async () => (i === 1 ? Promise.reject(new Error('nope')) : `res ${i + 1}`) }),
  })
  const r = await t.invoke({ tasks: ['a', 'b'] })
  assert.equal(r.ok, true, 'some succeeded → ok')
  assert.equal(r.completed, 1)
  assert.equal(r.failed, 1)
  assert.match(r.text, /✅ Task 1/)
  assert.match(r.text, /❌ Task 2: nope/)
  assert.equal(r.results.length, 2)
})

test('wait:false — ticket now, ONE aggregated delivery on all three rails later', async () => {
  const notified = []
  const announced = []
  let release
  const gate = new Promise((r) => { release = r })
  const t = makeSpawnAgentsTool({
    agentFactory: async (i) => ({ invoke: async () => { await gate; return `bg answer ${i + 1}` } }),
    notify: (title, body) => notified.push({ title, body }),
    announce: (id, summary, result) => announced.push({ id, summary, result }),
  })
  const r = await t.invoke({ tasks: ['a', 'b'], wait: false })
  assert.equal(r.pending, true, 'returned before the batch finished')
  assert.match(r.batch_id, /^batch_/)
  assert.equal(r.tasks, 2)
  assert.equal(notified.length, 0, 'nothing delivered yet')

  release()
  await settle()
  assert.equal(notified.length, 1, 'exactly ONE notification, not one per task')
  assert.match(notified[0].title, /2\/2 done/)
  assert.equal(announced.length, 1)
  assert.equal(announced[0].id, r.batch_id)
  assert.match(announced[0].result, /bg answer 1/)
  assert.match(announced[0].result, /bg answer 2/)
  // history notice — the rail that survives both notifications missing
  const hist = readFileSync(join(process.env.HOME || home, '.tiny_history'), 'utf8')
  assert.match(hist, new RegExp(`spawn_agents batch ${r.batch_id}`))
})

test('wait:false failure path still delivers (failed counts in the summary)', async () => {
  const notified = []
  const t = makeSpawnAgentsTool({
    agentFactory: async () => ({ invoke: async () => { throw new Error('all dead') } }),
    notify: (title, body) => notified.push({ title, body }),
  })
  const r = await t.invoke({ tasks: ['a'], wait: false })
  assert.equal(r.pending, true)
  await settle()
  assert.equal(notified.length, 1)
  assert.match(notified[0].title, /0\/1 done \(1 failed\)/)
})

// ── wiring rules (source-level, same pattern as loop.test.mjs) ───────────────

test('spawn_agents stays RESERVED so a local tool cannot shadow it inside a loop', () => {
  const src = readFileSync(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  assert.match(src, /'use_loop', 'spawn_agents'/,
    'reserved even in background mode, where the tool is unregistered')
})

test('registration is foreground-only and sub-agents are background:true (depth 1)', () => {
  const src = readFileSync(new URL('../src/agent/agent.ts', import.meta.url), 'utf-8')
  // the makeSpawnAgentsTool call sits inside the !background block, after the
  // LoopRunner — and its factory builds background agents.
  const block = src.slice(src.indexOf('if (!this.opts.background)'), src.indexOf('this.builtinToolNames ='))
  assert.match(block, /makeSpawnAgentsTool/, 'registered in the foreground-only block')
  assert.match(block, /printer: false, background: true/, 'sub-agents are background agents')
})

test('the description warns the model off nesting and points loops elsewhere', () => {
  assert.match(SPAWN_DESCRIPTION, /cannot spawn further agents/i)
  assert.match(SPAWN_DESCRIPTION, /use_loop/)
})

// ── TUI chip ────────────────────────────────────────────────────────────────

test('spawn_agents has a width-unambiguous glyph', async () => {
  const { toolIcon } = await import('../dist/tui/tool-icons.js')
  assert.equal(toolIcon('spawn_agents'), '🤖')
})
