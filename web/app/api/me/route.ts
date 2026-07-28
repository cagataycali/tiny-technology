/** GET /api/me → current session user + owned tinys + their standing. 401 if not logged in. */
import { getSession, getUserWithTinys } from '@/lib/auth'
import { freeTierRequestsPerDay } from '@/lib/free-tier'
import { reputationFor } from '@/lib/reputation'
import { standingFor } from '@/lib/standing'

export const runtime = 'edge'

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // 🏅 Standing rides along on the probe every client already makes (one shared
  // /api/me per page — lib/chat/whoami.ts). Until now the ONLY place the
  // platform said what a builder's reputation is worth was the 429 itself: c8's
  // header, then c37's copy. Both speak after the refusal. Meanwhile
  // ModelSettings quoted `freeTierRequestsPhrase()` — the deployment's base,
  // caller-blind — so a builder with standing was told the wrong number on the
  // one screen whose job is explaining the free tier.
  //
  // Two round-trips in parallel, not in sequence: this probe gates several
  // mount-time fetches, so serialising a 2s-worst-case worker read in front of
  // it would delay the whole authenticated page. `reputationFor` already
  // degrades to 0 on a slow or unhappy worker (standing can only RAISE a
  // limit), so the failure mode here is a builder shown their base allowance —
  // exactly what they saw before this existed.
  const [data, score] = await Promise.all([
    getUserWithTinys(session.sub),
    reputationFor(session.sub),
  ])
  return new Response(JSON.stringify({
    authenticated: true,
    user: {
      id: session.sub,
      login: session.login,
      name: session.name,
      avatar: session.avatar,
    },
    tinys: data?.tinys || [],
    // Computed with the SAME reputationAllowance the limiter builds its window
    // with (lib/rate-limit-curve), so the number shown before the wall and the
    // number enforced at it cannot drift. Pinned in tests/standing.test.ts.
    standing: standingFor(freeTierRequestsPerDay(), score, true),
  }), { headers: { 'Content-Type': 'application/json' } })
}
