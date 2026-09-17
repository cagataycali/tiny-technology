/**
 * Direct-message tools (user↔user DMs via the worker) — extracted from the
 * chat route so the VOICE bridge can mount the same session-bound objects
 * (/api/voice/tool). Factories: pass the session for execution, null when
 * only the schema is read (voice roster advertising).
 */
import { tool, ImageBlock, TextBlock } from '@strands-agents/sdk'
import { z } from 'zod'
import { decideDmSend, dmRecipientLabel, DM_MAX_CHARS } from '../dm-send'
import {
  decideDmAttachments, dmAttachmentSummary, isMediaStoreUrl,
  DM_MAX_ATTACHMENTS, DM_MODEL_IMAGE_MAX, type DmAttachment,
} from '../dm-attachments'

const WORKER = 'https://plugin.tiny.technology'

type Session = { sub: string } | null

export function makeSendMessageTool(session: Session, viaTiny = '') {
  return tool({
    name: 'send_message',
    description: `Send a direct message to another tiny.technology user. "to" accepts their GitHub login (with or without @) OR any tiny slug they own (e.g. 'mert' works for both). Delivery: stored in their inbox + pushed to their Telegram bot (if connected) + web push notification (if enabled). They'll see the sender's name and can reply from any of their tinys. Can carry up to ${DM_MAX_ATTACHMENTS} photos/videos/voice notes — pass "attachments" with media URLs you already have from this conversation (a generate_image result, a necklace photo, a device screenshot). Only tiny media-store URLs work; you cannot attach an arbitrary link from the web. With an attachment the message text is optional (a caption-less photo is fine). Limits: ${DM_MAX_CHARS} chars (over that is REFUSED, not truncated — a DM can't be unsent, so split it yourself), 100/day.`,
    inputSchema: z.object({
      to: z.string().describe(`Recipient: GitHub login or a tiny slug they own`),
      message: z.string().describe(`The message (≤${DM_MAX_CHARS} chars; longer is refused, not cut). May be empty ONLY when attachments are present.`),
      attachments: z.array(z.object({
        url: z.string().describe('A tiny media-store URL (https://plugin.tiny.technology/media/…) — e.g. the url a generate_image, screenshot or necklace-photo result gave you'),
        contentType: z.string().describe('image/jpeg|png|webp|gif, video/mp4, audio/mp4|mpeg|wav|ogg'),
      })).optional().describe(`Up to ${DM_MAX_ATTACHMENTS} media files to send with the message`),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — messages are sent from the user account.' }
      const target = String(input.to || '').trim().replace(/^@/, '').slice(0, 64)
      if (!target) return { ok: false, error: 'recipient required' }
      // 📷 Media first: bad attachments must stop the send rather than let the
      // text go out with the photo quietly missing. The refusal names what is
      // wrong (wrong host, unsupported type) so the agent can fix it — most
      // often by using the url a previous tool result already handed it instead
      // of a link it found on the web.
      const media = decideDmAttachments(input.attachments)
      if (!media.ok) return media
      // A caption-less photo is a real message, so blankness is only fatal when
      // there is nothing else to deliver. The TEXT rule below is untouched.
      const mediaOnly = media.attachments.length > 0 && !String(input.message ?? '').trim()
      if (mediaOnly) {
        return sendDm({ session, target, body: '', attachments: media.attachments, viaTiny })
      }
      // A DM cannot be unsent, so an over-long message is REFUSED rather than
      // truncated: the old `.slice(0, 2000)` delivered 2000 chars, reported
      // "Delivered", and left the agent believing the rest arrived (it also cut
      // between surrogate pairs, so an emoji at the boundary shipped as a lone
      // \ud83d). The refusal names the overrun so the agent can split and
      // retry — recoverable refusal over unrecoverable success. See lib/chat/dm-send.
      const decided = decideDmSend(input.message)
      if (!decided.ok) return decided
      return sendDm({ session, target, body: decided.body, attachments: media.attachments, viaTiny })
    },
  })
}

/**
 * POST the decided message to the worker and phrase the outcome for the agent.
 *
 * Declared below its caller on purpose — `function` hoists, and keeping the
 * fetch AFTER the `decideDmSend` gate in source order is what the wiring test
 * asserts (a refusal that does not precede the send decides nothing).
 */
function sendDm(opts: {
  session: { sub: string }
  target: string
  body: string
  attachments: DmAttachment[]
  viaTiny: string
}) {
  const { session, target, body, attachments, viaTiny } = opts
  return fetch(`${WORKER}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      fromUserId: session.sub,
      toLogin: target,
      toTiny: target.toLowerCase(),
      body,
      attachments,
      viaTiny: viaTiny || '',
    }),
  }).then(r => r.json()).then(d => d.ok
    ? {
      ...d,
      // Name the media in the confirmation. Without it the agent says
      // "Delivered" for a text message and for a message with three photos in
      // exactly the same words, and cannot tell the user what actually went.
      note: `Delivered to ${dmRecipientLabel(d.to?.name, target)}${attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''}${d.delivered?.telegram ? ' (Telegram ✓)' : ''}${d.delivered?.push ? ` (push ×${d.delivered.push})` : ''} — stored in their inbox.`,
    }
    : d
  ).catch(e => ({ ok: false, error: String(e) }))
}

/**
 * 📷 Turn the photos in a thread into content blocks the model can SEE.
 *
 * Without this, reading a conversation containing a photo returns a URL and a
 * helpful disposition — and the model describes a picture it never looked at.
 * The same shape and the same reasoning as `deviceReplyBlocks`
 * (lib/chat/tools/platform.ts): image blocks first, then the JSON text, so the
 * pixels and the structured thread arrive in one tool result.
 *
 * Bounded and defensive by design:
 *  - only IMAGES become pixels. There is no video understanding on this path and
 *    audio is covered by its transcript, so both stay as text.
 *  - `isMediaStoreUrl` gates every fetch. The URL was already validated on the
 *    way IN by the app and again by the worker, but this is the place where
 *    bytes get fetched and handed to a model as trusted content, so it is
 *    checked once more at the sink rather than trusted from storage.
 *  - a URL that will not fetch degrades to text-only. The conversation the user
 *    asked for must not be lost because one GET failed.
 *  - GIF is fetched but not sent as pixels: the vision formats here are
 *    jpeg/png/webp, and mislabelling a gif as jpeg produces a decode error that
 *    fails the whole turn.
 */
const MODEL_IMAGE_FORMATS: Record<string, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export async function dmImageBlocks(thread: any, max = DM_MODEL_IMAGE_MAX): Promise<any[]> {
  const msgs = Array.isArray(thread?.messages) ? thread.messages : []
  const picks: Array<{ url: string; format: 'jpeg' | 'png' | 'webp'; from: string }> = []
  // Newest first: if a thread has more images than the budget, the ones worth
  // seeing are the ones just sent, not the oldest in the window.
  for (const m of [...msgs].reverse()) {
    for (const a of Array.isArray(m?.attachments) ? m.attachments : []) {
      const format = MODEL_IMAGE_FORMATS[String(a?.contentType || '')]
      if (a?.kind === 'image' && format && isMediaStoreUrl(a?.url) && picks.length < max) {
        picks.push({ url: String(a.url), format, from: m?.direction === 'sent' ? 'the user' : 'the other person' })
      }
    }
  }
  if (!picks.length) return []

  const blocks: any[] = []
  for (const p of picks) {
    const bytes = await fetch(p.url, { cache: 'no-store' })
      .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
    if (bytes) blocks.push(new ImageBlock({ format: p.format, source: { bytes: new Uint8Array(bytes) } }))
  }
  return blocks
}

export function makeReadMessagesTool(session: Session) {
  return tool({
    name: 'read_messages',
    description: `Read the user's direct messages. No args → inbox overview (threads, unread counts). With "with" → the full conversation with that person (marks their messages read). Messages can carry photos, video clips and voice notes: any PHOTOS in the conversation come back as images you can actually SEE, voice notes arrive as the transcript the sender's phone produced, and videos come back as a file reference only (you cannot watch them — do not describe their contents). Use when the user asks about their messages or when unread DMs appear in context.`,
    inputSchema: z.object({
      with: z.string().optional().describe('Peer GitHub login to open that thread'),
      limit: z.number().optional().describe('Thread messages to fetch (default 50)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required to read messages.' }
      const qs = new URLSearchParams({ userId: session.sub })
      if (input.with) qs.set('with', String(input.with).trim().replace(/^@/, '').slice(0, 64))
      if (input.limit) qs.set('limit', String(Math.min(Math.max(Number(input.limit) || 50, 1), 200)))
      const data = await fetch(`${WORKER}/messages?${qs}`, {
        headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))

      // Inbox overview, an error, or a thread with no media: unchanged JSON.
      if (!data || data.error || !Array.isArray(data.messages)) return data

      // Describe each attachment in the text half, so the model knows which URL
      // is which picture, that a video exists but is not viewable, and what a
      // voice note said. Done for EVERY thread with media — including the ones
      // whose images failed to fetch, which is what stops a failed GET from
      // looking like a message with no photo in it.
      const withMedia = {
        ...data,
        messages: data.messages.map((m: any) => {
          const atts: DmAttachment[] = Array.isArray(m?.attachments) ? m.attachments : []
          if (!atts.length) return m
          return { ...m, media: atts.map(a => dmAttachmentSummary(a)) }
        }),
      }

      const blocks = await dmImageBlocks(withMedia)
      if (!blocks.length) return withMedia

      // Pixels first, then the thread as JSON — the order generate_image,
      // screenshot and use_device all use.
      blocks.push(new TextBlock(
        `${JSON.stringify(withMedia)}\n\n(The ${blocks.length === 1 ? 'image' : `${blocks.length} images`} above ${blocks.length === 1 ? 'is a photo' : 'are photos'} from this conversation, newest first — matched by the [photo] urls in the "media" fields. Embed one with ![…](url) to show it to the user.)`
      ))
      return blocks
    },
  })
}
