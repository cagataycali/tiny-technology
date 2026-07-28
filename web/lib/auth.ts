/**
 * 🔐 tiny auth — edge-safe session + backend helpers.
 *
 * Identity model (free platform):
 *   - Users sign in with GitHub OAuth (primary) → user row in D1 (via worker).
 *   - Users can then enroll WebAuthn passkeys (biometric) tied to their user id.
 *   - Passkey login = full session, no GitHub roundtrip needed.
 *   - Sessions are signed JWTs (jose/HS256) in an httpOnly cookie.
 *
 * Env:
 *   AUTH_JWT_SECRET       — HMAC secret for session JWTs
 *   GITHUB_CLIENT_ID      — GitHub OAuth app
 *   GITHUB_CLIENT_SECRET
 *   INTERNAL_API_KEY      — shared secret with the Cloudflare worker
 */
import { SignJWT, jwtVerify } from 'jose'

export const SESSION_COOKIE = 'tiny_session'
export const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET
  if (!secret) throw new Error('AUTH_JWT_SECRET not set')
  return new TextEncoder().encode(secret)
}

export type SessionUser = {
  sub: string          // user id (uuid from D1)
  login: string        // github login
  name?: string
  avatar?: string
}

export async function issueSession(user: SessionUser): Promise<string> {
  return new SignJWT({ login: user.login, name: user.name, avatar: user.avatar })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL)
    .sign(secretKey())
}

/**
 * CLI token — same signing machinery, but marked aud:'tiny-cli' with a jti
 * so future revocation (KV denylist) can target CLI tokens without touching
 * browser sessions. verifySession ignores aud, so these pass everywhere a
 * session does.
 */
export const CLI_TOKEN_TTL = 60 * 60 * 24 * 90 // 90 days

export async function issueCliToken(user: SessionUser): Promise<string> {
  return new SignJWT({ login: user.login, name: user.name, avatar: user.avatar })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setAudience('tiny-cli')
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CLI_TOKEN_TTL)
    .sign(secretKey())
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey())
    return {
      sub: payload.sub as string,
      login: (payload.login as string) || '',
      name: payload.name as string | undefined,
      avatar: payload.avatar as string | undefined,
    }
  } catch {
    return null
  }
}

/**
 * Read one cookie value from a Cookie header, anchored to a cookie boundary.
 * A bare `name=([^;]+)` match is a substring match: a cookie like
 * `x_tiny_session=garbage` appearing before the real one would win and log a
 * genuine user out. Anchor to start-or-`; ` and escape regex metachars.
 */
export function readCookie(header: string, name: string): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return header.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]+)`))?.[1]
}

/** Extract + verify the session from a Request (cookie or bearer). */
export async function getSession(req: Request): Promise<SessionUser | null> {
  const cookie = req.headers.get('cookie') || ''
  let token = readCookie(cookie, SESSION_COOKIE)
  if (!token) {
    const auth = req.headers.get('authorization') || ''
    if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim()
  }
  if (!token) return null
  return verifySession(token)
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/**
 * Open-redirect guard for OAuth return_to / state. Only a same-origin
 * path is allowed — '/foo' passes, but '//evil.com' and '/\evil.com'
 * are protocol-relative (browsers treat them as an external host) and
 * fall back to '/'. Used post-login so a crafted return_to can't bounce
 * a genuinely-authenticated user to a phishing lookalike.
 */
export function safeReturnPath(raw: unknown): string {
  return typeof raw === 'string' && /^\/(?![/\\])/.test(raw) ? raw : '/'
}

// ── Worker (D1) helpers — internal-key guarded ──────────────────────────────

function internalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
  }
}

/**
 * Every worker round-trip here is on the identity critical path (OAuth
 * callback → upsert/get; passkey login → list/signcount; enroll → add).
 * A worker that HANGS rather than errors would otherwise pin the edge
 * invocation to Cloudflare's wall-clock ceiling and die as an opaque 502 —
 * the try/catch guards only catch *thrown* errors, never a stalled socket.
 * Bound each fetch to 10s so a hang fails fast into the same paths, matching
 * the house rule already applied in app/api/control + app/api/share.
 */
function internalInit(init: RequestInit = {}): RequestInit {
  return { ...init, headers: internalHeaders(), signal: AbortSignal.timeout(10_000) }
}

export async function upsertUser(gh: {
  id: number | string
  login: string
  email?: string
  name?: string
  avatar_url?: string
}): Promise<{ id: string } | null> {
  try {
    const res = await fetch(`${WORKER_URL}/user/upsert`, internalInit({
      method: 'POST',
      body: JSON.stringify({
        githubId: gh.id,
        login: gh.login,
        email: gh.email,
        name: gh.name,
        avatar: gh.avatar_url,
      }),
    }))
    const data = await res.json()
    return data.user || null
  } catch {
    return null
  }
}

export async function getUserWithTinys(userId: string) {
  try {
    const res = await fetch(`${WORKER_URL}/user/get?id=${encodeURIComponent(userId)}`, internalInit())
    return await res.json()
  } catch {
    return null
  }
}

export async function addCredential(cred: {
  userId: string
  credentialId: string
  publicKey: string
  signCount: number
  transports?: string[]
  label?: string
}) {
  return fetch(`${WORKER_URL}/credential/add`, internalInit({
    method: 'POST',
    body: JSON.stringify(cred),
  })).then(r => r.json())
}

export async function listCredentials(params: { userId?: string; credentialId?: string }) {
  const qs = params.credentialId
    ? `credential_id=${encodeURIComponent(params.credentialId)}`
    : `user_id=${encodeURIComponent(params.userId || '')}`
  return fetch(`${WORKER_URL}/credential/list?${qs}`, internalInit())
    .then(r => r.json())
    .then(d => d.credentials || [])
}

export async function updateSignCount(credentialId: string, signCount: number) {
  return fetch(`${WORKER_URL}/credential/signcount`, internalInit({
    method: 'POST',
    body: JSON.stringify({ credentialId, signCount }),
  })).then(r => r.json())
}
