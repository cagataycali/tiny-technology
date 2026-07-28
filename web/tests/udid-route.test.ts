// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The device callback stores into Vercel KV — mock it so the route logic
// (UDID extraction + validation + redirect) is exercised without a live store.
// vi.hoisted so the store exists when the hoisted vi.mock factory runs.
const kvStore = vi.hoisted(() => ({
  sadd: vi.fn(async () => 1), set: vi.fn(async () => 'OK'), scard: vi.fn(async () => 0),
  smembers: vi.fn(async () => [] as string[]), get: vi.fn(async () => null as any),
}))
vi.mock('@vercel/kv', () => ({ kv: kvStore }))

// Session identity for the ?list=1 owner gate. vi.hoisted so the getSession
// return value is swappable per test before the route reads it.
const sessionState = vi.hoisted(() => ({ user: null as null | { sub: string; login: string } }))
vi.mock('../lib/auth', () => ({ getSession: vi.fn(async () => sessionState.user) }))

import { GET, POST, isOwnerLogin } from '../app/api/udid/route'

beforeEach(() => {
  kvStore.sadd.mockClear(); kvStore.set.mockClear()
  kvStore.scard.mockReset().mockResolvedValue(0)
  kvStore.smembers.mockReset().mockResolvedValue(['00008101-001D45EA0168001E'])
  kvStore.get.mockReset().mockResolvedValue({ product: 'iPhone15,2', version: '18.0' })
  sessionState.user = null
  delete process.env.ENROLL_SECRET
  delete process.env.OWNER_LOGIN
})

// The DEVICE posts PKCS7(DER) with the plist embedded as plaintext; the route
// extracts keys via a byte-string regex, so a plain plist body suffices here.
const plist = (attrs: Record<string, string>) =>
  '<plist><dict>' +
  Object.entries(attrs).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('') +
  '</dict></plist>'

const post = (body: string) =>
  POST(new Request('https://tiny.technology/api/udid', { method: 'POST', body }))

describe('POST /api/udid — UDID format validation (device callback)', () => {
  it('ACCEPTS the modern iPhone XS / A12+ UDID (8-16, single dash) — the regression', async () => {
    // This is the shape essentially every current device sends. The old regex
    // demanded an 8-4-16 middle group that real UDIDs do not have, so this
    // 400'd and no current device could enroll.
    const res = await post(plist({ UDID: '00008101-001D45EA0168001E', PRODUCT: 'iPhone15,2', VERSION: '18.0' }))
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toContain('00008101-001D45EA0168001E')
    expect(kvStore.sadd).toHaveBeenCalledWith('ios_udids', '00008101-001D45EA0168001E')
  })

  it('ACCEPTS the legacy 40-hex UDID (pre-XS)', async () => {
    const res = await post(plist({ UDID: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }))
    expect(res.status).toBe(301)
  })

  it('ACCEPTS lowercase modern UDID', async () => {
    const res = await post(plist({ UDID: '00008030-000a49e80c08802e' }))
    expect(res.status).toBe(301)
  })

  it('REJECTS a UUID-shaped value (8-4-4-4-12) — not a UDID', async () => {
    const res = await post(plist({ UDID: '12345678-1234-1234-1234-123456789012' }))
    expect(res.status).toBe(400)
    expect(kvStore.sadd).not.toHaveBeenCalled()
  })

  it('REJECTS a missing/garbage UDID', async () => {
    expect((await post(plist({ PRODUCT: 'iPhone15,2' }))).status).toBe(400)
    expect((await post(plist({ UDID: 'not-a-udid' }))).status).toBe(400)
  })

  it('does not enroll past the cap but still redirects the device', async () => {
    kvStore.scard.mockResolvedValue(200)
    const res = await post(plist({ UDID: '00008101-001D45EA0168001E' }))
    expect(res.status).toBe(301)
    expect(kvStore.sadd).not.toHaveBeenCalled()
  })

  it('rejects an oversized body', async () => {
    const res = await post('x'.repeat(100_001))
    expect(res.status).toBe(400)
  })
})

describe('isOwnerLogin (roster owner gate — pure)', () => {
  it('matches the default repo owner, case-insensitively', () => {
    expect(isOwnerLogin('cagataycali')).toBe(true)
    expect(isOwnerLogin('CagatayCali')).toBe(true)
  })

  it('rejects any non-owner login', () => {
    expect(isOwnerLogin('mallory')).toBe(false)
  })

  it('rejects empty / non-string logins (no anonymous match)', () => {
    expect(isOwnerLogin('')).toBe(false)
    expect(isOwnerLogin(null)).toBe(false)
    expect(isOwnerLogin(undefined)).toBe(false)
    expect(isOwnerLogin(123 as any)).toBe(false)
  })

  it('honors a comma-separated OWNER_LOGIN override (trims + lowercases)', () => {
    expect(isOwnerLogin('alice', ' Alice , bob ')).toBe(true)
    expect(isOwnerLogin('bob', ' Alice , bob ')).toBe(true)
    expect(isOwnerLogin('cagataycali', 'alice,bob')).toBe(false) // override replaces default
  })
})

const getList = (headers: Record<string, string> = {}) =>
  GET(new Request('https://tiny.technology/api/udid?list=1', { headers }))

describe('GET /api/udid?list=1 — roster is owner-only (PII gate)', () => {
  it('401s an anonymous request', async () => {
    const res = await getList()
    expect(res.status).toBe(401)
  })

  it('404s a logged-in NON-owner (the leak fix) — no roster disclosed', async () => {
    sessionState.user = { sub: 'u-mallory', login: 'mallory' }
    const res = await getList()
    expect(res.status).toBe(404)
    expect(kvStore.smembers).not.toHaveBeenCalled()
  })

  it('serves the roster to the site owner', async () => {
    sessionState.user = { sub: 'u-owner', login: 'cagataycali' }
    const res = await getList()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.devices[0].udid).toBe('00008101-001D45EA0168001E')
  })

  it('serves the roster to the build bot via x-enroll-key (no session needed)', async () => {
    process.env.ENROLL_SECRET = 's3cret'
    const res = await getList({ 'x-enroll-key': 's3cret' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('rejects a wrong x-enroll-key and falls back to the (missing) session → 401', async () => {
    process.env.ENROLL_SECRET = 's3cret'
    const res = await getList({ 'x-enroll-key': 'wrong' })
    expect(res.status).toBe(401)
  })
})
