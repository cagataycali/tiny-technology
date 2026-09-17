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
// One Range parser for the whole worker: /voice/recording learned the AVPlayer
// contract the hard way, and this store serves the same kind of bytes.
import { parseByteRange } from "./voice";

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

/**
 * 🗑️ EVERY KEY FAMILY IN THIS BUCKET, AND WHAT WOULD RECLAIM IT.
 *
 * There is no `MEDIA.delete` and no `MEDIA.list` anywhere in this worker: an
 * object here is permanent, and once its last reference is dropped it is also
 * unreachable — nothing can enumerate a bucket by prefix to find it again. So
 * "who still points at this?" is a property of OTHER stores, and a writer who
 * adds a key family without asking that question leaves bytes that are billed
 * forever and readable by nobody.
 *
 * Exported and enumerated because that bug is an ABSENCE — the same reason
 * delete.ts exports TINY_OWNED_STORES. A test asserts this list covers every
 * key template written in the worker AND every `reclaimed: false` entry says
 * why, in prose, so the gap is a documented decision instead of a silence.
 *
 * ⚠️ `reclaimed: false` is the honest state for ALL of them today. It is not a
 * TODO marker: it records that the reference-dropping half exists and the
 * byte-deleting half does not.
 */
export const MEDIA_KEY_FAMILIES: {
  key: string; writtenBy: string; referencedBy: string; reclaimed: boolean; how: string;
}[] = [
  {
    key: "<uuid>.<ext>",
    writtenBy: "media.ts MediaUploadCall (phones: screenshots, generated images, necklace audio, DM attachments)",
    referencedBy: "whatever row the uploader files afterwards — transcripts.audio_url, a messages attachment, a tool_results payload, or a chat history entry",
    reclaimed: false,
    how: "no delete exists. Several referrers are RINGS or sweeps that drop the reference by design (transcripts prunes at TRANSCRIPT_RING_CAP; tool_results sweeps at RESULT_SWEEP_AGE_S), so these are orphaned in normal operation, not only on user delete. A key may also be referenced by MORE than one row (a forwarded DM attachment), so a reclaim must be reference-counted — see MessageDeleteCall.",
  },
  {
    key: "voice/<sessionId>/recording.wav",
    writtenBy: "voice.ts (mixed on first replay request, then cached)",
    referencedBy: "derivable from the voice_sessions row id; regenerated from the pcm segments if absent",
    reclaimed: false,
    how: "a cache, not a record — safe to delete at any time, and nothing does. voice_sessions itself has no delete path anywhere (delete.ts TINY_OWNED_STORES tracks that as its own gap), so the session id that names this key outlives every tiny it belonged to.",
  },
  {
    key: "voice/<sessionId>/events.jsonl",
    writtenBy: "voice.ts teardown (the session's event journal)",
    referencedBy: "the voice_sessions row id",
    reclaimed: false,
    how: "written on teardown for a replay nobody has asked for yet — the same speculative-write shape the glasses recorder stopped doing (tests/glasses-clip-lazy-upload.test.ts). Kept because a call's journal is the only record of what the model heard and said.",
  },
  {
    key: "voice/<sessionId>/<in|out>-<seq>.pcm",
    writtenBy: "voice.ts flushSegment (fire-and-forget, every few seconds of a live call)",
    referencedBy: "the voice_sessions row id, by convention — the seq range is discovered by probing keys, never listed",
    reclaimed: false,
    how: "the highest-volume family here: raw audio of every voice call, both directions, written while the call runs. No delete, and the probe-by-convention read means a gap in the sequence is indistinguishable from the end of the call.",
  },
];

/** contentType allowlist → extension. Images + the audio formats the speak
 *  tool will persist. Anything else is rejected (this store never serves
 *  HTML/JS — no stored-XSS surface on the public GET).
 *
 *  📦 The last two are firmware, not media: a necklace's over-the-air bundle is
 *  a handful of MicroPython modules plus a manifest naming their sha256s, and
 *  the board streams them straight from here (strands-nicla firmware/tiny_ota.py,
 *  tools/publish_ota.py). Uploaded under their honest types rather than dressed
 *  as a PNG, so an object in this bucket is identifiable by whoever audits it.
 *
 *  Neither adds a script surface. MediaGetCall serves the stored contentType with
 *  X-Content-Type-Options: nosniff, and nosniff is exactly what stops a browser
 *  treating a non-JS type as JS — including a <script src> pointed at the JSON,
 *  which is the one way an inert-looking document becomes executable. The
 *  firmware itself is public source in the strands-nicla repo, so an unguessable
 *  URL holding a copy of it discloses nothing; the sha256s in the manifest are
 *  what make the bytes trustworthy, not the secrecy of the key. */
export const EXT: Record<string, string> = {
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
  // 📦 a necklace's OTA bundle: the modules, and the manifest that names them.
  "text/x-python": "py",
  "application/json": "json",
  // 📦 the Sticky's OTA app image (single-file A/B slot) — served as inert
  // bytes on the public GET like everything else; the 6MB cap governs and a
  // 4MB OTA slot caps the useful size anyway.
  "application/octet-stream": "bin",
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

    const base: Record<string, string> = {
      // Keys are content-addressed-once (never overwritten) — cache hard
      "Cache-Control": "public, max-age=31536000, immutable",
      // Belt-and-braces for the image/audio-only allowlist above
      "X-Content-Type-Options": "nosniff",
      // 🎧 Advertised on EVERY response, including the 404 path's siblings and
      // the whole-body 200: AVPlayer decides whether an asset is seekable from
      // this header on the first response, and a 200 without it is treated as a
      // non-seekable stream even if later requests would have been honored.
      "Accept-Ranges": "bytes",
    };

    // ── Range, because this store serves AUDIO to AVPlayer ────────────────────
    //
    // The route was `new Response(obj.body)` with no Content-Length and no
    // Accept-Ranges: fine for <img> and for web <audio>, and NOT playable by
    // AVPlayer, which opens every remote asset with `Range: bytes=0-1` and needs
    // Accept-Ranges + Content-Length + a correct 206/Content-Range to size and
    // seek the file. This is the identical bug that /voice/recording already had
    // and fixed ("iOS won't play call recordings"); NiclaRecorder uploads its
    // takes HERE, so the necklace's audio inherited the un-fixed copy. The rule
    // from that fix holds: the strictest client we serve defines the contract.
    //
    // parseByteRange is voice.ts's — imported rather than re-implemented, so the
    // RFC 7233 forms (0-1 probe, open-ended seek, suffix, clamping, the
    // unsatisfiable cases) stay pinned by ONE set of tests instead of drifting
    // between two parsers.
    const head = await env.MEDIA.head(key);
    if (!head) return json({ error: "not found" }, 404);
    const total = head.size as number;
    const type = head.httpMetadata?.contentType || "application/octet-stream";
    const r = parseByteRange(request.headers.get("Range"), total);

    if (r && "unsatisfiable" in r) {
      // 416 with `bytes */total` — a seek past the end must say how long the
      // asset really is, or the player retries the same bad window forever.
      return new Response(null, {
        status: 416,
        headers: { ...base, "Content-Type": type, "Content-Range": `bytes */${total}` },
      });
    }

    if (r) {
      // R2 slices server-side: a 2-byte probe reads 2 bytes, not the whole 6MB
      // clip, which is what makes this cheap enough to do on every open.
      const part = await env.MEDIA.get(key, { range: { offset: r.start, length: r.end - r.start + 1 } });
      if (!part) return json({ error: "not found" }, 404);
      return new Response(part.body, {
        status: 206,
        headers: {
          ...base,
          "Content-Type": type,
          "Content-Range": `bytes ${r.start}-${r.end}/${total}`,
          "Content-Length": String(r.end - r.start + 1),
        },
      });
    }

    const obj = await env.MEDIA.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      // Content-Length on the whole-body path too: without it the response is
      // chunked, and a player that cannot learn the length cannot show a
      // scrubber or seek — it just plays forward, if it plays at all.
      headers: { ...base, "Content-Type": type, "Content-Length": String(total) },
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
