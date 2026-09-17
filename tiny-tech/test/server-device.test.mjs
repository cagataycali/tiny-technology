/**
 * The device-tool bridge on the MCP server.
 *
 * Two halves. The pure half (selection, deadline) is imported straight from
 * dist/server.js — importing it starts nothing, only startServer() does. The
 * protocol half spawns the built server over real stdio, unauthenticated and
 * in an isolated TINY_HOME, and checks what a client actually sees: that this
 * machine's tools are IN the catalog with usable schemas, that a call reaches
 * the real capability, and that the env var can take them away again.
 *
 * Measured on this Mac while writing it: 25 device tools, 27 KB of
 * descriptions, a use_computer round trip in 69-74ms, boot (import + build all 25)
 * ~140ms of the 166ms handshake.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const {
  deviceToolsWanted, deviceCallTimeout, withDeadline, bridgeDeviceTools, loadDeviceTools,
  strandsToMcpContent, DEVICE_CALL_TIMEOUT_MS,
} = await import('../dist/server.js')

// ── selection ───────────────────────────────────────────────────────────────

const AVAILABLE = ['use_apple', 'use_computer', 'use_memory']

test('unset mounts everything — the bridge exists to hand over the machine', () => {
  assert.deepEqual(deviceToolsWanted(undefined, AVAILABLE), { mount: AVAILABLE, unknown: [] })
  assert.deepEqual(deviceToolsWanted('', AVAILABLE).mount, AVAILABLE)
  assert.deepEqual(deviceToolsWanted('   ', AVAILABLE).mount, AVAILABLE)
})

test('the opt-out spellings a person would actually type all mean none', () => {
  for (const off of ['0', 'off', 'false', 'no', 'none', 'OFF', ' 0 ']) {
    assert.deepEqual(deviceToolsWanted(off, AVAILABLE), { mount: [], unknown: [] }, off)
  }
})

test('the opt-IN spellings mean everything, not one tool named "on"', () => {
  for (const on of ['1', 'on', 'true', 'yes', 'all', 'ALL']) {
    assert.deepEqual(deviceToolsWanted(on, AVAILABLE).mount, AVAILABLE, on)
  }
})

test('a name is accepted with or without use_, because both spellings are in the user\'s face', () => {
  // `use_computer` is what the agent's transcript calls it; `notes` is what the
  // capability labels on /devices call it. Neither is more correct.
  assert.deepEqual(deviceToolsWanted('computer', AVAILABLE).mount, ['use_computer'])
  assert.deepEqual(deviceToolsWanted('use_computer', AVAILABLE).mount, ['use_computer'])
  assert.deepEqual(deviceToolsWanted('MEMORY', AVAILABLE).mount, ['use_memory'])
})

test('commas, spaces, or both separate a list', () => {
  for (const spec of ['computer,memory', 'computer memory', 'computer, memory', ' computer ,, memory ']) {
    assert.deepEqual(deviceToolsWanted(spec, AVAILABLE).mount, ['use_computer', 'use_memory'], spec)
  }
})

test('the catalog reads in machine order however the env var was typed', () => {
  assert.deepEqual(deviceToolsWanted('memory,apple', AVAILABLE).mount, ['use_apple', 'use_memory'])
})

test('a name matching nothing is reported, not silently dropped', () => {
  // A typo'd env var that quietly mounts nothing looks exactly like a Mac with
  // no capabilities, and this stderr line is the only place to catch it.
  const r = deviceToolsWanted('memory, bogus, use_nope', AVAILABLE)
  assert.deepEqual(r.mount, ['use_memory'])
  assert.deepEqual(r.unknown, ['bogus', 'use_nope'])
})

test('asking for a tool this machine cannot do is unknown, not an empty mount', () => {
  // use_flipper is real — it just did not register, because no Flipper is
  // plugged in. The gate stays in makeDeviceTools(); this only reports.
  assert.deepEqual(deviceToolsWanted('flipper', AVAILABLE), { mount: [], unknown: ['flipper'] })
})

// ── the deadline ────────────────────────────────────────────────────────────

test('the default deadline sits above the longest deadline a tool sets for itself', async () => {
  const { NPM_INSTALL_TIMEOUT_MS } = await import('../dist/agent/npm.js')
  // Below it, a slow-but-working `use_npm install` would be reported as a
  // hang. This is the whole reason the number is 240s and not 30.
  assert.ok(DEVICE_CALL_TIMEOUT_MS > NPM_INSTALL_TIMEOUT_MS,
    `${DEVICE_CALL_TIMEOUT_MS} must exceed npm's own ${NPM_INSTALL_TIMEOUT_MS}`)
})

test('the timeout env var is honoured only when it is a positive number', () => {
  assert.equal(deviceCallTimeout('5000'), 5000)
  assert.equal(deviceCallTimeout('0.5'), 0.5)
  for (const junk of [undefined, '', 'soon', '0', '-1', 'NaN', 'Infinity']) {
    assert.equal(deviceCallTimeout(junk), DEVICE_CALL_TIMEOUT_MS, JSON.stringify(junk))
  }
})

test('work that finishes in time is returned untouched', async () => {
  assert.equal(await withDeadline('use_memory', 5000, async () => 'ok'), 'ok')
})

test('a throwing tool keeps its own error — the deadline does not rewrite it', async () => {
  await assert.rejects(
    withDeadline('use_memory', 5000, async () => { throw new Error('osascript said no') }),
    /osascript said no/,
  )
})

test('a call past the deadline says the work may STILL be running', async () => {
  // The promise is not cancellable — nothing here can kill a wedged osascript.
  // Reporting "timed out" alone would imply it stopped, and a user who
  // believes that re-runs a send that already went out.
  await assert.rejects(
    withDeadline('use_apple', 20, () => new Promise((r) => setTimeout(r, 5000).unref())),
    (e) => {
      assert.match(e.message, /^use_apple did not answer within 20ms/)
      assert.match(e.message, /may still be running on this machine/)
      assert.match(e.message, /TINY_MCP_DEVICE_TIMEOUT_MS/)
      return true
    },
  )
})

test('a sub-second deadline is reported in ms, never as "within 0s"', async () => {
  await assert.rejects(
    withDeadline('use_memory', 5, () => new Promise((r) => setTimeout(r, 500).unref())),
    /within 5ms/,
  )
  await assert.rejects(
    withDeadline('use_memory', 1500, () => new Promise((r) => setTimeout(r, 5000).unref())),
    /within 2s/,
  )
})

test('a finished call leaves no timer holding the process open', async () => {
  // The deadline is 4 MINUTES by default. An abandoned timer per call would
  // keep this process alive long after the client hung up — so the test is
  // that the event loop empties on its own, with no unref and no kill.
  const { execFileSync } = await import('node:child_process')
  const code = `
    const { withDeadline } = await import('${join(HERE, '..', 'dist', 'server.js')}')
    await withDeadline('use_memory', 240000, async () => 'done')
    process.stdout.write('exited-cleanly')
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 20_000 })
  assert.equal(String(out), 'exited-cleanly')
})

// ── the bridge, against a fake registry ─────────────────────────────────────
//
// Everything below is reachable ONLY this way. All 25 real tools carry a zod
// object and none of them throws on registration, so a test that just spawns
// the server cannot tell a bridge that handles those cases from one that
// doesn't — and both failures look like "this machine has no capabilities".

/** A registry that records instead of serving, plus a tool factory. */
function fakeRegistry(behaviour = () => {}) {
  const registered = []
  const warnings = []
  return {
    registered, warnings,
    register: (name, config, handler) => { behaviour(name); registered.push({ name, config, handler }) },
    warn: (line) => warnings.push(line),
  }
}
const fakeTool = (name, over = {}) => ({
  name,
  description: `does ${name} things, at length, so the router has something to read`,
  _inputSchema: { shape: { action: 'zod-ish' } },
  _callback: async (a) => `${name}:${JSON.stringify(a)}`,
  ...over,
})

test('a capability probe that throws costs the device tools, not the server', async () => {
  // This runs at boot, before the transport connects. Unhandled, it would abort
  // startServer() and the client would see a server that never came up —
  // strictly worse than a server with no Flipper on it.
  const warnings = []
  const tools = await loadDeviceTools(async () => { throw new Error('serial probe exploded') }, (l) => warnings.push(l))
  assert.deepEqual(tools, [])
  assert.match(warnings.join(''), /device tools unavailable \(serial probe exploded\) — platform tools only/)
})

test('a working build is handed through untouched, and needs no logger', async () => {
  const built = [fakeTool('use_apple')]
  assert.equal(await loadDeviceTools(async () => built), built)
  // A throwing build with no warn must still not throw.
  assert.deepEqual(await loadDeviceTools(async () => { throw new Error('x') }), [])
})

test('a tool with no object schema is skipped and said out loud', () => {
  const r = fakeRegistry()
  const mounted = bridgeDeviceTools({
    tools: [fakeTool('use_ok'), fakeTool('use_bare', { _inputSchema: undefined }), fakeTool('use_flat', { _inputSchema: {} })],
    register: r.register, warn: r.warn,
  })
  assert.deepEqual(mounted, ['use_ok'])
  assert.deepEqual(r.registered.map((x) => x.name), ['use_ok'])
  assert.match(r.warnings.join(''), /use_bare has no object schema/)
  assert.match(r.warnings.join(''), /use_flat has no object schema/)
})

test('a non-object shape is not passed to the SDK as one', () => {
  // `z.string()` has no `.shape`; a zod type whose shape is a function or a
  // string would sail through a truthiness check and land in registerTool.
  const r = fakeRegistry()
  const mounted = bridgeDeviceTools({
    tools: [fakeTool('use_weird', { _inputSchema: { shape: 'action' } })],
    register: r.register, warn: r.warn,
  })
  assert.deepEqual(mounted, [])
})

test('one tool the SDK refuses costs that tool, not the machine', () => {
  // Before this was a per-tool try, a single throwing registerTool rejected
  // mountDeviceTools → startServer, and the client got a server with NOTHING
  // on it — indistinguishable from a Mac with no capabilities.
  const r = fakeRegistry((name) => { if (name === 'use_bad') throw new Error('name already taken') })
  const mounted = bridgeDeviceTools({
    tools: [fakeTool('use_first'), fakeTool('use_bad'), fakeTool('use_last')],
    register: r.register, warn: r.warn,
  })
  assert.deepEqual(mounted, ['use_first', 'use_last'])
  assert.match(r.warnings.join(''), /use_bad could not be mounted \(name already taken\)/)
})

test('what gets registered is the tool\'s own description and schema, untouched', () => {
  const r = fakeRegistry()
  const t = fakeTool('use_apple')
  bridgeDeviceTools({ tools: [t], register: r.register, warn: r.warn })
  const { config } = r.registered[0]
  assert.equal(config.description, t.description)
  assert.equal(config.inputSchema, t._inputSchema.shape, 'the zod shape must be handed over by reference')
  assert.deepEqual(config.annotations, { openWorldHint: true })
})

test('the registered handler calls the tool and wraps the answer in a content block', async () => {
  const r = fakeRegistry()
  bridgeDeviceTools({ tools: [fakeTool('use_memory')], register: r.register, warn: r.warn })
  const res = await r.registered[0].handler({ action: 'sentiment' })
  assert.notEqual(res.isError, true)
  assert.equal(res.content[0].text, 'use_memory:{"action":"sentiment"}')
})

test('a device tool that breaks its contract and throws becomes an isError result', async () => {
  // House invariant: callbacks return a plain string and never throw. When one
  // does anyway, the client must get a tool error, not a dead session.
  const r = fakeRegistry()
  bridgeDeviceTools({
    tools: [fakeTool('use_flipper', { _callback: async () => { throw new Error('serial port gone') } })],
    register: r.register, warn: r.warn,
  })
  const res = await r.registered[0].handler({})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /serial port gone/)
})

test('the handler enforces the deadline it was configured with', async () => {
  const r = fakeRegistry()
  bridgeDeviceTools({
    tools: [fakeTool('use_computer', { _callback: () => new Promise((res) => setTimeout(res, 5000).unref()) })],
    register: r.register, warn: r.warn, timeoutRaw: '15',
  })
  const res = await r.registered[0].handler({})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /use_computer did not answer within 15ms/)
})

test('the selection applies to what actually registers, not just to the report', () => {
  const r = fakeRegistry()
  const tools = [fakeTool('use_apple'), fakeTool('use_memory')]
  const mounted = bridgeDeviceTools({ tools, register: r.register, warn: r.warn, spec: 'memory' })
  assert.deepEqual(mounted, ['use_memory'])
  assert.deepEqual(r.registered.map((x) => x.name), ['use_memory'], 'a filtered-out tool still reached the SDK')
})

test('a bridge with nothing to mount registers nothing and warns about nothing', () => {
  const r = fakeRegistry()
  assert.deepEqual(bridgeDeviceTools({ tools: [fakeTool('use_apple')], register: r.register, warn: r.warn, spec: 'off' }), [])
  assert.deepEqual(r.registered, [])
  assert.deepEqual(r.warnings, [], 'a deliberate opt-out is not a warning')
})

test('warn is optional — the bridge does not require a logger to run', () => {
  const r = fakeRegistry()
  assert.deepEqual(
    bridgeDeviceTools({ tools: [fakeTool('use_x', { _inputSchema: undefined })], register: r.register }),
    [],
  )
})

// ── pixels: Strands blocks → MCP blocks ─────────────────────────────────────
//
// use_computer's screenshot and use_device's "the phone screenshotted itself"
// both answer with a Strands block ARRAY. Before the mapper, ok() stringified
// it and the client got 200 KB of base64 inside a text block — the model saw
// nothing, and nothing in the protocol tests could tell.

test('a Strands block array becomes MCP image + text blocks', () => {
  const out = strandsToMcpContent([
    { image: { format: 'png', source: { bytes: 'AAAA' } } },
    { image: { format: 'jpeg', source: { bytes: 'BBBB' } } },
    { text: 'the screen, 1440×900' },
  ])
  assert.deepEqual(out, [
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
    { type: 'text', text: 'the screen, 1440×900' },
  ])
})

test('jpg is spelled image/jpeg on the wire, and a missing format means png', () => {
  assert.equal(strandsToMcpContent([{ image: { format: 'jpg', source: { bytes: 'x' } } }])[0].mimeType, 'image/jpeg')
  assert.equal(strandsToMcpContent([{ image: { source: { bytes: 'x' } } }])[0].mimeType, 'image/png')
})

test('anything that is not a block array is left for the text path', () => {
  // A device list, a string, an empty array, an array with one foreign
  // element, raw bytes instead of base64 — all must come back null so ok()
  // stringifies them WHOLE rather than half-mapping and dropping the rest.
  for (const v of ['hello', { ok: true, devices: [] }, [], [{ id: 1 }], [{ text: 'a' }, 7], null, undefined,
    [{ image: { format: 'png', source: { bytes: Buffer.from('x') } } }]]) {
    assert.equal(strandsToMcpContent(v), null, JSON.stringify(v))
  }
})

test('a device tool that answers with pixels reaches the client as an image block', async () => {
  const r = fakeRegistry()
  bridgeDeviceTools({
    tools: [fakeTool('use_computer', {
      _callback: async () => [{ image: { format: 'png', source: { bytes: 'iVBORw0' } } }, { text: 'screenshot 1440×900' }],
    })],
    register: r.register, warn: r.warn,
  })
  const res = await r.registered[0].handler({ action: 'screenshot' })
  assert.notEqual(res.isError, true)
  assert.deepEqual(res.content, [
    { type: 'image', data: 'iVBORw0', mimeType: 'image/png' },
    { type: 'text', text: 'screenshot 1440×900' },
  ])
})

test('a device tool that answers with an object is still one JSON text block', async () => {
  const r = fakeRegistry()
  bridgeDeviceTools({
    tools: [fakeTool('use_device', { _callback: async () => ({ ok: true, devices: [{ id: 'd1', online: null }] }) })],
    register: r.register, warn: r.warn,
  })
  const res = await r.registered[0].handler({ action: 'list' })
  assert.equal(res.content.length, 1)
  assert.deepEqual(JSON.parse(res.content[0].text), { ok: true, devices: [{ id: 'd1', online: null }] })
})

// ── over the wire ───────────────────────────────────────────────────────────

function client(extraEnv = {}, args = []) {
  const proc = spawn('node', [join(HERE, '..', 'dist', 'cli.js'), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TINY_HOME: mkdtempSync(join(tmpdir(), 'tiny-dev-')), TINY_TOKEN: '', ...extraEnv },
  })
  let buf = '', stderr = '', nextId = 1
  const waiters = {}
  proc.stderr.on('data', (d) => { stderr += d })
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); if (m.id && waiters[m.id]) { waiters[m.id](m); delete waiters[m.id] } } catch {}
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    waiters[id] = resolve
    setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 30_000).unref()
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return {
    proc, rpc,
    stderr: () => stderr,
    async ready() {
      const init = await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'device-test', version: '0' },
      })
      assert.equal(init.result.serverInfo.name, 'tiny-tech')
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      return this
    },
  }
}

let mcp, catalog
before(async () => {
  mcp = await client().ready()
  catalog = (await mcp.rpc('tools/list')).result.tools
})
after(() => mcp?.proc.kill())

test('this machine\'s tools are in the catalog at all', () => {
  // The gap this whole section exists to close: before the bridge, a client
  // that mounted tiny-tech got tiny_* and my_* and could not read the calendar
  // of the machine it was running on.
  const device = catalog.filter((t) => t.name.startsWith('use_'))
  assert.ok(device.length >= 3, `only ${device.length} device tools mounted`)
  // Always-on regardless of hardware: integrations is unconditional, and
  // use_computer resolves on any Mac with screencapture. On a non-Mac the
  // second is legitimately absent.
  const names = device.map((t) => t.name)
  assert.ok(names.includes('use_integrations'), 'the unconditional tool did not mount')
  if (process.platform === 'darwin') assert.ok(names.includes('use_computer'), 'the screen tool did not mount')
})

test('the platform tools are still all there — the bridge added, it did not replace', () => {
  const names = catalog.map((t) => t.name)
  for (const n of ['tiny_whoami', 'tiny_chat', 'tiny_search', 'tiny_reload_tools', 'mesh_peers']) {
    assert.ok(names.includes(n), `missing ${n}`)
  }
})

test('every mounted device tool carries a usable object schema and a description', () => {
  // The bridge reads `_inputSchema.shape`. A tool whose schema failed to
  // convert would show up here as an argument-less tool the client can call
  // but never pass anything to.
  for (const t of catalog.filter((x) => x.name.startsWith('use_'))) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema is not an object`)
    assert.ok(Object.keys(t.inputSchema.properties || {}).length > 0, `${t.name} exposes no arguments`)
    assert.ok((t.description || '').length > 50, `${t.name} description too thin to route on`)
    // Local side effects reach outside this process; none of these is read-only.
    assert.equal(t.annotations?.openWorldHint, true, `${t.name} is not marked open-world`)
    assert.notEqual(t.annotations?.readOnlyHint, true, `${t.name} claims to be read-only`)
  }
})

test('the fleet is in the catalog — use_device mounts next to this machine\'s tools', () => {
  // The gap THIS test exists to close: the REPL agent has had use_device as a
  // builtin since day one, but it is not in makeDeviceTools(), so the device
  // bridge handed an MCP client the Mac and not the phone. Schema, description
  // and open-world are pinned by the every-use_* loop above.
  const t = catalog.find((x) => x.name === 'use_device')
  assert.ok(t, 'use_device is not in the catalog')
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['action', 'device_id', 'envelope_id', 'prompt', 'wait'])
  assert.match(t.description, /OTHER enrolled devices/)
  assert.match(mcp.stderr(), /this machine → .*\bdevice\b/)
})

test('use_device logged out answers with a login hint, not a dead session', async () => {
  // Empty TINY_HOME, no token. The tool catches AuthRequiredError itself and
  // returns { ok:false, error } — the same contract as the REPL — so the
  // client sees a normal text result it can act on.
  const r = await mcp.rpc('tools/call', { name: 'use_device', arguments: { action: 'list' } })
  assert.ok(r.result, JSON.stringify(r))
  const body = JSON.parse(r.result.content[0].text)
  assert.equal(body.ok, false)
  assert.match(String(body.error), /log ?in|login|auth/i)
})

test('`tiny-tech mcp` is the MCP server — the word in every client config, not a one-shot prompt', async () => {
  // Before the alias, `mcp` was not in KNOWN and fell through to the one-shot
  // agent path: a mesh node came up and the model was asked, literally, "mcp".
  // `serve` was the only spelling and nobody guesses it.
  const c = client({ TINY_MCP_DEVICE_TOOLS: '0' }, ['mcp'])
  try {
    await c.ready()
    const names = (await c.rpc('tools/list')).result.tools.map((t) => t.name)
    assert.ok(names.includes('tiny_whoami'))
    assert.doesNotMatch(c.stderr(), /mesh: joined/)
  } finally { c.proc.kill() }
})

test('device tools need no account — they mount while logged OUT', () => {
  // This client has an empty TINY_HOME and no token. The platform tools all
  // answer with a login hint; the machine's own tools must not.
  assert.ok(catalog.some((t) => t.name.startsWith('use_')))
  assert.match(mcp.stderr(), /this machine → /)
})

test('a real device call goes through the bridge and comes back as content', async (t) => {
  if (process.platform !== 'darwin') return t.skip('use_computer is macOS-only')
  const r = await mcp.rpc('tools/call', {
    name: 'use_computer', arguments: { action: 'screen_size' },
  })
  assert.notEqual(r.result.isError, true, JSON.stringify(r.result))
  // Not just "something came back": the answer carries this display's real
  // logical size, so a stub could not have produced it.
  assert.match(r.result.content[0].text, /\d+×\d+ logical points/)
})

test('a device tool\'s own validation reaches the client instead of throwing', async (t) => {
  if (process.platform !== 'darwin') return t.skip('use_computer is macOS-only')
  // House invariant: device callbacks return a plain string and never throw.
  // 'click' with no coordinates is refused by the tool itself, before any event
  // reaches the screen — a throw here would surface as a protocol error.
  const r = await mcp.rpc('tools/call', { name: 'use_computer', arguments: { action: 'click' } })
  assert.match(r.result.content[0].text, /need x \+ y/)
})

test('an unknown argument is rejected by the schema, not passed to the machine', async () => {
  const r = await mcp.rpc('tools/call', { name: 'use_integrations', arguments: { action: 'list', rm: '-rf /' } })
  // Either the SDK rejects it or the tool ignores it — what must never happen
  // is the value reaching a shell. Both outcomes are fine; a crash is not.
  assert.ok(r.error || r.result, 'no response at all')
  if (r.result) assert.doesNotMatch(String(r.result.content?.[0]?.text || ''), /rf \//)
})

test('TINY_MCP_DEVICE_TOOLS=0 takes the machine back out of the catalog', async () => {
  const off = await client({ TINY_MCP_DEVICE_TOOLS: '0' }).ready()
  try {
    const names = (await off.rpc('tools/list')).result.tools.map((t) => t.name)
    assert.equal(names.filter((n) => n.startsWith('use_')).length, 0)
    assert.ok(names.includes('tiny_whoami'), 'the platform tools went with them')
    assert.match(off.stderr(), /no device tools mounted/)
    // Not merely hidden from the list — actually unreachable.
    const r = await off.rpc('tools/call', { name: 'use_computer', arguments: { action: 'screen_size' } })
    assert.ok(r.error || r.result.isError, 'an unmounted tool answered')
  } finally {
    off.proc.kill()
  }
})

test('a named subset mounts exactly those, and says what it did not recognise', async () => {
  const some = await client({ TINY_MCP_DEVICE_TOOLS: 'integrations, bogus' }).ready()
  try {
    const names = (await some.rpc('tools/list')).result.tools.map((t) => t.name).filter((n) => n.startsWith('use_'))
    assert.deepEqual(names, ['use_integrations'])
    assert.match(some.stderr(), /names nothing on this machine: bogus/)
  } finally {
    some.proc.kill()
  }
})

test('a too-small deadline reports a hang instead of hanging the client', async () => {
  // 1ms is not a realistic setting; it is the only way to observe the watchdog
  // without wedging real work. It has to be an AWAITING callback: withDeadline
  // is a Promise.race, and a synchronous tool (screen_size, npm installed —
  // both execFileSync) resolves before the timer can ever fire, so those look
  // like a broken watchdog when the watchdog is fine. `npm search` awaits a
  // fetch, which loses a 1ms race even with no network at all.
  const slow = await client({ TINY_MCP_DEVICE_TOOLS: 'npm', TINY_MCP_DEVICE_TIMEOUT_MS: '1' }).ready()
  try {
    const r = await slow.rpc('tools/call', { name: 'use_npm', arguments: { action: 'search', query: 'zod' } })
    assert.equal(r.result.isError, true)
    assert.match(r.result.content[0].text, /did not answer within 1ms/)
    assert.match(r.result.content[0].text, /may still be running/)
    // And the session survives it: the next call still works.
    const after = await slow.rpc('tools/list')
    assert.ok(after.result.tools.length > 0)
  } finally {
    slow.proc.kill()
  }
})
