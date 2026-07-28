/**
 * /api/follow — follow/unfollow a builder (the user-gesture social edge).
 *   GET  ?login=<builder>          → { following } (or 401 logged out)
 *   POST { login, action? }        → follow (default) | unfollow
 *
 * Session-gated: the follower is ALWAYS session.sub — a client can never
 * follow on someone else's behalf. Follows are public edges by design
 * (the feed/trust layer reads them); unfollow closes bitemporally.
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

async function callWorker(followerId: string, targetLogin: string, action: string) {
  // 10s deadline + catch: without them a hung worker held this open to the
  // platform wall-clock and then threw an unhandled 500 — same gap the
  // pass-86dce4d hardening closed on the read routes. A follow tap that
  // can't reach the worker should surface a clean 503, not a dead spinner.
  try {
    const res = await fetch(`${WORKER}/follow`, {
      method: 'POST',
      headers: ikey(),
      body: JSON.stringify({ followerId, targetLogin: targetLogin.slice(0, 64), action }),
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'follow service unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const login = new URL(req.url).searchParams.get('login') || '';
  if (!login) return new Response(JSON.stringify({ error: 'login required param' }), { status: 400 });
  return callWorker(session.sub, login, 'check');
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  }
  const { login, action } = await req.json().catch(() => ({}));
  if (!login || typeof login !== 'string') {
    return new Response(JSON.stringify({ error: 'login required' }), { status: 400 });
  }
  return callWorker(session.sub, login, action === 'unfollow' ? 'unfollow' : 'follow');
}
