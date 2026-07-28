/**
 * tiny.technology platform tools as Strands SDK tools — the REPL agent's
 * cloud half. Mirrors the MCP registrations in server.ts but in the
 * SDK's tool() vocabulary so the local Agent can call them natively.
 *
 * Every handler is a thin authenticated proxy through TinyApi (/api/*) —
 * internal-key never leaves the server (AGENTS.md §13, goal doc §8).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { TinyApi } from '../api.js'
import { topUpAdvice } from '../wallet.js'

const WORKER_PUBLIC = 'https://plugin.tiny.technology'

const j = (d: any) => (typeof d === 'string' ? d : JSON.stringify(d))

export function makeTinyTools(api: TinyApi) {
  const whoami = tool({
    name: 'tiny_whoami',
    description: 'Who am I on tiny.technology? Identity + owned tinys.',
    inputSchema: z.object({}),
    callback: async () => j(await api.get('/api/me')),
  })

  const learn = tool({
    name: 'tiny_learn',
    description: "Store a durable memory about the user in tiny.technology's cross-agent memory graph (≤2000 chars, short + factual). Use supersedes to replace outdated facts.",
    inputSchema: z.object({
      content: z.string().min(1).max(2000),
      supersedes: z.string().optional().describe('Memory id this replaces'),
      visibility: z.enum(['private', 'public']).optional(),
    }),
    // The route requires `supersedes` as an ARRAY (scalars are silently
    // dropped — audit 2026-07-23), so wrap the single id.
    callback: async ({ content, supersedes, visibility }) => j(await api.post('/api/learnings', {
      content,
      ...(supersedes ? { supersedes: [supersedes] } : {}),
      ...(visibility ? { visibility } : {}),
    })),
  })

  const recall = tool({
    name: 'tiny_recall',
    description: "Semantic search over the user's tiny memories. Use before assuming you don't know something about them. hops=1 also surfaces facts LINKED to the matches.",
    // Same query contract as the MCP tool (limit=0&q[&hops=1] → {relevant,
    // total}) — the shapes had drifted apart (audit 2026-07-23 item 7).
    inputSchema: z.object({ query: z.string().min(1), hops: z.number().int().min(0).max(1).optional() }),
    callback: async ({ query, hops }) => {
      const d = await api.get(`/api/learnings?limit=0&q=${encodeURIComponent(query.slice(0, 500))}${hops === 1 ? '&hops=1' : ''}`)
      return j({ matches: d.relevant || [], totalMemories: d.total ?? (d.learnings || []).length })
    },
  })

  // id stays REQUIRED here on purpose: the backend treats a missing id as
  // "close ALL memories", which an autonomous local agent must never be able
  // to reach. The MCP tool exposes wipe-all because a human approves each call.
  const unlearn = tool({
    name: 'tiny_unlearn',
    description: 'Delete a stored memory by id (from tiny_recall results). Confirm with the user first.',
    inputSchema: z.object({ id: z.string().min(1) }),
    callback: async ({ id }) => j(await api.delete('/api/learnings', { id })),
  })

  const search = tool({
    name: 'tiny_search',
    description: 'Search the tiny.technology universe of public AIs (RAG over every public tiny).',
    inputSchema: z.object({ query: z.string().min(1) }),
    callback: async ({ query }) =>
      j(await api.getPublic(`${WORKER_PUBLIC}/retrieve?text=${encodeURIComponent(query)}`)),
  })

  const askTiny = tool({
    name: 'ask_tiny',
    description: "Chat with any tiny on tiny.technology (agent-as-a-tool). The tiny answers with its own identity, knowledge and skills.",
    inputSchema: z.object({
      tiny: z.string().min(1).describe('Tiny slug (e.g. "tiny", "support")'),
      message: z.string().min(1),
    }),
    callback: async ({ tiny, message }) => {
      const r = await api.chat({ tiny, message, timeoutMs: 120_000 })
      if (r.error) return `Error: ${r.error}`
      return r.text || '(empty response)'
    },
  })

  const events = tool({
    name: 'tiny_events',
    description: "The user's activity feed: job results, telegram messages, share views, visits. Pass since_id to poll incrementally.",
    inputSchema: z.object({ since_id: z.number().int().optional() }),
    callback: async ({ since_id }) =>
      j(await api.get(`/api/events${since_id ? `?sinceId=${since_id}` : ''}`)),
  })

  const messages = tool({
    name: 'tiny_messages',
    description: 'DM inbox. No args: thread list. With `with`: full conversation (marks read).',
    inputSchema: z.object({ with: z.string().optional(), limit: z.number().int().optional() }),
    callback: async (input) => {
      const qs = new URLSearchParams()
      if (input.with) qs.set('with', input.with.replace(/^@/, ''))
      if (input.limit) qs.set('limit', String(input.limit))
      const q = qs.toString()
      return j(await api.get(`/api/messages${q ? `?${q}` : ''}`))
    },
  })

  const sendMessage = tool({
    name: 'tiny_send_message',
    description: 'Send a DM to another tiny.technology user (@login or tiny slug). Max 2000 chars.',
    inputSchema: z.object({ to: z.string().min(1), message: z.string().min(1).max(2000) }),
    callback: async ({ to, message }) =>
      j(await api.post('/api/messages', { to, message, viaTiny: 'tiny-tech' })),
  })

  const schedule = tool({
    name: 'tiny_schedule',
    description: "Background jobs that run server-side even when this machine is off. Recurring: '*/30m', 'daily@09:00' (UTC). One-shot: run_in_minutes.",
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'delete']),
      name: z.string().optional(),
      prompt: z.string().optional(),
      schedule: z.string().optional(),
      run_in_minutes: z.number().optional(),
      tiny: z.string().optional(),
      id: z.string().optional(),
    }),
    callback: async (input) => {
      if (input.action === 'list') return j(await api.get('/api/jobs'))
      if (input.action === 'delete') {
        if (!input.id) return 'Error: id required for delete'
        return j(await api.delete('/api/jobs', { id: input.id }))
      }
      if (!input.name || !input.prompt) return 'Error: name and prompt required'
      if (!input.schedule && !input.run_in_minutes) return 'Error: schedule or run_in_minutes required'
      return j(await api.post('/api/jobs', {
        tiny: input.tiny, name: input.name, prompt: input.prompt,
        schedule: input.schedule, run_in_minutes: input.run_in_minutes,
      }))
    },
  })

  // Payments for the AUTONOMOUS local agent: read + quote ONLY. There is
  // deliberately no confirm/execute tool here — an unattended agent must
  // never be able to move money. The user confirms via the web/iOS payer
  // card or the MCP tiny_pay_confirm (where a human approves each call).
  const wallet = tool({
    name: 'tiny_wallet',
    description: "The user's tiny wallet — read-only here: 'balance' (+history), 'deposit_info' (how THIS deployment funds a wallet — its reply carries a `top_up` sentence naming the one valid route), 'pricing' for a resource like tiny:<slug>. Balance is real USDC on Base on the public deployment and non-withdrawable trial credit on a testnet or self-hosted chain — deposit_info says which. Never tell the user to buy, bridge or exchange USDC unless deposit_info confirms an external rail: on a self-hosted chain nobody sells the token, so that advice spends real money for credit this deployment cannot accept.",
    inputSchema: z.object({
      action: z.enum(['balance', 'deposit_info', 'pricing']),
      resource: z.string().optional().describe("pricing: e.g. 'tiny:<slug>'"),
    }),
    callback: async ({ action, resource }) => {
      if (action === 'balance') return j(await api.get('/api/wallet'))
      const r = await api.post('/api/wallet', { action, ...(resource ? { resource } : {}) })
      // Same `top_up` line the MCP tool attaches — this agent runs UNATTENDED, so
      // it's the surface most likely to invent a Coinbase step from its priors,
      // with nobody reading over its shoulder. (No 'faucet' action here on
      // purpose: claiming is a write against a once-a-day allowance.)
      if (action === 'deposit_info' && r && typeof r === 'object') {
        return j({ ...r, top_up: topUpAdvice(r) })
      }
      return j(r)
    },
  })

  const payQuote = tool({
    name: 'tiny_pay_quote',
    description: 'Quote a payment for a paid x402 service — NO money moves. Show the returned summary to the user; only they can execute it (web/iOS payer card or MCP tiny_pay_confirm).',
    inputSchema: z.object({
      url: z.string().url().describe('https x402 endpoint, e.g. https://tiny.technology/api/x402/chat/<slug>'),
      message: z.string().min(1).max(8000),
      max_spend_micro: z.number().int().positive().optional(),
    }),
    callback: async ({ url, message, max_spend_micro }) =>
      j(await api.post('/api/x402/pay', { url, message, ...(max_spend_micro ? { max_spend_micro } : {}) })),
  })

  /** Forged my_* tools — fetched at boot, run in tiny's server sandbox */
  async function makeForgedTools() {
    let rows: any[] = []
    try {
      const d = await api.get('/api/tools')
      rows = d.tools || []
    } catch { return [] }
    return rows.map((t: any) => {
      const shape: Record<string, z.ZodType> = {}
      for (const [k, desc] of Object.entries(t.params || {})) {
        shape[k] = z.string().describe(String(desc || k))
      }
      return tool({
        name: `my_${t.name}`,
        description: `[your forged tool] ${t.description || t.name} (runs in tiny's server sandbox)`,
        inputSchema: z.object(shape),
        callback: async (args: Record<string, any>) => {
          const r = await api.post('/api/tools/run', { name: t.name, args })
          return r?.ok === false ? `Error: ${r.error || 'tool failed'}` : j(r.result ?? r)
        },
      })
    })
  }

  return {
    static: [whoami, learn, recall, unlearn, search, askTiny, events, messages, sendMessage, schedule, wallet, payQuote],
    makeForgedTools,
  }
}
