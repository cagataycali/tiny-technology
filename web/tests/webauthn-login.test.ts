// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret-webauthn' })

import { POST } from '../app/api/auth/webauthn/login/route'
import { SignJWT } from 'jose'

const secret = () => new TextEncoder().encode(process.env.AUTH_JWT_SECRET!)
const CHALLENGE_COOKIE = 'tiny_webauthn_auth'

async function challengeCookie(challenge = 'abc123'): Promise<string> {
  const jwt = await new SignJWT({ challenge })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(secret())
  return `${CHALLENGE_COOKIE}=${jwt}`
}

const post = (body: string | object | null, cookie?: string) =>
  POST(new Request('https://tiny.technology/api/auth/webauthn/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/auth/webauthn/login — pre-verification guards', () => {
  it('no challenge cookie → 400 (before any body parse)', async () => {
    const res = await post({ id: 'cred' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/challenge expired/)
  })

  it('tampered/invalid challenge JWT → 400', async () => {
    const res = await post({ id: 'cred' }, `${CHALLENGE_COOKIE}=not.a.jwt`)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid challenge/)
  })

  it('valid challenge but malformed JSON body → 400, not 500', async () => {
    const res = await post('{bad json', await challengeCookie())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid credential/)
  })

  it('valid challenge but body missing a string id → 400', async () => {
    const res = await post({ notId: true }, await challengeCookie())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid credential/)
  })

  it('a challenge signed with a different secret is rejected', async () => {
    const jwt = await new SignJWT({ challenge: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('WRONG-secret'))
    const res = await post({ id: 'cred' }, `${CHALLENGE_COOKIE}=${jwt}`)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid challenge/)
  })
})
