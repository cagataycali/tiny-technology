/**
 * LIVE end-to-end suite — talks to production with the local credentials.
 *
 *   npm run test:live
 *
 * NOT part of `npm test`/CI: requires ~/.tiny/credentials.json (or
 * TINY_TOKEN) and creates/deletes real probe resources (a tiny named
 * e2e-live-probe, a forged tool live_probe_tool, a share). Everything it
 * creates it deletes; it never touches pre-existing resources.
 *
 * Exit code 0 = all green.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const proc = spawn('node', [join(HERE, '..', 'dist', 'cli.js')], { stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
const waiters = {}
let nextId = 1
proc.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try { const m = JSON.parse(line); if (m.id && waiters[m.id]) { waiters[m.id](m); delete waiters[m.id] } } catch {}
  }
})

function rpc(method, params, timeoutMs = 120_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiters[id] = resolve
    const t = setTimeout(() => reject(new Error(`rpc ${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    t.unref()
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const call = (name, args) => rpc('tools/call', { name, arguments: args })
const text = (m) => m.result?.content?.[0]?.text ?? ''

let pass = 0, failCount = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${label}`) }
  else { failCount++; console.log(`❌ ${label} ${detail}`) }
}

const PROBE_TINY = 'e2e-live-probe'
const PROBE_TOOL = 'live_probe_tool'

async function cleanup() {
  await call('tiny_delete', { name: PROBE_TINY }).catch(() => {})
  await call('tiny_remove_tool', { name: PROBE_TOOL }).catch(() => {})
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-e2e', version: '0' } })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  console.log(`server ${init.result.serverInfo.name} ${init.result.serverInfo.version}\n`)

  // ── identity ──
  const who = await call('tiny_whoami', {})
  if (who.result.isError) {
    console.error('Not logged in — run `npx tiny-tech login` first. Skipping live suite.')
    proc.kill(); process.exit(0) // absent creds is a skip, not a failure
  }
  check('whoami', text(who).includes('"authenticated": true') || text(who).includes('login'))

  // ── memory round-trip ──
  const marker = `live-e2e marker ${nextId}-${process.pid}`
  const learn = JSON.parse(text(await call('tiny_learn', { content: marker })))
  check('learn stores + indexes', learn.ok === true && learn.indexed === true)
  const recall = JSON.parse(text(await call('tiny_recall', { query: 'live-e2e marker' })))
  check('recall finds the marker', (recall.matches || []).some(x => x.content === marker))
  const un = JSON.parse(text(await call('tiny_unlearn', { id: String(learn.id) })))
  check('unlearn deletes it', un.ok === true && un.deleted === 1)
  const unBad = await call('tiny_unlearn', { id: '99999999' })
  check('unlearn bogus id → error', unBad.result.isError === true, text(unBad).slice(0, 60))

  // ── tiny lifecycle with config preservation ──
  const created = JSON.parse(text(await call('tiny_create', { name: 'E2E Live Probe', systemPrompt: 'v1', systemKnowledge: 'KEEP' })))
  check('create echoes stored slug', created.name === PROBE_TINY, `got ${created.name}`)
  await call('tiny_update', { name: PROBE_TINY, systemPrompt: 'v2' })
  const got = JSON.parse(text(await call('tiny_get', { name: PROBE_TINY })))
  check('update changes prompt', got.systemPrompt === 'v2')
  check('update preserves knowledge', got.systemKnowledge === 'KEEP')
  // private flip: owner must still read the full record (regression: the
  // owner userId wasn't forwarded with the internal key, masking own tinys)
  await call('tiny_update', { name: PROBE_TINY, priv: true })
  const priv = JSON.parse(text(await call('tiny_get', { name: PROBE_TINY })))
  check('private flip sticks', priv.private === true)
  check('owner reads own private tiny', priv.systemPrompt === 'v2', `prompt: ${JSON.stringify(priv.systemPrompt)}`)
  const del = JSON.parse(text(await call('tiny_delete', { name: PROBE_TINY })))
  check('delete', del.ok === true)
  const gone = await call('tiny_get', { name: PROBE_TINY })
  check('deleted tiny → error', gone.result.isError === true)

  // ── forge lifecycle ──
  const forged = JSON.parse(text(await call('tiny_create_tool', { name: PROBE_TOOL, description: 'live probe', params: { text: 't' }, code: '(args) => args.text.toUpperCase()' })))
  check('forge', forged.ok === true)
  const reload = JSON.parse(text(await call('tiny_reload_tools', {})))
  check('reload mounts it', reload.mounted.includes(`my_${PROBE_TOOL}`))
  const run = await call(`my_${PROBE_TOOL}`, { text: 'live' })
  check('run forged tool', text(run) === 'LIVE', text(run).slice(0, 40))
  const rm = JSON.parse(text(await call('tiny_remove_tool', { name: PROBE_TOOL })))
  check('remove', rm.ok === true)
  const rmAgain = await call('tiny_remove_tool', { name: PROBE_TOOL })
  check('remove again → 404 error', rmAgain.result.isError === true)

  // ── validation errors are precise ──
  const badName = await rpc('tools/call', { name: 'tiny_create_tool', arguments: { name: 'Bad Name!', description: 'x', code: '(args) => 1' } })
  check('bad tool name rejected client-side', !!(badName.error || badName.result?.isError))
  const badCode = await call('tiny_create_tool', { name: 'probe_bad_code', description: 'x', code: '(args) => require("fs")' })
  check('forbidden code → sandbox message', text(badCode).includes('forbidden'))

  // ── attachments ──
  const dir = mkdtempSync(join(tmpdir(), 'live-e2e-'))
  const txt = join(dir, 'probe.txt')
  writeFileSync(txt, 'the secret word is xylophone')
  const chat = JSON.parse(text(await call('tiny_chat', { tiny: 'tiny', message: 'What is the secret word in the attached file? Reply with just that word.', files: [txt] })))
  check('chat reads attachment', /xylophone/i.test(chat.text), chat.text?.slice(0, 60))

  // ── feeds ──
  check('events', !!(JSON.parse(text(await call('tiny_events', {}))).ok))
  check('share list', Array.isArray(JSON.parse(text(await call('tiny_share', { action: 'list' }))).shares))
  check('search', !(await call('tiny_search', { limit: 2 })).result.isError)

  console.log(`\n${pass} passed, ${failCount} failed`)
} catch (e) {
  console.error('SUITE ERROR:', e.message)
  failCount++
} finally {
  await cleanup()
  proc.kill()
  process.exit(failCount ? 1 : 0)
}
