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
import { mkdtempSync, rmSync } from 'node:fs'
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
