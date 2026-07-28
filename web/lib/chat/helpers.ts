/**
 * Chat route helpers (extracted from app/api/chat/route.ts) — pure
 * functions shared by the main loop, nested agents, and now tests.
 */
import { McpClient } from '@strands-agents/sdk'
import { validatePublicUrl } from '../utils'

/**
 * True when a provider error is a context-length overflow the chat route
 * can self-heal by dropping older history and retrying ONCE. Deliberately
 * excludes rate/quota/billing — those don't get better on retry, and
 * retrying a rate-limited request just wastes another call. Matched on
 * message text (brittle across providers, so kept broad + tested).
 */
export function isOverflowError(err: unknown): boolean {
  const m = String((err as any)?.message || err || '')
  return /context.*(length|window)|too many tokens|maximum (context|token)|prompt is too long|input is too long|request too large|exceeds.*(context|token)/i.test(m) &&
         !/rate|quota|billing/i.test(m)
}

// The canonical Rule-B money formatter for agent-relayed payment prose lives in
// lib/utils (neutral home shared with the x402 pay route); re-exported here so
// the chat-route sites + tests that adopted it in Cycle 101 keep importing it
// from '@/lib/chat/helpers' unchanged.
export { usd } from '../utils'

// Normalize provider errors into short, human-readable messages
export function friendlyError(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? 'Unknown error')
  // Try to dig JSON error bodies out of provider messages
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      let obj: any = JSON.parse(jsonMatch[0])
      // unwrap nested stringified errors (Google does this)
      for (let i = 0; i < 3; i++) {
        if (typeof obj?.error?.message === 'string') {
          const inner = obj.error.message.match(/\{[\s\S]*\}/)
          if (inner) { try { obj = JSON.parse(inner[0]); continue } catch { /* fallthrough */ } }
          return obj.error.message
        }
        break
      }
      if (typeof obj?.message === 'string') return obj.message
    } catch { /* use raw */ }
  }
  return raw.slice(0, 500)
}

// Extract plain text from an AgentResult's last message
export function resultText(result: any): string {
  try {
    const blocks = result?.lastMessage?.content ?? []
    const texts = blocks
      .filter((b: any) => b?.type === 'textBlock' || typeof b?.text === 'string')
      .map((b: any) => b.text)
      .filter(Boolean)
    if (texts.length) return texts.join('\n')
    return String(result ?? '')
  } catch {
    return String(result ?? '')
  }
}

// Serialize tool result content blocks (TextBlock/JsonBlock/...) to plain data
export function serializeToolContent(content: any): any {
  if (!content) return content
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c?.toJSON === 'function' ? c.toJSON() : c))
  }
  return typeof content?.toJSON === 'function' ? content.toJSON() : content
}

interface McpServerEntry {
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export function buildMcpClients(configs: unknown): McpClient[] {
  if (!configs || typeof configs !== 'object') return []
  const entries = (configs as any).mcpServers ?? configs
  if (!entries || typeof entries !== 'object') return []

  const clients: McpClient[] = []
  for (const [name, raw] of Object.entries(entries as Record<string, McpServerEntry>)) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.disabled) continue
    // Edge runtime: only url-based (streamable-http) transports are supported.
    if (!raw.url) continue
    // SSRF guard — the URL comes from the x-tiny-mcp-servers request header
    // (client-controlled) or the tiny's stored config (owner-controlled, and
    // owner ≠ the acting user). The server connects to it AND injects the
    // owner's headers/secrets, so an unvalidated URL is blind SSRF + secret
    // exfil. Same guard every other server-fetched user URL uses.
    const checked = validatePublicUrl(raw.url)
    if ('error' in checked) {
      console.warn(`MCP client '${name}' rejected: ${checked.error}`)
      continue
    }
    try {
      clients.push(
        new McpClient({
          url: checked.url.toString(),
          ...(raw.headers ? { headers: raw.headers } : {}),
          applicationName: `tinyai-${name}`,
          continueOnError: true, // never let a dead MCP server kill the chat
        })
      )
    } catch (e) {
      console.error(`MCP client '${name}' init failed:`, e)
    }
  }
  return clients
}
