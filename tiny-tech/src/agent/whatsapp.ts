/**
 * use_whatsapp — the whole wacli surface (steipete/wacli).
 *
 * DevDuck's tools/whatsapp.py ported to TypeScript. No Cloud API, no Business
 * account: wacli speaks the WhatsApp Web protocol against a local SQLite store,
 * so reads are instant and offline and only sends need the network.
 *
 * DevDuck's version also ran an auto-reply listener that answered strangers
 * with a fresh agent. That is deliberately NOT ported: an agent replying to
 * the user's real contacts unattended is the user's call to make explicitly,
 * not a side effect of having a tool available.
 *
 * Everything runs through `--json`, so the model gets structured records
 * (JIDs, timestamps, message ids) instead of a rendered table it has to
 * re-parse — the JID is what every follow-up call needs.
 *
 * Argument arrays are built here and passed to execFileSync WITHOUT a shell:
 * message text is arbitrary user content, and a quoted string in a shell
 * command line is one backtick away from being executed.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'

const WACLI = process.env.WACLI_BINARY || 'wacli'

export function hasWhatsapp(): boolean {
  try {
    execFileSync('command', ['-v', WACLI], { stdio: 'ignore', shell: '/bin/sh' })
    return true
  } catch {
    return false
  }
}

/**
 * Installed vs actually linked — the distinction onboarding needs to make.
 * `wacli doctor` reports `authenticated:false` once the linked device expires
 * (WhatsApp drops them), and every read then returns an empty list that reads
 * like "no messages" rather than "go re-scan the QR".
 */
export function whatsappState(): 'ready' | 'unauthorized' | 'missing' {
  if (!hasWhatsapp()) return 'missing'
  try {
    // Short leash: this runs behind `tiny-tech login`'s one-line hint and
    // inside status listings, and a locked store must not stall either.
    const out = execFileSync(WACLI, [...baseArgs(), 'doctor'], {
      encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(out.trim())
    return (parsed?.data?.authenticated || parsed?.authenticated) ? 'ready' : 'unauthorized'
  } catch {
    // A doctor that won't run (locked store, version drift) is not proof of a
    // dead session — report the softer state and let the tool say more.
    return 'unauthorized'
  }
}

/**
 * A phone number is not a JID. wacli accepts a bare number for `send --to`,
 * but every query flag (`--chat`, `--jid`) needs the full JID, and passing a
 * number there silently matches nothing — an empty list that reads like "no
 * messages" rather than "wrong identifier".
 */
export function toJid(value: string, kind: 'user' | 'group' = 'user'): string {
  const v = value.trim()
  if (v.includes('@')) return v
  const digits = v.replace(/[^\d]/g, '')
  if (!digits) return v
  return `${digits}@${kind === 'group' ? 'g.us' : 's.whatsapp.net'}`
}

/** Global flags every invocation carries (store location + JSON output). */
export function baseArgs(): string[] {
  const store = process.env.WACLI_STORE || process.env.WACLI_STORE_DIR
  return store ? ['--store', store, '--json'] : ['--json']
}

/**
 * Map a tool action to a wacli argv. Pure, so the whole flag surface is
 * unit-testable without WhatsApp — a wrong flag name is the failure mode this
 * catches (wacli exits 1 on unknown flags, so it's loud, but only at runtime).
 */
export function buildArgs(action: string, a: Record<string, any>): string[] {
  const limit = String(a.limit ?? 50)
  const chat = a.chat ? toJid(a.chat) : undefined
  switch (action) {
    case 'send_text':
      return ['send', 'text', '--to', String(a.to), '--message', String(a.text)]
    case 'send_file': {
      const args = ['send', 'file', '--to', String(a.to), '--file', String(a.file_path)]
      if (a.caption) args.push('--caption', String(a.caption))
      if (a.filename) args.push('--filename', String(a.filename))
      if (a.mime) args.push('--mime', String(a.mime))
      return args
    }
    case 'messages_list': {
      const args = ['messages', 'list', '--limit', limit]
      if (chat) args.push('--chat', chat)
      if (a.after) args.push('--after', String(a.after))
      if (a.before) args.push('--before', String(a.before))
      return args
    }
    case 'messages_search': {
      // query is positional here, unlike every other command's flags
      const args = ['messages', 'search', String(a.query), '--limit', limit]
      if (chat) args.push('--chat', chat)
      if (a.sender) args.push('--from', toJid(a.sender))
      if (a.after) args.push('--after', String(a.after))
      if (a.before) args.push('--before', String(a.before))
      if (a.media_type) args.push('--type', String(a.media_type))
      return args
    }
    case 'messages_context':
      return ['messages', 'context', '--chat', String(chat), '--id', String(a.message_id),
        '--before', String(a.context_before ?? 5), '--after', String(a.context_after ?? 5)]
    case 'messages_show':
      return ['messages', 'show', '--chat', String(chat), '--id', String(a.message_id)]
    case 'chats_list': {
      const args = ['chats', 'list', '--limit', limit]
      if (a.query) args.push('--query', String(a.query))
      return args
    }
    case 'chats_show':
      return ['chats', 'show', '--jid', String(chat)]
    case 'contacts_search':
      return ['contacts', 'search', String(a.query), '--limit', limit]
    case 'contacts_show':
      return ['contacts', 'show', '--jid', toJid(String(a.jid))]
    case 'contacts_refresh':
      return ['contacts', 'refresh']
    case 'groups_list': {
      const args = ['groups', 'list', '--limit', limit]
      if (a.query) args.push('--query', String(a.query))
      return args
    }
    case 'groups_info':
      return ['groups', 'info', '--jid', toJid(String(a.jid), 'group')]
    case 'groups_rename':
      return ['groups', 'rename', '--jid', toJid(String(a.jid), 'group'), '--name', String(a.name)]
    case 'groups_refresh':
      return ['groups', 'refresh']
    case 'media_download': {
      const args = ['media', 'download', '--chat', String(chat), '--id', String(a.message_id)]
      if (a.output) args.push('--output', String(a.output))
      return args
    }
    case 'history_backfill':
      return ['history', 'backfill', '--chat', String(chat), '--count', String(a.count ?? 50)]
    case 'sync':
      return ['sync', '--once', '--idle-exit', '30s']
    case 'doctor':
      return ['doctor']
    default:
      throw new Error(`unknown action: ${action}`)
  }
}

/** Required arguments per action, so a bad call fails before spawning wacli. */
const REQUIRED: Record<string, string[]> = {
  send_text: ['to', 'text'],
  send_file: ['to', 'file_path'],
  messages_search: ['query'],
  messages_context: ['chat', 'message_id'],
  messages_show: ['chat', 'message_id'],
  chats_show: ['chat'],
  contacts_search: ['query'],
  contacts_show: ['jid'],
  groups_info: ['jid'],
  groups_rename: ['jid', 'name'],
  media_download: ['chat', 'message_id'],
  history_backfill: ['chat'],
}

export function missingArgs(action: string, a: Record<string, any>): string[] {
  return (REQUIRED[action] || []).filter((k) => a[k] === undefined || a[k] === null || a[k] === '')
}

/** Commands that wait on the network (or a phone) need a longer leash. */
function timeoutFor(action: string): number {
  switch (action) {
    case 'sync': return 90_000
    case 'history_backfill': return 180_000
    case 'send_file': case 'media_download': return 120_000
    case 'groups_info': case 'groups_refresh': case 'contacts_refresh': return 60_000
    default: return 30_000
  }
}

/**
 * wacli's JSON envelope is `{success, data, error}` and it reports failures
 * in that envelope on STDOUT, exit code and stderr both unhelpful. So the
 * error has to be read out of the payload, or a failed send reads as a
 * success whose output happens to contain the word "error".
 */
export function extractError(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw.trim())
    if (parsed && typeof parsed === 'object' && parsed.success === false) {
      return String(parsed.error || 'unknown wacli error')
    }
  } catch { /* not the envelope — no structured error to pull */ }
  return null
}

/** Turn a wacli failure into something the user can act on. */
export function explainFailure(message: string, action: string, timeoutMs: number): string {
  if (/not authenticated|not logged in|no session/i.test(message)) {
    return 'WhatsApp is not authorized on this machine (the linked device expired or was removed). ' +
      'The user has to run `wacli auth` in a terminal and scan the QR code — it needs an interactive TTY, ' +
      'so the agent cannot do it. After that, run action=\'sync\'.'
  }
  if (/database is locked|store lock|resource temporarily unavailable/i.test(message)) {
    return `wacli's store is locked by another wacli process (a running \`wacli sync\`?). Stop it and retry.\n${message.slice(0, 300)}`
  }
  if (/websocket disconnected|failed to get device list|connection closed/i.test(message)) {
    return `WhatsApp dropped the connection mid-${action} — the message was NOT sent. ` +
      `This is usually a stale linked device: check action='doctor', and re-run \`wacli auth\` if it reports authenticated:false.\n${message.slice(0, 300)}`
  }
  return `wacli ${action} failed: ${message.slice(0, 600)}`
}

/** Pretty-print wacli's JSON; hand back raw text when it isn't JSON. */
export function formatOutput(raw: string): string {
  const text = raw.trim()
  if (!text) return '(no output)'
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length === 0) return '(no results)'
    // An envelope whose data is null/empty is a real "nothing found", but
    // JSON.stringify would render it as a wall of nulls the model must read.
    if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.success !== false) {
      const data = parsed.data
      if (data === null || data === undefined) return '(no results)'
      if (Array.isArray(data) && data.length === 0) return '(no results)'
      if (data && typeof data === 'object' && 'messages' in data && !data.messages) return '(no messages)'
      return JSON.stringify(data, null, 2)
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

export function makeWhatsappTool() {
  const run = (action: string, a: Record<string, any>): string => {
    const args = [...baseArgs(), ...buildArgs(action, a)]
    const timeoutMs = timeoutFor(action)
    try {
      const out = execFileSync(WACLI, args, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Exit code 0 is NOT success: wacli puts failures in the JSON envelope
      // on stdout, so a dropped send would otherwise be reported as sent.
      const failure = extractError(out)
      if (failure) return explainFailure(failure, action, timeoutMs)
      return formatOutput(out)
    } catch (e: any) {
      if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') {
        return `wacli ${action} timed out after ${timeoutMs / 1000}s`
      }
      const stderr = String(e?.stderr || '').trim()
      const stdout = String(e?.stdout || '').trim()
      return explainFailure(extractError(stdout) || stderr || stdout || String(e?.message || e), action, timeoutMs)
    }
  }

  return tool({
    name: 'use_whatsapp',
    description: `WhatsApp via wacli — the WhatsApp Web protocol against a local store (no Cloud API, no Business account). Reads hit local SQLite and are instant; sends need the network.

Send:
- send_text (to, text) — to is a phone number or JID
- send_file (to, file_path, caption?, filename?, mime?) — image/video/audio/document

Read:
- chats_list (query?, limit) — start here; every other call needs the JID it returns
- chats_show (chat)
- messages_list (chat?, after?, before?, limit) — after/before are 'YYYY-MM-DD' or RFC3339
- messages_search (query, chat?, sender?, media_type?, after?, before?, limit)
- messages_show (chat, message_id) / messages_context (chat, message_id, context_before?, context_after?)
- media_download (chat, message_id, output?) — saves the attachment, returns its path

Contacts & groups:
- contacts_search (query) / contacts_show (jid) / contacts_refresh
- groups_list (query?) / groups_info (jid) / groups_rename (jid, name) / groups_refresh

Maintenance:
- sync — one-shot catch-up of new messages (up to 90s)
- history_backfill (chat, count) — ask the phone for older messages
- doctor — diagnose store/auth/search

Sending a message reaches a real person: quote what you're about to send and to whom, and get the user's go-ahead first. If wacli isn't authorized, the user must run \`wacli auth\` themselves — the QR scan needs a terminal.`,
    inputSchema: z.object({
      action: z.string(),
      to: z.string().optional().describe('recipient phone number or JID'),
      text: z.string().optional(),
      file_path: z.string().optional(),
      caption: z.string().optional(),
      filename: z.string().optional(),
      mime: z.string().optional(),
      chat: z.string().optional().describe('chat JID (from chats_list)'),
      query: z.string().optional(),
      sender: z.string().optional(),
      message_id: z.string().optional(),
      jid: z.string().optional(),
      name: z.string().optional(),
      media_type: z.string().optional().describe('image|video|audio|document'),
      after: z.string().optional(),
      before: z.string().optional(),
      context_before: z.number().optional(),
      context_after: z.number().optional(),
      output: z.string().optional(),
      count: z.number().optional(),
      limit: z.number().optional(),
    }),
    callback: async (a) => {
      const action = a.action
      if (action === 'auth') {
        return 'WhatsApp auth needs an interactive terminal for the QR code — run `wacli auth` yourself, then use `sync`.'
      }
      const missing = missingArgs(action, a as Record<string, any>)
      if (missing.length) return `need ${missing.join(' + ')} for ${action}`
      try {
        return run(action, a as Record<string, any>)
      } catch (e: any) {
        return `error: ${String(e?.message || e).slice(0, 400)}`
      }
    },
  })
}
