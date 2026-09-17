/**
 * Mesh registry — file-based cross-process discovery (devduck mesh_registry port).
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeshRegistry, sanitizeMetadata, IDENTITY_MAX_CHARS, TOOLS_MAX } from '../dist/mesh/registry.js'

// Every mkdtemp here used to leak — 60 stale tiny-reg-* dirs were sitting in
// $TMPDIR. Track and remove them when the process exits.
const tmpDirs = []
const regDir = (prefix = 'tiny-reg-') => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
process.on('exit', () => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

const fresh = () => new MeshRegistry(join(regDir(), 'mesh_registry.json'))

test('registry: register → visible, atomic file written', () => {
  const r = fresh()
  r.register('node-1', 'zenoh', { hostname: 'boxA', model: 'tiny-tech', is_self: true })
  const all = r.getAll()
  assert.ok(all['node-1'])
  assert.strictEqual(all['node-1'].metadata.hostname, 'boxA')
  assert.strictEqual(all['node-1'].pid, process.pid)
  assert.ok(r.isSelf(all['node-1']), 'own entry is self (via pid)')
  assert.ok(!existsSync(r['path'] + '.lock'), 'lock released')
})

test('registry: is_self stamps the pid but is NEVER persisted', () => {
  const r = fresh()
  r.register('mine', 'zenoh', { hostname: 'boxA', is_self: true, layer: 'local' })
  const mine = r.get('mine')
  assert.strictEqual(mine.pid, process.pid)
  assert.strictEqual(mine.metadata.is_self, undefined, 'is_self must not reach disk')
  assert.strictEqual(mine.metadata.layer, undefined, 'layer is not a fact about a peer')
  assert.strictEqual(mine.metadata.hostname, 'boxA', 'real metadata survives')
})

test('registry: a peer mirror cannot steal our self-flag or pid', () => {
  const r = fresh()
  r.register('mine', 'zenoh', { is_self: true })
  // Another process discovers US and mirrors the entry (no is_self).
  r.register('mine', 'zenoh', { hostname: 'seen-from-elsewhere' })
  assert.strictEqual(r.get('mine').pid, process.pid, 'pid preserved by a foreign mirror')
  assert.ok(r.isSelf(r.get('mine')))
  // And a foreign node claiming is_self in its own heartbeat metadata does not
  // make it OUR process when we read the file.
  r.register('theirs', 'zenoh', { hostname: 'boxB' })
  assert.ok(!r.isSelf(r.get('theirs')))
})

test('registry: identity + tools are clamped so the file cannot bloat', () => {
  const r = fresh()
  // A devduck heartbeat ships its whole prompt — 356 KB was measured live.
  const huge = 'x'.repeat(400_000)
  r.register('duck', 'zenoh', { system_prompt: huge, tools: Array.from({ length: 300 }, (_, i) => `t${i}`) })
  const e = r.get('duck')
  assert.ok(e.metadata.system_prompt.length <= IDENTITY_MAX_CHARS + 1, 'prompt clamped')
  assert.strictEqual(e.metadata.tools.length, TOOLS_MAX, 'tools clamped')
  const bytes = readFileSync(r['path']).length
  assert.ok(bytes < 8_000, `registry stays small, got ${bytes} bytes`)
})

test('registry: an already-bloated entry shrinks on its next heartbeat', () => {
  const dir = regDir()
  const path = join(dir, 'mesh_registry.json')
  // Simulate a file written by an older tiny (pre-clamp).
  writeFileSync(path, JSON.stringify({ agents: { old: {
    id: 'old', type: 'zenoh', registered_at: Date.now(), last_seen: Date.now(),
    metadata: { system_prompt: 'y'.repeat(300_000), is_self: true },
  } } }))
  const r = new MeshRegistry(path)
  r.heartbeat('old', { tool_count: 3 })
  const e = r.get('old')
  assert.ok(e.metadata.system_prompt.length <= IDENTITY_MAX_CHARS + 1, 'legacy bloat clamped on touch')
  assert.strictEqual(e.metadata.is_self, undefined, 'legacy is_self scrubbed on touch')
})

test('registry: sanitizeMetadata is pure and leaves small metadata alone', () => {
  const input = { hostname: 'a', tools: ['x'], system_prompt: 'short' }
  const out = sanitizeMetadata(input)
  assert.deepStrictEqual(out, input)
  assert.notStrictEqual(out, input, 'returns a copy')
})

test('registry: heartbeat refreshes + merges metadata, keeps registered_at', async () => {
  const r = fresh()
  r.register('node-1', 'zenoh', { hostname: 'boxA' })
  const first = r.get('node-1')
  await new Promise((res) => setTimeout(res, 5))
  r.heartbeat('node-1', { tool_count: 42 })
  const after = r.get('node-1')
  assert.strictEqual(after.registered_at, first.registered_at)
  assert.ok(after.last_seen >= first.last_seen)
  assert.strictEqual(after.metadata.hostname, 'boxA')
  assert.strictEqual(after.metadata.tool_count, 42)
})

test('registry: stale entries hidden by TTL, visible with includeStale, pruneable', () => {
  const r = new MeshRegistry(join(regDir(), 'r.json'), 20)
  r.register('ghost', 'zenoh', {})
  return new Promise((res) => setTimeout(() => {
    assert.strictEqual(Object.keys(r.getAll()).length, 0)
    assert.strictEqual(Object.keys(r.getAll(true)).length, 1)
    r.prune()
    assert.strictEqual(Object.keys(r.getAll(true)).length, 0)
    res()
  }, 40))
})

test('registry: unregister removes, missing file reads empty', () => {
  const r = fresh()
  assert.deepStrictEqual(r.getAll(), {})
  r.register('n', 'zenoh', {})
  r.unregister('n')
  assert.deepStrictEqual(r.getAll(), {})
})

test('registry: concurrent writers do not lose entries', () => {
  const r = fresh()
  for (let i = 0; i < 20; i++) r.register(`n${i}`, 'zenoh', { i })
  assert.strictEqual(r.live().length, 20)
})

test('registry: a lock held by another process blocks the write, never races it', () => {
  const r = fresh()
  r.register('first', 'zenoh', { hostname: 'boxA' })
  const before = readFileSync(r['path'], 'utf8')

  // Stand in for a peer process mid-write. acquireLock() spins 50x10ms = 500ms,
  // well under LOCK_STALE_MS (2s), so this lock never looks abandoned.
  const lock = r['path'] + '.lock'
  closeSync(openSync(lock, 'wx'))
  const t0 = Date.now()
  r.register('second', 'zenoh', { hostname: 'boxB' })
  const waited = Date.now() - t0

  assert.ok(waited >= 400, `should have spun for the lock, waited ${waited}ms`)
  assert.strictEqual(readFileSync(r['path'], 'utf8'), before,
    'file must be untouched: writing here is a read-modify-write of the WHOLE map and would drop the lock holder\'s keys')
  assert.strictEqual(r.get('second'), undefined, 'the skipped write is simply absent')
  assert.ok(r.get('first'), 'and the existing entry survived')

  // Heartbeats repeat every 5s — the next one lands once the lock is gone.
  unlinkSync(lock)
  r.register('second', 'zenoh', { hostname: 'boxB' })
  assert.ok(r.get('second'), 'retry succeeds')
})

test('registry: a stale lock (crashed writer) is broken so the mesh recovers', () => {
  const r = fresh()
  const lock = r['path'] + '.lock'
  closeSync(openSync(lock, 'wx'))
  const old = new Date(Date.now() - 10_000)
  utimesSync(lock, old, old)          // as if a killed process left it behind
  r.register('after-crash', 'zenoh', { hostname: 'boxC' })
  assert.ok(r.get('after-crash'), 'stale lock broken, write proceeded')
  assert.ok(!existsSync(lock), 'lock released')
})

test('registry: parallel processes converge — every writer keeps all its ids', async () => {
  // Heartbeat-shaped: each child retries until its own ids are on disk, which
  // is what a 5s heartbeat does. The invariant is that no writer ever destroys
  // another writer's entries, so all 6x15 must be present at the end.
  const { execFile } = await import('node:child_process')
  const path = join(regDir(), 'mesh_registry.json')
  const regUrl = new URL('../dist/mesh/registry.js', import.meta.url).href
  const child = (tag) => new Promise((res, rej) => {
    const code = [
      `const { MeshRegistry } = await import(${JSON.stringify(regUrl)})`,
      `const r = new MeshRegistry(${JSON.stringify(path)})`,
      `const pad = 'z'.repeat(20000)`,
      `for (let i = 0; i < 15; i++) {`,
      `  const id = '${tag}-' + i`,
      `  for (let a = 0; a < 60 && !r.get(id); a++) r.register(id, 'zenoh', { tag: '${tag}', system_prompt: pad })`,
      `}`,
    ].join('\n')
    execFile(process.execPath, ['--input-type=module', '-e', code], (e) => (e ? rej(e) : res()))
  })
  await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(child))

  const r = new MeshRegistry(path)
  const ids = Object.keys(r.getAll(true))
  for (const tag of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.strictEqual(ids.filter((id) => id.startsWith(tag + '-')).length, 15,
      `${tag} lost ids — a writer clobbered another writer (have ${ids.length} total)`)
  }
  // 6 x 15 x 20 KB of prompt would be 1.8 MB unclamped.
  const bytes = readFileSync(path).length
  assert.ok(bytes < 120_000, `clamped file stayed small: ${bytes} bytes`)
})
