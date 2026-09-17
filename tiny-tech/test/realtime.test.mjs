/**
 * Realtime speech-to-speech — the parts that only ever break on a real call.
 *
 * Every test here is a scar from the web/iOS implementation (the VoiceSession
 * DO), reproduced against the CLI port with a fake socket and fake audio
 * devices. The reason they are worth this much test code: each one is invisible
 * in a unit sense and obvious to a person on a phone call — a spurious error
 * banner every turn, a blip of an interrupted sentence, the tiny interrupting
 * itself through its own speaker, a call that hangs in silence forever because a
 * tool threw and the model never got an answer.
 */
import { test } from 'node:test'
import assert from 'node:assert'

const {
  RealtimeCall, buildSessionUpdate, toRealtimeTool, resolveVoice,
  buildVoiceInstructions, DEFAULT_REALTIME_MODEL, MAX_TOOLS, ECHO_TAIL_MS,
  BARGE_FRAMES, BARGE_MARGIN, ECHO_LEARN_FRAMES,
  resolveFullDuplex, resolveNoiseReduction,
} = await import('../dist/agent/realtime.js')
const { recordArgs, playArgs, frameLevel, detectBackend, BYTES_PER_MS } = await import('../dist/agent/audio.js')

/** A socket that records what was sent and lets a test play OpenAI's part. */
function fakeSocket() {
  const sent = []
  const s = {
    sent,
    closed: false,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data) { sent.push(JSON.parse(data)) },
    close() { s.closed = true },
    /** Deliver an upstream event as OpenAI would. */
    deliver(obj) { s.onmessage?.({ data: JSON.stringify(obj) }) },
    ofType(t) { return sent.filter((m) => m.type === t) },
    has(t) { return sent.some((m) => m.type === t) },
  }
  return s
}

/** Fake devices: a speaker that records writes/flushes, a mic we drive. */
function fakeAudio() {
  const writes = []
  let flushes = 0
  let speaking = false
  let micFrame = null
  return {
    writes,
    get flushes() { return flushes },
    setSpeaking(v) { speaking = v },
    frame(buf) { micFrame?.(buf) },
    speakerFactory: () => ({
      write(b) { writes.push(b); speaking = true },
      flush() { flushes++; speaking = false },
      close() { speaking = false },
      get speaking() { return speaking },
    }),
    micFactory: (onFrame) => { micFrame = onFrame; return { stop() { micFrame = null }, alive: true } },
  }
}

/** A live call wired to fakes, already past session.update. */
async function liveCall(extra = {}) {
  const sock = fakeSocket()
  const audio = fakeAudio()
  const events = []
  const call = new RealtimeCall({
    apiKey: 'sk-test',
    onEvent: (e) => events.push(e),
    socketFactory: () => sock,
    speakerFactory: audio.speakerFactory,
    micFactory: audio.micFactory,
    backend: 'sox',
    ...extra,
  })
  const started = call.start()
  sock.onopen()
  await started
  return { call, sock, audio, events, of: (t) => events.filter((e) => e.type === t) }
}

const pcm = (ms) => Buffer.alloc(Math.round(ms * BYTES_PER_MS), 1)
const b64 = (ms) => pcm(ms).toString('base64')

/** A 20 ms frame at a chosen amplitude, so a test can be quiet or loud on
 *  purpose — the gate's whole job is telling those two apart. */
function tone(amp, ms = 20) {
  const b = Buffer.alloc(Math.round(ms * BYTES_PER_MS))
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(amp, i * 2)
  return b
}
/** frameLevel is mean|sample| / 8000, so this inverts it for readable tests. */
const ampFor = (level) => Math.round(level * 8000)
/** Feed n frames and hand back how many appends the socket saw in total. */
function feed(audio, frame, n) { for (let i = 0; i < n; i++) audio.frame(frame) }

// ── the session frame ──────────────────────────────────────────────────────

test('session.update uses the GA nested audio schema, not the old flat one', () => {
  const f = buildSessionUpdate({ instructions: 'hi', voice: 'cedar' })
  assert.strictEqual(f.type, 'session.update')
  assert.strictEqual(f.session.type, 'realtime')
  // The flat shape (modalities / input_audio_format) is silently ignored by the
  // GA model, which then answers in text while a person waits for a voice.
  assert.ok(!('modalities' in f.session), 'modalities is the beta shape')
  assert.ok(!('input_audio_format' in f.session))
  assert.deepStrictEqual(f.session.audio.input.format, { type: 'audio/pcm', rate: 24000 })
  assert.deepStrictEqual(f.session.audio.output.format, { type: 'audio/pcm', rate: 24000 })
  assert.strictEqual(f.session.audio.output.voice, 'cedar')
})

test('semantic VAD and USER-side transcription are both on', () => {
  const f = buildSessionUpdate({ instructions: 'hi' })
  assert.strictEqual(f.session.audio.input.turn_detection.type, 'semantic_vad')
  // Interruption is the MODEL's job: it cancels its own reply when it hears you.
  // Asked for explicitly rather than inherited from a default we do not own —
  // and never reimplemented client-side, which would be a second, worse VAD.
  assert.strictEqual(f.session.audio.input.turn_detection.interrupt_response, true)
  assert.strictEqual(f.session.audio.input.turn_detection.create_response, true)
  // Without this the CLI never learns what the person SAID, so nothing can be
  // injected into the typed session's history — the feature's whole point.
  assert.ok(f.session.audio.input.transcription?.model)
})

test('an unknown voice falls back instead of being sent to the API', () => {
  assert.strictEqual(resolveVoice('nope'), 'marin')
  assert.strictEqual(resolveVoice('CEDAR'), 'cedar')
  assert.strictEqual(resolveVoice(undefined), 'marin')
})

test('a Strands tool converts to a realtime function tool', () => {
  const t = { toolSpec: { name: 'use_bash', description: 'run a command', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } } }
  const r = toRealtimeTool(t)
  assert.deepStrictEqual(r, {
    type: 'function', name: 'use_bash', description: 'run a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  })
})

test('the tool roster is capped — 200 tools is a rejected session', () => {
  const tools = Array.from({ length: 200 }, (_, i) => ({ type: 'function', name: `t${i}`, description: '', parameters: {} }))
  const f = buildSessionUpdate({ instructions: 'hi', tools })
  assert.strictEqual(f.session.tools.length, MAX_TOOLS)
  assert.strictEqual(f.session.tool_choice, 'auto')
})

test('no tools means no tools key at all, not an empty array', () => {
  const f = buildSessionUpdate({ instructions: 'hi' })
  assert.ok(!('tools' in f.session))
  assert.ok(!('tool_choice' in f.session))
})

test('the spoken brief tells the model NOT to narrate tools or read code aloud', () => {
  const s = buildVoiceInstructions('cwd is /tmp')
  assert.match(s, /never narrate tool use/i)
  assert.match(s, /cwd is \/tmp/)
})

// ── the dial ───────────────────────────────────────────────────────────────

test('the key rides as a subprotocol — Node sends no custom WS headers', async () => {
  let seenUrl = '', seenProtocols = []
  const sock = fakeSocket()
  const call = new RealtimeCall({
    apiKey: 'sk-abc', backend: 'sox',
    socketFactory: (url, protocols) => { seenUrl = url; seenProtocols = protocols; return sock },
    speakerFactory: fakeAudio().speakerFactory, micFactory: fakeAudio().micFactory,
  })
  const p = call.start()
  sock.onopen()
  await p
  assert.match(seenUrl, new RegExp(`model=${DEFAULT_REALTIME_MODEL}`))
  assert.ok(seenProtocols.includes('realtime'))
  assert.ok(seenProtocols.includes('openai-insecure-api-key.sk-abc'))
  // Sending the beta subprotocol (as the OpenAI SDK's browser helper still
  // does) routes to the retired beta API: the call connects, reports live, and
  // every session.update comes back "no longer supported". It can never speak.
  assert.ok(!seenProtocols.some((p) => p.includes('beta')), 'GA is the bare realtime subprotocol')
  assert.strictEqual(sock.sent[0].type, 'session.update', 'configure before anything else')
})

test('a close before open rejects with the likely cause, not a mute failure', async () => {
  const sock = fakeSocket()
  const call = new RealtimeCall({ apiKey: 'sk-bad', backend: 'sox', socketFactory: () => sock })
  const p = call.start()
  sock.onclose({ code: 1008 })
  const err = await p.then(() => null, (e) => e)
  assert.ok(err, 'must reject')
  assert.match(err.message, /1008/)
  assert.match(err.message, /OPENAI_API_KEY/, 'a 401 arrives as a close — name the cause')
})

test('no key at all refuses before opening a socket', async () => {
  const call = new RealtimeCall({ apiKey: '', backend: 'sox', socketFactory: () => { throw new Error('should not dial') } })
  const err = await call.start().then(() => null, (e) => e)
  assert.match(err.message, /OPENAI_API_KEY/)
})

// ── barge-in: the three scars ──────────────────────────────────────────────

test('speech_started with NO response in flight does not cancel — the spurious-error bug', async () => {
  const { sock, of } = await liveCall()
  // Every turn's first word fires this while nothing is generating.
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  assert.strictEqual(sock.ofType('response.cancel').length, 0, 'cancelling here makes OpenAI answer "no active response"')
  assert.strictEqual(sock.ofType('conversation.item.truncate').length, 0)
  // …but the local speaker is STILL flushed, and the surface still hears it.
  assert.strictEqual(of('barge_in').length, 1)
})

test('a real barge-in cancels, truncates at what actually PLAYED, and suppresses the tail', async () => {
  const { sock, audio } = await liveCall()
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio.delta', delta: b64(500), item_id: 'item_9' })
  assert.strictEqual(audio.writes.length, 1)

  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  assert.strictEqual(sock.ofType('response.cancel').length, 1)
  const trunc = sock.ofType('conversation.item.truncate')[0]
  assert.strictEqual(trunc.item_id, 'item_9')
  assert.strictEqual(trunc.audio_end_ms, 500, 'the model must remember only what the human heard')
  assert.strictEqual(audio.flushes, 1, 'queued audio has to stop being audible')

  // Residual deltas of the cancelled reply keep arriving; they must not play.
  sock.deliver({ type: 'response.output_audio.delta', delta: b64(100), item_id: 'item_9' })
  assert.strictEqual(audio.writes.length, 1, 'a flushed queue must not replay the interrupted sentence')

  // A fresh turn re-opens the gate.
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio.delta', delta: b64(100), item_id: 'item_10' })
  assert.strictEqual(audio.writes.length, 2)
})

test('the beta audio event name still plays — a pinned older model must work', async () => {
  const { sock, audio } = await liveCall()
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.audio.delta', delta: b64(100), item_id: 'x' })
  assert.strictEqual(audio.writes.length, 1)
})

test('response_cancel_not_active is swallowed — it happens on every interruption', async () => {
  const { sock, of } = await liveCall()
  sock.deliver({ type: 'error', error: { code: 'response_cancel_not_active', message: 'no active response' } })
  assert.strictEqual(of('error').length, 0)
  sock.deliver({ type: 'error', error: { code: 'other', message: 'rate limited' } })
  assert.deepStrictEqual(of('error').map((e) => e.error), ['rate limited'])
})

// ── half duplex: the echo physics ──────────────────────────────────────────

test('half duplex drops mic frames while the tiny is audible — it must not interrupt itself', async () => {
  const { sock, audio } = await liveCall({ fullDuplex: false })
  audio.frame(pcm(20))
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 1, 'silence: the mic is open')

  audio.setSpeaking(true)
  audio.frame(pcm(20))
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 1, 'a laptop mic hears the laptop speaker')

  // The tail keeps the gate shut for a beat after the speaker drains.
  audio.setSpeaking(false)
  audio.frame(pcm(20))
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 1, `the speaker's own tail is still in the room`)
  assert.ok(ECHO_TAIL_MS > 0)
})

test('full duplex sends everything — barge-in is the best part, on headphones', async () => {
  const { sock, audio } = await liveCall({ fullDuplex: true })
  audio.setSpeaking(true)
  audio.frame(pcm(20))
  audio.frame(pcm(20))
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 2)
})

test('the mic is OPEN by default — the whole barge-in bug was this line', async () => {
  // Shipping the gate as the default meant a person could not interrupt at all:
  // the model's native interrupt_response cannot fire on audio it never got.
  const { sock, audio, call } = await liveCall()
  assert.strictEqual(call.fullDuplex, true)
  audio.setSpeaking(true)
  feed(audio, tone(ampFor(0.4)), 3)
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 3)
})

test('echo gating is opt-in, both ways, and one env knob no longer beats the other', () => {
  const save = { ...process.env }
  try {
    delete process.env.TINY_VOICE_FULL_DUPLEX; delete process.env.TINY_VOICE_HALF_DUPLEX
    assert.strictEqual(resolveFullDuplex(), true, 'default: the mic streams')
    assert.strictEqual(resolveFullDuplex(false), false, '--half-duplex wins')
    process.env.TINY_VOICE_HALF_DUPLEX = '1'
    assert.strictEqual(resolveFullDuplex(), false)
    assert.strictEqual(resolveFullDuplex(true), true, '--interrupt wins over the env')
    process.env.TINY_VOICE_FULL_DUPLEX = '1'
    assert.strictEqual(resolveFullDuplex(), true, 'the explicit yes wins the tie')
  } finally {
    process.env = save
  }
})

test(`the API's own noise reduction is asked for, where the VAD can use it`, () => {
  const save = process.env.TINY_VOICE_NOISE_REDUCTION
  try {
    delete process.env.TINY_VOICE_NOISE_REDUCTION
    assert.deepStrictEqual(buildSessionUpdate({ instructions: 'hi' }).session.audio.input.noise_reduction, { type: 'near_field' })
    process.env.TINY_VOICE_NOISE_REDUCTION = 'far_field'
    assert.strictEqual(resolveNoiseReduction(), 'far_field')
    process.env.TINY_VOICE_NOISE_REDUCTION = 'off'
    assert.strictEqual(resolveNoiseReduction(), null)
    // Absent, not null: an explicit null is a schema error on the session frame.
    assert.ok(!('noise_reduction' in buildSessionUpdate({ instructions: 'hi' }).session.audio.input))
  } finally {
    if (save === undefined) delete process.env.TINY_VOICE_NOISE_REDUCTION
    else process.env.TINY_VOICE_NOISE_REDUCTION = save
  }
})

// ── the gate is a door: talking over the tiny has to reach the model ────────
// The bug these pin: half duplex dropped EVERY frame while the tiny was
// audible, so interruption — the thing that makes speech-to-speech feel alive,
// and which the model handles natively — could not happen at all on the default
// setup. Not because the model ignored it: because it never heard it.

const ECHO = tone(ampFor(0.12))          // our own speaker, leaking back in
const PERSON = tone(ampFor(0.6))         // someone leaning into the mic
const CLICK = tone(ampFor(0.9))          // one frame of keyboard/desk knock

/** A gated call whose echo floor has already been measured at ECHO's level. */
async function speakingCall() {
  const c = await liveCall({ fullDuplex: false })
  c.audio.setSpeaking(true)
  feed(c.audio, ECHO, ECHO_LEARN_FRAMES)          // the measure-only window
  assert.strictEqual(c.sock.ofType('input_audio_buffer.append').length, 0)
  return c
}

test('talking over the tiny reaches the model — the interrupt it can actually honour', async () => {
  const { sock, audio, call } = await speakingCall()
  feed(audio, PERSON, BARGE_FRAMES)
  const sentFrames = sock.ofType('input_audio_buffer.append')
  // All of them, including the ones held while deciding: the server's VAD needs
  // the ONSET of the word, and an interruption that swallows "stop—" reads as
  // being ignored.
  assert.strictEqual(sentFrames.length, BARGE_FRAMES, 'the held onset goes upstream too')
  assert.strictEqual(call.bargeIns, 1)
})

test('the tiny still does not interrupt itself — its own echo never opens the gate', async () => {
  const { sock, audio, call } = await speakingCall()
  feed(audio, ECHO, 50)     // a whole sentence of echo, at the measured level
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 0)
  assert.strictEqual(call.bargeIns, 0)
  assert.ok(BARGE_MARGIN > 1, 'a person has to be louder than the echo, not equal to it')
})

test('the first syllables of a reply are measured, never believed — cold start', async () => {
  // With no learn window the floor starts at zero, so the reply's own first
  // words clear any margin and the tiny cancels itself on every sentence.
  const { sock, audio } = await liveCall({ fullDuplex: false })
  audio.setSpeaking(true)
  feed(audio, PERSON, ECHO_LEARN_FRAMES)
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 0, 'loud early audio is the echo, by assumption')
})

test('one loud frame is a knock on the desk, not a sentence', async () => {
  const { sock, audio, call } = await speakingCall()
  audio.frame(CLICK)
  feed(audio, ECHO, 5)
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 0)
  assert.strictEqual(call.bargeIns, 0)
  assert.ok(BARGE_FRAMES > 1)
})

test('once open the door stays open — a person pauses mid-sentence and is still heard', async () => {
  const { sock, audio } = await speakingCall()
  feed(audio, PERSON, BARGE_FRAMES)
  const after = sock.ofType('input_audio_buffer.append').length
  feed(audio, ECHO, 4)   // the dips between their own words
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, after + 4)
})

test('the next answer closes the door and re-measures the room', async () => {
  const { sock, audio } = await speakingCall()
  feed(audio, PERSON, BARGE_FRAMES)
  const after = sock.ofType('input_audio_buffer.append').length
  sock.deliver({ type: 'response.created', response: { id: 'r2' } })
  feed(audio, ECHO, 3)
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, after, 'gating is back on for the new reply')
})

test('the gate never opens when the tiny is silent — that path is not gated at all', async () => {
  const { sock, audio, call } = await liveCall({ fullDuplex: false })
  feed(audio, PERSON, 3)
  assert.strictEqual(sock.ofType('input_audio_buffer.append').length, 3)
  assert.strictEqual(call.bargeIns, 0, 'nothing was interrupted')
})

test('frames held and then sent are not counted as muted — an honest status line', async () => {
  const { audio, call } = await speakingCall()
  const gatedAfterLearning = call.gatedFrames
  feed(audio, PERSON, BARGE_FRAMES)
  assert.strictEqual(call.gatedFrames, gatedAfterLearning, 'held ≠ lost')
})

test('mic frames are base64 PCM16, and a level is reported for the meter', async () => {
  const { sock, audio, of } = await liveCall()
  audio.frame(pcm(20))
  const append = sock.ofType('input_audio_buffer.append')[0]
  assert.strictEqual(Buffer.from(append.audio, 'base64').length, Math.round(20 * BYTES_PER_MS))
  assert.strictEqual(of('level').length, 1)
})

// ── tools: the model must never be left hanging ────────────────────────────

test('a tool call runs locally and its output goes back as function_call_output', async () => {
  const invoked = []
  const tools = [{
    toolSpec: { name: 'use_bash', description: 'run', inputSchema: { type: 'object', properties: {} } },
    invoke: async (args) => { invoked.push(args); return 'build passed' },
  }]
  const { sock, of } = await liveCall({ tools })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'use_bash', arguments: '{"cmd":"npm test"}' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepStrictEqual(invoked, [{ cmd: 'npm test' }], 'the REAL local tool ran, not a bridge to one')
  const item = sock.ofType('conversation.item.create')[0]
  assert.strictEqual(item.item.type, 'function_call_output')
  assert.strictEqual(item.item.call_id, 'c1')
  assert.strictEqual(item.item.output, 'build passed')
  assert.ok(sock.has('response.create'), 'and the model is told to keep talking')
  assert.strictEqual(of('tool_call').length, 1)
  assert.strictEqual(of('tool_result')[0].output, 'build passed')
})

test('a tool that THROWS still answers — silence is the worst failure voice has', async () => {
  const tools = [{
    toolSpec: { name: 'use_computer', description: '', inputSchema: {} },
    invoke: async () => { throw new Error('screen recording not permitted') },
  }]
  const { sock } = await liveCall({ tools })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c2', name: 'use_computer', arguments: '{}' })
  await new Promise((r) => setTimeout(r, 20))
  const item = sock.ofType('conversation.item.create')[0]
  assert.match(item.item.output, /screen recording not permitted/)
  assert.ok(sock.has('response.create'))
})

test('a tool the machine does not have answers too, instead of hanging', async () => {
  const { sock } = await liveCall()
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c3', name: 'nonexistent', arguments: '{}' })
  await new Promise((r) => setTimeout(r, 20))
  assert.match(sock.ofType('conversation.item.create')[0].item.output, /no tool named nonexistent/)
})

test('malformed tool arguments degrade to {} rather than killing the turn', async () => {
  const seen = []
  const tools = [{ toolSpec: { name: 't', description: '', inputSchema: {} }, invoke: async (a) => { seen.push(a); return 'ok' } }]
  const { sock } = await liveCall({ tools })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c4', name: 't', arguments: '{not json' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepStrictEqual(seen, [{}])
})

// ── the transcript that lands in the CLI's context ─────────────────────────

test('a completed exchange is handed back as text for the typed session', async () => {
  const { sock, of } = await liveCall()
  sock.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'does the build pass?' })
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio_transcript.delta', delta: 'It ' })
  sock.deliver({ type: 'response.output_audio_transcript.delta', delta: 'passes.' })
  sock.deliver({ type: 'response.done' })
  assert.deepStrictEqual(of('turn'), [{ type: 'turn', user: 'does the build pass?', assistant: 'It passes.', continuation: false }])
})

test('the interrupted half of a turn is still transcribed — the person heard it', async () => {
  const { sock, of } = await liveCall()
  sock.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'tell me about' })
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Well, the thing is' })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  assert.deepStrictEqual(of('turn'), [{ type: 'turn', user: 'tell me about', assistant: 'Well, the thing is', continuation: false }])
})

test('a tool-only turn logs nothing — an empty exchange is noise in the history', async () => {
  const { sock, of } = await liveCall()
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.done' })
  assert.strictEqual(of('turn').length, 0)
})

test('a call goes live and says so before anyone types into it', async () => {
  const { call, sock, of } = await liveCall()
  assert.strictEqual(call.live, true)
  assert.deepStrictEqual(of('status').map((e) => e.status), ['connecting', 'live'])
  assert.ok(sock.has('session.update'))
  assert.strictEqual(sock.ofType('conversation.item.create').length, 0, 'nothing is said until someone says it')
})

test('sendUserText creates a user message and asks for a response', async () => {
  const { call, sock, of } = await liveCall()
  assert.strictEqual(call.sendUserText('  '), false, 'empty text is not a turn')
  assert.strictEqual(call.sendUserText('/Users/me/log.txt line 42'), true)
  const item = sock.ofType('conversation.item.create')[0]
  assert.deepStrictEqual(item.item, {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '/Users/me/log.txt line 42' }],
  })
  assert.ok(sock.has('response.create'))
  // …and it pairs into the transcript like a spoken turn would.
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Looking now.' })
  sock.deliver({ type: 'response.done' })
  assert.deepStrictEqual(of('turn')[0], { type: 'turn', user: '/Users/me/log.txt line 42', assistant: 'Looking now.', continuation: false })
})

// ── hanging up ─────────────────────────────────────────────────────────────

test('stop closes the socket AND the devices — a live mic light is unforgivable', async () => {
  const { call, sock, audio, of } = await liveCall()
  let micStopped = false
  // Re-open with an observable mic.
  const sock2 = fakeSocket()
  const c2 = new RealtimeCall({
    apiKey: 'k', backend: 'sox', socketFactory: () => sock2,
    speakerFactory: audio.speakerFactory,
    micFactory: () => ({ stop() { micStopped = true }, alive: true }),
  })
  const p = c2.start(); sock2.onopen(); await p
  c2.stop()
  assert.ok(micStopped, 'the microphone must be released')
  assert.ok(sock2.closed)
  c2.stop() // idempotent
  call.stop()
  assert.ok(sock.closed)
  assert.ok(of('status').some((e) => e.status === 'ended'))
})

test('a surface that throws in onEvent does not take the call down', async () => {
  const sock = fakeSocket()
  const call = new RealtimeCall({
    apiKey: 'k', backend: 'sox', socketFactory: () => sock,
    onEvent: () => { throw new Error('render bug') },
    speakerFactory: fakeAudio().speakerFactory, micFactory: fakeAudio().micFactory,
  })
  const p = call.start(); sock.onopen(); await p
  assert.strictEqual(call.live, true)
  sock.deliver({ type: 'response.created' })
  assert.strictEqual(call.live, true)
})

test('garbage on the wire is ignored, not fatal', async () => {
  const { call, sock } = await liveCall()
  sock.onmessage({ data: 'not json at all' })
  sock.onmessage({ data: JSON.stringify({ no: 'type' }) })
  sock.deliver({ type: 'some.future.event.we.do.not.know' })
  assert.strictEqual(call.live, true)
})

// ── the audio device layer ─────────────────────────────────────────────────

test('the recorder asks for exactly the wire format, quietly', () => {
  for (const backend of ['sox', 'ffmpeg']) {
    const { bin, args } = recordArgs(backend)
    assert.ok(bin)
    assert.ok(args.includes('24000') || args.join(' ').includes('24000'), 'rate must be the API rate')
    assert.strictEqual(args.at(-1), '-', 'PCM to stdout')
  }
  // A recorder writing a banner to stdout would be sent to the model as noise.
  assert.ok(recordArgs('sox').args.includes('-q'))
  assert.ok(recordArgs('ffmpeg').args.includes('error'))
})

test('ffmpeg gets -nostdin — otherwise the recorder eats the composer keystrokes', () => {
  assert.ok(recordArgs('ffmpeg').args.includes('-nostdin'))
})

test('a mic device name is an argv element, never a command line', () => {
  const { args } = recordArgs('ffmpeg', ':1; rm -rf /')
  assert.ok(args.includes(':1; rm -rf /'), 'passed as data to a shell-less spawn')
})

test('the player is configured for conversation latency, not for analysis', () => {
  const ff = playArgs('ffmpeg').args.join(' ')
  assert.match(ff, /nobuffer/)
  assert.match(ff, /low_delay/)
  assert.match(ff, /-nodisp/, 'no window from a terminal')
  assert.ok(playArgs('sox').args.includes('-q'))
})

test('frameLevel is 0 for silence and rises with amplitude', () => {
  assert.strictEqual(frameLevel(Buffer.alloc(0)), 0)
  assert.strictEqual(frameLevel(Buffer.alloc(480)), 0)
  const loud = Buffer.alloc(480)
  for (let i = 0; i < 240; i++) loud.writeInt16LE(8000, i * 2)
  assert.ok(frameLevel(loud) > frameLevel(Buffer.alloc(480)))
  assert.ok(frameLevel(loud) <= 1)
})

test('the backend probe answers with a real backend or an actionable refusal', () => {
  const b = detectBackend()
  assert.ok(b === null || b === 'sox' || b === 'ffmpeg')
})

/**
 * ── scar 5: the turn that never closes ─────────────────────────────────────
 *
 * Found by talking to the real API, not by reading the DO. On some utterances
 * OpenAI's semantic VAD sends `input_audio_buffer.speech_started` and then
 * nothing at all — no speech_stopped, no commit, no response, no error — while
 * the socket stays open and billed. Reproduced on a bare WebSocket with none of
 * this class in the path, so the only fix available to a client is to close the
 * turn itself. These tests pin the recovery, because the symptom (you talk, the
 * tiny never answers) is indistinguishable from "thinking" until you hang up.
 */
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))

test('a turn that the server never closes gets closed by us', async () => {
  const { call, sock } = await liveCall({ stallMs: 15 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  await settle()
  assert.ok(sock.has('input_audio_buffer.commit'), 'the input buffer must be committed by hand')
  assert.ok(sock.has('response.create'), 'and the answer asked for, or the call just sits there')
  assert.equal(call.stalledTurns, 1, 'a rescued turn is counted, like gated frames')
  call.stop()
})

test('a server that closes the turn itself is not second-guessed', async () => {
  const { call, sock } = await liveCall({ stallMs: 15 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  sock.deliver({ type: 'input_audio_buffer.speech_stopped' })
  await settle()
  assert.equal(sock.has('input_audio_buffer.commit'), false, 'a healthy turn must not get a second commit')
  assert.equal(sock.has('response.create'), false)
  assert.equal(call.stalledTurns, 0)
  call.stop()
})

test('a response already on its way disarms the watchdog', async () => {
  const { call, sock } = await liveCall({ stallMs: 15 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  sock.deliver({ type: 'response.created' })
  await settle()
  assert.equal(sock.has('input_audio_buffer.commit'), false, 'the model is answering — do not commit under it')
  call.stop()
})

test('hanging up disarms the watchdog — a dead call sends nothing', async () => {
  const { call, sock } = await liveCall({ stallMs: 15 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  call.stop()
  const after = sock.sent.length
  await settle()
  assert.equal(sock.sent.length, after, 'a stopped call must not wake up to commit a buffer')
})

test('the rescue is silent when the buffer turns out to be empty', async () => {
  const { call, sock, of } = await liveCall({ stallMs: 15 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  await settle()
  sock.deliver({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer is empty' } })
  assert.deepEqual(of('error'), [], 'a raced commit is our own bookkeeping, not a line on the screen')
  call.stop()
})

test('the watchdog can be switched off entirely', async () => {
  const { call, sock } = await liveCall({ stallMs: 0 })
  sock.deliver({ type: 'input_audio_buffer.speech_started' })
  await settle()
  assert.equal(sock.has('input_audio_buffer.commit'), false)
  call.stop()
})

/**
 * One spoken turn must be ONE entry in the typed session's history. A tool call
 * splits a turn into two responses on the wire (the call, then the spoken
 * result), and pairing each of them separately writes a question answered by
 * silence followed by an answer to a question nobody asked. Found on the first
 * live tool call, where the history read exactly that badly.
 */
test('a tool call in the middle does not split one spoken turn into two entries', async () => {
  const { call, sock, of } = await liveCall({
    tools: [{ toolSpec: { name: 'build', description: '', inputSchema: {} }, invoke: async () => 'passes' }],
  })
  sock.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'does the build pass?' })
  // Response 1: the tool call, no speech at all.
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'build', arguments: '{}' })
  sock.deliver({ type: 'response.done' })
  assert.strictEqual(of('turn').length, 0, 'a tool-only response is half a turn — do not log it yet')
  // Response 2: the model speaks the result.
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.output_audio_transcript.delta', delta: 'It passes.' })
  sock.deliver({ type: 'response.done' })
  assert.deepStrictEqual(of('turn'), [
    { type: 'turn', user: 'does the build pass?', assistant: 'It passes.', continuation: false },
  ], 'the question and the spoken answer belong to each other')
  call.stop()
})

test('a question left in the air when the line drops is still recorded', async () => {
  const { call, sock, of } = await liveCall()
  sock.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what time is it?' })
  sock.deliver({ type: 'response.created' })
  sock.deliver({ type: 'response.done' })          // tool-only: held, not emitted
  assert.strictEqual(of('turn').length, 0)
  call.stop()                                       // …and the call ends first
  assert.deepStrictEqual(of('turn'), [
    { type: 'turn', user: 'what time is it?', assistant: '', continuation: false },
  ])
})

// ── the ToolContext regression: voice could TALK but not DO ─────────────────
//
// Symptom, live: "test one of your tools" → "the tool context wasn't available."
// Cause: runTool called `tool.invoke(args)` with one argument. The SDK's vended
// tools take a ToolContext second — makeBash() reads `context.agent.sandbox` —
// and throw "Tool context is required for bash operations" without it. runTool
// catches that and hands it to the model, which speaks the failure as an
// apology, so a total wiring break sounds like a minor hiccup.
//
// Every fake tool above takes ONE parameter, which is exactly why the suite was
// green while bash and fileEditor were dead in every call. These two assert on
// the second argument, so the shape can't rot back.

test('a tool is invoked WITH a ToolContext — the vended tools refuse without one', async () => {
  const seen = []
  const agent = { sandbox: { execute: async () => ({ stdout: 'ok', stderr: '' }) } }
  const tools = [{
    toolSpec: { name: 'bash', description: 'run', inputSchema: { type: 'object', properties: {} } },
    // The real signature. A tool that needs the context and doesn't get one throws.
    invoke: async (input, context) => {
      if (!context) throw new Error('Tool context is required for bash operations')
      seen.push({ input, context })
      return await context.agent.sandbox.execute(input.command).then((r) => r.stdout)
    },
  }]
  const { sock } = await liveCall({ tools, agent })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c9', name: 'bash', arguments: '{"command":"pwd"}' })
  await new Promise((r) => setTimeout(r, 20))

  assert.strictEqual(seen.length, 1, 'the tool ran')
  const ctx = seen[0].context
  assert.strictEqual(ctx.agent, agent, 'and got the REAL agent — that is what carries the sandbox')
  assert.strictEqual(ctx.toolUse.name, 'bash')
  assert.strictEqual(ctx.toolUse.toolUseId, 'c9', 'the call_id doubles as the toolUseId')
  assert.deepStrictEqual(ctx.toolUse.input, { command: 'pwd' })
  assert.ok(ctx.invocationState, 'invocationState is present, per the ToolContext contract')
  const item = sock.ofType('conversation.item.create')[0]
  assert.strictEqual(item.item.output, 'ok', 'and the model hears the RESULT, not an excuse')
})

test('executeTool wins over the built-in invoke — the agent owns its own tools', async () => {
  // The TUI and the CLI both pass agent.invokeTool, so a spoken tool call runs
  // through the same seam as a typed one instead of a second, subtly different path.
  let via = 'none'
  const tools = [{
    toolSpec: { name: 'bash', description: '', inputSchema: {} },
    invoke: async () => { via = 'realtime-direct'; return 'wrong path' },
  }]
  const { sock } = await liveCall({ tools, executeTool: async (name) => { via = `agent:${name}`; return 'right path' } })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c10', name: 'bash', arguments: '{}' })
  await new Promise((r) => setTimeout(r, 20))
  assert.strictEqual(via, 'agent:bash')
  assert.strictEqual(sock.ofType('conversation.item.create')[0].item.output, 'right path')
})

test('executeTool may be synchronous — a string is as good as a promise', async () => {
  // OpenCallOptions typed it `Promise<string> | string` while RealtimeCallOptions
  // demanded a promise: the build went red between the two call sites.
  const { sock } = await liveCall({ executeTool: () => 'sync answer' })
  sock.deliver({ type: 'response.function_call_arguments.done', call_id: 'c11', name: 'whatever', arguments: '{}' })
  await new Promise((r) => setTimeout(r, 20))
  assert.strictEqual(sock.ofType('conversation.item.create')[0].item.output, 'sync answer')
})
