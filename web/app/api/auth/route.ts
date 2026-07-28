/**
 * GitHub OAuth — login entry + callback (https://tiny.technology/api/auth).
 *
 * GET /api/auth            → redirect to GitHub authorize
 * GET /api/auth?code=...   → exchange code, upsert user in D1, set session cookie
 */
import { issueSession, sessionCookie, upsertUser, safeReturnPath, readCookie } from '@/lib/auth'

export const runtime = 'edge'

// CSRF nonce cookie for the OAuth handshake. `state` carries `<nonce>:<path>`;
// the callback requires the nonce to match this cookie, so an attacker can't
// force a victim's browser to complete a login the victim never started
// (classic OAuth login-CSRF → logging the victim into the attacker's account).
const OAUTH_STATE_COOKIE = 'tiny_oauth_state'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return new Response('GitHub OAuth not configured', { status: 500 })
  }

  // Step 1: no code → mint a nonce, stash it in an httpOnly cookie, and pack
  // it into `state` alongside the (validated) return path.
  if (!code) {
    const returnTo = safeReturnPath(url.searchParams.get('return_to'))
    const nonce = crypto.randomUUID()
    const authorize = new URL('https://github.com/login/oauth/authorize')
    authorize.searchParams.set('client_id', clientId)
    authorize.searchParams.set('scope', 'read:user user:email')
    authorize.searchParams.set('state', `${nonce}:${returnTo}`)
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorize.toString(),
        // 10-min lifetime — the handshake takes seconds; SameSite=Lax so it
        // rides the top-level redirect back from GitHub.
        'Set-Cookie': `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    })
  }

  // Callback: verify the state nonce against the cookie before trusting `code`.
  const rawState = url.searchParams.get('state') || ''
  const sep = rawState.indexOf(':')
  const stateNonce = sep >= 0 ? rawState.slice(0, sep) : ''
  const returnTo = safeReturnPath(sep >= 0 ? rawState.slice(sep + 1) : rawState)
  const cookieNonce = readCookie(req.headers.get('cookie') || '', OAUTH_STATE_COOKIE)
  if (!stateNonce || !cookieNonce || stateNonce !== cookieNonce) {
    // Bounce back to a fresh login rather than error — a genuine user whose
    // nonce expired just re-starts; an attacker's forged callback dead-ends.
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/api/auth',
        'Set-Cookie': `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    })
  }

  // Step 2: exchange code for access token. 10s bound on every GitHub hop —
  // this is the login critical path; a hung GitHub connection would otherwise
  // pin the edge invocation to the platform wall-clock. Timeout → catch → the
  // clean OAuth-failed responses below (house rule, matches every other route).
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(() => null)

  const accessToken = tokenRes?.access_token
  if (!accessToken) {
    return new Response('GitHub OAuth failed: no access token', { status: 401 })
  }

  // Step 3: fetch GitHub identity
  const gh = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tiny-technology',
    },
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(() => null)

  if (!gh?.id) {
    return new Response('GitHub OAuth failed: no user', { status: 401 })
  }

  // Fetch primary email if not public
  let email = gh.email
  if (!email) {
    const emails = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tiny-technology',
      },
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.json()).catch(() => [])
    email = Array.isArray(emails)
      ? emails.find((e: any) => e.primary)?.email || emails[0]?.email
      : undefined
  }

  // Step 4: upsert user in D1 (via worker)
  const user = await upsertUser({
    id: gh.id,
    login: gh.login,
    email,
    name: gh.name,
    avatar_url: gh.avatar_url,
  })

  if (!user?.id) {
    return new Response('Failed to create user account', { status: 500 })
  }

  // Step 5: issue session + redirect home
  const token = await issueSession({
    sub: user.id,
    login: gh.login,
    name: gh.name || gh.login,
    avatar: gh.avatar_url,
  })

  // returnTo was validated (safeReturnPath) when state was parsed above.
  // Set the session cookie and clear the one-shot OAuth nonce.
  const headers = new Headers({ Location: returnTo })
  headers.append('Set-Cookie', sessionCookie(token))
  headers.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return new Response(null, { status: 302, headers })
}
