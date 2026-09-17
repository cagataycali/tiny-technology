/**
 * 📡 use_device — the local agent's hand into the user's OTHER enrolled
 * devices, through the session-verb relay proxies (Bearer token, no worker
 * key on this machine).
 *
 * These tests pin the contracts that got the web tool burned:
 *  - `online: null` (endpoint device) must SURVIVE the projection — coercing
 *    it to false makes the model call a healthy robot offline and refuse it.
 *  - `capabilities` must be in the projection at all (the web tool once
 *    dropped it, and the model guessed device powers from names).
 *  - a duplicated name marks the stale row `superseded` — an age is a fact
 *    the model has to interpret; the row that IS the device is a verdict.
 *  - a timeout is a pending TICKET, not an error: the mailbox keeps the
 *    reply ~24h and action:'result' redeems it later.
 *  - media URLs from a reply are fetched ONLY from the trusted media origin —
 *    anything else is a device feeding arbitrary bytes to the model.
 *  - invoking THIS machine is refused: that envelope would sit in the mailbox
 *    this same process polls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  makeUseDeviceTool, isDeviceMediaUrl, parseCapabilities, duplicateRoles,
  projectDevices, deviceReplyBlocks,
} = await import('../dist/agent/device-invoke.js')

const cbOf = (t) => t.callback ?? t.handler ?? t.fn ?? t._callback

/** Minimal DeviceApi double: canned GET responses per path prefix + a log. */
function fakeApi({ gets = {}, postStatus } = {}) {
  const calls = []
  return {
    calls,
    async get(path) {
      calls.push(['get', path])
      for (const [prefix, val] of Object.entries(gets)) {
        if (path.startsWith(prefix)) return typeof val === 'function' ? val(path) : val
      }
      return { ok: false, error: `unexpected GET ${path}` }
    },
    async postStatus(path, body) {
      calls.push(['post', path, body])
      if (!postStatus) throw new Error(`unexpected POST ${path}`)
      return postStatus(path, body)
    },
  }
}

// Fast polling for every invoke test: 2 tries × 5ms instead of 15 × 3s.
const FAST = { pollTries: 2, pollMs: 5, selfDeviceId: () => 'dev_self' }

// ─── list projection ─────────────────────────────────────────────────────────

test('list: projects capabilities, preserves online:null for endpoint devices', async () => {
  const now = Math.floor(Date.now() / 1000)
  const api = fakeApi({
    gets: {
      '/api/devices': {
        ok: true,
        devices: [
          { id: 'd1', name: 'mac', kind: 'daemon', platform: 'darwin-arm64', capabilities: '["computer","apple"]', online: 1, last_seen: now - 10 },
          { id: 'd2', name: 'printer', kind: 'endpoint', platform: 'bambu-x2d', capabilities: null, online: null, last_seen: null, url: 'https://printer.local' },
        ],
      },
    },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'list' })
  assert.equal(out.ok, true)
  const [mac, printer] = out.devices

  assert.deepEqual(mac.capabilities, ['computer', 'apple'], 'JSON-string capabilities column is parsed')
  assert.equal(mac.online, true)
  assert.ok(mac.last_seen_seconds_ago >= 10 && mac.last_seen_seconds_ago < 15)

  assert.strictEqual(printer.online, null, 'endpoint online:null must NOT be coerced to false')
  assert.match(printer.note, /reachability unknown/)
  assert.deepEqual(printer.capabilities, [], 'null capabilities normalize to []')
  assert.equal(printer.url, 'https://printer.local')
  assert.strictEqual(printer.last_seen_seconds_ago, null)
})

test('list: newest last_seen wins per duplicated name — older row is superseded', async () => {
  const api = fakeApi({
    gets: {
      '/api/devices': {
        ok: true,
        devices: [
          { id: 'old', name: 'cagatay-iphone', kind: 'daemon', capabilities: '["chat"]', online: 0, last_seen: 100 },
          { id: 'new', name: 'Cagatay-iPhone ', kind: 'daemon', capabilities: '["chat","screenshot"]', online: 1, last_seen: 200 },
          { id: 'solo', name: 'mac', kind: 'daemon', capabilities: '[]', online: 1, last_seen: 150 },
        ],
      },
    },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'list' })
  const by = Object.fromEntries(out.devices.map((d) => [d.id, d]))
  assert.equal(by.old.superseded, true, 'stale duplicate carries the verdict')
  assert.match(by.old.note_superseded, /OLDER enrollment/)
  assert.equal(by.new.current_for_name, true)
  assert.equal(by.new.superseded, undefined)
  assert.equal(by.solo.superseded, undefined, 'unique names carry no extra field')
  assert.equal(by.solo.current_for_name, undefined)
})

test('list: passes the route error sentence through', async () => {
  const api = fakeApi({ gets: { '/api/devices': { ok: false, error: 'registry not deployed' } } })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'list' })
  assert.deepEqual(out, { ok: false, error: 'registry not deployed' })
})

// ─── invoke ──────────────────────────────────────────────────────────────────

test('invoke: happy path — send, poll, reply comes back parsed', async () => {
  let polls = 0
  const api = fakeApi({
    gets: {
      '/api/devices/relay?inReplyTo=env_1': () => {
        polls++
        return polls < 2
          ? { ok: true, reply: null }
          : { ok: true, reply: { payload: JSON.stringify({ result: { answer: 42 } }) } }
      },
    },
    postStatus: (path, body) => {
      assert.equal(path, '/api/devices/relay')
      assert.equal(body.toDevice, 'dev_2')
      assert.deepEqual(JSON.parse(body.payload), { type: 'invoke', prompt: 'uptime' })
      return { status: 200, body: { ok: true, id: 'env_1' } }
    },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_2', prompt: 'uptime' })
  assert.equal(out.ok, true)
  assert.equal(out.envelope_id, 'env_1')
  assert.deepEqual(out.result, { answer: 42 })
})

test('invoke: no reply within budget → pending ticket, not an error', async () => {
  const api = fakeApi({
    gets: { '/api/devices/relay?inReplyTo=': { ok: true, reply: null } },
    postStatus: () => ({ status: 200, body: { ok: true, id: 'env_slow' } }),
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_2', prompt: 'build it' })
  assert.equal(out.ok, true, 'a slow device is NOT a failure')
  assert.equal(out.pending, true)
  assert.equal(out.envelope_id, 'env_slow')
  assert.match(out.note, /env_slow/, 'the note hands the model its own redeem call')
  // Polls only — the one extra GET is the kind lookup (/api/devices), not a poll.
  assert.equal(api.calls.filter(([v, p]) => v === 'get' && p.startsWith('/api/devices/relay')).length, 2, 'polled exactly pollTries times')
})

test('invoke: wait:false returns the ticket immediately, zero polls', async () => {
  const api = fakeApi({ postStatus: () => ({ status: 200, body: { ok: true, id: 'env_bg' } }) })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_2', prompt: 'long task', wait: false })
  assert.equal(out.pending, true)
  assert.equal(out.background, true)
  assert.equal(out.envelope_id, 'env_bg')
  assert.equal(api.calls.filter(([v, p]) => v === 'get' && p.startsWith('/api/devices/relay')).length, 0, 'fire-and-forget never polls')
})

test('invoke: the relay route error sentence passes through (404 no such device)', async () => {
  const api = fakeApi({ postStatus: () => ({ status: 404, body: { ok: false, error: 'no such device' } }) })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_gone', prompt: 'hi' })
  assert.deepEqual(out, { ok: false, device_id: 'dev_gone', error: 'no such device' })
})

test('invoke: refuses to relay to THIS machine', async () => {
  const api = fakeApi({ postStatus: () => { throw new Error('must not send') } })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_self', prompt: 'hi' })
  assert.equal(out.ok, false)
  assert.match(out.note, /this machine/)
  assert.equal(api.calls.length, 0, 'refused before any network call')
})

test('invoke: missing device_id/prompt refused', async () => {
  const out = await cbOf(makeUseDeviceTool(fakeApi(), FAST))({ action: 'invoke', device_id: 'dev_2' })
  assert.equal(out.ok, false)
  assert.match(out.error, /device_id and prompt required/)
})

// ─── result ──────────────────────────────────────────────────────────────────

test('result: redeems a parked reply; non-JSON payload comes back verbatim', async () => {
  const api = fakeApi({
    gets: { '/api/devices/relay?inReplyTo=env_9': { ok: true, reply: { payload: 'plain prose answer' } } },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'result', envelope_id: 'env_9' })
  assert.equal(out.ok, true)
  assert.equal(out.result, 'plain prose answer')
  assert.equal(out.envelope_id, 'env_9')
})

test('result: missing reply → pending note (kept ~24h), and envelope_id required', async () => {
  const api = fakeApi({ gets: { '/api/devices/relay?inReplyTo=': { ok: true, reply: null } } })
  const cb = cbOf(makeUseDeviceTool(api, FAST))
  const out = await cb({ action: 'result', envelope_id: 'env_x' })
  assert.equal(out.pending, true)
  assert.match(out.note, /~24h/)
  const bad = await cb({ action: 'result' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /envelope_id required/)
})

// ─── media contract ──────────────────────────────────────────────────────────

test('isDeviceMediaUrl: only https on the media origin with a /media/<name> path', () => {
  assert.equal(isDeviceMediaUrl('https://plugin.tiny.technology/media/shot-1.png'), true)
  assert.equal(isDeviceMediaUrl('https://plugin.tiny.technology/media/a.b_c-d.jpeg'), true)
  // Everything a hostile reply might try:
  assert.equal(isDeviceMediaUrl('http://plugin.tiny.technology/media/x.png'), false, 'plain http')
  assert.equal(isDeviceMediaUrl('https://evil.example.com/media/x.png'), false, 'foreign origin')
  assert.equal(isDeviceMediaUrl('https://plugin.tiny.technology/api/me'), false, 'non-media path')
  assert.equal(isDeviceMediaUrl('https://plugin.tiny.technology/media/../secrets'), false, 'traversal')
  assert.equal(isDeviceMediaUrl('https://plugin.tiny.technology/media/a/b.png'), false, 'nested path')
  assert.equal(isDeviceMediaUrl(''), false)
  assert.equal(isDeviceMediaUrl(null), false)
  assert.equal(isDeviceMediaUrl('not a url'), false)
})

test('deviceReplyBlocks: image blocks first, text with hosted URLs last; foreign URLs never fetched', async () => {
  const fetched = []
  const fakeFetch = async (url) => {
    fetched.push(url)
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  }
  const blocks = await deviceReplyBlocks('here is the screen', [
    { url: 'https://plugin.tiny.technology/media/a.png', format: 'png' },
    { url: 'https://evil.example.com/media/b.png', format: 'png' },
    { url: 'https://plugin.tiny.technology/media/c.jpg', format: 'jpeg' },
  ], fakeFetch)

  assert.deepEqual(fetched, [
    'https://plugin.tiny.technology/media/a.png',
    'https://plugin.tiny.technology/media/c.jpg',
  ], 'the foreign origin was filtered BEFORE fetch, not after')
  assert.equal(blocks.length, 3, '2 images + 1 text')
  assert.equal(blocks[0].image.format, 'png')
  assert.equal(blocks[0].image.source.bytes, Buffer.from([1, 2, 3]).toString('base64'), 'imageBlock shape: base64 string bytes')
  assert.equal(blocks[1].image.format, 'jpeg')
  assert.match(blocks[2].text, /here is the screen/)
  assert.match(blocks[2].text, /media\/a\.png.*media\/c\.jpg/s, 'hosted URLs listed for embedding')
})

test('deviceReplyBlocks: failed fetch degrades to text-only (null), invalid-only input is null', async () => {
  const deadFetch = async () => { throw new Error('net down') }
  assert.equal(await deviceReplyBlocks('answer', [{ url: 'https://plugin.tiny.technology/media/x.png', format: 'png' }], deadFetch), null,
    'the device\'s text answer must not be lost because a GET failed')
  assert.equal(await deviceReplyBlocks('answer', [{ url: 'https://evil.example.com/media/x.png' }], deadFetch), null)
  assert.equal(await deviceReplyBlocks('answer', undefined, deadFetch), null)
})

test('invoke: a reply with images returns SEEN blocks, not a prose result', async () => {
  const api = fakeApi({
    gets: {
      '/api/devices/relay?inReplyTo=env_img': {
        ok: true,
        reply: { payload: JSON.stringify({ result: 'screenshot taken', images: [{ url: 'https://plugin.tiny.technology/media/s.png', format: 'png' }] }) },
      },
    },
    postStatus: () => ({ status: 200, body: { ok: true, id: 'env_img' } }),
  })
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer })
  const out = await cbOf(makeUseDeviceTool(api, { ...FAST, fetchImpl: fakeFetch }))({ action: 'invoke', device_id: 'dev_2', prompt: 'look at your screen' })
  assert.ok(Array.isArray(out), 'content blocks, not an object')
  assert.ok(out[0].image, 'the model sees the pixels')
  assert.match(out.at(-1).text, /screenshot taken/)
})

// ─── pure helpers ────────────────────────────────────────────────────────────

test('parseCapabilities: string/array/null/garbage', () => {
  assert.deepEqual(parseCapabilities('["A"," chat ",""]'), ['a', 'chat'])
  assert.deepEqual(parseCapabilities(['Shell']), ['shell'])
  assert.deepEqual(parseCapabilities(null), [])
  assert.deepEqual(parseCapabilities('not json'), [])
  assert.deepEqual(parseCapabilities(42), [])
})

test('duplicateRoles: never-seen rows in a duplicated group are superseded; projectDevices is pure', () => {
  const roles = duplicateRoles([
    { id: 'a', name: 'phone', last_seen: 100 },
    { id: 'b', name: 'phone', last_seen: null },
  ])
  assert.equal(roles.get('a'), 'current')
  assert.equal(roles.get('b'), 'superseded')

  const projected = projectDevices([{ id: 'x', name: 'n', kind: 'daemon', online: 0, last_seen: 900 }], 1000)
  assert.equal(projected[0].last_seen_seconds_ago, 100, 'nowSeconds is a parameter, so the age is pinned')
  assert.equal(projected[0].online, false)
})

// ─── endpoint devices: dialed out to, never relayed ──────────────────────────

test('invoke: an endpoint device takes the endpoint/chat door, never the relay mailbox', async () => {
  const api = fakeApi({
    gets: {
      '/api/devices': { ok: true, devices: [
        { id: 'arm_1', name: 'fomo-the-arm', kind: 'endpoint', platform: 'strands-arm', online: null, url: 'https://arm.example' },
        { id: 'dev_2', name: 'mac', kind: 'cli', online: true },
      ] },
    },
    postStatus: (path, body) => {
      assert.equal(path, '/api/devices/endpoint/chat')
      assert.deepEqual(body, { deviceId: 'arm_1', prompt: 'tilt?' })
      return { status: 200, body: { ok: true, result: 'tilt is 95.4°' } }
    },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'arm_1', prompt: 'tilt?' })
  assert.deepEqual(out, { ok: true, device_id: 'arm_1', device: 'fomo-the-arm', result: 'tilt is 95.4°' })
  assert.ok(!api.calls.some(([m, p]) => m === 'post' && p === '/api/devices/relay'), 'no envelope was sent')
})

test('invoke: endpoint failures keep the three kinds apart, named after the device', async () => {
  const mk = (body, status = 502) => fakeApi({
    gets: { '/api/devices': { ok: true, devices: [{ id: 'arm_1', name: 'fomo-the-arm', kind: 'endpoint' }] } },
    postStatus: () => ({ status, body }),
  })
  const call = (api) => cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'arm_1', prompt: 'x' })
  let out = await call(mk({ ok: false, error: 'no answer', timeout: true }, 504))
  assert.equal(out.ok, false); assert.match(out.note, /still working/); assert.match(out.note, /fomo-the-arm/)
  out = await call(mk({ ok: false, error: 'down', unreachable: true }))
  assert.match(out.note, /unreachable/)
  out = await call(mk({ ok: false, error: '401', unauthorized: true }))
  assert.match(out.note, /re-enroll/)
})

test('invoke: a pull device still relays even when the device list is available', async () => {
  const api = fakeApi({
    gets: {   // fakeApi matches by prefix in order: the poll path goes first
      '/api/devices/relay?inReplyTo=env_9': { ok: true, reply: { payload: JSON.stringify({ result: 'up 3d' }) } },
      '/api/devices': { ok: true, devices: [{ id: 'dev_2', name: 'mac', kind: 'cli', online: true }] },
    },
    postStatus: (path) => { assert.equal(path, '/api/devices/relay'); return { status: 200, body: { ok: true, id: 'env_9' } } },
  })
  const out = await cbOf(makeUseDeviceTool(api, FAST))({ action: 'invoke', device_id: 'dev_2', prompt: 'uptime' })
  assert.equal(out.result, 'up 3d')
})
