// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret-cli' })

import { POST } from '../app/api/auth/cli/token/route'
import { SignJWT } from 'jose'

const secret = (s = process.env.AUTH_JWT_SECRET!) => new TextEncoder().encode(s)

// Mint a code JWT the way /api/auth/cli does
async function code(opts: {
  state?: string; sub?: string; aud?: string; secret?: string; expSecondsAgo?: number
} = {}): Promise<string> {
  const jwt = new SignJWT({ login: 'tester', state: opts.state ?? 'nonce-1234567890ab' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub ?? 'user-1')
    .setAudience(opts.aud ?? 'tiny-cli-code')
    .setIssuedAt()
    .setExpirationTime(opts.expSecondsAgo ? Math.floor(Date.now() / 1000) - opts.expSecondsAgo : '5m')
  return jwt.sign(secret(opts.secret))
}

const post = (body: object | string | null) =>
  POST(new Request('https://tiny.technology/api/auth/cli/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/auth/cli/token', () => {
  it('valid code + matching state → token', async () => {
    const c = await code({ state: 'nonce-1234567890ab' })
    const res = await post({ code: c, state: 'nonce-1234567890ab' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(typeof data.token).toBe('string')
    expect(data.user.login).toBe('tester')
  })

  it('malformed body → 400', async () => {
    expect((await post('{bad')).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post({ code: 'x' })).status).toBe(400) // state missing
  })

  it('state mismatch → 401 (the loopback binding)', async () => {
    const c = await code({ state: 'nonce-1234567890ab' })
    const res = await post({ code: c, state: 'different-nonce-value' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/state mismatch/)
  })

  it('wrong audience is rejected — a session/cli token can\'t be replayed as a code', async () => {
    const sessionToken = await code({ aud: 'tiny-cli' }) // the FINAL token's aud, not a code
    const res = await post({ code: sessionToken, state: 'nonce-1234567890ab' })
    expect(res.status).toBe(401)
  })

  it('wrong signing secret is rejected', async () => {
    const forged = await code({ secret: 'attacker-secret' })
    const res = await post({ code: forged, state: 'nonce-1234567890ab' })
    expect(res.status).toBe(401)
  })

  it('expired code is rejected', async () => {
    const stale = await code({ expSecondsAgo: 60 })
    const res = await post({ code: stale, state: 'nonce-1234567890ab' })
    expect(res.status).toBe(401)
  })
})

// ── tinyapp:// scheme variant (iOS app) ─────────────────────────────────

import { POST as mintCode } from '../app/api/auth/cli/route'
import { issueSession } from '../lib/auth'

const mintReq = (body: any, cookie?: string) =>
  new Request('https://tiny.technology/api/auth/cli', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

describe('POST /api/auth/cli — tinyapp scheme (iOS)', () => {
  const state = 'a'.repeat(32)

  it('scheme:tinyapp skips the port requirement and redirects to tinyapp://auth', async () => {
    const cookie = `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`
    const res = await mintCode(mintReq({ scheme: 'tinyapp', state }, cookie))
    const d = await res.json()
    expect(res.status).toBe(200)
    expect(d.redirect).toMatch(/^tinyapp:\/\/auth\?code=/)
    expect(d.redirect).toContain(`state=${state}`)
  })

  it('arbitrary schemes are rejected (still needs a valid port)', async () => {
    const cookie = `tiny_session=${await issueSession({ sub: 'u1', login: 'me' })}`
    const res = await mintCode(mintReq({ scheme: 'evil', state }, cookie))
    expect(res.status).toBe(400)   // no port, scheme not allowlisted
  })

  it('anonymous scheme request → 401', async () => {
    const res = await mintCode(mintReq({ scheme: 'tinyapp', state }))
    expect(res.status).toBe(401)
  })
})
