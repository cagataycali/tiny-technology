// config.ts — the one backend resolution: --api → TINY_API_URL → config.json →
// credentials/device origin → https://tiny.technology.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = await import('../dist/config.js')

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-config-'))
  process.env.TINY_HOME = dir
  delete process.env.TINY_API_URL
  delete process.env.TINY_WORKER_URL
  cfg.setApiFlag(undefined)
  return dir
}

test('default is the public deployment when nothing is configured', () => {
  const dir = scratch()
  assert.deepEqual(cfg.resolveApiUrl(), { api: 'https://tiny.technology', source: 'default' })
  assert.equal(cfg.apiHost(), 'tiny.technology')
  assert.equal(cfg.workerUrl(), 'https://plugin.tiny.technology', 'built-in worker for the public deployment')
  assert.equal(cfg.isCustomBackend(), false)
  rmSync(dir, { recursive: true, force: true })
})

test('normalizeApiUrl: scheme added, path dropped, http only for local hosts', () => {
  assert.equal(cfg.normalizeApiUrl('my-tiny.vercel.app/devices'), 'https://my-tiny.vercel.app')
  assert.equal(cfg.normalizeApiUrl(' https://Example.COM/ '), 'https://example.com')
  assert.equal(cfg.normalizeApiUrl('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(cfg.normalizeApiUrl('http://192.168.0.20:8097'), 'http://192.168.0.20:8097')
  assert.throws(() => cfg.normalizeApiUrl('http://example.com'), /plain http/)
  assert.throws(() => cfg.normalizeApiUrl(''), /empty/)
  assert.throws(() => cfg.normalizeApiUrl('ftp://x'), /unsupported scheme/)
})

test('takeApiFlag removes --api <url> and --api=<url> from argv', () => {
  const a = ['--api', 'https://a.example', 'login']
  assert.equal(cfg.takeApiFlag(a), 'https://a.example')
  assert.deepEqual(a, ['login'])
  const b = ['whoami', '--api=https://b.example']
  assert.equal(cfg.takeApiFlag(b), 'https://b.example')
  assert.deepEqual(b, ['whoami'])
  assert.equal(cfg.takeApiFlag(['login']), undefined)
  assert.throws(() => cfg.takeApiFlag(['login', '--api']), /--api needs a URL/)
})

test('precedence: flag > env > config.json > credentials > device > default', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ apiUrl: 'https://device.example' }))
  assert.equal(cfg.resolveApiUrl().source, 'device')
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ apiUrl: 'https://creds.example' }))
  assert.deepEqual(cfg.resolveApiUrl(), { api: 'https://creds.example', source: 'credentials' })
  cfg.writeConfig({ api: 'https://config.example', worker: 'https://w.config.example' })
  assert.deepEqual(cfg.resolveApiUrl(), { api: 'https://config.example', source: 'config' })
  assert.equal(cfg.workerUrl(), 'https://w.config.example')
  process.env.TINY_API_URL = 'https://env.example'
  assert.deepEqual(cfg.resolveApiUrl(), { api: 'https://env.example', source: 'env' })
  assert.equal(cfg.workerUrl(), null, 'a cached worker never leaks to a different api')
  process.env.TINY_WORKER_URL = 'https://w.env.example/'
  assert.equal(cfg.workerUrl(), 'https://w.env.example')
  cfg.setApiFlag('flag.example')
  assert.deepEqual(cfg.resolveApiUrl(), { api: 'https://flag.example', source: 'flag' })
  assert.equal(cfg.isCustomBackend(), true)
  rmSync(dir, { recursive: true, force: true })
})

test('apiUrlFor: explicit settings repoint a record; otherwise the record origin wins', () => {
  const dir = scratch()
  assert.equal(cfg.apiUrlFor('https://enrolled.example'), 'https://enrolled.example')
  assert.equal(cfg.apiUrlFor(null), 'https://tiny.technology')
  cfg.writeConfig({ api: 'https://config.example' })
  assert.equal(cfg.apiUrlFor('https://enrolled.example'), 'https://config.example')
  rmSync(dir, { recursive: true, force: true })
})

test('writeConfig writes 0600 JSON and keeps unspecified fields', () => {
  const dir = scratch()
  cfg.writeConfig({ api: 'https://a.example', siteName: 'A' })
  cfg.writeConfig({ api: 'https://a.example', worker: 'https://w.example' })
  const j = JSON.parse(readFileSync(cfg.configPath(), 'utf8'))
  assert.equal(j.version, 1)
  assert.equal(j.siteName, 'A')
  assert.equal(j.worker, 'https://w.example')
  assert.equal(typeof j.updatedAt, 'number')
  rmSync(dir, { recursive: true, force: true })
})

test('probeDeployment accepts a tiny-vercel style health answer and rejects HTML', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://good.example')) {
      return new Response(JSON.stringify({ ok: true, service: 'web', siteName: 'Good', workerUrl: 'https://w.good.example' }), { status: 200 })
    }
    return new Response('<!DOCTYPE html>', { status: 404 })
  }
  try {
    const info = await cfg.probeDeployment('https://good.example')
    assert.equal(info.workerUrl, 'https://w.good.example')
    assert.equal(info.siteName, 'Good')
    await assert.rejects(() => cfg.probeDeployment('https://bad.example'), /answered 404/)
  } finally {
    globalThis.fetch = orig
  }
})

test('init: writes api + advertised worker; falls back to the built-in entry for the public deployment', async () => {
  const dir = scratch()
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://good.example')) {
      return new Response(JSON.stringify({ ok: true, service: 'web', siteName: 'Good', workerUrl: 'https://w.good.example' }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }
  try {
    const c = await cfg.init('good.example')
    assert.equal(c.api, 'https://good.example')
    assert.equal(c.worker, 'https://w.good.example')
    const pub = await cfg.init('https://tiny.technology')
    assert.equal(pub.worker, 'https://plugin.tiny.technology')
    await assert.rejects(() => cfg.init('https://unknown.example'), /answered 404/)
    const pinned = await cfg.init('https://good.example', { worker: 'https://pin.example' })
    assert.equal(pinned.worker, 'https://pin.example', '--worker beats the advertised one')
  } finally {
    globalThis.fetch = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discoverWorker: probes the app, caches only for a persistent source', async () => {
  const dir = scratch()
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, service: 'web', workerUrl: 'https://w.flag.example' }), { status: 200 })
  try {
    cfg.setApiFlag('https://flag.example')
    assert.equal(await cfg.discoverWorker(), 'https://w.flag.example')
    assert.equal(cfg.readConfig(), null, 'a --api run leaves config.json alone')
    cfg.setApiFlag(undefined)
    cfg.writeConfig({ api: 'https://cfg.example' })
    assert.equal(await cfg.discoverWorker(), 'https://w.flag.example')
    assert.equal(cfg.readConfig().worker, 'https://w.flag.example', 'cached for the configured api')
  } finally {
    globalThis.fetch = orig
    rmSync(dir, { recursive: true, force: true })
  }
})
