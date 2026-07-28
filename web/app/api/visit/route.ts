/**
 * /api/visit — pageview beacon from the chat client. Forwards to the
 * worker's /visit (internal-key), attaching the visitor's session identity
 * so owners aren't notified about their own visits and the notification
 * can say who came by.
 */
import { getSession } from "@/lib/auth";
import { enforceIpDailyLimit } from "@/lib/rate-limit";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // Bound to the slug charset/length the worker actually stores — this fires an
  // owner-facing notification/event, and the event ring is 200-capped, so an
  // unbounded/garbage name would forward verbatim and could evict real events.
  const name = String(body?.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  if (!name) {
    return new Response(JSON.stringify({ error: 'name required' }), { status: 400 });
  }
  // Per-IP daily cap on this unauthenticated beacon so an attacker can't loop
  // POSTs to flood a target owner's notification stream / event ring. Generous
  // (real users open at most a few dozen tinys/day, once per mount) + a distinct
  // bucket so it never starves the chat/login windows. Fails open on KV errors.
  // cost: 'others' — the thing being protected is a TARGET OWNER's notification
  // stream and 200-capped event ring, not our bill. Reputation buys nothing:
  // being followed is standing with the platform, not consent from the person
  // whose ring you'd be filling. IP-keyed at the base allowance. (Stated
  // explicitly so this can't drift into `userId: session?.sub` later.)
  const limited = await enforceIpDailyLimit(req, {
    requests: 300, keyPrefix: "visit_ratelimit_", json: true,
    message: "Too many visits today.", cost: 'others',
  });
  if (limited) return limited;

  const session = await getSession(req);
  // Deadline the beacon: a hung worker would otherwise hold this edge
  // invocation open until the platform wall-clock kills it (wasted compute on
  // a fire-and-forget POST). 10s → AbortError → .catch → null → the 502 below.
  const res = await fetch(`${WORKER}/visit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      name,
      ...(session ? { visitorId: session.sub, visitorLogin: session.login } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  // Don't forward the worker's raw error body/status to this unauthenticated
  // caller — a non-ok response can carry internal detail (e.g. `D1_ERROR:…`)
  // and was previously relayed verbatim while always labeled JSON. This is a
  // fire-and-forget beacon; the client ignores the body. Normalize to a fixed
  // ok/not-ok shape and a 502 on any upstream failure (mirrors /api/events).
  if (!res || !res.ok) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
