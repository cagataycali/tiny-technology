/**
 * device.ts — identity store + enroll/heartbeat against a mocked fetch.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-device-'))
process.env.TINY_HOME = home
delete process.env.TINY_API_URL

const { loadDevice, saveDevice, clearDevice, defaultDeviceName, devicePlatform, enrollDevice, heartbeat } =
  await import('../dist/device.js')

const identity = {
  version: 1,
  deviceId: 'dev-123',
  token: 'tind_secret',
  name: 'test-box',
  apiUrl: 'https://tiny.example',
  enrolledAt: 1700000000,
}

const realFetch = globalThis.fetch
after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }) })
beforeEach(() => { clearDevice() })

test('load returns null when no file', () => {
  assert.equal(loadDevice(), null)
})

test('save → load roundtrip, 0600 perms', () => {
  saveDevice(identity)
  const loaded = loadDevice()
  assert.equal(loaded.deviceId, 'dev-123')
  const mode = statSync(join(home, 'device.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('clearDevice removes the file', () => {
  saveDevice(identity)
  assert.equal(clearDevice(), true)
  assert.equal(existsSync(join(home, 'device.json')), false)
  assert.equal(clearDevice(), false) // second clear is a no-op
})

test('defaultDeviceName + devicePlatform are sane', () => {
  assert.ok(defaultDeviceName().length > 0)
  assert.ok(defaultDeviceName().length <= 64)
  assert.match(devicePlatform(), /^[a-z0-9]+-[a-z0-9]+$/)
})

test('heartbeat: ok:true → alive', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  assert.equal(await heartbeat(identity), true)
})

test('heartbeat: 401 → revoked (false)', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'unknown device' }), { status: 401 })
  assert.equal(await heartbeat(identity), false)
})

test('heartbeat: network failure → treated alive (retry later, not revoked)', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await heartbeat(identity), true)
})

test('enrollDevice: enrolls via /api/devices and persists identity', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ ok: true, device_id: 'new-id', device_token: 'tind_new' }), { status: 200 })
  }
  const fakeApi = {
    baseUrl: 'https://tiny.example',
    post: async (path, body) => {
      calls.push({ url: path, body })
      return { ok: true, device_id: 'new-id', device_token: 'tind_new' }
    },
  }
  const d = await enrollDevice(fakeApi)
  assert.equal(d.deviceId, 'new-id')
  assert.equal(loadDevice().token, 'tind_new')
  const enrollCall = calls.find(c => c.url === '/api/devices')
  assert.ok(enrollCall, 'posted to /api/devices')
  assert.ok(Array.isArray(enrollCall.body.capabilities))
})

test('enrollDevice: keeps existing identity when heartbeat proves it live', async () => {
  saveDevice(identity)
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  let posted = false
  const fakeApi = { baseUrl: 'https://tiny.example', post: async () => { posted = true; return {} } }
  const d = await enrollDevice(fakeApi)
  assert.equal(d.deviceId, 'dev-123')
  assert.equal(posted, false, 'no re-enroll when token is live')
})

test('enrollDevice: re-enrolls when stored token is revoked (401)', async () => {
  saveDevice(identity)
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 401 })
  const fakeApi = {
    baseUrl: 'https://tiny.example',
    post: async () => ({ ok: true, device_id: 'fresh-id', device_token: 'tind_fresh' }),
  }
  const d = await enrollDevice(fakeApi)
  assert.equal(d.deviceId, 'fresh-id')
})
