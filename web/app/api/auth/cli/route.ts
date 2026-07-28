/**
 * POST /api/auth/cli — mint a short-lived CLI auth code (consent page only).
 *
 * The npx tiny-tech CLI opens /auth/cli?port=<loopback>&state=<nonce>; the
 * consent page (session-gated) POSTs here after the user clicks Approve.
 * The code is a 5-minute signed JWT (aud:'tiny-cli-code') carrying the user
 * claims + the CLI's state nonce — stateless, no KV needed. The CLI
 * exchanges it at /api/auth/cli/token.
 *
 * Security: session required (the click IS the consent), loopback-only
 * redirect (127.0.0.1 + integer port), code bound to the state nonce and
 * useless without it, 5-minute expiry.
 */
import { getSession } from '@/lib/auth'
import { SignJWT } from 'jose'

export const runtime = 'edge'

const CODE_TTL_SECONDS = 300

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { port, state, scheme } = await req.json().catch(() => ({} as any))

  // Two redirect targets: loopback (CLI) or the fixed app scheme (iOS app).
  // scheme is an allowlist of exactly 'tinyapp' — never a client-provided URL.
  const useAppScheme = scheme === 'tinyapp'
  const portNum = Number(port)
  if (!useAppScheme && (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535)) {
    return json({ ok: false, error: 'invalid port' }, 400)
  }
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
    return json({ ok: false, error: 'invalid state' }, 400)
  }

  const secret = process.env.AUTH_JWT_SECRET
  if (!secret) return json({ ok: false, error: 'auth not configured' }, 500)

  const code = await new SignJWT({
    login: session.login,
    name: session.name,
    avatar: session.avatar,
    state,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.sub)
    .setAudience('tiny-cli-code')
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret))

  return json({
    ok: true,
    redirect: useAppScheme
      ? `tinyapp://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
      : `http://127.0.0.1:${portNum}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  })
}
