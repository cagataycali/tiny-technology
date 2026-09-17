/**
 * 📡 The relay reply contract — what a device actually sends back (loop d-d).
 *
 * handleEnvelope is the whole device side of use_device: run the prompt on a
 * fresh local agent, PATCH the answer. Two things must hold or a finished job
 * is silently lost: the envelope has to FIT the worker's 8KB limit (a rejected
 * PATCH looks exactly like a device that never replied), and an agent that made
 * images has to send them — until now the reply was string-only, so a
 * screenshot could not leave the machine that took it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-relay-'))
process.env.TINY_HOME = home

const { handleEnvelope } = await import('../dist/mesh/relay-poller.js')

const realFetch = globalThis.fetch
after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }) })

const device = { version: 1, deviceId: 'dev-1', token: 'tind_x', name: 'box', apiUrl: 'https://tiny.example', enrolledAt: 1 }

/** Run one envelope against a recorded PATCH; returns the parsed reply payload. */
async function reply(agent, envelopePayload = JSON.stringify({ type: 'invoke', prompt: 'hi' })) {
  const patches = []
  globalThis.fetch = async (_url, init) => {
    patches.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  await handleEnvelope(device, 'https://tiny.example', { id: 'env-1', payload: envelopePayload }, {
    agentFactory: async () => agent,
  })
  assert.equal(patches.length, 1, 'exactly one reply per envelope')
  assert.equal(patches[0].inReplyTo, 'env-1')
  return { payload: JSON.parse(patches[0].payload), raw: patches[0].payload }
}

test('a text-only agent replies exactly as it always did', async () => {
  const { payload } = await reply({ invoke: async (q) => `you said ${q}` })
  assert.deepEqual(payload, { result: 'you said hi' })
})

test('an agent with invokeWithMedia sends its images along', async () => {
  const { payload } = await reply({
    invoke: async () => 'unused',
    invokeWithMedia: async (q) => ({
      text: `looked at the screen for "${q}"`,
      images: [{ url: 'https://plugin.tiny.technology/media/a.png', format: 'png' }],
    }),
  })
  assert.match(payload.result, /looked at the screen/)
  assert.deepEqual(payload.images, [{ url: 'https://plugin.tiny.technology/media/a.png', format: 'png' }])
})

test('invokeWithMedia is PREFERRED — invoke must not run twice', async () => {
  // Running both would execute the user's request a second time (shell
  // commands, sends, deletes) — a double side effect, not just wasted tokens.
  let plain = 0
  const { payload } = await reply({
    invoke: async () => { plain++; return 'plain' },
    invokeWithMedia: async () => ({ text: 'rich', images: [] }),
  })
  assert.equal(plain, 0)
  assert.equal(payload.result, 'rich')
})

test('a huge reply is shrunk to a payload the worker will ACCEPT', async () => {
  // 9000 newlines slice to 9000 chars but SERIALIZE to 18000 — the old
  // slice-then-stringify order produced an envelope over the 8192-byte cap,
  // which the worker rejected wholesale. The reply then never existed.
  const { payload, raw } = await reply({ invoke: async () => '\n'.repeat(9000) })
  assert.ok(raw.length <= 8000, `payload was ${raw.length}`)
  assert.match(payload.result, /…$/)
})

test('an agent that throws still replies — with the error, not silence', async () => {
  const { payload } = await reply({ invoke: async () => { throw new Error('model unreachable') } })
  assert.match(payload.result, /Error: model unreachable/)
})

test('a media-capable agent that throws falls back to an error reply', async () => {
  const { payload } = await reply({
    invoke: async () => 'never',
    invokeWithMedia: async () => { throw new Error('upload exploded') },
  })
  assert.match(payload.result, /Error: upload exploded/)
})

test('an unknown envelope type is answered, not dropped', async () => {
  const { payload } = await reply({ invoke: async () => 'x' }, JSON.stringify({ type: 'reboot' }))
  assert.match(payload.result, /unsupported envelope type: reboot/)
})

test('an unparseable envelope is answered too (the sender is waiting)', async () => {
  const { payload } = await reply({ invoke: async () => 'x' }, '{not json')
  assert.match(payload.result, /^Error:/)
})

// ── backoff on error STATUS, not just on network failure ────────────────────
// fetch REJECTS on a network failure but RESOLVES on 500/502/429, so an error
// status used to take the success path: failures reset to 0, no backoff, another
// PUT every 5s indefinitely, from every enrolled device at once. The ladder that
// exists for network blips never engaged for the outage most likely to need it,
// and 429 — the one response whose entire meaning is "slow down" — was ignored.

const { startRelayPoller } = await import('../dist/mesh/relay-poller.js')

// startRelayPoller reads the enrolled identity off disk (handleEnvelope above is
// handed one directly), so these need a device.json in the temp TINY_HOME.
writeFileSync(join(home, 'device.json'), JSON.stringify(device))

/** Poll for `ms` against a fetch that always answers `status`; count the PUTs. */
async function pollsIn(ms, status, body = { messages: [] }) {
  let puts = 0
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') puts++
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  const h = startRelayPoller({ agentFactory: async () => ({ invoke: async () => 'x' }), pollIntervalMs: 5 })
  assert.ok(h, 'the device is enrolled, so the poller started')
  await new Promise((r) => setTimeout(r, ms))
  h.stop()
  return puts
}

test('a healthy relay is polled at full rate', async () => {
  const puts = await pollsIn(200, 200)
  assert.ok(puts > 10, `expected steady polling, got ${puts} PUTs in 200ms`)
})

test('a 500ing relay is backed off instead of hammered', async () => {
  const healthy = await pollsIn(200, 200)
  const broken = await pollsIn(200, 500)
  assert.ok(broken < healthy / 2,
    `500 must throttle: ${broken} PUTs vs ${healthy} healthy in the same window`)
})

test('429 — the response that MEANS slow down — actually slows it down', async () => {
  const broken = await pollsIn(200, 429)
  assert.ok(broken < 12, `429 must back off, got ${broken} PUTs in 200ms`)
})

test('401 still stops the poller outright rather than backing off', async () => {
  let stopped = null
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  const h = startRelayPoller({
    agentFactory: async () => ({ invoke: async () => 'x' }),
    pollIntervalMs: 5,
    onStop: (r) => { stopped = r },
  })
  await new Promise((r) => setTimeout(r, 60))
  h.stop()
  assert.match(stopped || '', /revoked/, 'a revoked device stops, it does not retry')
})

test('a relay that recovers resets the ladder', async () => {
  // Otherwise one bad patch would leave the device permanently slow.
  let puts = 0
  let status = 500
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') puts++
    return { ok: status < 300, status, json: async () => ({ messages: [] }) }
  }
  const h = startRelayPoller({ agentFactory: async () => ({ invoke: async () => 'x' }), pollIntervalMs: 5 })
  await new Promise((r) => setTimeout(r, 120))
  const whileBroken = puts
  status = 200
  await new Promise((r) => setTimeout(r, 200))
  const afterRecovery = puts - whileBroken
  h.stop()
  assert.ok(afterRecovery > whileBroken,
    `recovery must speed back up: ${whileBroken} PUTs while broken, ${afterRecovery} after`)
})
