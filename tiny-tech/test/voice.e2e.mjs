/**
 * LIVE end-to-end check of the realtime speech-to-speech path.
 *
 *   npm run test:voice          # ~30s, needs OPENAI_API_KEY, costs a few cents
 *
 * NOT part of `npm test`/CI: it opens a real metered realtime session against
 * gpt-realtime. It is here because every bug this path has actually had was
 * invisible to the mocked suite — a session frame the API accepts and then
 * ignores, a turn the server's VAD never closes, a tool call that answers into
 * the void. test/realtime.test.mjs pins the behaviour; this proves the wire.
 *
 * The microphone is SYNTHETIC (macOS `say` → PCM16/24k, the exact mic format)
 * so the run is deterministic and needs no human in a quiet room, and the
 * speaker just counts bytes, so "it answered" is measured rather than heard.
 * Set E2E_PCM=/path/to/raw to feed your own 24 kHz mono PCM16 instead.
 *
 * It runs against the REAL mounted tool roster, executed through
 * agent.invokeTool — not a hand-made stub. That detail is the whole reason the
 * file exists: with a stub tool everything passed while the shipped product
 * could not run bash at all, because the SDK's vended tools refuse to run
 * without a ToolContext and a voice call cheerfully speaks the resulting error.
 *
 * What it proves, in one call:
 *   1. the GA dial works and the session goes live
 *   2. what we said comes back as text (the model really heard audio)
 *   3. audio comes BACK, by byte count
 *   4. the assistant transcript streams
 *   5. a REAL tool runs LOCALLY, on this machine, mid-call
 *   6. the tool's OUTPUT reaches the model and is spoken back
 *   7. one spoken exchange becomes one turn for the typed session
 *   8. talking over a reply CANCELS it — the model's own interrupt_response,
 *      which needs the mic to keep streaming while the tiny talks
 *
 * Exit code 0 = all green.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, unlinkSync } from 'node:fs'
import { RealtimeCall } from '../dist/agent/realtime.js'
import { TinyApi } from '../dist/api.js'
import { TinyAgent } from '../dist/agent/agent.js'

const pexec = promisify(execFile)
const BYTES_PER_MS = 48
const log = (...a) => console.log(...a)

if (!process.env.OPENAI_API_KEY) {
  log('skipped: this check needs OPENAI_API_KEY (a real realtime session).')
  process.exit(0)
}

/** Say a sentence into a PCM16/24k buffer — the exact format openMic produces. */
async function synthMic(text) {
  const aiff = `/tmp/voice-e2e-${Buffer.from(text).toString('hex').slice(0, 12)}.aiff`
  const raw = aiff.replace('.aiff', '.raw')
  await pexec('say', ['-o', aiff, text])
  await pexec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff,
    '-f', 's16le', '-ar', '24000', '-ac', '1', raw])
  const buf = readFileSync(raw)
  try { unlinkSync(aiff); unlinkSync(raw) } catch { /* best effort */ }
  return buf
}

// The REAL roster, executed the real way. A stub tool here would pass while the
// product was broken — that is exactly what happened once.
log('0. waking the agent (real tools)…')
const agent = new TinyAgent({ api: new TinyApi(), printer: false })
await agent.init()
const tools = agent.mountedTools
log(`   ${tools.length} tools mounted`)

// A token the shell prints and nothing else on this machine says, so finding it
// in the spoken answer proves tool output travelled model-wards and back.
const PROOF = 'tiny tech voice proof'
let toolRan = false
const executeTool = async (name, args) => {
  toolRan = true
  return await agent.invokeTool(name, args)
}

const seen = { status: [], heard: '', said: '', audioBytes: 0, turns: [], errors: [], toolCalls: [], toolOutput: '', barges: 0, flushes: 0, atBarge: '' }
let micPush = null

const call = new RealtimeCall({
  apiKey: process.env.OPENAI_API_KEY,
  context: 'You are being tested. Use tools when asked. Answer in one short sentence.',
  tools,
  executeTool,
  // Synthetic mic: hand back a Mic whose frames the script pushes itself.
  micFactory: (onFrame) => { micPush = onFrame; return { stop() { micPush = null } } },
  // A CI-safe speaker: count the audio instead of playing it.
  speakerFactory: () => {
    let bytes = 0
    return {
      get speaking() { return false },   // the synthetic mic cannot echo
      write(buf) { bytes += buf.length; seen.audioBytes = bytes },
      // A flush is the audible half of an interruption: bytes already handed to
      // a player have to stop playing. Counted, so barge-in is measurable.
      flush() { seen.flushes++ }, close() {},
    }
  },
  fullDuplex: true,
  onEvent: (e) => {
    switch (e.type) {
      case 'status': seen.status.push(e.status); log('  ·', e.status); break
      case 'user_transcript': seen.heard = e.text; log('  heard:', JSON.stringify(e.text)); break
      case 'assistant_transcript': seen.said += e.delta; break
      case 'tool_call': seen.toolCalls.push(e.name); log('  tool_call:', e.name, JSON.stringify(e.args)); break
      case 'tool_result': seen.toolOutput += e.output; log('  tool_result:', e.output.replace(/\s+/g, ' ').slice(0, 100)); break
      case 'response_done': log('  said:', JSON.stringify(seen.said.trim())); break
      case 'turn': seen.turns.push(e); log('  turn:', JSON.stringify({ user: e.user.slice(0, 50), assistant: e.assistant.slice(0, 50), continuation: e.continuation })); break
      case 'barge_in': seen.barges++; seen.atBarge = seen.said; log('  barge_in (cut off at:', JSON.stringify(seen.said.trim().slice(-40)) + ')'); break
      case 'error': seen.errors.push(e.error); log('  ERROR:', e.error); break
      default: break // level fires every 20ms
    }
  },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Feed a buffer in 20 ms frames, at real time, exactly like a microphone. */
let pushed = 0
async function speak(buf) {
  const frame = 20 * BYTES_PER_MS
  for (let i = 0; i < buf.length; i += frame) {
    if (!micPush) throw new Error('the mic closed mid-sentence')
    micPush(buf.subarray(i, i + frame)); pushed++
    await sleep(20)
  }
  // Trailing silence, so the server's VAD hears the end of the sentence.
  const silence = Buffer.alloc(frame)
  for (let i = 0; i < 50; i++) { micPush?.(silence); await sleep(20) }
}

const line = `Run the shell command echo ${PROOF} and tell me exactly what it printed.`

log('1. dialling…')
await call.start()
if (!call.live) throw new Error('the call did not go live')

log(`2. speaking: "${line}"`)
const pcm = process.env.E2E_PCM ? readFileSync(process.env.E2E_PCM) : await synthMic(line)
log(`   (${(pcm.length / BYTES_PER_MS / 1000).toFixed(2)}s of synthetic speech)`)
await speak(pcm)

log('3. waiting for the answer…')
for (let i = 0; i < 150 && seen.turns.length === 0; i++) await sleep(200)
await sleep(2000)   // let the spoken answer finish arriving

// ── phase 2: interrupt it mid-sentence ─────────────────────────────────────
// The point of this phase: interruption is the MODEL's, not ours — semantic VAD
// with interrupt_response cancels the reply server-side the moment it hears a
// person. All the client owes it is the audio, which is exactly what the old
// half-duplex default withheld: the mic was muted while the tiny talked, so a
// person could not interrupt at all and it looked like the model ignoring them.
log('4. barge-in: asking for a long answer, then talking over it')
// Phase 1's verdict is read from a snapshot: `heard`/`said` are live fields and
// the next two utterances overwrite them, which failed two green checks once.
const phase1 = { heard: seen.heard, said: seen.said }
const bargesBefore = seen.barges
seen.said = ''
await speak(await synthMic('Please count slowly from one to thirty, saying every number out loud.'))
for (let i = 0; i < 100 && seen.said.trim().length < 12; i++) await sleep(100)   // wait until it is talking
const talking = seen.said.trim().length > 0
log(`   it is talking: ${JSON.stringify(seen.said.trim().slice(0, 40))}`)
await speak(await synthMic('Stop. Forget the counting and just say the word okay.'))
for (let i = 0; i < 100 && seen.barges === bargesBefore; i++) await sleep(100)
await sleep(2500)
const cutOff = seen.atBarge
log(`   after the interruption it said: ${JSON.stringify(seen.said.trim().slice(0, 80))}`)

log('5. hanging up')
call.stop()
await sleep(200)

// ── verdict ────────────────────────────────────────────────────────────────
const checks = [
  ['the session went live', seen.status[0] === 'connecting' && seen.status.includes('live')],
  ['our speech was transcribed', /shell|command|echo|print/i.test(phase1.heard)],
  ['audio came back', seen.audioBytes > 20000],
  ['the assistant transcript streamed', phase1.said.trim().length > 5],
  ['a REAL mounted tool ran on this machine', toolRan && seen.toolCalls.length > 0],
  ['the tool ran without a ToolContext error', !/tool context is required/i.test(seen.toolOutput)],
  ['the tool output came back spoken', new RegExp(PROOF.replace(/ /g, '[ -]?'), 'i').test(phase1.said)],
  ['the exchange became a turn for the typed session', seen.turns.length > 0 && seen.turns[0].assistant.length > 0],
  ['it answered the long question out loud', talking],
  ['talking over it registered as a barge-in', seen.barges > bargesBefore],
  ['the audio already queued was flushed — it stopped being audible', seen.flushes > 0],
  ['it never finished counting — the reply really was cancelled', !/thirty/i.test(cutOff)],
  ['it answered the interruption instead of the question it was on', /okay|ok\b/i.test(seen.said)],
  ['no errors surfaced', seen.errors.length === 0],
]
log('\n─── verdict ───')
let ok = true
for (const [name, pass] of checks) { log(`${pass ? '✅' : '❌'} ${name}`); if (!pass) ok = false }
log(`\n${pushed} frames in · ${seen.audioBytes} bytes back ≈ ${(seen.audioBytes / BYTES_PER_MS / 1000).toFixed(1)}s of speech`)
if (call.stalledTurns) log(`${call.stalledTurns} turn(s) the server never closed, rescued by the stall watchdog`)
process.exit(ok ? 0 : 1)
