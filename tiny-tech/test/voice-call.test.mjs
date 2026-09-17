/**
 * The TUI's realtime call strip. What's under test is not the pixels — it's the
 * coalescing store, because the failure it prevents (Ink repainting 40× a
 * second while someone types) is invisible in a screenshot and obvious in the
 * hands. So: how many times does React get woken, and is the LAST frame always
 * one of them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallStore, FRAME_MS, meterBars, VoiceCallStrip } from '../dist/tui/voice-call.js'

/** A clock we control — tests must not sleep to prove a frame budget. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

/** Counts publishes and captures every snapshot React would have rendered. */
function watch(store) {
  const frames = []
  store.subscribe(() => frames.push(store.getSnapshot()))
  return frames
}

test('a burst of mic frames wakes the renderer once, not once per frame', () => {
  const c = clock()
  const store = new CallStore({ now: c.now })
  const frames = watch(store)

  // 25 frames at 30ms apart = 750ms of speech. Unthrottled that is 25 repaints.
  for (let i = 0; i < 25; i++) { store.handle({ type: 'level', level: 0.5 }); c.advance(30) }
  store.flush()

  assert.ok(frames.length <= 12, `expected ≤12 publishes for 750ms of audio, got ${frames.length}`)
  assert.ok(frames.length >= 8, `the meter must still feel live, got only ${frames.length} publishes`)
})

test('the newest level survives coalescing — the meter shows now, not 80ms ago', () => {
  const c = clock()
  const store = new CallStore({ now: c.now })
  const frames = watch(store)
  store.handle({ type: 'level', level: 0.1 })
  store.flush()
  store.handle({ type: 'level', level: 0.2 })
  store.handle({ type: 'level', level: 0.9 })
  store.handle({ type: 'level', level: 0.4 })
  c.advance(FRAME_MS)
  store.handle({ type: 'level', level: 0.42 })
  assert.equal(frames.at(-1).level, 0.42)
})

test('the last frame always paints — a call that ends between frames is not lost', async () => {
  const store = new CallStore()
  const frames = watch(store)
  store.handle({ type: 'status', status: 'live' })   // leading edge: paints now
  store.handle({ type: 'status', status: 'ended' })  // inside the budget: deferred
  assert.equal(frames.at(-1).phase, 'listening', 'the deferred frame should not have painted yet')
  await new Promise((r) => setTimeout(r, FRAME_MS + 30))
  assert.equal(frames.at(-1).phase, 'ended', 'the trailing flush must deliver the final frame')
  store.dispose()
})

test('snapshot identity changes only on publish — React re-renders exactly then', () => {
  const c = clock()
  const store = new CallStore({ now: c.now })
  store.handle({ type: 'status', status: 'live' })
  const a = store.getSnapshot()
  store.handle({ type: 'level', level: 0.3 })  // absorbed, not published
  assert.equal(store.getSnapshot(), a, 'a coalesced event must not change snapshot identity')
  c.advance(FRAME_MS)
  store.handle({ type: 'level', level: 0.3 })
  assert.notEqual(store.getSnapshot(), a)
})

test('phases follow the call: dialling → listening → speaking → tool → listening', () => {
  const c = clock()
  const store = new CallStore({ now: c.now })
  const seen = []
  store.subscribe(() => seen.push(store.getSnapshot().phase))
  const step = (e) => { store.handle(e); c.advance(FRAME_MS); store.flush() }

  assert.equal(store.getSnapshot().phase, 'connecting')
  step({ type: 'status', status: 'live' })
  step({ type: 'user_transcript', text: 'does the build pass?' })
  step({ type: 'response_started' })
  step({ type: 'tool_call', id: 'c1', name: 'bash', args: { command: 'npm run build' } })
  step({ type: 'response_done' })
  assert.deepEqual(seen, ['listening', 'listening', 'speaking', 'working', 'listening'])
})

test('a barge-in keeps the half-said sentence and marks it cut off', () => {
  const store = new CallStore()
  store.handle({ type: 'response_started' })
  store.handle({ type: 'assistant_transcript', delta: 'The build passes, and I also' })
  store.handle({ type: 'barge_in' })
  const s = store.getSnapshot()
  assert.equal(s.phase, 'listening')
  assert.equal(s.interrupted, true)
  assert.match(s.tiny, /and I also$/, 'the interrupted words stay on screen — being cut off is information')
})

test('a new question clears the previous answer and its tool lines', () => {
  const store = new CallStore()
  store.handle({ type: 'tool_call', id: 'c1', name: 'bash', args: {} })
  store.handle({ type: 'assistant_transcript', delta: 'it passes' })
  store.handle({ type: 'user_transcript', text: 'what about the tests?' })
  const s = store.getSnapshot()
  assert.equal(s.you, 'what about the tests?')
  assert.equal(s.tiny, '')
  assert.deepEqual(s.tools, [])
  assert.equal(s.interrupted, false)
})

test('a tool result attaches to its own call, by id', () => {
  const store = new CallStore()
  store.handle({ type: 'tool_call', id: 'a', name: 'bash', args: {} })
  store.handle({ type: 'tool_call', id: 'b', name: 'read_file', args: {} })
  store.handle({ type: 'tool_result', id: 'b', name: 'read_file', output: 'contents' })
  const s = store.getSnapshot()
  assert.equal(s.tools.find((t) => t.id === 'a').output, undefined)
  assert.equal(s.tools.find((t) => t.id === 'b').output, 'contents')
})

test('only the last three tool calls are kept — the strip is a strip, not a log', () => {
  const store = new CallStore()
  for (const id of ['a', 'b', 'c', 'd', 'e']) store.handle({ type: 'tool_call', id, name: 't' + id, args: {} })
  assert.deepEqual(store.getSnapshot().tools.map((t) => t.id), ['c', 'd', 'e'])
})

test('a long spoken answer cannot grow the strip without bound', () => {
  const store = new CallStore()
  for (let i = 0; i < 500; i++) store.handle({ type: 'assistant_transcript', delta: 'word ' })
  const s = store.getSnapshot()
  assert.ok(s.tiny.length <= 400, `strip text grew to ${s.tiny.length} chars`)
  assert.match(s.tiny, /word $/, 'it must keep the NEWEST words, not the oldest')
})

test('turns are counted, including continuations', () => {
  const store = new CallStore()
  store.handle({ type: 'turn', user: 'hi', assistant: 'hello', continuation: false })
  store.handle({ type: 'turn', user: '', assistant: 'and one more thing', continuation: true })
  assert.equal(store.getSnapshot().turns, 2)
})

test('the meter zeroes when the call ends — no bar left frozen mid-level', () => {
  const store = new CallStore()
  store.handle({ type: 'level', level: 0.8 })
  store.flush()
  store.handle({ type: 'status', status: 'ended' })
  store.flush()
  const s = store.getSnapshot()
  assert.equal(s.level, 0)
  assert.equal(s.peak, 0)
})

test('errors surface without ending the call', () => {
  const store = new CallStore()
  store.handle({ type: 'status', status: 'live' })
  store.handle({ type: 'error', error: 'the tool timed out' })
  const s = store.getSnapshot()
  assert.equal(s.error, 'the tool timed out')
  assert.equal(s.phase, 'listening', 'an error is a line on screen, not a hangup')
})

test('a listener that throws does not stop the others or the call', () => {
  const store = new CallStore()
  let reached = false
  store.subscribe(() => { throw new Error('render blew up') })
  store.subscribe(() => { reached = true })
  store.handle({ type: 'status', status: 'live' })
  assert.equal(reached, true)
})

test('unknown events are ignored, not crashed on', () => {
  const store = new CallStore()
  store.handle({ type: 'something_new_from_openai', foo: 1 })
  assert.equal(store.getSnapshot().phase, 'connecting')
})

test('dispose drops the pending frame so a closed strip stops repainting', async () => {
  const store = new CallStore()
  const frames = watch(store)
  store.handle({ type: 'status', status: 'live' })
  store.handle({ type: 'level', level: 0.5 })
  const before = frames.length
  store.dispose()
  await new Promise((r) => setTimeout(r, FRAME_MS + 30))
  assert.equal(frames.length, before, 'a disposed store must not wake a component that unmounted')
})

test('the peak marker decays instead of sticking at the loudest frame ever', () => {
  const c = clock()
  const store = new CallStore({ now: c.now })
  store.handle({ type: 'level', level: 1 })
  store.flush()
  const loud = store.getSnapshot().peak
  for (let i = 0; i < 5; i++) { c.advance(FRAME_MS); store.handle({ type: 'level', level: 0 }); store.flush() }
  assert.ok(store.getSnapshot().peak < loud, 'peak-hold must fall back, or the meter reads as a static bar')
})

test('the meter draws level, peak marker and empty cells distinctly', () => {
  assert.equal(meterBars(0, 0, 8), '········')
  assert.equal(meterBars(1, 1, 8), '████████')
  const m = meterBars(0.25, 0.75, 8)
  assert.equal(m.slice(0, 2), '██', 'two of eight cells lit at quarter level')
  assert.ok(m.includes('▖'), 'the recent peak is marked where the level no longer reaches')
  assert.equal(m.length, 8)
})

test('a garbage level never draws a broken meter', () => {
  for (const bad of [NaN, Infinity, -1, 5, undefined]) {
    const m = meterBars(bad, bad, 6)
    assert.equal(m.length, 6, `level ${bad} produced "${m}"`)
  }
})

test('the strip is a plain component — props in, elements out, no call attached', () => {
  const el = VoiceCallStrip({ state: { ...new CallStore().getSnapshot(), you: 'hi', tiny: 'hello', phase: 'speaking' } })
  assert.ok(el && typeof el === 'object' && 'type' in el, 'must return an element tree')
})

/**
 * The strip sits directly above the composer. Ink repaints from the first
 * changed line down, so if the box grows a line mid-sentence it drags the prompt
 * and the cursor with it — the thing you are typing visibly jumps while the tiny
 * talks. Found exactly this on the first real paint (a wrapped model name added
 * a second header line), hence a test that measures HEIGHT, not text.
 */
test('the strip keeps a constant height in a narrow terminal, however long the speech', async () => {
  const { render } = await import('ink')
  const React = (await import('react')).default

  const paint = (state, columns) => {
    const frames = []
    const stdout = {
      columns, rows: 40,
      write: (s) => frames.push(s),
      on: () => {}, off: () => {}, removeListener: () => {},
    }
    const inst = render(React.createElement(VoiceCallStrip, { state }), {
      stdout, patchConsole: false, exitOnCtrlC: false,
    })
    inst.unmount()
    const last = frames.at(-1) || ''
    // eslint-disable-next-line no-control-regex
    return last.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd().split('\n').length
  }

  const base = {
    phase: 'speaking', level: 0.5, peak: 0.7, you: 'hi', tiny: 'ok',
    tools: [{ id: 'c1', name: 'bash', output: 'fine' }], error: '', turns: 1,
    interrupted: false, model: 'gpt-realtime-2.1-mini', voice: 'marin', fullDuplex: false,
  }
  const long = {
    ...base,
    you: 'can you check whether the build passes and then tell me what the longest file in the repo is, '.repeat(3),
    tiny: 'sure — running the build now, it takes about eleven seconds on this machine, '.repeat(4),
    tools: [{ id: 'c1', name: 'bash', output: 'x'.repeat(400) }],
  }

  for (const columns of [60, 100]) {
    assert.equal(paint(long, columns), paint(base, columns),
      `at ${columns} columns a long transcript changed the strip's height — the composer below it would jump`)
  }
})

test('openCall refuses clearly without a key instead of dialling', async () => {
  const { openCall } = await import('../dist/tui/voice-call.js')
  const saved = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    await assert.rejects(() => openCall({}), /OpenAI key/)
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved
  }
})
