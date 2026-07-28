import { enforceIpDailyLimit } from "@/lib/rate-limit";
import { isTinyNotExists } from "@/lib/tiny-record";
import { getSession } from "@/lib/auth";

// IMPORTANT! Set the runtime to edge
export const runtime = 'edge'

export async function POST(req: Request) {
  // cost: 'others' — this is the private-tiny key check. The window IS the
  // brute-force budget against another owner's key, so a signed-in caller gets
  // no widening and no per-user bucket (free accounts would multiply the
  // budget). See LimitCost.
  const limited = await enforceIpDailyLimit(req, { cost: 'others' });
  if (limited) return limited;


  // Never a bare req.json() (AGENTS.md gotcha #13) — a malformed/empty body
  // would throw an unhandled 500 outside the try below instead of a clean 400.
  const { name, key } = (await req.json().catch(() => ({}))) as { name?: unknown; key?: unknown };

  if (!name || typeof name !== 'string') {
    return new Response(JSON.stringify({ ok: false, message: 'name required' }), { status: 400 });
  }

  // Session ownership unlocks private tinys without any key
  const session = await getSession(req);

  try {
    const params = new URLSearchParams({ name });
    if (typeof key === 'string' && key) params.set('key', key);
    if (session) params.set('userId', session.sub);
    // 10s bound: without it a worker that connects but never responds holds
    // this edge invocation open to the platform wall-clock, and the user then
    // lands in the catch below — which returns the "tiny doesn't exist" shape,
    // so a slow worker reads as a MISSING tiny. Timeout → AbortError → catch
    // (same bounded degrade, just fast). House rule (pass 86dce4d).
    const tiny = await fetch(`https://plugin.tiny.technology/get?${params}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      signal: AbortSignal.timeout(10_000),
    }).then(res => res.json());

    // Not-exists sentinel — field-inconsistent (`response` vs `message`);
    // normalization lives in lib/tiny-record (was: a `.message`-only check
    // was dead and a missing tiny fell through to ok:true; see pass 138).
    if (isTinyNotExists(tiny)) {
      return new Response(JSON.stringify({
        name,
        ok: false,
        active: false,
        private: false,
        systemPrompt: '',
        systemKnowledge: '',
        data: '',
        hook: '',
      }));
    }

    // Only expose owner-sensitive fields when the key actually authorized
    const authorized = tiny.isAuthorized === true;
    return new Response(JSON.stringify({
      name,
      ok: true,
      private: tiny.private,
      isAuthorized: authorized,
      active: tiny.active,
      systemPrompt: authorized || !tiny.private ? tiny.systemPrompt : '',
      systemKnowledge: authorized || !tiny.private ? tiny.systemKnowledge : '',
      data: authorized ? tiny.data : '',
      hook: authorized ? tiny.hook : '',
    }));
  } catch (err) {
    return new Response(JSON.stringify({
      name,
      private: false,
      active: false,
      systemPrompt: '',
      systemKnowledge: '',
      data: '',
      hook: '',
    }));
  }
}