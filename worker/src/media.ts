/**
 * Media store (on-device generative tools — docs/on-device-genai-research-2026-07.md).
 *
 * Cloud persistence for device-generated media (images now, audio next):
 * a phone generates an image on-device, uploads it here once, and every
 * client renders it by URL — no base64 in histories, no relay size caps.
 *
 *   POST /media/upload        { userId | deviceId+token, data(base64), contentType }
 *                                                            → { key, url }   (internal-key)
 *   GET  /media/:key          → bytes (public; keys are unguessable UUIDs)
 *   POST /device/tool-result  { userId, toolUseId, payload }        → { ok }         (internal-key)
 *   GET  /device/tool-result?userId=&toolUseId=                     → { result? }    (internal-key)
 *
 * The tool-result pair is the mailbox that turns fire-and-forget client
 * tools into round-trips: the device posts its outcome keyed by toolUseId,
 * the chat route's tool callback polls it back into the agent loop (same
 * shape as relay send/recv, but tool-scoped and without the 8KB envelope
 * cap mattering — media rides R2, the mailbox carries only {key,url,meta}).
 *
 * Security invariants:
 *   - upload/post/get-result ride the internal-key channel only; the app
 *     proxies front them and stamp the session's userId (a client can never
 *     write another user's mailbox or attribute media to someone else)
 *   - a DEVICE may upload without a session, but only by presenting its own
 *     enrolled token: the owner is looked up from (id, token_hash, revoked=0),
 *     never taken from the request. This is what lets a wearable — whose flash
 *     is readable by anyone holding it — carry a narrow revocable credential
 *     instead of the account's bearer JWT.
 *   - /media/:key GETs are public-but-unguessable (UUID keys, like every
 *     CDN share link); owner rides R2 customMetadata for future auditing
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken } from "./devices";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Decoded upload cap — a 1280px JPEG from the phones is ~200-800KB; 6MB
 *  leaves room for PNG/audio without letting the mailbox become a dropbox. */
const MEDIA_MAX_BYTES = 6 * 1024 * 1024;
const RESULT_MAX = 32 * 1024;
const RESULT_SWEEP_AGE_S = 900; // tool results are ephemeral: 15 min

/** contentType allowlist → extension. Images + the audio formats the speak
 *  tool will persist. Anything else is rejected (this store never serves
 *  HTML/JS — no stored-XSS surface on the public GET). */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  // 🎥 meta_record_video (glasses clips) — mp4 is as inert as the images on
  // the public GET (no HTML/JS surface); the 6MB cap above still governs.
  "video/mp4": "mp4",
};

/** Resolve an uploading device's owner. Identical shape to
 *  RELAY_DEVICE_AUTH_SQL: a device id alone proves nothing, and a revoked
 *  device stops resolving the moment the owner revokes it. */
export const MEDIA_DEVICE_AUTH_SQL = `
  SELECT user_id FROM devices WHERE id = ?1 AND token_hash = ?2 AND revoked = 0`;

export const TOOL_RESULT_INSERT_SQL = `
  INSERT INTO tool_results (id, user_id, tool_use_id, payload, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)`;

export const TOOL_RESULT_GET_SQL = `
  SELECT payload, created_at FROM tool_results
  WHERE user_id = ?1 AND tool_use_id = ?2
  ORDER BY created_at DESC LIMIT 1`;

export const TOOL_RESULT_SWEEP_SQL = `
  DELETE FROM tool_results WHERE created_at < ?1`;

/** Base64 → bytes with a hard size gate BEFORE decode (a 100MB body must
 *  not be atob'd just to be rejected). 4/3 overhead + padding slack. */
export function decodeBase64Capped(b64: string, maxBytes: number): Uint8Array | null {
  if (typeof b64 !== "string" || !b64) return null;
  if (b64.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  try {
    const bin = atob(b64);
    if (bin.length > maxBytes) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export class MediaUploadCall extends OpenAPIRoute {
  static schema = {
    tags: ["Media"],
    summary: "Internal: store device-generated media in R2, get a stable URL.",
    requestBody: {
      userId: new Str({ required: false, description: "owner; OR authenticate with deviceId+token" }),
      deviceId: new Str({ required: false, description: "enrolled device uploading on its own token" }),
      token: new Str({ required: false, description: "that device's token (verified by hash)" }),
      data: new Str({ required: true, description: "base64 bytes, ≤6MB decoded" }),
      contentType: new Str({ required: true, description: "image/jpeg|png|webp|gif, audio/mp4|mpeg|wav|ogg" }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    if (!env.MEDIA) return json({ error: "media store not provisioned" }, 424);
    const { userId, deviceId, token, data: b64, contentType } = data.body;

    // Two ways to name the owner, and the DEVICE never gets to assert it.
    // A wearable's flash is readable by whoever holds the wearable, so the
    // necklace carries only its own revocable device token — not the account
    // bearer JWT it used to need to reach the app's /api/media proxy. The
    // owner is resolved from (id, token_hash) exactly as relay poll/reply do,
    // so a stolen token uploads to its own account and dies on revoke.
    let owner: string;
    if (deviceId && token) {
      const row = await env.DB.prepare(MEDIA_DEVICE_AUTH_SQL)
        .bind(String(deviceId), await hashDeviceToken(String(token))).first();
      // Wrong token and revoked device are indistinguishable — same no-oracle
      // property as heartbeat: no probing which device ids exist.
      if (!row?.user_id) return json({ error: "unknown device" }, 401);
      owner = String(row.user_id);
    } else if (userId) {
      owner = String(userId);
    } else {
      return json({ error: "userId or deviceId+token required" }, 400);
    }

    const ext = EXT[String(contentType || "")];
    if (!ext) return json({ error: `contentType must be one of: ${Object.keys(EXT).join(", ")}` }, 400);

    const bytes = decodeBase64Capped(String(b64 || ""), MEDIA_MAX_BYTES);
    if (!bytes || bytes.length === 0) return json({ error: "data must be valid base64 ≤6MB" }, 400);

    const key = `${crypto.randomUUID()}.${ext}`;
    await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: String(contentType) },
      customMetadata: { user_id: owner },
    });

    const url = `${new URL(request.url).origin}/media/${key}`;
    return json({ ok: true, key, url, bytes: bytes.length });
  }
}

export class MediaGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Media"],
    summary: "Serve stored media (public; unguessable UUID keys).",
    responses: { "200": { description: "Bytes" } },
  };

  async handle(request: Request, env: any) {
    if (!env.MEDIA) return json({ error: "media store not provisioned" }, 424);
    // Last path segment; itty exposes params but parsing the URL needs no
    // router coupling and survives docs-registration quirks.
    const key = decodeURIComponent(new URL(request.url).pathname.split("/").pop() || "");
    // UUID.ext only — no traversal, no listing probes
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(key)) return json({ error: "not found" }, 404);

    const obj = await env.MEDIA.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
        // Keys are content-addressed-once (never overwritten) — cache hard
        "Cache-Control": "public, max-age=31536000, immutable",
        // Belt-and-braces for the image/audio-only allowlist above
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}

export class ToolResultPostCall extends OpenAPIRoute {
  static schema = {
    tags: ["Media"],
    summary: "Internal: device posts a client-tool result (keyed by toolUseId).",
    requestBody: {
      userId: new Str({ required: true }),
      toolUseId: new Str({ required: true }),
      payload: new Str({ required: true, description: "JSON string, ≤32KB (media rides R2, not here)" }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, toolUseId, payload } = data.body;
    if (!userId || !toolUseId) return json({ error: "userId and toolUseId required" }, 400);

    let clean: string;
    try {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
      if (!text || text.length > RESULT_MAX) return json({ error: "payload must be JSON ≤32KB" }, 400);
      JSON.parse(text);
      clean = text;
    } catch {
      return json({ error: "payload must be valid JSON" }, 400);
    }

    await env.DB.prepare(TOOL_RESULT_INSERT_SQL).bind(
      crypto.randomUUID(), String(userId), String(toolUseId), clean, Math.floor(Date.now() / 1000)
    ).run();

    // Fire-and-forget hygiene (relay.ts sweep pattern — waitUntil, never blocks)
    const cutoff = Math.floor(Date.now() / 1000) - RESULT_SWEEP_AGE_S;
    const p = env.DB.prepare(TOOL_RESULT_SWEEP_SQL).bind(cutoff).run().catch(() => { });
    try { ctx?.waitUntil?.(p); } catch { }

    return json({ ok: true });
  }
}

export class ToolResultGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Media"],
    summary: "Internal: fetch a device-posted tool result (user-scoped).",
    parameters: {
      userId: Query(Str, { required: true }),
      toolUseId: Query(Str, { required: true }),
    },
    responses: { "200": { description: "Result", schema: { response: "Result" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const userId = data.userId || url.searchParams.get("userId");
    const toolUseId = data.toolUseId || url.searchParams.get("toolUseId");
    if (!userId || !toolUseId) return json({ error: "userId and toolUseId required" }, 400);

    const row = await env.DB.prepare(TOOL_RESULT_GET_SQL)
      .bind(String(userId), String(toolUseId)).first();
    if (!row) return json({ ok: true, result: null });
    return json({ ok: true, result: { payload: row.payload, created_at: row.created_at } });
  }
}
