import { enforceIpDailyLimit } from "@/lib/rate-limit";
import { isTinyNotExists } from "@/lib/tiny-record";
import { getSession, getUserWithTinys } from "@/lib/auth";
import slugify from "slugify";

// IMPORTANT! Set the runtime to edge
export const runtime = 'edge'

export async function POST(req: Request) {
  // cost: 'others' — this endpoint accepts a private-tiny `key`, so the window
  // is the brute-force budget for guessing SOMEONE ELSE's key. Identity must buy
  // nothing here: accounts are free, so a per-user key would hand one attacker N
  // windows instead of one, and reputation is standing with us, not permission
  // over another owner's private tiny. IP-keyed at the base allowance.
  const limited = await enforceIpDailyLimit(req, { cost: 'others' });
  if (limited) return limited;

  const { name, key } = await req.json().catch(() => ({} as any));
  if (!name || typeof name !== 'string') {
    return new Response(JSON.stringify({ error: 'name required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Client-supplied values in an internal-key-authenticated URL — encode
  // so crafted input can't inject query params on the privileged channel
  const keyQuery = key ? `&key=${encodeURIComponent(String(key))}` : '';

  // Owner check: if the logged-in user owns this tiny, fetch with the internal
  // key so they can see + edit their full MCP config (headers included).
  const session = await getSession(req);
  let isOwner = false;
  if (session) {
    try {
      const profile = await getUserWithTinys(session.sub);
      // Stored tiny names are the worker's CANONICAL strict slug (upsert.ts:
      // { lower: true, strict: true }). The request `name` may be a
      // non-canonical variant the user typed into the editable name field
      // ("MyTiny", "cool.ai") — compare on the same strict slug or an owner
      // editing their own private tiny loads it un-vouched and gets it
      // blanked/redacted (no internal key forwarded below).
      const wantSlug = slugify(name, { lower: true, strict: true });
      isOwner = (profile?.tinys || []).some(
        (t: any) => t.name === name || t.name === wantSlug,
      );
    } catch { /* fail closed */ }
  }

  try {
    // userId must ride along with the internal key — the worker only unmasks
    // private content when the vouched userId matches tinys.user_id
    const ownerQuery = isOwner && session ? `&userId=${encodeURIComponent(session.sub)}` : '';
    // 10s bound: a worker that connects but never responds would otherwise
    // hold this open to the platform wall-clock, then drop into the catch —
    // which returns the blank/"missing" shape, so a slow worker reads as a
    // non-existent tiny in the editor. Timeout → AbortError → same bounded
    // degrade, fast. House rule (pass 86dce4d).
    const tiny = await fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(name)}${keyQuery}${ownerQuery}`, {
      headers: isOwner ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } : {},
      signal: AbortSignal.timeout(10_000),
    }).then(res => res.json());

    // Not-exists sentinel — field-inconsistent (`response` vs `message`);
    // normalization lives in lib/tiny-record (was: wrong-field read let a
    // missing tiny fall through with every field undefined).
    if (isTinyNotExists(tiny)) {
      return new Response(JSON.stringify({
        name,
        active: false,
        systemPrompt: '',
        systemKnowledge: '',
        data: '',
        hook: '',
        worker: '',
        schema: {},
      }));
    }

    return new Response(JSON.stringify({
      name,
      private: tiny.private,
      // Whether THIS caller is vouched for the private tiny (worker get.ts
      // echoes it in both the locked and full shapes). Native clients read
      // it to decide lock-screen vs unlocked chat; web derives the same from
      // its own /api/login unlock. Only ever true when isOwner forwarded the
      // internal key + userId above.
      isAuthorized: tiny.isAuthorized ?? false,
      active: tiny.active,
      systemPrompt: tiny.systemPrompt,
      systemKnowledge: tiny.systemKnowledge,
      data: tiny.data,
      hook: tiny.hook,
      worker: tiny.worker,
      schema: tiny.schema,
      ...(tiny.mcpServers ? { mcpServers: tiny.mcpServers } : {}),
      hero: tiny.hero || '',
      theme: tiny.theme || undefined,
      // 🎭 Per-tiny identity — top-level snake_case, matching the hero style
      logo: tiny.logo || '',
      intro_vibe: tiny.intro_vibe || '',
      chips: Array.isArray(tiny.chips) ? tiny.chips : [],
      tagline: tiny.tagline || '',
      // Per-tiny realtime call-voice (worker get.ts echoes it) — native clients
      // read it to show the active selection in the owner-only voice picker.
      voice: tiny.voice || '',
      isOwner,
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
      worker: '',
      schema: {},
    }));
  }
}