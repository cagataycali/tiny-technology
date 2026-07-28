/**
 * Mesh tests — protocol shapes + peer table, no real zenoh session.
 * (Live mesh round-trips are covered by manual smoke — CI has no multicast.)
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { MeshNode } from '../dist/mesh/zenoh.js'

test('mesh: instance id shape {host}-{6hex}', () => {
  const m = new MeshNode()
  assert.match(m.instanceId, /^.+-[0-9a-f]{6}$/)
})

test('mesh: explicit instanceId honored', () => {
  const m = new MeshNode({ instanceId: 'test-abc123' })
  assert.strictEqual(m.instanceId, 'test-abc123')
})

test('mesh: presence handling — add, refresh, ignore self, expire stale', () => {
  const m = new MeshNode({ instanceId: 'me-000000' })
  const priv = m
  // simulate presence messages through the private handler
  priv['onPresence']({ instance_id: 'peer-1', hostname: 'box1', model: 'x' })
  priv['onPresence']({ instance_id: 'me-000000', hostname: 'self' }) // self — ignored
  priv['onPresence']({ instance_id: 'peer-2', hostname: 'box2' })
  let peers = m.listPeers()
  assert.strictEqual(peers.length, 2)
  assert.ok(!peers.find((p) => p.instanceId === 'me-000000'))

  // stale expiry
  const p1 = peers.find((p) => p.instanceId === 'peer-1')
  p1.lastSeen = Date.now() - 60_000
  peers = m.listPeers()
  assert.strictEqual(peers.length, 1)
  assert.strictEqual(peers[0].instanceId, 'peer-2')
})

test('mesh: response aggregation — stream chunks + turn_end resolve', async () => {
  const m = new MeshNode({ instanceId: 'me-000000' })
  // fake a running session so dispatch works, capture publishes
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  const resultPromise = m.send('peer-9', 'do the thing', 2000)
  // grab the turn id from the outgoing publish
  await new Promise((r) => setTimeout(r, 50))
  const sent = published.find((p) => p.k === 'devduck/cmd/peer-9')
  assert.ok(sent, 'command published to devduck/cmd/peer-9')
  assert.strictEqual(sent.v.sender_id, 'me-000000')
  const turnId = sent.v.turn_id

  // simulate the remote: ack → stream chunks → turn_end
  m['onResponse']({ type: 'ack', responder_id: 'peer-9', turn_id: turnId })
  m['onResponse']({ type: 'stream', responder_id: 'peer-9', turn_id: turnId, data: 'hel' })
  m['onResponse']({ type: 'stream', responder_id: 'peer-9', turn_id: turnId, data: 'lo' })
  m['onResponse']({ type: 'turn_end', responder_id: 'peer-9', turn_id: turnId, result: 'hello' })

  const results = await resultPromise
  assert.strictEqual(results.length, 1)
  assert.strictEqual(results[0].responder, 'peer-9')
  assert.strictEqual(results[0].result, 'hello')
})

test('mesh: error response resolves with Error text', async () => {
  const m = new MeshNode({ instanceId: 'me-000000' })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  const p = m.broadcast('boom', 2000)
  await new Promise((r) => setTimeout(r, 50))
  const sent = published.find((x) => x.k === 'devduck/broadcast')
  m['onResponse']({ type: 'error', responder_id: 'peer-x', turn_id: sent.v.turn_id, error: 'nope' })
  const results = await p
  assert.strictEqual(results[0].result, 'Error: nope')
})

test('mesh: incoming command — no agentFactory → error response on the wire', async () => {
  const m = new MeshNode({ instanceId: 'me-000000' })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  await m['onCommand']({ sender_id: 'peer-2', turn_id: 't1', command: 'hi' })
  const keys = published.map((p) => p.k)
  assert.ok(keys.every((k) => k === 'devduck/response/peer-2/t1'))
  const types = published.map((p) => p.v.type)
  assert.deepStrictEqual(types, ['ack', 'error'])
})

test('mesh: incoming command — agentFactory runs, streams + turn_end', async () => {
  const m = new MeshNode({
    instanceId: 'me-000000',
    agentFactory: async () => ({ invoke: async (q) => `echo:${q}` }),
  })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  await m['onCommand']({ sender_id: 'peer-2', turn_id: 't2', command: 'ping' })
  const types = published.map((p) => p.v.type)
  assert.deepStrictEqual(types, ['ack', 'stream', 'turn_end'])
  const end = published.find((p) => p.v.type === 'turn_end')
  assert.strictEqual(end.v.result, 'echo:ping')
})

test('mesh: own commands ignored (no self-execution loop)', async () => {
  const m = new MeshNode({ instanceId: 'me-000000', agentFactory: async () => ({ invoke: async () => 'x' }) })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }
  await m['onCommand']({ sender_id: 'me-000000', turn_id: 't3', command: 'loop' })
  assert.strictEqual(published.length, 0)
})
