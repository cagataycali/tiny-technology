import { OpenAPIRoute, Str, Bool } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
const slugify = require('slugify')
const OpenAI = require("openai");

// Optional fields that must be PRESERVED when an UPDATE omits them — sending a
// partial body (e.g. modify_ai refining just the prompt) must not wipe a
// tiny's worker/skills/data. `undefined` = keep existing; any other value
// (incl. '') = update/clear.
const PRESERVED_FIELDS = [
  'systemPrompt', 'systemKnowledge', 'data', 'worker', 'schema', 'skills', 'mcpServers', 'hook', 'hero', 'theme',
  'logo', 'intro_vibe', 'chips', 'tagline', 'voice',
] as const;

// 🎭 Per-tiny identity (cosmetic, like hero/theme) — pure normalizers, exported
// for tests (tests/upsert-merge.test.ts). Shared semantics: '' = explicit clear
// (PRESERVED_FIELDS overwrites), invalid = undefined (preserve existing).

/** The vibrate tool's canonical pattern names (web lib/chat/tools/client-side.ts). */
export const INTRO_VIBE_PATTERNS = [
  'tap', 'double', 'success', 'warning', 'error', 'heartbeat', 'sos', 'long', 'escalate', 'wave',
] as const;

/** Logo media URL — same https regex/limits as hero. Any media type (svg/gif/png/jpg/webp/mp4/webm); no extension enforcement. */
export function normalizeLogo(v: any): string | undefined {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return /^https:\/\/[^\s"'\\<>]{1,500}$/.test(s) ? s : undefined;
}

/**
 * Landing tagline — the owner's custom hero subtitle that replaces the generic
 * "A tiny — a living AI at tiny.technology/<name>. Say anything." line. Free
 * text, control chars stripped, trimmed, capped at 200 chars. '' = explicit
 * clear (falls back to the generic line); a run-on that exceeds the cap is
 * rejected (undefined = preserve existing) rather than silently truncated.
 */
export function normalizeTagline(v: any): string | undefined {
  const s = String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (s === '') return '';
  return s.length <= 200 ? s : undefined;
}

/** The OpenAI Realtime voices tiny's speech-to-speech sessions can use. */
export const VOICE_NAMES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

/**
 * Per-tiny voice — which OpenAI Realtime voice the tiny speaks with in voice
 * sessions (docs/voice-sessions-design.md). Allowlisted; '' clears (falls back
 * to the default 'marin' at session-create), anything unknown preserves.
 */
export function normalizeVoice(v: any): string | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return '';
  return (VOICE_NAMES as readonly string[]).includes(s) ? s : undefined;
}

/** Intro haptic — allowlisted vibrate pattern name. '' clears; anything else preserves. */
export function normalizeIntroVibe(v: any): string | undefined {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  return (INTRO_VIBE_PATTERNS as readonly string[]).includes(s) ? s : undefined;
}

/**
 * Starter chips — 1-4 strings, control chars stripped, trimmed, 1-60 chars
 * each; stored as a JSON array. Accepts an array or a JSON-array string (itty
 * declares the field as Str). '' or [] = explicit clear; anything malformed
 * (non-array, >4, non-string / empty / oversize element) = preserve.
 */
export function normalizeChips(v: any): string[] | '' | undefined {
  let arr: any = v;
  if (typeof arr === 'string') {
    if (arr.trim() === '') return '';
    try { arr = JSON.parse(arr); } catch { return undefined; }
  }
  if (!Array.isArray(arr)) return undefined;
  if (arr.length === 0) return '';
  if (arr.length > 4) return undefined;
  const cleaned: string[] = [];
  for (const c of arr) {
    if (typeof c !== 'string') return undefined;
    const s = c.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (s.length < 1 || s.length > 60) return undefined;
    cleaned.push(s);
  }
  return cleaned;
}

/**
 * Build the stored KV payload for an UPDATE: spread the incoming body, but for
 * each preserved field fall back to the existing stored value when the caller
 * omitted it. Pure + tested (tests/upsert-merge.test.ts) — this is the guard
 * against a partial update silently blanking a tiny's config.
 *
 * `canonicalName` is the authoritative slug (the KV key). It's stamped over
 * the body's raw `name` so the stored payload's name always matches the key —
 * otherwise /get returns the raw input (e.g. "My Tiny!") and builds broken
 * vcard/QR/stats URLs against it while the tiny lives at the slug.
 */
export function mergeUpsertPayload(body: any, existing: any, owner: string, nextPrivate: boolean, canonicalName: string): any {
  const merged: any = { ...body };
  for (const k of PRESERVED_FIELDS) {
    merged[k] = body[k] !== undefined ? body[k] : existing?.[k];
  }
  merged.name = canonicalName;
  merged.owner = owner;
  merged.active = true;
  merged.private = nextPrivate;
  return merged;
}

/**
 * Upsert a tiny — FREE platform, fresh start on tiny-v2.
 *
 * The tiny-v2 `tinys` table is the ONLY source of truth for existence and
 * ownership. Legacy KV/D1 data is kept for reference but is NOT in the hot
 * path: a name with no tiny-v2 row is free to claim, even if it existed on
 * the old platform.
 *
 *   - Requests carry `userId` (set by the Next.js app after GitHub/WebAuthn
 *     auth) — guarded by the internal key header.
 *   - No tiny-v2 row  → CREATE under the logged-in user (login required).
 *   - tiny-v2 row     → UPDATE only if userId matches the row's owner.
 *   - Legacy keys no longer authorize anything.
 */
export class UpsertCall extends OpenAPIRoute {
  static schema = {
    tags: ["Upsert AI"],
    summary: "Create or update a tiny (auth required for creation).",
    requestBody: {
      name: new Str({ required: true, description: "The unique name of your AI." }),
      systemPrompt: new Str({ required: true, description: "System prompt." }),
      systemKnowledge: new Str({ required: true, description: "System knowledge." }),
      data: new Str({ required: false, description: "Data repository." }),
      hook: new Str({ required: false, description: "Webhook URL." }),
      worker: new Str({ required: false, description: "OpenAPI.json URL for skills." }),
      mcpServers: new Str({ required: false, description: "MCP servers config (JSON: { name: { url, headers? } }). Headers stay private to the owner." }),
      private: new Bool({ required: false, description: "Private tinys are hidden from search/list; only the owner can chat." }),
      schema: new Str({ required: false, description: "Worker OpenAPI schema (JSON string)." }),
      skills: new Str({ required: false, description: "Parsed skills (JSON string)." }),
      hero: new Str({ required: false, description: "Hero/banner image URL (https) shown behind the tiny's landing hero. Empty string clears." }),
      theme: new Str({ required: false, description: "Per-tiny UI theme (JSON string: { accent: '#RRGGBB', bg: '#RRGGBB' }). Empty string clears." }),
      logo: new Str({ required: false, description: "Logo/avatar media URL (https) shown above the tiny's name on its landing hero — svg/gif/png/jpg/webp/mp4/webm all work. Empty string clears." }),
      intro_vibe: new Str({ required: false, description: "Haptic pattern played when the tiny opens on mobile — one of tap|double|success|warning|error|heartbeat|sos|long|escalate|wave. Empty string clears." }),
      chips: new Str({ required: false, description: "Starter suggestion chips (JSON array of 1-4 strings, each 1-60 chars) shown on the landing page instead of the defaults. Empty string/array clears." }),
      tagline: new Str({ required: false, description: "Custom landing subtitle (≤200 chars) shown under the tiny's name instead of the generic \"A tiny — a living AI at …\" line. Empty string clears (falls back to the generic line)." }),
      voice: new Str({ required: false, description: "Voice for speech-to-speech sessions — one of alloy|ash|ballad|coral|echo|sage|shimmer|verse|marin|cedar. Empty string clears (defaults to marin)." }),
      userId: new Str({ required: false, description: "Authenticated user id (internal)." }),
    },
    responses: {
      "200": { description: "Successful response", schema: { response: 'Welcome to tiny.technology!' } },
    },
  };

  async handle(
    request: Request,
    env: any,
    _ctx: any,
    data: Record<string, any>
  ) {
    // strict:true drops URL-hostile punctuation ('!!!' → ''); the empty
    // check rejects names that slugify to nothing (CJK, whitespace-only) —
    // otherwise we'd create a row with name='' reachable at tiny.technology/
    const name = slugify(String(data.body.name || ''), { lower: true, strict: true });
    if (!name) {
      return {
        response: "That name can't be used — pick one with letters or numbers (a-z, 0-9, hyphens).",
        error: 'invalid name',
      };
    }
    const userId: string = data.body.userId || '';

    // Normalize MCP config: accept object or JSON string → store as object.
    // Shape: { "<serverName>": { url: string, headers?: Record<string,string>, disabled?: bool } }
    if (data.body.mcpServers !== undefined) {
      let mcp = data.body.mcpServers;
      if (typeof mcp === 'string') {
        try { mcp = JSON.parse(mcp); } catch { mcp = undefined; }
      }
      if (mcp && typeof mcp === 'object') {
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(mcp as Record<string, any>)) {
          if (!v || typeof v !== 'object' || typeof (v as any).url !== 'string') continue;
          if (!(v as any).url.startsWith('https://')) continue; // https only
          cleaned[String(k).slice(0, 64)] = {
            url: (v as any).url,
            ...((v as any).headers && typeof (v as any).headers === 'object' ? { headers: (v as any).headers } : {}),
            ...((v as any).disabled ? { disabled: true } : {}),
          };
        }
        data.body.mcpServers = Object.keys(cleaned).length ? cleaned : undefined;
      } else {
        data.body.mcpServers = undefined;
      }
    }

    // 🎨 Per-tiny branding: hero must be a plain https URL (it lands in a
    // CSS background-image — reject anything that couldn't be an image URL);
    // theme is hex-validated {accent, bg}. Empty string = explicit clear
    // (PRESERVED_FIELDS semantics: '' overwrites, undefined preserves).
    if (data.body.hero !== undefined) {
      const h = String(data.body.hero || '').trim();
      if (h === '') data.body.hero = '';
      else data.body.hero = /^https:\/\/[^\s"'\\<>]{1,500}$/.test(h) ? h : undefined;
    }
    // 🎭 Per-tiny identity — same '' clears / invalid preserves semantics as
    // hero (pure normalizers above, exported for tests)
    if (data.body.logo !== undefined) data.body.logo = normalizeLogo(data.body.logo);
    if (data.body.intro_vibe !== undefined) data.body.intro_vibe = normalizeIntroVibe(data.body.intro_vibe);
    if (data.body.chips !== undefined) data.body.chips = normalizeChips(data.body.chips);
    if (data.body.tagline !== undefined) data.body.tagline = normalizeTagline(data.body.tagline);
    if (data.body.voice !== undefined) data.body.voice = normalizeVoice(data.body.voice);
    if (data.body.theme !== undefined) {
      let t: any = data.body.theme;
      if (typeof t === 'string') {
        if (t.trim() === '') t = '';
        else { try { t = JSON.parse(t); } catch { t = undefined; } }
      }
      if (t === '') {
        data.body.theme = '';
      } else if (t && typeof t === 'object') {
        const hex = /^#[0-9a-fA-F]{6}$/;
        const cleaned: any = {};
        if (hex.test(String((t as any).accent || ''))) cleaned.accent = (t as any).accent;
        if (hex.test(String((t as any).bg || ''))) cleaned.bg = (t as any).bg;
        data.body.theme = Object.keys(cleaned).length ? cleaned : undefined;
      } else {
        data.body.theme = undefined;
      }
    }

    // schema/skills arrive as JSON strings (router strips undeclared object
    // fields) — parse back to objects for storage
    for (const f of ['schema', 'skills'] as const) {
      if (typeof data.body[f] === 'string') {
        try { data.body[f] = JSON.parse(data.body[f]); } catch { data.body[f] = undefined; }
      }
    }

    // userId claims must come from our own app (internal key guard)
    const internalOk = checkInternalKey(request, env);
    const authedUserId = internalOk ? userId : '';

    // tiny-v2 is the source of truth — legacy KV data does NOT block creation
    let row: any = null;
    try {
      row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(name).first();
    } catch (err) { console.log(err, 'tinys lookup'); }

    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const embedTiny = async (active: boolean) => {
      try {
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: JSON.stringify({
            name,
            systemPrompt: data.body?.systemPrompt,
            systemKnowledge: data.body?.systemKnowledge,
            data: data.body?.data,
            worker: data.body?.worker,
            schema: data.body?.schema,
            timestamp: Date.now(),
          }),
          encoding_format: "float",
        });
        const values = embedding.data[0].embedding;
        if (values) {
          await env.VECTOR_INDEX.upsert([
            { id: name, values, metadata: { active } },
          ]);
        }
      } catch (err) {
        console.log(err, 'embeddings');
      }
    };

    // ─── CREATE (no tiny-v2 row — name is free, old-platform data ignored) ──
    if (!row) {
      // Login is REQUIRED to create a tiny (free platform, but must be authed)
      if (!authedUserId) {
        return {
          response: "Login required. Sign in at tiny.technology to create your AI — it's free!",
          loginRequired: true,
        };
      }

      // Honor the requested privacy flag at creation — the UI/tools offer a
      // PRIVATE toggle on the create form, and silently forcing public here
      // would index a private tiny's prompt/knowledge into universe search.
      const wantPrivate = data.body.private === true;

      const payload = JSON.stringify({
        ...data.body,
        name,                   // canonical slug, not the raw body name —
                                // /get builds vcard/QR/stats URLs from this
        hook: data.body.hook,
        active: true,           // FREE: active immediately
        private: wantPrivate,
        owner: authedUserId,
      });

      // Claim the name ATOMICALLY in the relational source of truth first.
      // The `if (!row)` above is a check-then-act: two concurrent creates of
      // the same free slug both read row=null. `INSERT OR REPLACE` would let
      // the loser silently overwrite the winner's ownership row (and its KV
      // config below). `ON CONFLICT(name) DO NOTHING` + a changes check makes
      // the claim first-writer-wins; the loser is told the name is taken.
      // (A genuine D1 error — not a conflict — throws and we stay lenient,
      // preserving the prior "DB hiccup doesn't block creation" behavior.)
      let claimed = true;
      try {
        const res = await env.DB.prepare(
          "INSERT INTO tinys (name, user_id, system_prompt, system_knowledge, private, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(name) DO NOTHING"
        ).bind(name, authedUserId, data.body.systemPrompt || '', data.body.systemKnowledge || '', wantPrivate ? 1 : 0).run();
        claimed = res?.meta?.changes === 1;
      } catch (err) {
        console.log(err, 'tinys insert');
      }
      if (!claimed) {
        return {
          response: "That name was just claimed by another account. Try a different one.",
        };
      }

      // KV stays the chat-runtime read path — written only AFTER we own the
      // name, so a race loser can't clobber the winner's config.
      await env.tiny.put(name, payload);

      // Private tinys are kept out of universe search entirely (retrieve also
      // filters — defense in depth); only public ones get embedded.
      if (!wantPrivate) await embedTiny(true);

      try {
        const createCount = await env.stats.get('tiny:create');
        await env.stats.put('tiny:create', Number(createCount || 0) + 1);
      } catch (err) { console.log(err); }

      return {
        response: `# 🌟 Your AI is live: [${name}]

**[${name}]** is ready at [tiny.technology/${name}](https://tiny.technology/${name}) — free, forever.

Chat with your AI!`
      };
    }

    // ─── UPDATE (tiny-v2 row exists) ─────────────────────────────────────────
    // Authorization: the logged-in user must own the row. Nothing else counts.
    const isOwner = !!authedUserId && row.user_id === authedUserId;

    if (!isOwner) {
      return {
        response: authedUserId
          ? "Not authorized. This tiny belongs to another account."
          : "Login required. Sign in at tiny.technology as the owner to modify this tiny.",
      };
    }

    const db = (await env.tiny.get(name, { type: "json" })) || {};
    const nextPrivate = data.body.private !== undefined ? data.body.private : db.private;

    // Preserve omitted optional fields (see mergeUpsertPayload) so a partial
    // update can't blank a tiny's worker/skills/data; name = the canonical slug.
    const payload = JSON.stringify(mergeUpsertPayload(data.body, db, authedUserId, nextPrivate, name));

    await env.tiny.put(name, payload);

    // Mirror the update into the relational table
    try {
      await env.DB.prepare(
        "UPDATE tinys SET system_prompt = ?, system_knowledge = ?, private = ?, active = 1, updated = unixepoch() WHERE name = ?"
      ).bind(data.body.systemPrompt || '', data.body.systemKnowledge || '', nextPrivate ? 1 : 0, name).run();
    } catch (err) { console.log(err, 'tinys update'); }

    // Vector index: private tinys are REMOVED from universe search entirely
    // (retrieve also filters — defense in depth); public ones re-embed.
    // Note: use nextPrivate, not the stale db.private.
    if (nextPrivate) {
      try { await env.VECTOR_INDEX.deleteByIds([name]); } catch (err) { console.log(err, 'vector delete'); }
    } else {
      await embedTiny(true);
    }

    try {
      const prefix = `tiny:update:${name}`;
      const updateCount = await env.stats.get(prefix);
      await env.stats.put(prefix, Number(updateCount || 0) + 1);
    } catch (err) { console.log(err); }

    return {
      response: `[${name}](https://tiny.technology/${name}) is updated.`
    };
  }
}
