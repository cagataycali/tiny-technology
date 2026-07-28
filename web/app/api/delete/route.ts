/**
 * DELETE /api/delete — permanently remove a tiny you own.
 * Session-authorized; the worker enforces ownership against tiny-v2.
 */
import { getSession } from "@/lib/auth";

export const runtime = 'edge'

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Login required.' }), { status: 401 });
  }

  const { name } = await req.json().catch(() => ({} as any));
  if (!name || typeof name !== 'string') {
    return new Response(JSON.stringify({ error: 'name required' }), { status: 400 });
  }

  // 10s bound + fetch-throw guard: the fetch had no timeout (hang to CF
  // wall-clock) and `await res.text()` was unprotected against the fetch
  // rejecting (timeout/network) — a thrown fetch became an opaque 500 with no
  // JSON body, so Control.tsx's d.ok/d.error branch got nothing to read.
  // Degrade to an honest 503 {error} the consumer's else-branch surfaces.
  let res: Response;
  try {
    res = await fetch('https://plugin.tiny.technology/tiny', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({ name, userId: session.sub }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return new Response(JSON.stringify({ error: "Couldn't reach the server — try again." }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
