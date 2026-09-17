/**
 * What a DM is allowed to carry besides text — photos, short video clips and
 * voice notes — and what the recipient's inbox/push/Telegram preview says about
 * it.
 *
 * The DM rail was text-only (migration 0011: `body TEXT` and nothing else) while
 * the agent-chat rail had attachments end-to-end. This module is the ONE place
 * the rules live for the app side; the worker enforces the same rules
 * independently (worker/src/messages.ts), because the send
 * endpoint has four doors and history here says only one of them ever runs the
 * check — that is exactly how the 2000-char truncation shipped.
 *
 * Pure — no fetch, no session, no DOM — so every rule below is a node test.
 *
 * TWO RULES CARRY THE SECURITY WEIGHT:
 *
 *  1. `isMediaStoreUrl` — an attachment URL is only ever OUR media store
 *     (`<worker>/media/<uuid>.<ext>`). This is not cosmetic: `read_messages`
 *     FETCHES these bytes and hands them to the model as trusted image content,
 *     so an arbitrary URL here is an SSRF primitive with a credulous reader on
 *     the end. Same guard, same reasoning as `isDeviceMediaUrl` in
 *     lib/chat/tools/platform.ts (a parity test pins the two together).
 *
 *  2. `kind` is DERIVED from `contentType`, never taken from the caller. A
 *     client that could label an mp4 `image` would decide which branch every
 *     renderer takes — and which bytes the read path tries to feed the model as
 *     a picture. The contentType allowlist is itself the worker media store's
 *     (src/media.ts `EXT`); a test asserts the two agree, so a format the store
 *     will not accept can never be advertised here.
 */
import { decideDmSend, dmLength, DM_MAX_CHARS } from './dm-send'

/** Photos + one clip + a voice note is a message; twenty files is an upload
 *  session. Kept small deliberately: the thread read is polled, every extra
 *  attachment is a row of JSON on a hot path, and the read path fetches image
 *  bytes for the model (bounded separately, see DM_MAX_MODEL_IMAGES). */
export const DM_MAX_ATTACHMENTS = 4

/** How many DM images the agent is handed as real pixels in one read. Fetching
 *  bytes costs a round-trip each and every image spends model context, so the
 *  rest degrade to their URLs — mirrors `deviceReplyBlocks`'s own `max = 2`. */
export const DM_MODEL_IMAGE_MAX = 4

/** A voice note's transcript cap. The same 2000 code points as the body: it is
 *  read as text by the recipient AND by the agent, so it obeys the text rule
 *  rather than a second number nobody would keep in sync. */
export const DM_MAX_TRANSCRIPT_CHARS = DM_MAX_CHARS

export type DmAttachmentKind = 'image' | 'video' | 'audio'

/**
 * contentType → kind. This IS the allowlist: a type absent here is refused, so
 * this table and the media store's `EXT` must agree (tests/dm-attachments pins
 * it by reading the worker source). Note `video/mp4` only — the store accepts
 * no other container, and the clients compress to it before upload.
 */
export const DM_ATTACHMENT_TYPES: Record<string, DmAttachmentKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'audio/mp4': 'audio',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
}

export interface DmAttachment {
  kind: DmAttachmentKind
  /** `<worker>/media/<uuid>.<ext>` — nothing else (see isMediaStoreUrl) */
  url: string
  contentType: string
  bytes?: number
  /** 🎤 voice notes: what the phone heard, transcribed ON-DEVICE. There is no
   *  Workers AI binding in this stack — the phones transcribe (as migration
   *  0030's `transcripts.text` already does) and send the text alongside the
   *  audio. This is what lets the AGENT read a voice note instead of only
   *  knowing one exists, and it is why a web-recorded note (no on-device
   *  recogniser) is honestly transcript-less rather than silently empty. */
  transcript?: string
  /** audio/video length, so a bubble can show "0:14" without fetching bytes */
  durationMs?: number
  /** image/video pixel size, so a thumbnail reserves the right box and the
   *  thread does not reflow as media loads */
  width?: number
  height?: number
}

/** The media-store origins an attachment may point at. Mirrors platform.ts's
 *  MEDIA_ORIGINS — the deployed worker plus whatever a dev env overrides. */
const MEDIA_ORIGINS = [
  'https://plugin.tiny.technology',
  process.env.TINY_WORKER_URL || '',
].filter(Boolean)

/**
 * Is this one of OUR media-store URLs?
 *
 * https only, an origin from the allowlist, and a `/media/<key>` path. The key
 * shape is the store's own (`crypto.randomUUID() + '.' + ext`), so the pattern
 * also rules out traversal and listing probes.
 */
export function isMediaStoreUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (!MEDIA_ORIGINS.some(o => { try { return new URL(o).origin === u.origin } catch { return false } })) return false
    return /^\/media\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(u.pathname)
  } catch { return false }
}

export type DmAttachmentsDecision =
  | { ok: true; attachments: DmAttachment[] }
  | { ok: false; error: string }

/** Clamp a transcript on a code-point boundary (never inside a surrogate
 *  pair). Unlike the BODY, a transcript is a lossy convenience beside the
 *  audio itself, so clipping it is correct where clipping the body is not. */
function clipTranscript(text: string): string {
  const cps = Array.from(text)
  return cps.length <= DM_MAX_TRANSCRIPT_CHARS
    ? text
    : cps.slice(0, DM_MAX_TRANSCRIPT_CHARS).join('')
}

/**
 * Validate and NORMALISE a caller's attachment list.
 *
 * Returns a fresh array built field-by-field rather than the caller's objects:
 * anything not named here (an `owner`, an `isTrusted`, a stray `body`) is
 * dropped instead of being stored in D1 and echoed back to every client as if
 * the server had vouched for it.
 *
 * Refuses rather than filters. A silently-dropped attachment is the truncation
 * defect again in another costume: the sender watches a photo disappear from a
 * message they cannot unsend, and the tool/route reported success.
 */
export function decideDmAttachments(raw: unknown): DmAttachmentsDecision {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'refused: attachments must be an array — nothing was sent' }
  }
  if (raw.length > DM_MAX_ATTACHMENTS) {
    return {
      ok: false,
      error:
        `refused: ${raw.length} attachments, ${raw.length - DM_MAX_ATTACHMENTS} over the ` +
        `${DM_MAX_ATTACHMENTS} limit — nothing was sent. Send them across several messages.`,
    }
  }

  const out: DmAttachment[] = []
  // Index loop, not `.entries()`: this build has no downlevelIteration (the same
  // constraint that makes `Array.from` the spread of choice in dm-send.ts).
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    const at = a && typeof a === 'object' ? (a as Record<string, unknown>) : null
    if (!at) return { ok: false, error: `refused: attachment ${i + 1} is not an object — nothing was sent` }

    const contentType = String(at.contentType || '').toLowerCase().trim()
    const kind = DM_ATTACHMENT_TYPES[contentType]
    if (!kind) {
      return {
        ok: false,
        error:
          `refused: attachment ${i + 1} has contentType "${contentType || '(missing)'}", which is not ` +
          `supported — nothing was sent. Allowed: ${Object.keys(DM_ATTACHMENT_TYPES).join(', ')}.`,
      }
    }

    const url = String(at.url || '')
    if (!isMediaStoreUrl(url)) {
      // Naming the requirement (not just "invalid") is what makes this
      // actionable for an agent: the fix is to upload through /api/media first
      // and attach the URL it returns.
      return {
        ok: false,
        error:
          `refused: attachment ${i + 1} must be a tiny media-store URL ` +
          `(upload it to /api/media first and attach the returned url) — nothing was sent.`,
      }
    }

    const num = (v: unknown): number | undefined => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
    }
    const transcriptRaw = typeof at.transcript === 'string' ? at.transcript.trim() : ''

    out.push({
      kind,
      url,
      contentType,
      ...(num(at.bytes) !== undefined ? { bytes: num(at.bytes) } : {}),
      // A transcript only means anything for audio. Accepting one on an image
      // would let a sender attach arbitrary text that the agent reads as if the
      // recipient's own device had heard it.
      ...(kind === 'audio' && transcriptRaw ? { transcript: clipTranscript(transcriptRaw) } : {}),
      ...(num(at.durationMs) !== undefined ? { durationMs: num(at.durationMs) } : {}),
      ...(num(at.width) !== undefined ? { width: num(at.width) } : {}),
      ...(num(at.height) !== undefined ? { height: num(at.height) } : {}),
    })
  }
  return { ok: true, attachments: out }
}

export type DmPayloadDecision =
  | { ok: true; body: string; attachments: DmAttachment[] }
  | { ok: false; error: string }

/**
 * The whole send decision: what body to store, what attachments to store, or a
 * refusal the caller can act on.
 *
 * The TEXT rule is not reimplemented here — it is `decideDmSend`, called
 * verbatim, so the code-point counting, the blank refusal and the
 * over-length-names-the-overrun message stay in one place with their own tests.
 * This function adds exactly one thing on top:
 *
 *   A MEDIA-ONLY DM IS A REAL MESSAGE. `decideDmSend` refuses a blank body,
 *   which is right for text (a blank text DM is a misfire nobody can unsend)
 *   and wrong the moment a photo is attached — a caption-less photo is the
 *   single commonest message anyone sends from a phone. So blankness is fatal
 *   only when there is nothing else to deliver.
 *
 * Everything else the text rule refuses, this refuses too: an over-long caption
 * is still refused whole rather than trimmed, even with a photo attached, so a
 * DM never arrives half-said.
 */
export function decideDmPayload(message: unknown, attachments?: unknown): DmPayloadDecision {
  // Attachments are decided FIRST: if the media is bad the message must not be
  // sent at all, not sent as text with the photo quietly missing.
  const media = decideDmAttachments(attachments)
  if (!media.ok) return media

  const blank = typeof message !== 'string' || !message.trim()
  if (blank && media.attachments.length) {
    // The caption is genuinely empty, and that is the message.
    return { ok: true, body: '', attachments: media.attachments }
  }

  const decided = decideDmSend(message)
  if (!decided.ok) return decided
  return { ok: true, body: decided.body, attachments: media.attachments }
}

/** Per-kind label for a preview line. Emoji-first because these land in
 *  Telegram, a push notification and the inbox list, none of which render a
 *  thumbnail. */
const KIND_LABEL: Record<DmAttachmentKind, { one: string; many: string }> = {
  image: { one: '📷 Photo', many: '📷 %n photos' },
  video: { one: '🎥 Video', many: '🎥 %n videos' },
  audio: { one: '🎤 Voice note', many: '🎤 %n voice notes' },
}

/**
 * The one-line summary of a message for a surface that shows no media: the
 * inbox row, the web-push body, the Telegram fan-out, the agent's event ring.
 *
 * With a caption, the caption wins and the media is a prefix ("📷 look at this")
 * — that is what every messaging app does, and the caption is the part the
 * reader actually wants. Without one, the label IS the preview, because the
 * alternative is what this rail used to produce for a photo: an empty string,
 * i.e. an inbox row that looks like nothing happened.
 */
export function dmPreview(body: string, attachments?: DmAttachment[] | null): string {
  const list = Array.isArray(attachments) ? attachments : []
  const text = typeof body === 'string' ? body.trim() : ''
  if (!list.length) return text

  const kinds = new Set(list.map(a => a.kind))
  let label: string
  if (kinds.size > 1) {
    label = `📎 ${list.length} attachments`
  } else {
    const kind = list[0].kind
    label = list.length === 1
      ? KIND_LABEL[kind].one
      : KIND_LABEL[kind].many.replace('%n', String(list.length))
  }

  if (!text) {
    // A voice note with a transcript previews as what was SAID — far more use
    // than "🎤 Voice note", and it costs nothing since the phone already sent it.
    const spoken = list.length === 1 && list[0].kind === 'audio' ? (list[0].transcript || '').trim() : ''
    return spoken ? `🎤 ${spoken}` : label
  }
  return `${label} ${text}`
}

/** Human duration for a bubble ("0:07", "1:42"). Shared so web/iOS/Android and
 *  the agent's text description all say the same thing. */
export function dmDuration(durationMs?: number): string {
  const ms = Number(durationMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * How an attachment reads to the AGENT in the text half of a tool result.
 *
 * Images additionally arrive as real pixels (see makeReadMessagesTool), but the
 * model still needs to know which URL is which picture, that a video exists at
 * all (it cannot watch one), and what a voice note said.
 */
export function dmAttachmentSummary(a: DmAttachment): string {
  const dur = dmDuration(a.durationMs)
  switch (a.kind) {
    case 'image':
      return `[photo] ${a.url}`
    case 'video':
      // Say plainly that the pixels are NOT here. Without this the model has a
      // URL and a helpful disposition, and it will describe a video it never saw.
      return `[video${dur ? ` ${dur}` : ''} — not viewable here, only the file] ${a.url}`
    case 'audio':
      return a.transcript
        ? `[voice note${dur ? ` ${dur}` : ''}, transcribed on the sender's device] "${a.transcript}"`
        : `[voice note${dur ? ` ${dur}` : ''} — no transcript available, audio not readable here] ${a.url}`
  }
}

/** Total code points a caller is trying to send as text, caption + transcripts.
 *  Exported for the composers, which show a counter. */
export function dmTextLength(body: string): number {
  return dmLength(typeof body === 'string' ? body : '')
}
