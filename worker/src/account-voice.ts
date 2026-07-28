/**
 * Account-level default voice for live speech-to-speech calls (internal-key only).
 *
 *   GET  /account-voice?userId=       → { ok, voice }   ('' = unset)
 *   POST /account-voice { userId, voice } → { ok }       ('' clears)
 *
 * The live-call voice resolves per call (app/api/voice/session): the tiny's own
 * `voice` (owner's explicit per-tiny choice) → else this account default → else
 * 'marin'. Stored on `users.voice` so it survives reverting to the free chat
 * tier and applies even when the OpenAI key arrives via device headers.
 *
 * Allowlisted to the OpenAI Realtime voice set. The two directions need OPPOSITE
 * handling of an unknown value, which is why there are two functions rather than
 * one shared "normalize":
 *
 *   WRITE (POST) — an unknown value is REJECTED (400, no UPDATE). It used to be
 *     coerced to '' and written, so `{voice:"Marin "}` or a typo'd name from a
 *     non-picker client silently erased a default the user had set, and the
 *     response still said `{ ok: true }`. Destroying stored state while
 *     reporting success is the worst of the three options; the caller gets an
 *     error instead. '' is still an explicit clear — that is a real intent.
 *
 *   READ (GET) — an unknown value already in the column reads as '' (unset),
 *     because that is exactly what a live call will do with it: the voice/session
 *     route re-validates against its own allowlist and falls through. Reporting
 *     the raw value would tell the settings UI a voice is selected that no call
 *     will ever use.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The OpenAI Realtime voices a live call can use (mirrors the voice/session
 *  route allowlist + per-tiny normalizeVoice). '' = unset (→ marin at call). */
export const ACCOUNT_VOICE_NAMES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

/**
 * READ path: what a stored column value means to a caller. '' stays '';
 * a known voice is kept; anything else reads as unset, because a live call
 * will re-validate and fall through anyway.
 *
 * Do NOT use this on the write path — see `parseAccountVoiceWrite`.
 */
export function readAccountVoice(v: any): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "") return "";
  return (ACCOUNT_VOICE_NAMES as readonly string[]).includes(s) ? s : "";
}

/**
 * WRITE path: '' = clear, a known voice = set, anything else = REJECT.
 *
 * Returns `{ voice }` for a value safe to store, or `{ error }` for one that
 * must not reach the UPDATE. The union (rather than a bare string) is the point:
 * a string return has no way to say "don't write", which is how the coerce-to-''
 * bug survived — every caller of a `string` normalizer writes what it gets back.
 */
export function parseAccountVoiceWrite(v: any): { voice: string } | { error: string } {
  // A clear must be ASKED FOR. Anything that isn't a string is refused rather
  // than stringified, because several nothing-shaped values stringify to '' —
  // `String(undefined ?? '')`, `String(null ?? '')` and `String([])` are all ''
  // — and '' is a destructive instruction here. A missing field, a truncated
  // body and a mis-typed client all took that path.
  if (typeof v !== "string") {
    return { error: "voice must be a string — '' to clear, or a Realtime voice name" };
  }
  const s = v.trim().toLowerCase();
  if (s === "") return { voice: "" };
  if ((ACCOUNT_VOICE_NAMES as readonly string[]).includes(s)) return { voice: s };
  return {
    error: `unknown voice "${s}" — expected '' (clear) or one of: ${ACCOUNT_VOICE_NAMES.join(", ")}`,
  };
}

export class AccountVoiceGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: read a user's account-default call voice.",
    parameters: { userId: Query(String, { required: true, description: "User id." }) },
    responses: { "200": { description: "Voice", schema: { response: "Voice" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const row: any = await env.DB.prepare("SELECT voice FROM users WHERE id = ?")
      .bind(userId).first();
    return json({ ok: true, voice: readAccountVoice(row?.voice) });
  }
}

export class AccountVoiceSetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: set a user's account-default call voice.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      voice: new Str({ required: false, description: "Realtime voice; '' clears. An unknown name is a 400 — it does NOT clear." }),
    },
    responses: { "200": { description: "Set", schema: { response: "Set" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const b = data.body || {};
    const userId = String(b.userId || "");
    if (!userId) return json({ error: "userId required" }, 400);
    const parsed = parseAccountVoiceWrite(b.voice);
    // Reject BEFORE the UPDATE. An unknown value used to be coerced to '' and
    // written, so a typo wiped the user's default and the response still said
    // ok — a silent data loss the client had no way to notice.
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    // The user row always exists (created at first login) — a plain UPDATE is
    // enough; no INSERT path needed for a preference column.
    await env.DB.prepare("UPDATE users SET voice = ? WHERE id = ?")
      .bind(parsed.voice, userId).run();
    return json({ ok: true, voice: parsed.voice });
  }
}
