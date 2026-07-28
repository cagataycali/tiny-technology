// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT } from 'jose'

// AUTH_JWT_SECRET must exist before the module reads it
beforeAll(() => { process.env.AUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod' })

import { issueSession, issueCliToken, verifySession, getSession, safeReturnPath, readCookie, sessionCookie, clearSessionCookie, SESSION_COOKIE } from '../lib/auth'

const USER = { sub: 'user-123', login: 'tester', name: 'Test User', avatar: 'https://a.example/x.png' }

describe('session JWT round-trip', () => {
  it('issue → verify preserves identity', async () => {
    const token = await issueSession(USER)
    const back = await verifySession(token)
    expect(back).toEqual(USER)
  })

  it('CLI tokens verify through the same path', async () => {
    const token = await issueCliToken(USER)
    const back = await verifySession(token)
    expect(back?.sub).toBe(USER.sub)
    expect(back?.login).toBe(USER.login)
  })

  it('tampered tokens are rejected', async () => {
    const token = await issueSession(USER)
    // flip a char in the payload segment
    const parts = token.split('.')
    const tampered = [parts[0], parts[1].slice(0, -2) + (parts[1].endsWith('A') ? 'B' : 'A') + parts[1].slice(-1), parts[2]].join('.')
    expect(await verifySession(tampered)).toBeNull()
    expect(await verifySession('garbage')).toBeNull()
    expect(await verifySession('')).toBeNull()
  })

  it('tokens signed with a different secret are rejected', async () => {
    const token = await issueSession(USER)
    process.env.AUTH_JWT_SECRET = 'rotated-secret'
    expect(await verifySession(token)).toBeNull()
    process.env.AUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod'
    expect(await verifySession(token)).not.toBeNull()
  })

  it('EXPIRED tokens are rejected (sessions must not live forever)', async () => {
    // Correctly-signed but past-exp — proves jwtVerify enforces expiry, so a
    // refactor that drops setExpirationTime would fail here instead of
    // silently minting never-expiring sessions.
    const secret = new TextEncoder().encode('test-secret-do-not-use-in-prod')
    const expired = await new SignJWT({ login: USER.login })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.sub)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // expired an hour ago
      .sign(secret)
    expect(await verifySession(expired)).toBeNull()
    // sanity: same claims but NOT expired verifies fine
    const valid = await new SignJWT({ login: USER.login })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.sub)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret)
    expect((await verifySession(valid))?.sub).toBe(USER.sub)
  })
})

describe('getSession extraction', () => {
  it('reads the session cookie', async () => {
    const token = await issueSession(USER)
    const req = new Request('https://x.example/', {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}; more=2` },
    })
    expect((await getSession(req))?.sub).toBe(USER.sub)
  })

  it('falls back to bearer auth (CLI path)', async () => {
    const token = await issueCliToken(USER)
    const req = new Request('https://x.example/', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect((await getSession(req))?.sub).toBe(USER.sub)
  })

  it('no credentials → null', async () => {
    expect(await getSession(new Request('https://x.example/'))).toBeNull()
  })

  it('ignores a decoy cookie whose name ends with the session name', async () => {
    // `x_tiny_session=decoy` must NOT satisfy a `tiny_session=` lookup, even
    // when it appears first — an unanchored regex would log the user out.
    const token = await issueSession(USER)
    const req = new Request('https://x.example/', {
      headers: { cookie: `x_${SESSION_COOKIE}=decoy; ${SESSION_COOKIE}=${token}` },
    })
    expect((await getSession(req))?.sub).toBe(USER.sub)
  })
})

describe('readCookie — boundary-anchored cookie parsing', () => {
  it('reads a cookie at the start of the header', () => {
    expect(readCookie('tiny_session=abc; other=1', 'tiny_session')).toBe('abc')
  })
  it('reads a cookie after a semicolon', () => {
    expect(readCookie('other=1; tiny_session=abc', 'tiny_session')).toBe('abc')
  })
  it('does NOT match a longer cookie name ending in the target', () => {
    expect(readCookie('x_tiny_session=decoy', 'tiny_session')).toBeUndefined()
  })
  it('prefers the real cookie over a decoy prefix cookie', () => {
    expect(readCookie('x_tiny_session=decoy; tiny_session=real', 'tiny_session')).toBe('real')
  })
  it('returns undefined when absent', () => {
    expect(readCookie('foo=1; bar=2', 'tiny_session')).toBeUndefined()
  })
})

describe('safeReturnPath — OAuth open-redirect guard', () => {
  it('allows same-origin paths', () => {
    expect(safeReturnPath('/')).toBe('/')
    expect(safeReturnPath('/@alice')).toBe('/@alice')
    expect(safeReturnPath('/support?q=hi')).toBe('/support?q=hi')
  })

  it('rejects protocol-relative // (the phishing bounce)', () => {
    expect(safeReturnPath('//evil.com')).toBe('/')
    expect(safeReturnPath('//evil.com/path')).toBe('/')
  })

  it('rejects backslash-prefixed /\\ (browsers normalize to //)', () => {
    expect(safeReturnPath('/\\evil.com')).toBe('/')
  })

  it('rejects absolute URLs and non-path junk', () => {
    expect(safeReturnPath('https://evil.com')).toBe('/')
    expect(safeReturnPath('http://evil.com')).toBe('/')
    expect(safeReturnPath('javascript:alert(1)')).toBe('/')
    expect(safeReturnPath('evil.com')).toBe('/')
  })

  it('rejects non-strings', () => {
    expect(safeReturnPath(null)).toBe('/')
    expect(safeReturnPath(undefined)).toBe('/')
    expect(safeReturnPath(42)).toBe('/')
  })
})

// The session cookie's flags are security-load-bearing: HttpOnly (no JS/XSS
// read), Secure (https only), SameSite=Lax (CSRF). A refactor silently
// dropping one is a serious, invisible auth hole — lock them.
describe('sessionCookie / clearSessionCookie flags', () => {
  it('sets the session token with all security flags', () => {
    const c = sessionCookie('tok-123')
    expect(c.startsWith(`${SESSION_COOKIE}=tok-123;`)).toBe(true)
    expect(c).toMatch(/;\s*HttpOnly/i)
    expect(c).toMatch(/;\s*Secure/i)
    expect(c).toMatch(/;\s*SameSite=Lax/i)
    expect(c).toMatch(/;\s*Path=\//i)
    expect(c).toMatch(/Max-Age=\d+/i)   // a positive lifetime
    expect(c).not.toMatch(/Max-Age=0\b/) // …not an immediate expiry
  })

  it('clear cookie expires immediately but keeps the security flags', () => {
    const c = clearSessionCookie()
    expect(c).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
    expect(c).toMatch(/Max-Age=0\b/)     // immediate expiry
    expect(c).toMatch(/;\s*HttpOnly/i)
    expect(c).toMatch(/;\s*Secure/i)
    expect(c).toMatch(/;\s*SameSite=Lax/i)
  })
})
