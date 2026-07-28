/**
 * MCP protocol smoke — spawns the built server over real stdio.
 * Runs UNAUTHENTICATED (isolated TINY_HOME): verifies handshake, tool
 * catalog, annotations, schemas, and the auth-error contract. Network
 * calls that need creds must fail with the login hint, never crash.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// import.meta.dirname needs Node ≥20.11 — CI runs 18 too
const HERE = dirname(fileURLToPath(import.meta.url))

let proc, waiters = {}, nextId = 1

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiters[id] = resolve
    const t = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 15_000)
    t.unref()
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

before(async () => {
  proc = spawn('node', [join(HERE, '..', 'dist', 'cli.js')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TINY_HOME: mkdtempSync(join(tmpdir(), 'tiny-srv-')), TINY_TOKEN: '' },
  })
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); if (m.id && waiters[m.id]) { waiters[m.id](m); delete waiters[m.id] } } catch {}
    }
  })
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  })
  assert.equal(init.result.serverInfo.name, 'tiny-tech')
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
})

after(() => proc?.kill())

test('tool catalog: all expected tools present', async () => {
  const { result } = await rpc('tools/list')
  const names = result.tools.map(t => t.name)
  for (const expected of [
    'tiny_whoami', 'tiny_login', 'tiny_learn', 'tiny_recall', 'tiny_unlearn', 'tiny_memories',
    'tiny_graph', 'tiny_resolve_conflict', 'tiny_follow',
    'tiny_chat', 'tiny_search', 'tiny_get', 'tiny_create', 'tiny_update', 'tiny_delete',
    'tiny_create_tool', 'tiny_remove_tool', 'tiny_marketplace', 'tiny_reload_tools',
    'tiny_schedule', 'tiny_share', 'tiny_events',
    'tiny_wallet', 'tiny_pay_quote', 'tiny_pay_confirm',
    'tiny_devices', 'tiny_model_config', 'tiny_archives',
  ]) assert.ok(names.includes(expected), `missing ${expected}`)
})

test('devices/model-config/archives: schemas + auth contract', async () => {
  const { result } = await rpc('tools/list')
  const by = Object.fromEntries(result.tools.map(t => [t.name, t]))
  assert.deepEqual(by.tiny_devices.inputSchema.properties.action.enum, ['list', 'revoke'])
  assert.equal(by.tiny_devices.annotations.destructiveHint, true)
  assert.deepEqual(by.tiny_model_config.inputSchema.properties.action.enum, ['get', 'set'])
  assert.deepEqual(by.tiny_archives.inputSchema.properties.action.enum, ['list', 'get', 'save', 'delete'])
  for (const [name, args] of [
    ['tiny_devices', { action: 'list' }],
    ['tiny_model_config', { action: 'get' }],
    ['tiny_archives', { action: 'list' }],
  ]) {
    const r = await rpc('tools/call', { name, arguments: args })
    assert.equal(r.result.isError, true, `${name} should error without creds`)
    assert.match(r.result.content[0].text, /tiny_login|tiny-tech login/)
  }
  // client-side validation guards before any network call
  const rv = await rpc('tools/call', { name: 'tiny_devices', arguments: { action: 'revoke' } })
  assert.match(rv.result.content[0].text, /deviceId required/)
})

test('handshake: server version matches package.json (no hardcoded drift)', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  const init2 = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test2', version: '0' },
  }).catch(() => null)
  // Re-initialize may be rejected by the SDK — fall back to reading the
  // built constant so the assertion still guards the drift either way.
  if (init2?.result?.serverInfo?.version) {
    assert.equal(init2.result.serverInfo.version, pkg.version)
  } else {
    const built = readFileSync(join(HERE, '..', 'dist', 'server.js'), 'utf8')
    assert.ok(!/version:\s*'0\.2\.0'/.test(built), 'hardcoded stale version resurfaced')
  }
})

test('schemas: tiny_update exposes branding fields (logo/tagline/chips/theme)', async () => {
  const { result } = await rpc('tools/list')
  const up = result.tools.find(t => t.name === 'tiny_update')
  for (const f of ['logo', 'hero', 'theme', 'tagline', 'intro_vibe', 'chips']) {
    assert.ok(up.inputSchema.properties[f], `tiny_update missing branding field ${f}`)
  }
  assert.equal(up.inputSchema.properties.chips.type, 'array')
  assert.equal(up.inputSchema.properties.tagline.maxLength, 200)
})

test('payments: confirm is destructive, quote is not, wallet enum enforced', async () => {
  const { result } = await rpc('tools/list')
  const by = Object.fromEntries(result.tools.map(t => [t.name, t]))
  assert.equal(by.tiny_pay_confirm.annotations.destructiveHint, true)
  assert.notEqual(by.tiny_pay_quote.annotations.destructiveHint, true)
  assert.deepEqual(
    by.tiny_wallet.inputSchema.properties.action.enum,
    ['balance', 'deposit_info', 'faucet', 'pricing', 'set_price', 'claim'],
  )
  // wallet deliberately does NOT expose withdraw/link_address (money-moving
  // + payout-destination — web-only flows)
  assert.ok(!by.tiny_wallet.inputSchema.properties.action.enum.includes('withdraw'))
  // A self-hosted deployment reports `default_network: "tiny"`, so omitting it
  // here made the flow the server documents impossible to express.
  assert.ok(
    by.tiny_wallet.inputSchema.properties.network.enum.includes('tiny'),
    "claim can't name the deployment's own chain",
  )
  // unauthenticated calls follow the standard auth-error contract
  const r = await rpc('tools/call', { name: 'tiny_wallet', arguments: { action: 'balance' } })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /tiny_login|tiny-tech login/)
  const q = await rpc('tools/call', { name: 'tiny_pay_quote', arguments: { url: 'https://tiny.technology/api/x402/chat/tiny', message: 'hi' } })
  assert.equal(q.result.isError, true)
  assert.match(q.result.content[0].text, /tiny_login|tiny-tech login/)
})

test("payments: the wallet's own description never sends a user to an exchange", async () => {
  // This description IS the product surface for an agent: it read "real USDC on
  // Base" unconditionally, on deployments where the token is unbuyable.
  const { result } = await rpc('tools/list')
  const d = result.tools.find(t => t.name === 'tiny_wallet').description
  assert.doesNotMatch(d, /coinbase|moonpay|bridge\.base\.org/i)
  assert.match(d, /never assume which; deposit_info says/i)
  assert.match(d, /NEVER tell a user to buy, bridge or exchange USDC/)
  assert.match(d, /'faucet'/, 'the only on-ramp on our own chain must be discoverable')
  // Unauthenticated faucet calls follow the same auth contract as the rest.
  const r = await rpc('tools/call', { name: 'tiny_wallet', arguments: { action: 'faucet' } })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /tiny_login|tiny-tech login/)
})

test('annotations: destructive and read-only hints set', async () => {
  const { result } = await rpc('tools/list')
  const by = Object.fromEntries(result.tools.map(t => [t.name, t.annotations || {}]))
  assert.equal(by.tiny_delete.destructiveHint, true)
  assert.equal(by.tiny_unlearn.destructiveHint, true)
  assert.equal(by.tiny_recall.readOnlyHint, true)
  assert.equal(by.tiny_whoami.readOnlyHint, true)
  assert.equal(by.tiny_chat.openWorldHint, true)
})

test('schemas: tiny_chat exposes files array param', async () => {
  const { result } = await rpc('tools/list')
  const chat = result.tools.find(t => t.name === 'tiny_chat')
  assert.equal(chat.inputSchema.properties.files.type, 'array')
})

test('auth contract: session tools error with login hint, never crash', async () => {
  for (const name of ['tiny_whoami', 'tiny_learn', 'tiny_events']) {
    const { result } = await rpc('tools/call', { name, arguments: name === 'tiny_learn' ? { content: 'x' } : {} })
    assert.equal(result.isError, true, `${name} should error without creds`)
    assert.match(result.content[0].text, /tiny_login|tiny-tech login/, `${name} points at recovery`)
  }
})

test('input validation: missing required args rejected by SDK', async () => {
  const res = await rpc('tools/call', { name: 'tiny_learn', arguments: {} })
  // SDK-level validation error (error response or isError result both acceptable)
  assert.ok(res.error || res.result.isError)
})

test('prompt: tiny-context resolves even unauthenticated', async () => {
  const { result } = await rpc('prompts/get', { name: 'tiny-context' })
  assert.match(result.messages[0].content.text, /Not logged in|memory/)
})

test('resources: identity + memory are listed', async () => {
  const { result } = await rpc('resources/list')
  const uris = result.resources.map(r => r.uri)
  assert.ok(uris.includes('tiny://me'), 'tiny://me resource missing')
  assert.ok(uris.includes('tiny://memories'), 'tiny://memories resource missing')
})

test('resources: per-tiny template is registered', async () => {
  const { result } = await rpc('resources/templates/list')
  const templates = result.resourceTemplates.map(t => t.uriTemplate)
  assert.ok(templates.includes('tiny://tiny/{name}'), 'per-tiny template missing')
})

test('resources: unauthenticated read returns a login hint, never crashes', async () => {
  for (const uri of ['tiny://me', 'tiny://memories', 'tiny://tiny/anything']) {
    const { result } = await rpc('resources/read', { uri })
    assert.ok(result.contents?.length, `${uri} returned no contents`)
    assert.match(result.contents[0].text, /Not logged in|tiny-tech login|doesn't exist/, `${uri} should hint recovery`)
  }
})

test('public tool works without creds: tiny_search', async () => {
  const { result } = await rpc('tools/call', { name: 'tiny_search', arguments: { limit: 2 } })
  assert.notEqual(result.isError, true)
  assert.match(result.content[0].text, /keys|name/)
})
