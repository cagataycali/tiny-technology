/**
 * WebAuthn passkey login — biometric sign-in, no GitHub roundtrip.
 *
 * GET  → authentication options (discoverable credentials / usernameless)
 * POST → verify assertion against stored public key → issue session
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import {
  issueSession,
  sessionCookie,
  listCredentials,
  updateSignCount,
  getUserWithTinys,
  readCookie,
} from '@/lib/auth'
import { SignJWT, jwtVerify } from 'jose'

export const runtime = 'edge'

const CHALLENGE_COOKIE = 'tiny_webauthn_auth'

function rpFrom(req: Request) {
  const host = (req.headers.get('host') || 'tiny.technology').split(':')[0]
  const origin = req.headers.get('origin') || `https://${req.headers.get('host')}`
  return { rpID: host, origin }
}

const secret = () => new TextEncoder().encode(process.env.AUTH_JWT_SECRET || '')

export async function GET(req: Request) {
  const { rpID } = rpFrom(req)

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    // usernameless: rely on discoverable credentials on the authenticator
  })

  const challengeJwt = await new SignJWT({ challenge: options.challenge })
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
  const cookie = req.headers.get('cookie') || ''
  const token = readCookie(cookie, CHALLENGE_COOKIE)
  if (!token) return new Response(JSON.stringify({ error: 'challenge expired' }), { status: 400 })

  let expectedChallenge: string
  try {
    const { payload } = await jwtVerify(token, secret())
    expectedChallenge = payload.challenge as string
  } catch {
    return new Response(JSON.stringify({ error: 'invalid challenge' }), { status: 400 })
  }

  const { rpID, origin } = rpFrom(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
    return new Response(JSON.stringify({ error: 'invalid credential response' }), { status: 400 })
  }

  // Look up the credential by its id
  const creds = await listCredentials({ credentialId: body.id })
  const cred = creds[0]
  if (!cred) return new Response(JSON.stringify({ error: 'unknown credential' }), { status: 404 })

  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedRPID: rpID,
      expectedOrigin: origin,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
        counter: cred.sign_count || 0,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
      requireUserVerification: false,
    })

    if (!verification.verified) {
      return new Response(JSON.stringify({ error: 'verification failed' }), { status: 401 })
    }

    await updateSignCount(cred.id, verification.authenticationInfo.newCounter)

    // Fetch the user for session claims
    const data = await getUserWithTinys(cred.user_id)
    const user = data?.user

    const session = await issueSession({
      sub: cred.user_id,
      login: user?.github_login || '',
      name: user?.name || user?.github_login || 'tiny user',
      avatar: user?.avatar || '',
    })

    // Two Set-Cookies (issue session + clear the challenge). Use Headers.append
    // — a single comma-joined Set-Cookie header is ambiguous/mishandled by some
    // runtimes. Clear must match the set attributes (Secure; SameSite=Lax) so
    // the browser reliably deletes the challenge cookie.
    const headers = new Headers({ 'Content-Type': 'application/json' })
    headers.append('Set-Cookie', sessionCookie(session))
    headers.append('Set-Cookie', `${CHALLENGE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
    return new Response(JSON.stringify({ ok: true }), { headers })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 400 })
  }
}
