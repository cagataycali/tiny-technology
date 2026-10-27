/**
 * 🎙️ Device transcribe — speech-to-text as a standalone device verb.
 *
 *   POST /device/transcribe   { deviceId, token, audioUrl }
 *                             → { ok, text }
 *
 * Until this route, a device could only turn speech into words by ASKING:
 * /device/ask transcribes and then runs a full agent turn on the result. That
 * left every other text field on a device keyboard-only — a Sticky replying to
 * a DM had to type on e-ink at two keys a second while the microphone sat
 * next to the glass. This route is the transcription half of /device/ask on
 * its own, so any input point (DM reply, ask composer, a future search box)
 * can offer dictation: record → /media/upload → here → the words land in the
 * field, editable, and the device sends them through whatever route that
 * field already uses. Nothing is sent, stored or answered on the caller's
 * behalf; the transcript goes back to the device and nowhere else.
 *
 * Auth is the device-API split /device/ask uses: internal-key gated (every
 * call arrives via the app proxy /api/devices/transcribe) and the device
 * token resolves the owner (DEVICE_EVENT_AUTH_SQL — wrong token, revoked and
 * unknown are one indistinguishable 401).
 *
 * One rule /device/ask does not need: the audio must be THIS OWNER'S upload.
 * /device/ask spends its transcript on the caller's own agent turn, so a
 * foreign URL only ever wastes the caller's own budget. Here the words come
 * straight back, which would make the route a reader for anyone else's voice
 * note whose media URL leaked (a forwarded DM attachment, a pasted link).
 * So only this worker's own /media/<uuid>.<ext> keys are accepted, and the
 * R2 object's customMetadata.user_id (stamped by MediaUploadCall) must be the
 * device's owner. A mismatch answers exactly like a missing object: 404,
 * no oracle on whose audio a key holds.
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken, DEVICE_EVENT_AUTH_SQL } from "./devices";
import { transcribeAudioUrl, ASK_AUDIO_URL_MAX, ASK_TEXT_MAX } from "./ask";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The media store's key shape (MediaUploadCall: `${uuid}.${ext}`). The same
 *  pattern decideAttachments pins DM attachment URLs to. */
const MEDIA_PATH = /^\/media\/([0-9a-f-]{36}\.[a-z0-9]{2,4})$/;

/** Not found and not yours read the same — see the header. */
export const TRANSCRIBE_NOT_FOUND = "audio not found";

/** The R2 key of an audioUrl if it names THIS worker's media store, else null.
 *  `origin` is the worker's own origin (new URL(request.url).origin) — the
 *  value MediaUploadCall stamps into the URLs it hands out. */
export function ownMediaKey(audioUrl: string, origin: string): string | null {
  let u: URL;
  let base: string;
  try {
    u = new URL(audioUrl);
    base = new URL(origin).origin;
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.origin !== base) return null;
  if (u.search || u.hash) return null;
  const m = u.pathname.match(MEDIA_PATH);
  return m ? m[1] : null;
}

export class DeviceTranscribeCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: a device turns its own uploaded audio into text (device token in-body). No agent turn, nothing sent or stored.",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      audioUrl: new Str({ required: true, description: "This worker's /media/<key> URL from /media/upload, uploaded by the same owner." }),
    },
    responses: { "200": { description: "Transcribed", schema: { response: "Transcribed" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token } = data.body;
    const audioUrl = String(data.body.audioUrl ?? "").trim();
    if (!deviceId || !token || !audioUrl) {
      return json({ ok: false, error: "deviceId, token and audioUrl required" }, 400);
    }
    if (audioUrl.length > ASK_AUDIO_URL_MAX) return json({ ok: false, error: "audioUrl too long" }, 400);

    const key = ownMediaKey(audioUrl, new URL(request.url).origin);
    if (!key) return json({ ok: false, error: "audioUrl must be a /media/... URL from this service" }, 400);

    // Same no-oracle auth as /device/ask: wrong token == revoked == unknown.
    const row = await env.DB.prepare(DEVICE_EVENT_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    if (!row?.user_id) return json({ ok: false, error: "unknown device" }, 401);
    const owner = String(row.user_id);

    if (!env.MEDIA) return json({ ok: false, error: "media store not provisioned" }, 424);
    // head(), not get(): ownership is decided before a byte of audio is read.
    const head = await env.MEDIA.head(key).catch(() => null);
    if (!head || String(head.customMetadata?.user_id ?? "") !== owner) {
      return json({ ok: false, error: TRANSCRIBE_NOT_FOUND }, 404);
    }
    if (!String(head.httpMetadata?.contentType ?? "").startsWith("audio/")) {
      return json({ ok: false, error: "not an audio upload" }, 400);
    }

    const t = await transcribeAudioUrl(env, audioUrl);
    // 422 like /device/ask: every transcription failure is retriable with a
    // new recording ("nothing transcribed" is the common one — a silent clip).
    if (t.error) return json({ ok: false, error: t.error }, 422);
    // Clamped to the same bound a typed /device/ask question gets: the words
    // are headed for a text field, and no field on a device holds more.
    return json({ ok: true, text: String(t.text).slice(0, ASK_TEXT_MAX) });
  }
}
