/**
 * 🎤 Transcripts (Nicla Voice recorder — migration 0030).
 *
 * The Voice necklace can only say THAT a word matched (device/event → the
 * ring); the words that follow are recorded and transcribed by the paired
 * PHONE, on-device. The phone uploads the audio to R2 via /media/upload and
 * POSTs the text here — so the transcript is durable, listable, and readable
 * by the agent tools long after the relay envelope that asked for it swept.
 *
 *   POST /transcript           { deviceId, token, text, label?, audioUrl?, durationS? }
 *                              → { ok, id }        (device token resolves the owner)
 *   GET  /transcript/list?userId=&limit=            → { transcripts } (previews, newest first)
 *   GET  /transcript?userId=&id=                    → { transcript }  (full text)
 *
 * Auth model splits like the rest of the device API: the WRITE authenticates
 * by device token (DEVICE_EVENT_AUTH_SQL — the caller may be a phone with
 * nobody logged in on screen, and the token resolves the OWNER so a device can
 * only ever write to its own user's transcripts). The READS are internal-only
 * with userId stamped by the app proxy / agent tool, never taken from a body.
 *
 * Ring semantics like events.ts: capped per user, oldest pruned on write —
 * a transcript is a note about a moment, not an archive; the audio in R2 is
 * the archive.
 */
import { OpenAPIRoute, Query, Str, Int } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken, DEVICE_EVENT_AUTH_SQL } from "./devices";
import { emitEvent } from "./events";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Ring cap per user (events.ts RING_CAP semantics: oldest pruned on write). */
export const TRANSCRIPT_RING_CAP = 200;
/** ~2 minutes of dense speech is <4KB; 16KB is generous without letting a
 *  compromised phone turn the table into blob storage. */
export const TRANSCRIPT_TEXT_MAX = 16 * 1024;
export const TRANSCRIPT_LABEL_MAX = 80;
export const TRANSCRIPT_AUDIO_URL_MAX = 300;
/** What the list returns per row — enough to recognize a recording. */
export const TRANSCRIPT_PREVIEW_CHARS = 200;

// SQL as exported constants (devices.ts pattern) so the worker-gated tests
// can exercise the exact statements against a local sqlite.
export const TRANSCRIPT_INSERT_SQL = `
  INSERT INTO transcripts (id, user_id, device_id, label, text, audio_url, duration_s, created)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

// `created` ties within a second; rowid breaks the tie in insertion order so
// the prune never evicts the newer of two same-second recordings.
export const TRANSCRIPT_PRUNE_SQL = `
  DELETE FROM transcripts WHERE user_id = ?1 AND id NOT IN (
    SELECT id FROM transcripts WHERE user_id = ?1
    ORDER BY created DESC, rowid DESC LIMIT ?2)`;

export const TRANSCRIPT_LIST_SQL = `
  SELECT id, label, substr(text, 1, ${TRANSCRIPT_PREVIEW_CHARS}) AS preview,
         audio_url, duration_s, created
  FROM transcripts WHERE user_id = ?1
  ORDER BY created DESC, rowid DESC LIMIT ?2`;

/** Owner-scoped, like ENDPOINT_GET_SQL: an id alone is never enough, so a
 *  leaked transcript id can't be used to read someone else's words. */
export const TRANSCRIPT_GET_SQL = `
  SELECT id, device_id, label, text, audio_url, duration_s, created
  FROM transcripts WHERE id = ?1 AND user_id = ?2`;

export class TranscriptAddCall extends OpenAPIRoute {
  static schema = {
    tags: ["Transcripts"],
    summary: "Internal: store a device-produced transcript (device token in-body).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      text: new Str({ required: true, description: "The transcript text (≤16KB, clamped)." }),
      label: new Str({ required: false, description: 'Wake label or reason, e.g. "wake: alexa" (≤80).' }),
      audioUrl: new Str({ required: false, description: "Hosted https:// audio URL from /media/upload (≤300)." }),
      durationS: new Int({ required: false, description: "Recording length in seconds." }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, text, label, audioUrl, durationS } = data.body;
    if (!deviceId || !token) return json({ error: "deviceId and token required" }, 400);
    const body = String(text ?? "");
    if (!body.trim()) return json({ error: "text required" }, 400);

    // Refuse a bad audio URL rather than storing it: every client renders this
    // field as a playable link, and an http:// or oversized value here would be
    // a broken (or mixed-content) player on every surface that lists it.
    const audio = String(audioUrl ?? "").trim();
    if (audio && (!audio.startsWith("https://") || audio.length > TRANSCRIPT_AUDIO_URL_MAX)) {
      return json({ error: `audioUrl must be https:// and ≤${TRANSCRIPT_AUDIO_URL_MAX} chars` }, 400);
    }

    // Same auth as /device/event: the token resolves the OWNER, so the write
    // can only land on the holder's own account — and a wrong token vs a
    // revoked device stay indistinguishable (no oracle).
    const row = await env.DB.prepare(DEVICE_EVENT_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    if (!row?.user_id) return json({ error: "unknown device" }, 401);

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const userId = String(row.user_id);
    await env.DB.prepare(TRANSCRIPT_INSERT_SQL).bind(
      id,
      userId,
      String(deviceId),
      String(label ?? "").slice(0, TRANSCRIPT_LABEL_MAX),
      body.slice(0, TRANSCRIPT_TEXT_MAX),
      audio,
      Math.max(0, Math.floor(Number(durationS) || 0)),
      now,
    ).run();

    // Ring semantics (events.ts RING_CAP): oldest beyond the cap pruned on write.
    await env.DB.prepare(TRANSCRIPT_PRUNE_SQL).bind(userId, TRANSCRIPT_RING_CAP).run();

    // Name the device + carry the id: the ring is what the next turn's prompt
    // reads, and an id in the detail is what lets the agent fetch the full text
    // (nicla_voice_transcript) instead of quoting a truncated event. Budgeted
    // to survive emitEvent's own 300-char slice: 40 name + 200 preview + the
    // uuid still fit, so the id is never the part that gets cut.
    const name = String(row.name || "device").slice(0, 40);
    await emitEvent(env, userId, "nicla_transcript",
      `${name}: "${body.slice(0, TRANSCRIPT_PREVIEW_CHARS)}" (transcript ${id})`);

    return json({ ok: true, id, created: now });
  }
}

export class TranscriptListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Transcripts"],
    summary: "Internal: a user's recent transcripts, newest first (previews).",
    parameters: {
      userId: Query(String, { required: true }),
      limit: Query(Number, { required: false, default: 10, description: "Max transcripts (≤50)." }),
    },
    responses: { "200": { description: "Transcripts", schema: { response: "Transcripts" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const limit = Math.min(Math.max(Number(q.get("limit")) || 10, 1), 50);
    const { results } = await env.DB.prepare(TRANSCRIPT_LIST_SQL).bind(userId, limit).all();
    return json({ ok: true, transcripts: results || [] });
  }
}

export class TranscriptGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Transcripts"],
    summary: "Internal: one transcript in full (owner-scoped by userId + id).",
    parameters: {
      userId: Query(String, { required: true }),
      id: Query(String, { required: true }),
    },
    responses: { "200": { description: "Transcript", schema: { response: "Transcript" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    const id = q.get("id") || "";
    if (!userId || !id) return json({ error: "userId and id required" }, 400);
    const row = await env.DB.prepare(TRANSCRIPT_GET_SQL).bind(id, userId).first();
    // Someone else's id and a nonexistent one answer alike — no oracle on
    // which transcript ids exist.
    if (!row) return json({ error: "not found" }, 404);
    return json({ ok: true, transcript: row });
  }
}
