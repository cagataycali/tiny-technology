/**
 * Web Push subscription management (session-authorized).
 *   GET    → { key }  (public VAPID key for pushManager.subscribe)
 *   POST   PushSubscription JSON → store for this user
 *   DELETE { endpoint } → remove
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

export async function GET() {
  // The worker owns the VAPID key pair (it signs the sends) — fetch the
  // public half from there so subscribe/sign can never drift. Env var is
  // only a fallback for local dev.
  const fromWorker = await fetch(`${WORKER}/push/key`, { signal: AbortSignal.timeout(10_000) })
    .then(r => r.json()).then((d: any) => d.key || null).catch(() => null);
  return new Response(JSON.stringify({ key: fromWorker || process.env.NEXT_PUBLIC_VAPID_KEY || null }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });

  const sub = await req.json().catch(() => ({} as any));
  if (!sub?.endpoint || !sub?.keys) {
    return new Response(JSON.stringify({ error: 'invalid subscription' }), { status: 400 });
  }

  // 10s deadline + catch: a hung worker otherwise leaves the "enable
  // notifications" tap pending to the platform wall-clock, then throws an
  // unhandled 500 with no cue — mirror the AbortSignal.timeout guard every
  // other worker-proxying edge route uses (pass 86dce4d).
  try {
    const res = await fetch(`${WORKER}/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        userId: session.sub,
        endpoint: sub.endpoint,
        keys: JSON.stringify(sub.keys),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'push service unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) return new Response(JSON.stringify({ error: 'login required' }), { status: 401 });
  const { endpoint } = await req.json().catch(() => ({} as any));
  try {
    const res = await fetch(`${WORKER}/push/subscribe`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({ userId: session.sub, endpoint }),
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'push service unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}
