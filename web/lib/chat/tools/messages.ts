/**
 * Direct-message tools (user↔user DMs via the worker) — extracted from the
 * chat route so the VOICE bridge can mount the same session-bound objects
 * (/api/voice/tool). Factories: pass the session for execution, null when
 * only the schema is read (voice roster advertising).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { decideDmSend, dmRecipientLabel, DM_MAX_CHARS } from '../dm-send'

const WORKER = 'https://plugin.tiny.technology'

type Session = { sub: string } | null

export function makeSendMessageTool(session: Session, viaTiny = '') {
  return tool({
    name: 'send_message',
    description: `Send a direct message to another tiny.technology user. "to" accepts their GitHub login (with or without @) OR any tiny slug they own (e.g. 'mert' works for both). Delivery: stored in their inbox + pushed to their Telegram bot (if connected) + web push notification (if enabled). They'll see the sender's name and can reply from any of their tinys. Limits: ${DM_MAX_CHARS} chars (over that is REFUSED, not truncated — a DM can't be unsent, so split it yourself), 100/day.`,
    inputSchema: z.object({
      to: z.string().describe(`Recipient: GitHub login or a tiny slug they own`),
      message: z.string().describe(`The message (≤${DM_MAX_CHARS} chars; longer is refused, not cut)`),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — messages are sent from the user account.' }
      const target = String(input.to || '').trim().replace(/^@/, '').slice(0, 64)
      if (!target) return { ok: false, error: 'recipient required' }
      // A DM cannot be unsent, so an over-long message is REFUSED rather than
      // truncated: the old `.slice(0, 2000)` delivered 2000 chars, reported
      // "Delivered", and left the agent believing the rest arrived (it also cut
      // between surrogate pairs, so an emoji at the boundary shipped as a lone
      // \ud83d). The refusal names the overrun so the agent can split and
      // retry — recoverable refusal over unrecoverable success. See lib/chat/dm-send.
      const decided = decideDmSend(input.message)
      if (!decided.ok) return decided
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
          body: decided.body,
          viaTiny: viaTiny || '',
        }),
      }).then(r => r.json()).then(d => d.ok
        ? { ...d, note: `Delivered to ${dmRecipientLabel(d.to?.name, target)}${d.delivered?.telegram ? ' (Telegram ✓)' : ''}${d.delivered?.push ? ` (push ×${d.delivered.push})` : ''} — stored in their inbox.` }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))
    },
  })
}

export function makeReadMessagesTool(session: Session) {
  return tool({
    name: 'read_messages',
    description: `Read the user's direct messages. No args → inbox overview (threads, unread counts). With "with" → the full conversation with that person (marks their messages read). Use when the user asks about their messages or when unread DMs appear in context.`,
    inputSchema: z.object({
      with: z.string().optional().describe('Peer GitHub login to open that thread'),
      limit: z.number().optional().describe('Thread messages to fetch (default 50)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required to read messages.' }
      const qs = new URLSearchParams({ userId: session.sub })
      if (input.with) qs.set('with', String(input.with).trim().replace(/^@/, '').slice(0, 64))
      if (input.limit) qs.set('limit', String(Math.min(Math.max(Number(input.limit) || 50, 1), 200)))
      return fetch(`${WORKER}/messages?${qs}`, {
        headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
    },
  })
}
