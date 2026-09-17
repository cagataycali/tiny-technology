/**
 * Mesh tests — protocol shapes + peer table, no real zenoh session.
 * (Live mesh round-trips are covered by manual smoke — CI has no multicast.)
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { MeshNode } from '../dist/mesh/zenoh.js'
import { IDENTITY_MAX_CHARS, TOOLS_MAX } from '../dist/mesh/registry.js'
import { makeMeshTools } from '../dist/mesh/tools.js'

// No test may touch the real /tmp/tiny registry: these suites used to leave
// `peer-1`/`peer-2` in the live mesh table of whatever machine ran them.
const noRegistry = { register() {}, heartbeat() {}, unregister() {}, live: () => [] }

test('mesh: instance id shape {host}-{6hex}', () => {
  const m = new MeshNode({ registry: noRegistry })
  assert.match(m.instanceId, /^.+-[0-9a-f]{6}$/)
})

test('mesh: explicit instanceId honored', () => {
  const m = new MeshNode({ instanceId: 'test-abc123', registry: noRegistry })
  assert.strictEqual(m.instanceId, 'test-abc123')
})

test('mesh: presence handling — add, refresh, ignore self, expire stale', () => {
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
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
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
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
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
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
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
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

// ── Auto-discovery additions ────────────────────────────────────────────────

test('mesh: rich presence captured + join/leave callbacks fire', () => {
  const joined = []
  const left = []
  const m = new MeshNode({
    instanceId: 'me-000000',
    registry: false,
    onPeerJoin: (p) => joined.push(p),
    onPeerLeave: (p) => left.push(p),
  })
  m['onPresence']({
    instance_id: 'peer-1', hostname: 'box1', model: 'tiny-tech (bedrock)',
    tools: ['bash', 'use_computer'], tool_count: 2, system_prompt: 'tiny — 2 tools',
    cwd: '/tmp', platform: 'darwin-arm64', started: '2026-01-01T00:00:00Z', node_version: 'v22.14.0',
  })
  m['onPresence']({ instance_id: 'peer-1', hostname: 'box1' }) // heartbeat, not a join
  assert.strictEqual(joined.length, 1)
  const p = m.listPeers()[0]
  assert.deepStrictEqual(p.tools, ['bash', 'use_computer'])
  assert.strictEqual(p.toolCount, 2)
  assert.strictEqual(p.systemPrompt, 'tiny — 2 tools')
  assert.strictEqual(p.nodeVersion, 'v22.14.0')
  assert.strictEqual(p.source, 'zenoh')

  // aging out fires onPeerLeave
  p.lastSeen = Date.now() - 60_000
  assert.strictEqual(m.listPeers().length, 0)
  assert.strictEqual(left.length, 1)
  assert.strictEqual(left[0].instanceId, 'peer-1')
})

test('mesh: streaming responder emits chunk per delta + tool lines', async () => {
  const m = new MeshNode({
    instanceId: 'me-000000',
    registry: false,
    agentFactory: async () => ({
      invoke: async () => 'unused',
      async *streamTurn(q) {
        yield { kind: 'text', text: 'he' }
        yield { kind: 'tool_start', name: 'bash' }
        yield { kind: 'tool_end', name: 'bash' }
        yield { kind: 'text', text: 'llo' }
        yield { kind: 'done', text: 'hello' }
      },
    }),
  })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  await m['onCommand']({ sender_id: 'peer-2', turn_id: 't9', command: 'hi' })
  const types = published.map((p) => p.v.type)
  assert.strictEqual(types[0], 'ack')
  assert.strictEqual(types.at(-1), 'turn_end')
  const streams = published.filter((p) => p.v.type === 'stream')
  assert.strictEqual(streams.length, 4) // he, tool_start, tool_end, llo
  assert.ok(streams.some((s) => s.v.chunk_type === 'tool' && s.v.data.includes('bash')))
  const end = published.at(-1).v
  assert.strictEqual(end.result, 'hello')
  assert.strictEqual(end.chunks_sent, 4)
})

test('mesh: broadcast waits for every known peer, not just the first', async () => {
  const m = new MeshNode({ instanceId: 'me-000000', registry: false })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }
  m['onPresence']({ instance_id: 'peer-a', hostname: 'a' })
  m['onPresence']({ instance_id: 'peer-b', hostname: 'b' })

  const p = m.broadcast('who is up?', 3000)
  await new Promise((r) => setTimeout(r, 50))
  const turnId = published.find((x) => x.k === 'devduck/broadcast').v.turn_id
  m['onResponse']({ type: 'turn_end', responder_id: 'peer-a', turn_id: turnId, result: 'A' })
  await new Promise((r) => setTimeout(r, 50))
  m['onResponse']({ type: 'turn_end', responder_id: 'peer-b', turn_id: turnId, result: 'B' })
  const results = await p
  assert.strictEqual(results.length, 2)
  assert.deepStrictEqual(results.map((r) => r.result).sort(), ['A', 'B'])
})

test('mesh: listAllPeers merges file-registry peers other processes found', () => {
  const now = Date.now()
  const fakeRegistry = {
    register() {}, heartbeat() {}, unregister() {},
    live: () => ([
      { id: 'daemon-1', type: 'zenoh', last_seen: now, registered_at: now,
        metadata: { hostname: 'mini', model: 'tiny-tech', tool_count: 30, cwd: '/x' } },
      { id: 'me-000000', type: 'zenoh', last_seen: now, registered_at: now, metadata: { is_self: true } },
    ]),
  }
  const m = new MeshNode({ instanceId: 'me-000000', registry: fakeRegistry })
  m['onPresence']({ instance_id: 'peer-live', hostname: 'lan-box' })
  const all = m.listAllPeers()
  const ids = all.map((p) => p.instanceId).sort()
  assert.deepStrictEqual(ids, ['daemon-1', 'peer-live']) // self excluded
  assert.strictEqual(all.find((p) => p.instanceId === 'daemon-1').source, 'registry')
})

test('mesh: foreign presence is clamped on ingest (devduck ships its whole prompt)', () => {
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
  m['onPresence']({
    instance_id: 'duck-1', hostname: 'box', model: 'BedrockModel',
    system_prompt: 'x'.repeat(400_000),                                  // 356 KB measured live
    tools: Array.from({ length: 300 }, (_, i) => `t${i}`),
  })
  const p = m.listPeers()[0]
  assert.ok(p.systemPrompt.length <= IDENTITY_MAX_CHARS + 1, `identity clamped, got ${p.systemPrompt.length}`)
  assert.strictEqual(p.tools.length, TOOLS_MAX, 'tools clamped')
})

test('mesh: a lean heartbeat still does not erase clamped rich presence', () => {
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
  m['onPresence']({ instance_id: 'duck-1', hostname: 'box', system_prompt: 'y'.repeat(9_000), tools: ['a', 'b'] })
  m['onPresence']({ instance_id: 'duck-1', hostname: 'box' })            // lean beat, no tools/prompt
  const p = m.listPeers()[0]
  assert.strictEqual(p.tools.length, 2, 'tools preserved')
  assert.ok(p.systemPrompt.length <= IDENTITY_MAX_CHARS + 1, 'and still clamped')
})

test('mesh: broadcast expects registry-only peers too, not just session peers', async () => {
  const now = Date.now()
  const registry = {
    register() {}, heartbeat() {}, unregister() {},
    live: () => ([{ id: 'daemon-1', type: 'zenoh', last_seen: now, registered_at: now, metadata: { hostname: 'mini' } }]),
  }
  const m = new MeshNode({ instanceId: 'me-000000', registry })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }
  m['onPresence']({ instance_id: 'peer-a', hostname: 'a' })              // 1 session peer + 1 registry peer

  const p = m.broadcast('who is up?', 3000)
  await new Promise((r) => setTimeout(r, 50))
  const turnId = published.find((x) => x.k === 'devduck/broadcast').v.turn_id
  const t0 = Date.now()
  m['onResponse']({ type: 'turn_end', responder_id: 'peer-a', turn_id: turnId, result: 'A' })
  // Well past dispatch's 250ms straggler grace: if `expected` only counted the
  // session peer we would have settled on 'A' and thrown this answer away.
  await new Promise((r) => setTimeout(r, 700))
  m['onResponse']({ type: 'turn_end', responder_id: 'daemon-1', turn_id: turnId, result: 'D' })
  const results = await p
  assert.ok(Date.now() - t0 < 2500, 'settled on the second answer, not the timeout')
  assert.deepStrictEqual(results.map((r) => r.result).sort(), ['A', 'D'])
})

test('mesh_send: the answer is always attributed to the responder', async () => {
  const fake = { instanceId: 'me-000000', listAllPeers: () => [], broadcast: async () => [],
    send: async () => ([{ responder: 'peer-a', result: 'hello from A' }]) }
  const [, , meshSend] = makeMeshTools(fake)
  const out = await meshSend._callback({ peer_id: 'peer-a', message: 'hi' })
  assert.match(out, /── peer-a ──/, 'names who answered')
  assert.match(out, /hello from A/)
})

test('mesh_send: an answer from the WRONG node is flagged, not passed off as the right one', async () => {
  const fake = { instanceId: 'me-000000', listAllPeers: () => [], broadcast: async () => [],
    send: async () => ([{ responder: 'someone-else', result: 'I am someone-else' }]) }
  const [, , meshSend] = makeMeshTools(fake)
  const out = await meshSend._callback({ peer_id: 'peer-a', message: 'who are you?' })
  assert.match(out, /someone-else/)
  assert.match(out, /⚠️/, 'mismatch is surfaced')
  assert.match(out, /asked peer-a/)
})

test('mesh_send: timeout says which peer went quiet', async () => {
  const fake = { instanceId: 'me-000000', listAllPeers: () => [], broadcast: async () => [], send: async () => [] }
  const [, , meshSend] = makeMeshTools(fake)
  assert.match(await meshSend._callback({ peer_id: 'peer-z', message: 'hi' }), /No response from peer-z/)
})

// ── Hop limiting: a peer must not answer a broadcast by broadcasting ────────

test('mesh: outgoing commands are stamped with hop+1', async () => {
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  m.send('peer-9', 'local ask', 50)            // hop defaults to 0 → wire says 1
  m.send('peer-9', 'relayed ask', 50, undefined, 1)  // already travelled 1 → 2
  await new Promise((r) => setTimeout(r, 40))
  const hops = published.filter((p) => p.k === 'devduck/cmd/peer-9').map((p) => p.v.hop)
  assert.deepStrictEqual(hops, [1, 2])
})

test('mesh: incoming hop is handed to the agent factory as context', async () => {
  const seen = []
  const m = new MeshNode({
    instanceId: 'me-000000', registry: noRegistry,
    agentFactory: async (ctx) => { seen.push(ctx); return { invoke: async () => 'ok' } },
  })
  m['running'] = true
  m['session'] = { put: () => {} }
  await m['onCommand']({ sender_id: 'peer-2', turn_id: 't-hop', command: 'hi', hop: 1 })
  assert.deepStrictEqual(seen, [{ hop: 1, from: 'peer-2', turnId: 't-hop' }])
})

test('mesh: a command past the hop cap is refused, and never reaches an agent', async () => {
  let built = 0
  const m = new MeshNode({
    instanceId: 'me-000000', registry: noRegistry,
    agentFactory: async () => { built++; return { invoke: async () => 'should not run' } },
  })
  const published = []
  m['running'] = true
  m['session'] = { put: (k, v) => published.push({ k, v: JSON.parse(v) }) }

  await m['onCommand']({ sender_id: 'peer-2', turn_id: 't-deep', command: 'relay this', hop: 2 })
  assert.strictEqual(built, 0, 'no agent is built past the cap — that is the amplification')
  assert.deepStrictEqual(published.map((p) => p.v.type), ['ack', 'error'])
  assert.match(published[1].v.error, /hop limit/)
})

test('mesh: a foreign command with no hop field is treated as leg 1, not refused', async () => {
  // devduck peers never send the field — they must keep working unchanged.
  const seen = []
  const m = new MeshNode({
    instanceId: 'me-000000', registry: noRegistry,
    agentFactory: async (ctx) => { seen.push(ctx.hop); return { invoke: async () => 'ok' } },
  })
  m['running'] = true
  m['session'] = { put: () => {} }
  await m['onCommand']({ sender_id: 'duck-1', turn_id: 't-foreign', command: 'hi' })
  assert.deepStrictEqual(seen, [1])
})

test('mesh_broadcast/mesh_send tools thread their hop onto the wire', async () => {
  const calls = []
  const fake = {
    instanceId: 'me-000000', listAllPeers: () => [],
    broadcast: async (msg, ms, onChunk, hop) => { calls.push(['broadcast', hop]); return [] },
    send: async (id, msg, ms, onChunk, hop) => { calls.push(['send', hop]); return [] },
  }
  const [, bc, sd] = makeMeshTools(fake, 1)
  await bc._callback({ message: 'x' })
  await sd._callback({ peer_id: 'p', message: 'x' })
  assert.deepStrictEqual(calls, [['broadcast', 1], ['send', 1]])
})

// ── Presence: advertise the real tool surface, not the startup snapshot ─────

test('mesh: setPresence updates advertised tools and beats immediately', () => {
  const beats = []
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry, tools: [] })
  m['running'] = true
  m['session'] = { put: (k, v) => beats.push(JSON.parse(v)) }

  m['beat']()
  assert.strictEqual(beats[0].tool_count, 0, 'the daemon really does start out empty')

  m.setPresence({ tools: ['bash', 'use_computer'], modelLabel: 'tiny-tech (opus)' })
  assert.strictEqual(beats.length, 2, 'setPresence beats now — not up to 5s later')
  assert.strictEqual(beats[1].tool_count, 2)
  assert.deepStrictEqual(beats[1].tools, ['bash', 'use_computer'])
  assert.strictEqual(beats[1].model, 'tiny-tech (opus)')
})

test('mesh: setPresence on a stopped node does not publish', () => {
  const beats = []
  const m = new MeshNode({ instanceId: 'me-000000', registry: noRegistry })
  m['session'] = { put: (k, v) => beats.push(JSON.parse(v)) }
  m.setPresence({ tools: ['bash'] })
  assert.strictEqual(beats.length, 0)
})

// ── The responder must KNOW it is a responder ───────────────────────────────
// Live finding: a peer whose mesh_send was withheld concluded the daemon's mesh
// transport was dead and offered to repair it. Missing capability with no
// explanation reads as breakage, so the context has to say why.

test('mesh: a mesh-originated agent is told it is answering for a peer', async () => {
  const { TinyAgent } = await import('../dist/agent/agent.js')
  const fakeMesh = {
    isRunning: true,
    listPeers: () => [{ instanceId: 'peer-a', hostname: 'box', model: 'x', lastSeen: Date.now() }],
  }
  const a = new TinyAgent({ api: { authenticated: false }, mesh: fakeMesh, meshHop: 1 })
  const ctx = await a['dynamicContext']()
  assert.match(ctx, /answering a request that arrived OVER THE MESH/)
  assert.match(ctx, /hop 1/)
  assert.match(ctx, /nothing is broken/, 'says it explicitly — the agent used to diagnose a phantom fault')
  assert.match(ctx, /cannot send to them on this turn/, 'the peer list stops advertising tools it does not have')
})

test('mesh: a LOCAL agent gets the normal reachable-peers block', async () => {
  const { TinyAgent } = await import('../dist/agent/agent.js')
  const fakeMesh = {
    isRunning: true,
    listPeers: () => [{ instanceId: 'peer-a', hostname: 'box', model: 'x', lastSeen: Date.now() }],
  }
  const a = new TinyAgent({ api: { authenticated: false }, mesh: fakeMesh })
  const ctx = await a['dynamicContext']()
  assert.match(ctx, /reachable via mesh_send\/mesh_broadcast/)
  assert.ok(!/OVER THE MESH/.test(ctx), 'no responder preamble for a human-driven turn')
})
