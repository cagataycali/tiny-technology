import { enforceIpDailyLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";
import slugify from "slugify";

// IMPORTANT! Set the runtime to edge
export const runtime = 'edge'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ message: 'Invalid request body.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const { name, systemPrompt, systemKnowledge, data, key, hook, priv, worker, schema, skills, mcpServers, hero, theme, logo, intro_vibe, chips, tagline, voice } = body;

  // Validate name before it reaches slugify (which throws on non-strings) —
  // otherwise a missing name faults into the generic catch and reports a
  // vague "something went wrong" instead of a clear validation error.
  if (typeof name !== 'string' || !name.trim()) {
    return new Response(JSON.stringify({ message: 'A name is required.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // 🔐 Auth-first: session (GitHub/WebAuthn) is the credential. The worker
  // authorizes by ownership (userId match in D1) — a legacy key is only an
  // optional fallback for pre-migration tinys.
  const session = await getSession(req);

  if (!session && !(key && key.trim().length > 0)) {
    return new Response(JSON.stringify({
      message: 'Login required. Sign in with GitHub to create or modify your AI — free!',
      loginRequired: true,
    }), { status: 401 });
  }

  // 🏅 Rate limit AFTER the session read, because this is the create/save path
  // and it's the wall the user actually reported: every builder behind one
  // office/campus/CGNAT egress shared a single 50/day bucket, so a colleague
  // iterating on their tiny could lock you out of saving yours. Signed-in
  // callers get their own window widened by their standing (cost: 'platform' —
  // the resource is our storage and re-index). Ordering matters: a 401 must not
  // consume a limiter slot, or a client looping without a session would burn a
  // real user's allowance out from under them.
  //
  // json: true because every other reply from this route is JSON and Control.tsx
  // calls response.json() unconditionally — a plain-text 429 threw into the
  // catch and surfaced as "Error on our end. Please try again.", which is both
  // false (it's the caller's allowance, not our failure) and hides the sentence
  // that says what standing is worth (lib/limit-message.ts).
  const limited = await enforceIpDailyLimit(req, { userId: session?.sub, json: true });
  if (limited) return limited;

  try {
    const { response, loginRequired, error } = await fetch('https://plugin.tiny.technology/upsert', {
      method: 'POST',
      // 15s bound (upsert can be heavier than a read — it writes tiny-v2 +
      // may re-index) so a hung worker routes into the existing catch below
      // ("Try again later") instead of pinning the edge invocation to CF
      // wall-clock. This is the create/save path — the user is waiting on it.
      signal: AbortSignal.timeout(15_000),
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        name,
        systemPrompt,
        systemKnowledge,
        data,
        private: priv,
        hook,
        worker,
        // Worker schema validates these as JSON strings
        ...(schema !== undefined ? { schema: typeof schema === 'string' ? schema : JSON.stringify(schema ?? {}) } : {}),
        ...(skills !== undefined ? { skills: typeof skills === 'string' ? skills : JSON.stringify(skills ?? []) } : {}),
        // Worker schema validates mcpServers as a string — stringify objects.
        // null (explicit clear) → empty string, which normalizes to undefined.
        ...(mcpServers !== undefined
          ? { mcpServers: typeof mcpServers === 'string' ? mcpServers : JSON.stringify(mcpServers ?? '') }
          : {}),
        // 🎨 Branding: worker validates https-URL hero + hex theme; both are
        // itty Str fields so objects must be stringified ('' = explicit clear)
        ...(hero !== undefined ? { hero: String(hero ?? '') } : {}),
        ...(theme !== undefined
          ? { theme: typeof theme === 'string' ? theme : (theme ? JSON.stringify(theme) : '') }
          : {}),
        // 🎭 Per-tiny identity — logo (https URL), intro_vibe (pattern name),
        // chips (array → JSON string; itty declares it as Str). '' / [] clears.
        ...(logo !== undefined ? { logo: String(logo ?? '') } : {}),
        ...(intro_vibe !== undefined ? { intro_vibe: String(intro_vibe ?? '') } : {}),
        ...(chips !== undefined
          ? { chips: typeof chips === 'string' ? chips : JSON.stringify(chips ?? []) }
          : {}),
        // Custom landing subtitle — plain string, '' = explicit clear
        ...(tagline !== undefined ? { tagline: String(tagline ?? '') } : {}),
        // 🎙️ Per-tiny live-call voice — worker allowlists; '' = inherit/clear
        ...(voice !== undefined ? { voice: String(voice ?? '') } : {}),
        ...(key && key.trim().length > 0 ? { key } : {}),
        ...(session ? { userId: session.sub } : {}),
      })
    })
      .then(response => response.json())

    if (loginRequired) {
      return new Response(JSON.stringify({
        message: 'Login required. Sign in with GitHub to create your AI — free!',
        loginRequired: true,
      }), { status: 401 });
    }

    if (typeof response === 'string' && response.includes('Not authorized')) {
      return new Response(JSON.stringify({
        message: "Not authorized — this tiny belongs to another account.",
      }), { status: 403 });
    }

    // Worker rejected the upsert (e.g. a name that strict-slugs to empty:
    // "___", "!!!" → { response: "That name can't be used…", error:
    // 'invalid name' }). Without this, the rejection fell through to the
    // Success branch below, which returned a truthy `name` → Control.tsx
    // toasted "saved 🎉" and opened a tab to a tiny that was never created.
    if (error) {
      return new Response(JSON.stringify({
        message: typeof response === 'string' && response
          ? response
          : "That name can't be used — pick one with letters or numbers.",
      }), { status: 400 });
    }

    return new Response(JSON.stringify({
      message: 'Success!',
      // Echo the name the worker actually stored (it slugifies) — callers
      // need the real slug to address the tiny afterwards. Must match the
      // worker's strict slug (upsert.ts: { lower: true, strict: true }) or a
      // name like "my!tiny" is stored as "mytiny" but reported as "my!tiny",
      // so the caller opens/displays a non-canonical URL for the new tiny.
      name: slugify(name, { lower: true, strict: true })
    }));
  } catch (err) {
    return new Response(JSON.stringify({
      message: 'Try again later. Something went wrong.',
    }));
  }
}