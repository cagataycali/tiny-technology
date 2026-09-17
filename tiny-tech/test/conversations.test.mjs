/**
 * Conversation reducer — the concurrency rules of the TUI, tested without a TTY.
 *
 * These are the guarantees the composer makes: a submit is NEVER dropped, live
 * streams can't contaminate each other, and a cancelled turn stops mattering.
 * The bug this file exists to prevent regressing is the original one —
 * `if (!q || busy) return` silently discarding a question while the placeholder
 * claimed it was queued.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createState, submit, applyEvent, complete, cancel, dropQueued, remove,
  running, queued, activeCount, queuedCount, isBusy, newestRunning, find,
  elapsedMs, formatElapsed, summarizeToolInput, PALETTE, MAX_CONCURRENT,
} from '../dist/tui/conversations.js'

const text = (t) => ({ kind: 'text', text: t })

test('default state has no ceiling — every submit starts immediately', () => {
  assert.equal(MAX_CONCURRENT, Infinity)
  let s = createState()
  const started = []
  for (const q of ['one', 'two', 'three', 'four', 'five']) {
    const r = submit(s, { query: q, now: 1000 })
    s = r.state
    started.push(...r.launch)
  }
  assert.equal(started.length, 5, 'all five launch, none queued')
  assert.equal(activeCount(s), 5)
  assert.equal(queuedCount(s), 0)
  assert.equal(s.totalSubmitted, 5)
  for (const c of started) assert.equal(c.status, 'running')
})

test('a submit is never dropped, even mid-stream', () => {
  // The regression guard: submitting while another turn runs must return a
  // launched conversation, not nothing.
  let s = createState()
  s = submit(s, { query: 'first' }).state
  const r = submit(s, { query: 'second while first streams' })
  assert.equal(r.launch.length, 1)
  assert.equal(r.launch[0].query, 'second while first streams')
  assert.equal(activeCount(r.state), 2)
})

test('neighbouring conversations never share a colour', () => {
  let s = createState()
  const seen = []
  for (let i = 0; i < PALETTE.length + 2; i++) {
    const r = submit(s, { query: `q${i}` })
    s = r.state
    seen.push(r.launch[0].color)
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], `#${i} reused its neighbour's colour`)
  }
})

test('explicit cap queues the overflow and drains FIFO on completion', () => {
  let s = createState({ maxConcurrent: 2 })
  const a = submit(s, { query: 'a', now: 1 }); s = a.state
  const b = submit(s, { query: 'b', now: 2 }); s = b.state
  const c = submit(s, { query: 'c', now: 3 }); s = c.state
  const d = submit(s, { query: 'd', now: 4 }); s = d.state

  assert.equal(a.launch.length, 1)
  assert.equal(b.launch.length, 1)
  assert.equal(c.launch.length, 0, 'third waits behind the cap')
  assert.equal(d.launch.length, 0)
  assert.equal(queuedCount(s), 2)

  // 'a' lands → 'c' (queued first) goes next, not 'd'.
  const done = complete(s, a.launch[0].id, 10)
  assert.equal(done.finished.query, 'a')
  assert.equal(done.launch.length, 1)
  assert.equal(done.launch[0].query, 'c')
  assert.equal(done.state.totalCompleted, 1)
})

test("a session doesn't consume a turn slot, and starts from behind a full queue", () => {
  // One open mic must not eat a quarter of the concurrency.
  let s = createState({ maxConcurrent: 1 })
  const t = submit(s, { query: 'long turn' }); s = t.state
  const q = submit(s, { query: 'waiting turn' }); s = q.state
  assert.equal(q.launch.length, 0, 'turn is capped out')

  const voice = submit(s, { query: 'voice session', kind: 'session' })
  assert.equal(voice.launch.length, 1, 'session starts anyway')
  assert.equal(voice.launch[0].kind, 'session')
  // ...and it does not make the queued turn runnable, nor block it forever.
  assert.equal(queuedCount(voice.state), 1)
})

test('isBusy tracks turns only — a live session leaves the loop free to arm', () => {
  let s = createState()
  const v = submit(s, { query: 'voice', kind: 'session' })
  assert.equal(isBusy(v.state), false, 'a session is not "busy"')
  assert.equal(activeCount(v.state), 1, 'but it IS active on screen')
  const t = submit(v.state, { query: 'turn' })
  assert.equal(isBusy(t.state), true)
})

test('events land on the conversation they name — no cross-contamination', () => {
  let s = createState()
  const a = submit(s, { query: 'a' }); s = a.state
  const b = submit(s, { query: 'b' }); s = b.state
  const [ida, idb] = [a.launch[0].id, b.launch[0].id]

  // Interleaved exactly the way two forked agents actually stream.
  s = applyEvent(s, ida, text('A1'))
  s = applyEvent(s, idb, text('B1'))
  s = applyEvent(s, ida, text('A2'))
  s = applyEvent(s, idb, text('B2'))

  assert.equal(find(s, ida).text, 'A1A2')
  assert.equal(find(s, idb).text, 'B1B2')
})

test('an event for an unknown conversation is ignored, not a crash', () => {
  const s = createState()
  assert.equal(applyEvent(s, 999, text('ghost')), s)
})

test('tool chips close the most recent unfinished chip of that name', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id
  s = applyEvent(s, id, { kind: 'tool_start', name: 'bash' })
  s = applyEvent(s, id, { kind: 'tool_start', name: 'bash' })
  s = applyEvent(s, id, { kind: 'tool_end', name: 'bash' })

  const tools = find(s, id).tools
  assert.equal(tools.length, 2)
  // Second (most recent) closed; the first is still running.
  assert.deepEqual(tools.map((t) => t.done), [false, true])
})

test('an unnamed tool result still closes something', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id
  s = applyEvent(s, id, { kind: 'tool_start', name: 'use_computer' })
  s = applyEvent(s, id, { kind: 'tool_end', error: 'boom' })
  const [chip] = find(s, id).tools
  assert.equal(chip.done, true)
  assert.equal(chip.error, 'boom')
})

test('done backfills text only when nothing streamed', () => {
  let s = createState()
  const a = submit(s, { query: 'streamed' }); s = a.state
  const b = submit(s, { query: 'silent' }); s = b.state
  s = applyEvent(s, a.launch[0].id, text('live'))
  s = applyEvent(s, a.launch[0].id, { kind: 'done', text: 'FULL' })
  s = applyEvent(s, b.launch[0].id, { kind: 'done', text: 'FULL' })
  assert.equal(find(s, a.launch[0].id).text, 'live', 'streamed text is not overwritten')
  assert.equal(find(s, b.launch[0].id).text, 'FULL', 'server-mode turn gets its text')
})

test('reasoning deltas are not rendered per panel', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const after = applyEvent(s, r.launch[0].id, { kind: 'reasoning', text: 'thinking' })
  assert.equal(after, s, 'state is untouched')
})

test('a cancelled turn ignores every event that arrives afterwards', () => {
  // The generator keeps producing until it notices; that output is noise.
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id
  s = applyEvent(s, id, text('before'))
  s = cancel(s, id).state
  s = applyEvent(s, id, text(' AFTER'))
  s = applyEvent(s, id, { kind: 'tool_start', name: 'bash' })
  const c = find(s, id)
  assert.equal(c.status, 'cancelled')
  assert.equal(c.text, 'before')
  assert.equal(c.tools.length, 0)
})

test('complete and cancel are both idempotent', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id

  const first = complete(s, id, 5)
  assert.ok(first.finished)
  const again = complete(first.state, id, 6)
  assert.equal(again.finished, undefined, 'no second completion')
  assert.equal(again.state.totalCompleted, 1, 'counter did not double-count')

  const late = cancel(first.state, id, 7)
  assert.equal(late.finished, undefined, 'cannot cancel what already landed')
})

test('cancel frees a slot so the queue keeps moving', () => {
  let s = createState({ maxConcurrent: 1 })
  const a = submit(s, { query: 'a' }); s = a.state
  const b = submit(s, { query: 'b' }); s = b.state
  assert.equal(b.launch.length, 0)
  const stop = cancel(s, a.launch[0].id)
  assert.equal(stop.launch.length, 1)
  assert.equal(stop.launch[0].query, 'b')
})

test('Esc drops what is still waiting and leaves running work alone', () => {
  let s = createState({ maxConcurrent: 1 })
  s = submit(s, { query: 'running' }).state
  s = submit(s, { query: 'waiting 1' }).state
  s = submit(s, { query: 'waiting 2' }).state
  const { state, dropped } = dropQueued(s)
  assert.equal(dropped, 2)
  assert.equal(queuedCount(state), 0)
  assert.equal(activeCount(state), 1)
  assert.equal(running(state)[0].query, 'running')
})

test('newestRunning is what a single ^C stops — turns only', () => {
  let s = createState()
  assert.equal(newestRunning(s), undefined)
  s = submit(s, { query: 'old' }).state
  s = submit(s, { query: 'new' }).state
  assert.equal(newestRunning(s).query, 'new')
  // A session opened afterwards must not steal the ^C.
  s = submit(s, { query: 'voice', kind: 'session' }).state
  assert.equal(newestRunning(s).query, 'new')
})

test('remove forgets a conversation the UI moved into the transcript', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const done = complete(s, r.launch[0].id)
  const gone = remove(done.state, r.launch[0].id)
  assert.equal(gone.items.length, 0)
  assert.equal(queued(gone).length, 0)
  // Counters survive the removal — they describe the session, not the panel.
  assert.equal(gone.totalSubmitted, 1)
  assert.equal(gone.totalCompleted, 1)
})

test('elapsed excludes queue wait and freezes when the turn lands', () => {
  let s = createState({ maxConcurrent: 1 })
  s = submit(s, { query: 'running', now: 1000 }).state
  const b = submit(s, { query: 'waiting', now: 1000 }); s = b.state
  const waiting = queued(s)[0]
  assert.equal(elapsedMs(waiting, 9000), 0, 'a queued turn has run for 0ms')

  const started = complete(s, running(s)[0].id, 2000).launch[0]  // starts at 2000
  assert.equal(elapsedMs(started, 5000), 3000, 'clock runs from start, not submit')
  const landed = complete({ ...s, items: [started] }, started.id, 6000).finished
  assert.equal(elapsedMs(landed, 999999), 4000, 'finished clock is frozen')
})

test('formatElapsed stays narrow enough for a panel label', () => {
  assert.equal(formatElapsed(0), '0s')
  assert.equal(formatElapsed(4200), '4s')
  assert.equal(formatElapsed(42_000), '42s')
  assert.equal(formatElapsed(72_000), '1m12s')
  assert.equal(formatElapsed(3_600_000), '60m00s')
})

// ─── Tool chip detail — "doing what?", not just "which tool" ────────────────

test('a chip records WHAT the tool was asked to do, not just its name', () => {
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id
  s = applyEvent(s, id, { kind: 'tool_start', name: 'bash', input: { command: 'npm test' } })
  assert.equal(find(s, id).tools[0].detail, 'npm test')
})

test('the detail survives the tool finishing', () => {
  // tool_end rebuilds the chip array; a spread that dropped `detail` would make
  // every completed chip anonymous again.
  let s = createState()
  const r = submit(s, { query: 'q' }); s = r.state
  const id = r.launch[0].id
  s = applyEvent(s, id, { kind: 'tool_start', name: 'bash', input: { command: 'ls -la' } })
  s = applyEvent(s, id, { kind: 'tool_end', name: 'bash' })
  const [chip] = find(s, id).tools
  assert.equal(chip.done, true)
  assert.equal(chip.detail, 'ls -la')
})

test('summarizeToolInput reads a URL as one thing, method included', () => {
  assert.equal(
    summarizeToolInput('httpRequest', { method: 'get', url: 'https://api.github.com/repos' }),
    'GET api.github.com/repos',
  )
  assert.equal(summarizeToolInput('httpRequest', { url: 'http://x.dev/a' }), 'x.dev/a')
})

test('summarizeToolInput prefers the file path and qualifies it with the mode', () => {
  assert.equal(
    summarizeToolInput('fileEditor', { mode: 'create', path: 'src/tui/App.tsx' }),
    'create src/tui/App.tsx',
  )
  assert.equal(summarizeToolInput('fileEditor', { file_path: 'a.ts' }), 'a.ts')
})

test('summarizeToolInput collapses whitespace and bounds the length', () => {
  const multiline = summarizeToolInput('bash', { command: 'for f in *; do\n  echo $f\ndone' })
  assert.ok(!multiline.includes('\n'), 'a chip is ONE row')
  assert.equal(multiline, 'for f in *; do echo $f done')

  const long = summarizeToolInput('bash', { command: 'x'.repeat(200) })
  assert.ok(long.length <= 56, `got ${long.length}`)
  assert.ok(long.endsWith('…'), 'truncation is visible')
})

test('summarizeToolInput never throws on the shapes a model actually sends', () => {
  // Model-generated input is arbitrary: this must degrade to undefined, not crash
  // a render mid-stream.
  assert.equal(summarizeToolInput('t', undefined), undefined)
  assert.equal(summarizeToolInput('t', null), undefined)
  assert.equal(summarizeToolInput('t', {}), undefined)
  assert.equal(summarizeToolInput('t', { nested: { deep: 'thing' } }), undefined)
  assert.equal(summarizeToolInput('t', { command: '   ' }), undefined, 'blank is not detail')
  assert.equal(summarizeToolInput('t', 'bare string'), 'bare string')
  // An unrecognised key is ignored rather than guessed at — showing a random
  // field is worse than showing the tool name alone.
  assert.equal(summarizeToolInput('t', { count: 3 }), undefined)
  assert.equal(summarizeToolInput('t', { pattern: 42 }), '42', 'a known key still renders')
})

test('loop iterations are marked so the transcript can collapse them', () => {
  const r = submit(createState(), { query: 'autonomous step', loop: true })
  assert.equal(r.launch[0].loop, true)
  assert.equal(submit(createState(), { query: 'typed' }).launch[0].loop, false)
})
