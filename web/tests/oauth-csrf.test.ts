// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'

// The route reads these at request time; set before import to be safe.
beforeAll(() => {
  process.env.GITHUB_CLIENT_ID = 'test-client'
  process.env.GITHUB_CLIENT_SECRET = 'test-secret'
})

import { GET } from '../app/api/auth/route'

const OAUTH_COOKIE = 'tiny_oauth_state'

function nonceFrom(setCookie: string | null): string | null {
  if (!setCookie) return null
  const m = setCookie.match(/tiny_oauth_state=([^;]+)/)
  return m ? m[1] : null
}

describe('GitHub OAuth CSRF gate', () => {
  it('step 1 (no code) sets an httpOnly state-nonce cookie and packs it into state', async () => {
    const res = await GET(new Request('https://tiny.technology/api/auth?return_to=/support'))
    expect(res.status).toBe(302)
    const setCookie = res.headers.get('set-cookie')
    const nonce = nonceFrom(setCookie)
    expect(nonce).toBeTruthy()
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Lax/)
    // state carries `<nonce>:<returnTo>`
    const authorize = new URL(res.headers.get('location')!)
    expect(authorize.hostname).toBe('github.com')
    expect(authorize.searchParams.get('state')).toBe(`${nonce}:/support`)
  })

  it('callback with a MISSING nonce cookie bounces to a fresh login (no code exchange)', async () => {
    const res = await GET(new Request('https://tiny.technology/api/auth?code=abc&state=some-nonce:/'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/auth')
  })

  it('callback with a MISMATCHED nonce bounces (forged CSRF callback dead-ends)', async () => {
    const res = await GET(new Request('https://tiny.technology/api/auth?code=abc&state=attacker-nonce:/', {
      headers: { cookie: `${OAUTH_COOKIE}=victims-different-nonce` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/auth')
  })

  it('a decoy cookie whose name ends with the state cookie does not satisfy the gate', async () => {
    // readCookie is boundary-anchored — x_tiny_oauth_state must not match.
    const res = await GET(new Request('https://tiny.technology/api/auth?code=abc&state=n:/', {
      headers: { cookie: `x_${OAUTH_COOKIE}=n` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/auth')
  })

  it('a MATCHING nonce passes the gate (proceeds to code exchange, not the bounce)', async () => {
    const realFetch = global.fetch
    // Stub GitHub token exchange to fail AFTER the gate — reaching this 401
    // (not the /api/auth bounce) proves the CSRF gate let a valid pair through.
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as any
    try {
      const res = await GET(new Request('https://tiny.technology/api/auth?code=abc&state=match:/', {
        headers: { cookie: `${OAUTH_COOKIE}=match` },
      }))
      // no access_token in the stubbed response → 401, and crucially NOT a 302 to /api/auth
      expect(res.status).toBe(401)
    } finally {
      global.fetch = realFetch
    }
  })
})
