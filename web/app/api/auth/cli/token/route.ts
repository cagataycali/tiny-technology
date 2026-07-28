/**
 * POST /api/auth/cli/token — exchange a short-lived code for a CLI token.
 *
 * Body: { code, state } → { ok, token, user, expires }
 * The code is a 5-minute aud:'tiny-cli-code' JWT minted by /api/auth/cli
 * after the user approved on the consent page; it must carry the same state
 * nonce the CLI generated. The returned token is a 90-day aud:'tiny-cli'
 * JWT accepted as Authorization: Bearer by every session-gated /api/* route.
 */
import { issueCliToken, CLI_TOKEN_TTL } from '@/lib/auth'
import { jwtVerify } from 'jose'

export const runtime = 'edge'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { code, state } = await req.json().catch(() => ({} as any))
  if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) {
    return json({ ok: false, error: 'code and state required' }, 400)
  }

  const secret = process.env.AUTH_JWT_SECRET
  if (!secret) return json({ ok: false, error: 'auth not configured' }, 500)

  let payload: any
  try {
    ({ payload } = await jwtVerify(code, new TextEncoder().encode(secret), {
      audience: 'tiny-cli-code',
    }))
  } catch {
    return json({ ok: false, error: 'code expired or invalid' }, 401)
  }

  if (payload.state !== state) return json({ ok: false, error: 'state mismatch' }, 401)
  if (!payload.sub) return json({ ok: false, error: 'malformed code' }, 401)

  const user = {
    sub: payload.sub as string,
    login: (payload.login as string) || '',
    name: payload.name as string | undefined,
    avatar: payload.avatar as string | undefined,
  }
  const token = await issueCliToken(user)

  return json({
    ok: true,
    token,
    user: { id: user.sub, login: user.login, name: user.name, avatar: user.avatar },
    expires: Math.floor(Date.now() / 1000) + CLI_TOKEN_TTL,
  })
}
