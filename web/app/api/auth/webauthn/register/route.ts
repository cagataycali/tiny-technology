/**
 * WebAuthn passkey enrollment (requires an active session — GitHub login first).
 *
 * GET  → registration options (challenge stashed in signed httpOnly cookie)
 * POST → verify attestation, store credential in D1 (via worker)
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { getSession, addCredential, listCredentials, readCookie } from '@/lib/auth'
import { SignJWT, jwtVerify } from 'jose'

export const runtime = 'edge'

const CHALLENGE_COOKIE = 'tiny_webauthn_reg'

function rpFrom(req: Request) {
  const host = (req.headers.get('host') || 'tiny.technology').split(':')[0]
  const origin = req.headers.get('origin') || `https://${req.headers.get('host')}`
  return { rpID: host, origin, rpName: 'tiny — Tiny Universe' }
}

const secret = () => new TextEncoder().encode(process.env.AUTH_JWT_SECRET || '')

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 })

  const { rpID, rpName } = rpFrom(req)
  const existing = await listCredentials({ userId: session.sub })

  const options = await generateRegistrationOptions({
    rpID,
    rpName,
    userName: session.login || session.sub,
    userDisplayName: session.name || session.login || 'tiny user',
    attestationType: 'none',
    excludeCredentials: existing.map((c: any) => ({ id: c.id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })

  const challengeJwt = await new SignJWT({ challenge: options.challenge, sub: session.sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(secret())

  return new Response(JSON.stringify(options), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${CHALLENGE_COOKIE}=${challengeJwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 })

  const cookie = req.headers.get('cookie') || ''
  const token = readCookie(cookie, CHALLENGE_COOKIE)
  if (!token) return new Response(JSON.stringify({ error: 'challenge expired' }), { status: 400 })

  let expectedChallenge: string
  try {
    const { payload } = await jwtVerify(token, secret())
    if (payload.sub !== session.sub) throw new Error('challenge/session mismatch')
    expectedChallenge = payload.challenge as string
  } catch {
    return new Response(JSON.stringify({ error: 'invalid challenge' }), { status: 400 })
  }

  const { rpID, origin } = rpFrom(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'invalid registration response' }), { status: 400 })
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedRPID: rpID,
      expectedOrigin: origin,
    })

    if (!verification.verified || !verification.registrationInfo) {
      return new Response(JSON.stringify({ error: 'verification failed' }), { status: 400 })
    }

    const { credential } = verification.registrationInfo
    // publicKey is Uint8Array — base64url encode for storage
    const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url')

    // The worker refuses (409) to re-bind a credential id already owned by a
    // DIFFERENT account — a globally-unique WebAuthn id colliding under another
    // user is never legitimate. Surface that instead of falsely reporting
    // success (the credential is NOT stored; the browser must not think the
    // passkey enrolled).
    const stored = await addCredential({
      userId: session.sub,
      credentialId: credential.id,
      publicKey: publicKeyB64,
      signCount: credential.counter,
      transports: body.response?.transports || [],
      label: body.label || 'passkey',
    })
    if (!stored?.ok) {
      return new Response(
        JSON.stringify({ error: stored?.error || 'could not store credential' }),
        { status: 409 },
      )
    }

    return new Response(JSON.stringify({ ok: true, credentialId: credential.id }), {
      headers: {
        'Content-Type': 'application/json',
        // Match the set attributes (Secure; SameSite=Lax) — a clearing
        // Set-Cookie whose attributes differ from the original may not reliably
        // delete it, leaving a stale challenge JWT in the browser.
        'Set-Cookie': `${CHALLENGE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 400 })
  }
}
