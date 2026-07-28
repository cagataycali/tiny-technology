/**
 * tiny-tech MCP server — exposes tiny.technology to any MCP client.
 *
 * Static tiny_* tools + dynamic my_* tools (the user's forged tools,
 * registered at startup with their own schemas). stdio transport.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { TinyApi, AuthRequiredError } from './api.js'
import { login, DEFAULT_API_URL } from './auth.js'
import { filesToContentBlocks } from './files.js'
import { WALLET_NETWORKS, faucetOutcome, topUpAdvice } from './wallet.js'
import { loadDevice, startHeartbeatLoop } from './device.js'

const WORKER_PUBLIC = 'https://plugin.tiny.technology'

// Handshake version = the real package version (dist/ and src/ both sit one
// level below package.json). A literal here drifted to 0.2.0 while the
// package shipped 0.6.x.
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// MCP tool results are content blocks; everything we return is JSON-ish
const ok = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: `Error: ${message}` }],
  isError: true,
})

/** Wrap a handler so auth problems come back as actionable tool errors */
function guard<A extends any[]>(fn: (...args: A) => Promise<any>) {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return fail(e.message)
      return fail(String(e?.message || e))
    }
  }
}

export async function startServer(): Promise<void> {
  const api = new TinyApi()

  const server = new McpServer({
    name: 'tiny-tech',
    version: PKG_VERSION,
  })

  // ── Identity ──────────────────────────────────────────────────────────

  server.registerTool('tiny_whoami', {
    annotations: { readOnlyHint: true },
    description: 'Who am I on tiny.technology? Returns identity and the list of tinys (AI personas) the user owns.',
    inputSchema: {},
  }, guard(async () => ok(await api.get('/api/me'))))

  server.registerTool('tiny_login', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: 'Log in to tiny.technology — opens the browser for a one-click authorization. Use when other tiny_* tools report auth errors.',
    inputSchema: {},
  }, guard(async () => {
    // Client-side expiry isn't enough — a revoked/garbage token looks
    // "valid" locally but 401s everywhere. Prove it against the server
    // before claiming already-logged-in, else we dead-end the recovery
    // path every other tool points at.
    if (api.authenticated) {
      try {
        const me = await api.get('/api/me')
        if (me?.authenticated) return ok(`Already logged in as @${me.user?.login}. Credentials at ~/.tiny/credentials.json`)
      } catch { /* token rejected — fall through to a fresh login */ }
    }
    const creds = await login(process.env.TINY_API_URL || DEFAULT_API_URL)
    api.reload()
    return ok(`Logged in as @${creds.user.login}`)
  }))

  // ── Memory (cross-agent, cross-device — D1 + Vectorize) ──────────────

  server.registerTool('tiny_learn', {
    annotations: { destructiveHint: false },
    description: "Store a durable memory about the user in tiny.technology's server-side memory graph (follows them across every agent and device — Claude Code today, their phone tomorrow). Keep entries short and factual, ≤2000 chars. When a new fact REPLACES an outdated one (moved, changed stack, new job), pass the old memory id in `supersedes` — it's closed as history, never deleted. When facts belong together, link them via `edges`.",
    inputSchema: {
      content: z.string().min(1).max(2000).describe('The fact/preference/context to remember'),
      supersedes: z.array(z.union([z.string(), z.number()])).optional().describe('Memory ids this fact replaces (closed bitemporally, kept as history)'),
      edges: z.array(z.object({
        rel: z.enum(['part_of', 'authored', 'relates_to', 'about']).describe('Relation type'),
        dst: z.union([z.string(), z.number()]).describe('Existing memory id to link to'),
        scope: z.string().optional().describe('Context qualifier (e.g. project name)'),
      })).optional().describe('Link this fact to existing memories — connected facts surface together in recall'),
      visibility: z.enum(['private', 'public']).optional().describe("'public' shares the fact with the user's followers (their feed). ONLY when the user explicitly asks to share/publish — default private"),
    },
  }, guard(async ({ content, supersedes, edges, visibility }: { content: string; supersedes?: (string | number)[]; edges?: any[]; visibility?: string }) =>
    ok(await api.post('/api/learnings', {
      content,
      ...(supersedes?.length ? { supersedes } : {}),
      ...(edges?.length ? { edges } : {}),
      ...(visibility === 'public' ? { visibility: 'public' } : {}),
    }))))

  server.registerTool('tiny_recall', {
    annotations: { readOnlyHint: true },
    description: "Semantic search over everything tiny knows about the user (their cross-agent memory graph). Use at the start of tasks to pull relevant context, or when the user references something you don't know. hops=1 also walks graph edges so facts LINKED to the matches surface too — use when context matters (projects, relationships, threads).",
    inputSchema: {
      query: z.string().min(1).describe('What to look for'),
      hops: z.number().int().min(0).max(1).optional().describe('1 = expand through graph edges to connected facts'),
    },
  }, guard(async ({ query, hops }: { query: string; hops?: number }) => {
    const d = await api.get(`/api/learnings?limit=0&q=${encodeURIComponent(query.slice(0, 500))}${hops === 1 ? '&hops=1' : ''}`)
    return ok({ matches: d.relevant || [], totalMemories: d.total ?? (d.learnings || []).length })
  }))

  server.registerTool('tiny_unlearn', {
    annotations: { destructiveHint: true },
    description: 'Close one memory by id (bitemporal: it leaves recall but survives as history — get ids from tiny_recall / tiny_memories), or ALL memories when id is omitted — confirm with the user before wiping everything.',
    inputSchema: { id: z.string().optional().describe('Memory id; omit to close ALL memories') },
  }, guard(async ({ id }: { id?: string }) => {
    const r = await api.delete('/api/learnings', id ? { id } : {})
    return r?.ok === false ? fail(r.error || 'delete failed') : ok(r)
  }))

  server.registerTool('tiny_memories', {
    annotations: { readOnlyHint: true },
    description: "List the user's most recent memories (no search — just the latest entries). include_history=true also returns closed (superseded/unlearned) facts with freshness fields.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('How many (default 30)'),
      include_history: z.boolean().optional().describe('Include closed facts (freshness: live|closed)'),
    },
  }, guard(async ({ limit, include_history }: { limit?: number; include_history?: boolean }) =>
    ok(await api.get(`/api/learnings?limit=${limit || 30}${include_history ? '&include_closed=1' : ''}`))))

  server.registerTool('tiny_graph', {
    annotations: { readOnlyHint: true },
    description: "Explore the user's memory graph structure. mode 'neighbors': the subgraph around a memory id (which facts link to it, via which relations — supersedes trails, part_of clusters). mode 'conflicts': contradiction candidates (same subject+relation pointing at different facts in the same scope) — present them to the user, then tiny_resolve_conflict with their pick. mode 'social': the PUBLIC interaction graph around a node (user:<id> or tiny:<slug>) + trust scores (PageRank over tiny-consults-tiny edges). mode 'feed': fresh public facts from builders the user follows.",
    inputSchema: {
      mode: z.enum(['neighbors', 'conflicts', 'social', 'feed']).describe('What to explore'),
      node: z.string().optional().describe("neighbors: a memory id · social: 'user:<id>' or 'tiny:<slug>' (optional — omit for trust scores only)"),
      hops: z.number().int().min(1).max(2).optional().describe('neighbors: traversal depth (default 1)'),
    },
  }, guard(async ({ mode, node, hops }: { mode: string; node?: string; hops?: number }) => {
    if (mode === 'conflicts') return ok(await api.get('/api/graph?conflicts=1'))
    if (mode === 'social') return ok(await api.get(`/api/graph?social=${encodeURIComponent(node || '')}`))
    if (mode === 'feed') return ok(await api.get('/api/graph?feed=1'))
    if (!node) return fail('neighbors mode needs a memory id (from tiny_recall / tiny_memories)')
    return ok(await api.get(`/api/graph?node=${encodeURIComponent(node)}${hops ? `&hops=${hops}` : ''}`))
  }))

  server.registerTool('tiny_resolve_conflict', {
    annotations: { destructiveHint: false },
    description: "Resolve a memory contradiction found by tiny_graph mode 'conflicts': keep the edge the user chose as current, close the rest as history (bitemporal — nothing is deleted). ALWAYS ask the user which candidate is current before resolving.",
    inputSchema: {
      keep: z.string().describe('Edge id to keep live (from the conflict candidates)'),
      close: z.array(z.string()).min(1).describe('Edge ids to close as history'),
    },
  }, guard(async ({ keep, close }: { keep: string; close: string[] }) => {
    const r = await api.post('/api/graph', { keep, close })
    return r?.ok === false ? fail(r.error || 'resolve failed') : ok(r)
  }))

  // ── Chat with tinys (full platform agent: spawn_agents, schedule, ...) ─

  server.registerTool('tiny_chat', {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Send a message to one of the user's tinys (or any public tiny) and get the full agent response. The tiny runs server-side with its complete toolset — web http, sub-agent spawning, scheduling, telegram, semantic retrieval, the user's forged tools. Attach local images (jpg/png/gif/webp <3MB), documents (pdf/csv/doc/docx/xls/xlsx/html/xml) or text files via `files`. Use for anything a tiny is better positioned to do, or to consult a persona.",
    inputSchema: {
      tiny: z.string().describe("Tiny name, e.g. 'tiny' (the default assistant) or a custom persona"),
      message: z.string().min(1).describe('The message/task for the tiny'),
      system_context: z.string().optional().describe('Optional extra context injected as a system message'),
      files: z.array(z.string()).optional().describe('Local file paths to attach (images/PDFs/docs/text)'),
    },
  }, guard(async ({ tiny, message, system_context, files }: { tiny: string; message: string; system_context?: string; files?: string[] }) => {
    const attachmentBlocks = files?.length ? filesToContentBlocks(files) : undefined
    const r = await api.chat({ tiny, message, systemContext: system_context, attachmentBlocks })
    if (r.error && !r.text) return fail(r.error)
    return ok({
      text: r.text,
      ...(r.toolCalls.length ? { toolCalls: r.toolCalls.map(t => ({ name: t.name, ...(t.error ? { error: t.error } : {}) })) } : {}),
      ...(r.error ? { warning: r.error } : {}),
    })
  }))

  // ── Tiny universe ──────────────────────────────────────────────────────

  server.registerTool('tiny_search', {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'Discover tinys in the public universe — list by prefix or semantic-search by topic.',
    inputSchema: {
      query: z.string().optional().describe('Semantic search text (topic, capability)'),
      prefix: z.string().optional().describe('Name prefix filter for plain listing'),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, guard(async ({ query, prefix, limit }: { query?: string; prefix?: string; limit?: number }) => {
    if (query) return ok(await api.getPublic(`${WORKER_PUBLIC}/retrieve?text=${encodeURIComponent(query)}`))
    const qs = new URLSearchParams()
    if (prefix) qs.set('prefix', prefix)
    if (limit) qs.set('limit', String(limit))
    return ok(await api.getPublic(`${WORKER_PUBLIC}/list?${qs}`))
  }))

  server.registerTool('tiny_get', {
    annotations: { readOnlyHint: true },
    description: "Fetch a tiny's full record (system prompt, knowledge, config; owner-only fields included for tinys the user owns).",
    inputSchema: { name: z.string().describe('Tiny name') },
  }, guard(async ({ name }: { name: string }) => {
    const r = await api.post('/api/tiny', { name })
    // The API masks nonexistent and private-non-owned tinys identically
    // (empty record) — say so instead of returning a confusing blank
    if (!r?.systemPrompt && !r?.isOwner) {
      return fail(`'${name}' doesn't exist or is private — try tiny_search to find public tinys`)
    }
    return ok(r)
  }))

  server.registerTool('tiny_create', {
    annotations: { destructiveHint: false },
    description: 'Create a new tiny (AI persona at tiny.technology/<name>). Names are slugified; the tiny is live immediately.',
    inputSchema: {
      name: z.string().min(1).describe('Name/slug for the tiny'),
      systemPrompt: z.string().min(1).describe('The persona/system prompt'),
      systemKnowledge: z.string().optional().describe('Greeting/knowledge shown as the first assistant message'),
      priv: z.boolean().optional().describe('Private tiny (owner-only)'),
    },
  }, guard(async (input: any) => ok(await api.post('/api/control', {
    name: input.name,
    systemPrompt: input.systemPrompt,
    systemKnowledge: input.systemKnowledge || '',
    priv: !!input.priv,
  }))))

  server.registerTool('tiny_update', {
    annotations: { destructiveHint: false, idempotentHint: true },
    description: "Update an existing tiny's prompt/knowledge/privacy/branding (must be owned by the user). Untouched config (data, skills, webhooks, MCP servers) is preserved. Branding: logo + hero (https URLs), theme colors, tagline (custom landing subtitle, ≤200 chars), intro_vibe haptic, starter chips — pass '' (or [] for chips) to clear one.",
    inputSchema: {
      name: z.string().min(1),
      systemPrompt: z.string().optional(),
      systemKnowledge: z.string().optional(),
      priv: z.boolean().optional(),
      logo: z.string().optional().describe("Logo/avatar media URL (https; svg/gif/png/jpg/webp/mp4/webm) shown on the tiny's landing hero. '' clears."),
      hero: z.string().optional().describe("Hero/banner image URL (https) behind the landing hero. '' clears."),
      theme: z.object({
        accent: z.string().optional().describe('Accent color (hex)'),
        bg: z.string().optional().describe('Background color (hex)'),
      }).optional().describe('Per-tiny theme colors'),
      tagline: z.string().max(200).optional().describe("Custom landing subtitle replacing the generic \"A tiny — a living AI…\" line. ≤200 chars; '' clears."),
      intro_vibe: z.string().optional().describe("Haptic played when the tiny opens on mobile: tap|double|success|warning|error|heartbeat|sos|long|escalate|wave. '' clears."),
      chips: z.array(z.string().min(1).max(60)).max(4).optional().describe('1-4 starter suggestion chips on the landing page. [] clears.'),
    },
  }, guard(async (input: any) => {
    // Re-send the core owner fields from the current record: the worker's
    // upsert merge-preserves fields that arrive `undefined`, but the /api/
    // control proxy stringifies several JSON-ish fields, so explicit
    // re-send of the core set stays the safe contract. Branding fields are
    // pass-through: omitted = preserved (worker-side merge), '' = clear.
    const current = await api.post('/api/tiny', { name: input.name })
    if (!current?.name) return fail(`tiny '${input.name}' not found`)
    if (!current.isOwner) return fail(`you don't own '${input.name}'`)
    return ok(await api.post('/api/control', {
      name: input.name,
      systemPrompt: input.systemPrompt ?? current.systemPrompt ?? '',
      systemKnowledge: input.systemKnowledge ?? current.systemKnowledge ?? '',
      priv: input.priv ?? !!current.private,
      data: current.data,
      hook: current.hook,
      worker: current.worker,
      schema: current.schema,
      skills: current.skills,
      ...(current.mcpServers !== undefined ? { mcpServers: current.mcpServers } : {}),
      ...(input.logo !== undefined ? { logo: input.logo } : {}),
      ...(input.hero !== undefined ? { hero: input.hero } : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
      ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
      ...(input.intro_vibe !== undefined ? { intro_vibe: input.intro_vibe } : {}),
      ...(input.chips !== undefined ? { chips: input.chips } : {}),
    }))
  }))

  server.registerTool('tiny_delete', {
    annotations: { destructiveHint: true },
    description: 'Permanently delete a tiny the user owns. Confirm with the user first.',
    inputSchema: { name: z.string().min(1) },
  }, guard(async ({ name }: { name: string }) => {
    const r = await api.delete('/api/delete', { name })
    return r?.ok === false ? fail(r.error || 'delete failed') : ok(r)
  }))

  // ── Forged tools (the tool creation runner) ───────────────────────────

  server.registerTool('tiny_create_tool', {
    annotations: { destructiveHint: false },
    description: "Forge a personal JavaScript tool that persists in the user's tiny account and follows them everywhere (web chat, telegram, this MCP server). Code shape: a single arrow function `(args) => result`. Sandbox: guarded fetch (https, public hosts; returns {status, ok, body} pre-parsed), JSON/Math/Date/String/URL, 10s timeout, ≤4KB. Code is PUBLIC on the user's builder profile — never embed secrets (pass them as args at call time). After creating, call tiny_reload_tools to mount it here.",
    inputSchema: {
      name: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, 'snake_case, 3-40 chars').describe('Tool name: snake_case, 3-40 chars (e.g. fetch_weather)'),
      description: z.string().min(1).describe('What it does'),
      params: z.record(z.string(), z.string()).optional().describe('Map of argName → description (all string args)'),
      code: z.string().min(1).max(4096).describe('(args) => result arrow function'),
    },
  }, guard(async (input: any) => {
    // Direct sandbox-validated creation (POST /api/tools) — same validation
    // path as the chat agent's create_tool, without the agent in the middle
    const r = await api.post('/api/tools', {
      name: input.name,
      description: input.description,
      params: input.params || {},
      code: input.code,
    })
    if (r?.ok === false) return fail(r.error || 'creation failed')
    return ok({ ...r, note: 'Forged — call tiny_reload_tools to mount it in this session' })
  }))

  server.registerTool('tiny_remove_tool', {
    annotations: { destructiveHint: true },
    description: 'Delete one of the user\'s forged tools by name.',
    inputSchema: { name: z.string().min(1).describe("Tool name (with or without the my_ prefix)") },
  }, guard(async ({ name }: { name: string }) => {
    const r = await api.delete('/api/tools', { name })
    return r?.ok === false ? fail(r.error || 'delete failed') : ok(r)
  }))

  server.registerTool('tiny_marketplace', {
    annotations: { readOnlyHint: false, openWorldHint: true },
    description: 'Browse public forged tools from the community, or install one from a builder into the user\'s account.',
    inputSchema: {
      action: z.enum(['browse', 'install']),
      query: z.string().optional().describe('Search text (browse)'),
      login: z.string().optional().describe('Builder GitHub login (install)'),
      name: z.string().optional().describe('Tool name (install)'),
    },
  }, guard(async ({ action, query, login: builder, name }: any) => {
    if (action === 'browse') {
      // Worker validation rejects an empty q param — omit it entirely
      const qs = query ? `?q=${encodeURIComponent(query)}&limit=20` : '?limit=20'
      return ok(await api.getPublic(`${WORKER_PUBLIC}/tools/browse${qs}`))
    }
    if (!builder || !name) return fail('login and name required for install')
    return ok(await api.post('/api/tools/install', { login: builder, name }))
  }))

  // ── Dynamic my_* tools ────────────────────────────────────────────────

  const registeredForged = new Map<string, { remove: () => void }>()

  async function mountForgedTools(): Promise<string[]> {
    let tools: any[] = []
    try {
      const d = await api.get('/api/tools')
      tools = d.tools || []
    } catch {
      return [] // not logged in yet — mounted on first tiny_reload_tools after login
    }

    // Drop tools that no longer exist
    for (const [name, reg] of registeredForged) {
      if (!tools.find(t => `my_${t.name}` === name)) {
        reg.remove()
        registeredForged.delete(name)
      }
    }

    const mounted: string[] = []
    for (const t of tools) {
      const mcpName = `my_${t.name}`
      mounted.push(mcpName)
      if (registeredForged.has(mcpName)) continue
      const schema: Record<string, z.ZodType> = {}
      for (const [k, desc] of Object.entries(t.params || {})) {
        schema[k] = z.string().describe(String(desc || k))
      }
      const reg = server.registerTool(mcpName, {
        // Forged tools can fetch external APIs — open-world, not read-only
        annotations: { openWorldHint: true },
        description: `[your forged tool] ${t.description || t.name} (runs in tiny's server sandbox)`,
        inputSchema: schema,
      }, guard(async (args: Record<string, any>) => {
        const r = await api.post('/api/tools/run', { name: t.name, args })
        return r?.ok === false ? fail(r.error || 'tool failed') : ok(r.result ?? r)
      }))
      registeredForged.set(mcpName, reg)
    }
    return mounted
  }

  server.registerTool('tiny_reload_tools', {
    annotations: { readOnlyHint: false, idempotentHint: true },
    description: "Re-sync the user's forged tools into this MCP session (call after tiny_create_tool / tiny_remove_tool / tiny_marketplace install).",
    inputSchema: {},
  }, guard(async () => {
    const mounted = await mountForgedTools()
    server.sendToolListChanged()
    return ok({ mounted })
  }))

  // ── Jobs & sharing ─────────────────────────────────────────────────────

  server.registerTool('tiny_schedule', {
    annotations: { destructiveHint: true },
    description: "Manage background jobs that run server-side on a schedule even when every device is off — results land on the user's event feed. Recurring: '*/30m', '*/2h', 'daily@09:00' (UTC). One-shot: run_in_minutes.",
    inputSchema: {
      action: z.enum(['create', 'list', 'delete']),
      name: z.string().optional().describe('Job name (create)'),
      prompt: z.string().optional().describe('What the job does each run (create)'),
      schedule: z.string().optional().describe("Recurring spec: '*/30m', 'daily@09:00'"),
      run_in_minutes: z.number().optional().describe('One-shot: run once N minutes from now'),
      tiny: z.string().optional().describe('Tiny persona to run the job as (default: tiny)'),
      id: z.string().optional().describe('Job id (delete)'),
    },
  }, guard(async (input: any) => {
    if (input.action === 'list') return ok(await api.get('/api/jobs'))
    if (input.action === 'delete') {
      if (!input.id) return fail('id required for delete')
      return ok(await api.delete('/api/jobs', { id: input.id }))
    }
    if (!input.name || !input.prompt) return fail('name and prompt required')
    if (!input.schedule && !input.run_in_minutes) return fail('schedule or run_in_minutes required')
    return ok(await api.post('/api/jobs', {
      tiny: input.tiny, name: input.name, prompt: input.prompt,
      schedule: input.schedule, run_in_minutes: input.run_in_minutes,
    }))
  }))

  server.registerTool('tiny_share', {
    annotations: { destructiveHint: true, openWorldHint: true },
    description: "Conversation share links. action:'create' publishes a snapshot ({role, content} messages) as a short tiny.technology URL; 'list' shows the user's existing links; 'revoke' kills one by id. Confirm before revoking.",
    inputSchema: {
      action: z.enum(['create', 'list', 'revoke']).describe("What to do (default 'create' when messages given)"),
      tiny: z.string().optional().describe('create: tiny name the conversation belongs to (default: tiny)'),
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).optional().describe('create: the conversation to share'),
      id: z.string().optional().describe('revoke: share id (from list)'),
    },
  }, guard(async ({ action, tiny, messages, id }: any) => {
    if (action === 'list') return ok(await api.get('/api/share?mine=1'))
    if (action === 'revoke') {
      if (!id) return fail('id required for revoke')
      return ok(await api.delete('/api/share', { id }))
    }
    if (!messages?.length) return fail('messages required for create')
    const snapshot = messages.map((m: any, i: number) => ({ id: String(i), role: m.role, content: m.content }))
    return ok(await api.post('/api/share', { name: tiny || 'tiny', messages: snapshot }))
  }))

  server.registerTool('tiny_events', {
    annotations: { readOnlyHint: true },
    description: "The user's activity feed — what happened while they were away: scheduled job results/errors, telegram messages, share views, tiny visits. Check after tiny_schedule creates jobs, or when the user asks 'what happened'. Pass since_id to poll incrementally.",
    inputSchema: {
      since_id: z.number().int().optional().describe('Only events newer than this id (from a previous call)'),
    },
  }, guard(async ({ since_id }: { since_id?: number }) =>
    ok(await api.get(`/api/events${since_id ? `?sinceId=${since_id}` : ''}`))))

  // ── Payments (USDC wallet + x402 payer) ──────────────────────────────
  //
  // CONFIRM-EVERY-PAYMENT: tiny_pay_quote never moves money — it returns a
  // signed HMAC quote describing exactly what WOULD be paid. Money moves
  // only via tiny_pay_confirm, and that tool must only ever be called after
  // the user has explicitly approved the exact quote (amount, payee,
  // network). The backend binds the quote to this user + message + a 5-min
  // expiry + a single-use nonce, so a stolen or replayed quote is inert.

  server.registerTool('tiny_wallet', {
    annotations: { destructiveHint: false },
    description: "The user's tiny.technology wallet. Actions: 'balance' (+ recent history), 'deposit_info' (how THIS deployment funds a wallet — read it before advising anything; the reply carries a `top_up` sentence naming the one valid route), 'faucet' (claim the free daily trial credit, where the deployment runs its own chain), 'pricing' (what a resource costs, e.g. a paid tiny), 'set_price' (price one of the user's own tinys, price_micro = USDC millionths, 0 = free), 'claim' (credit an on-chain deposit by tx hash). Balance is real USDC on Base on the public deployment and non-withdrawable trial credit on a testnet or self-hosted chain — never assume which; deposit_info says. NEVER tell a user to buy, bridge or exchange USDC before deposit_info confirms an external rail exists: on a self-hosted chain no exchange sells the token, so that advice costs them real money for credit this deployment cannot accept. Withdrawals and payout-address changes are deliberately NOT exposed here — use the web wallet.",
    inputSchema: {
      action: z.enum(['balance', 'deposit_info', 'faucet', 'pricing', 'set_price', 'claim']).describe('What to do'),
      resource: z.string().optional().describe("pricing/set_price: the resource, e.g. 'tiny:<slug>'"),
      price_micro: z.number().int().min(0).optional().describe('set_price: USDC millionths per message (1000000 = $1). 0 = free'),
      txHash: z.string().optional().describe('claim: the 0x… deposit transaction hash'),
      // 'tiny' belongs in this enum even though only a self-hosted deployment
      // serves it: deposit_info reports `default_network: "tiny"` there, and the
      // SDK used to reject the very network the server told the agent to use.
      network: z.enum(WALLET_NETWORKS as [string, ...string[]]).optional()
        .describe("claim: which network the deposit landed on (deposit_info.default_network; 'tiny' = this deployment's own chain)"),
    },
  }, guard(async (input: any) => {
    if (input.action === 'balance') {
      const r = await api.get('/api/wallet')
      return r?.ok === false ? fail(r.error || 'wallet unavailable') : ok(r)
    }
    // The faucet is its own route (it signs an on-chain mint), and its refusals
    // are only distinguishable WITH the status — see `faucetOutcome`.
    if (input.action === 'faucet') {
      const { status, body } = await api.postStatus('/api/wallet/faucet', {})
      const out = faucetOutcome(body, status)
      return out.ok ? ok({ ...body, summary: out.message }) : fail(out.message)
    }
    const body: any = { action: input.action }
    if (input.resource !== undefined) body.resource = input.resource
    if (input.price_micro !== undefined) body.price_micro = input.price_micro
    if (input.txHash !== undefined) body.txHash = input.txHash
    if (input.network !== undefined) body.network = input.network
    const r = await api.post('/api/wallet', body)
    if (r?.ok === false) return fail(r.error || `${input.action} failed`)
    // deposit_info is where an agent decides what to tell the user, so the reply
    // must carry the answer rather than leave it to be inferred from a network
    // string the model will interpret with its own USDC priors.
    if (input.action === 'deposit_info') return ok({ ...r, top_up: topUpAdvice(r) })
    return ok(r)
  }))

  server.registerTool('tiny_pay_quote', {
    annotations: { destructiveHint: false },
    description: "Get a payment QUOTE for consulting a paid x402 service (e.g. a priced tiny) — probes the endpoint, and if it answers 402 returns a signed quote {quote, price_micro, network, payee, expires_at, summary}. NO money moves. Present the quote's summary to the user and STOP — only after they explicitly approve may tiny_pay_confirm be called with the same quote + message. Free endpoints answer immediately (response included, paid_micro: 0).",
    inputSchema: {
      url: z.string().url().describe('The https x402 endpoint, e.g. https://tiny.technology/api/x402/chat/<slug>'),
      message: z.string().min(1).max(8000).describe('The message/task the payment buys — bound into the quote'),
      max_spend_micro: z.number().int().positive().optional().describe('Tighten the spend ceiling (USDC millionths); platform cap applies regardless'),
    },
  }, guard(async ({ url, message, max_spend_micro }: { url: string; message: string; max_spend_micro?: number }) => {
    const r = await api.post('/api/x402/pay', {
      url, message,
      ...(max_spend_micro ? { max_spend_micro } : {}),
    })
    return r?.ok === false ? fail(r.error || 'quote failed') : ok(r)
  }))

  server.registerTool('tiny_pay_confirm', {
    annotations: { destructiveHint: true },
    description: "EXECUTE a payment the user has EXPLICITLY approved — spends real USDC from their tiny wallet. Requires the exact quote from tiny_pay_quote and the same message it was quoted for (any mismatch is rejected). Quotes expire in ~5 minutes and are single-use. NEVER call this without the user's explicit, informed approval of the amount and payee in THIS conversation.",
    inputSchema: {
      quote: z.string().min(1).describe('The signed quote string from tiny_pay_quote'),
      message: z.string().min(1).max(8000).describe('The identical message the quote was minted for'),
    },
  }, guard(async ({ quote, message }: { quote: string; message: string }) => {
    const r = await api.put('/api/x402/pay', { quote, message })
    return r?.ok === false ? fail(r.error || 'payment failed') : ok(r)
  }))

  // ── Direct messages (user↔user DMs) ───────────────────────────────────

  server.registerTool('tiny_send_message', {
    annotations: { destructiveHint: false, openWorldHint: true },
    description: "Send a direct message to another tiny.technology user — by @login or by one of their tiny's slugs. Delivery: their 💬 inbox on every tiny page, a push notification, and Telegram if they've paired a bot. Max 2000 chars.",
    inputSchema: {
      to: z.string().min(1).describe("Recipient: @login, login, or a tiny slug they own"),
      message: z.string().min(1).max(2000).describe('The message'),
    },
  }, guard(async ({ to, message }: { to: string; message: string }) => {
    const r = await api.post('/api/messages', { to, message, viaTiny: 'tiny-tech' })
    return r?.ok === false ? fail(r.error || 'send failed') : ok(r)
  }))

  server.registerTool('tiny_messages', {
    annotations: { readOnlyHint: false },
    description: "The user's DM inbox on tiny.technology. Without args: all threads (peer, last message, unread counts). With `with`: the full conversation with that user — opening it marks inbound messages read. Check when the user asks about messages or at session start if they expect DMs.",
    inputSchema: {
      with: z.string().optional().describe('Peer @login to open that thread (marks read)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max messages in thread view (default 50)'),
    },
  }, guard(async (input: { with?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (input.with) qs.set('with', input.with.replace(/^@/, ''))
    if (input.limit) qs.set('limit', String(input.limit))
    const q = qs.toString()
    return ok(await api.get(`/api/messages${q ? `?${q}` : ''}`))
  }))

  server.registerTool('tiny_follow', {
    annotations: { destructiveHint: false },
    description: "Follow or unfollow a tiny.technology builder (by @login) — followers see the builder's PUBLIC memories in their feed (tiny_graph mode 'feed'). action 'check' reports current state without changing it. Unfollow closes the edge as history (bitemporal).",
    inputSchema: {
      login: z.string().min(1).describe('Builder GitHub login (with or without @)'),
      action: z.enum(['follow', 'unfollow', 'check']).optional().describe('Default: follow'),
    },
  }, guard(async ({ login, action }: { login: string; action?: string }) => {
    const clean = login.replace(/^@/, '')
    if (action === 'check') return ok(await api.get(`/api/follow?login=${encodeURIComponent(clean)}`))
    const r = await api.post('/api/follow', { login: clean, ...(action === 'unfollow' ? { action: 'unfollow' } : {}) })
    return r?.ok === false ? fail(r.error || 'follow failed') : ok(r)
  }))

  server.registerTool('tiny_delete_message', {
    annotations: { destructiveHint: true },
    description: 'Delete a DM the user sent, by message id (from tiny_messages thread view).',
    inputSchema: { id: z.union([z.string(), z.number()]).describe('Message id') },
  }, guard(async ({ id }: { id: string | number }) => {
    const r = await api.delete('/api/messages', { id: String(id) })
    return r?.ok === false ? fail(r.error || 'delete failed') : ok(r)
  }))

  // ── Devices, model config & archives ──────────────────────────────────

  server.registerTool('tiny_devices', {
    annotations: { destructiveHint: true },
    description: "The user's enrolled tiny devices (this CLI, phones, tiny-node daemons). 'list' shows id/name/kind/platform/online/last_seen. 'revoke' kills a device's token — its heartbeat/relay stops on the next 401. Enrollment isn't exposed here: devices enroll themselves on first run.",
    inputSchema: {
      action: z.enum(['list', 'revoke']).describe('What to do'),
      deviceId: z.string().optional().describe('revoke: the device id (from list)'),
    },
  }, guard(async ({ action, deviceId }: { action: string; deviceId?: string }) => {
    if (action === 'revoke') {
      if (!deviceId) return fail('deviceId required for revoke')
      const r = await api.delete('/api/devices', { deviceId })
      return r?.ok === false ? fail(r.error || 'revoke failed') : ok(r)
    }
    const r = await api.get('/api/devices')
    return r?.ok === false ? fail(r.error || 'device registry unavailable') : ok(r)
  }))

  server.registerTool('tiny_model_config', {
    annotations: { destructiveHint: false, idempotentHint: true },
    description: "The user's cross-device BYO model config (which provider/model their tinys use everywhere they're signed in). 'get' is safe — the stored API key is never returned, only hasKey. 'set' updates provider/model fields; include apiKey ONLY to change it (omitted = stored key preserved, '' = cleared). The key is stored server-side by design — that's what syncs it across the user's devices.",
    inputSchema: {
      action: z.enum(['get', 'set']).describe('get = read (key never returned) · set = update'),
      provider: z.string().optional().describe("set: e.g. 'anthropic', 'openai', 'bedrock', 'ollama'"),
      modelId: z.string().optional().describe('set: model id'),
      baseUrl: z.string().optional().describe('set: OpenAI-compatible base URL (for custom hosts)'),
      region: z.string().optional().describe('set: bedrock region'),
      maxTokens: z.string().optional().describe('set: max output tokens'),
      apiKey: z.string().optional().describe("set: ONLY to change the stored key ('' clears; omit to keep)"),
    },
  }, guard(async (input: any) => {
    if (input.action === 'get') {
      const r = await api.get('/api/model-config')
      return r?.ok === false ? fail(r.error || 'model config unavailable') : ok(r)
    }
    const config: any = {
      provider: input.provider ?? '',
      modelId: input.modelId ?? '',
      baseUrl: input.baseUrl ?? '',
      region: input.region ?? '',
      maxTokens: input.maxTokens ?? '',
    }
    if (input.apiKey !== undefined) config.apiKey = input.apiKey
    const r = await api.post('/api/model-config', { config })
    return r?.ok === false ? fail(r.error || 'save failed') : ok(r)
  }))

  server.registerTool('tiny_archives', {
    annotations: { destructiveHint: true },
    description: "Cloud archives of chat sessions (synced across the user's devices). 'list' → the user's archives; 'get' → one archive by id; 'save' → archive a conversation ({role, content} messages — the server redacts credentials); 'delete' → remove one by id.",
    inputSchema: {
      action: z.enum(['list', 'get', 'save', 'delete']).describe('What to do'),
      id: z.string().optional().describe('get/delete: archive id (from list)'),
      tiny: z.string().optional().describe("save: tiny the conversation belongs to (default 'tiny')"),
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).optional().describe('save: the conversation to archive'),
    },
  }, guard(async ({ action, id, tiny, messages }: { action: string; id?: string; tiny?: string; messages?: any[] }) => {
    if (action === 'save') {
      if (!messages?.length) return fail('messages required for save')
      const r = await api.post('/api/archives', { tiny: tiny || 'tiny', messages })
      return r?.error ? fail(r.error) : ok(r)
    }
    if (action === 'get' || action === 'delete') {
      if (!id) return fail(`id required for ${action}`)
      const r = action === 'get'
        ? await api.get(`/api/archives?id=${encodeURIComponent(id)}`)
        : await api.delete('/api/archives', { id })
      return r?.error ? fail(r.error) : ok(r)
    }
    const r = await api.get('/api/archives')
    return r?.error ? fail(r.error) : ok(r)
  }))

  // ── Context prompt ────────────────────────────────────────────────────

  server.registerPrompt('tiny-context', {
    description: "The user's recent tiny memories, formatted for injection at session start",
  }, async () => {
    let block = 'Not logged in to tiny.technology — no memory context available.'
    try {
      const d = await api.get('/api/learnings?limit=30')
      const items = (d.learnings || []).map((l: any) => `- ${l.content}`).join('\n')
      block = items
        ? `## What tiny knows about this user (cross-agent memory)\n${items}`
        : 'No memories stored yet — use tiny_learn as you discover durable facts about the user.'
    } catch {}
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: block } }],
    }
  })

  // ── Resources (browsable context, not just callable tools) ───────────
  //
  // Tools are verbs the model INVOKES; resources are nouns a client can
  // ATTACH. Surfacing identity + memory + each owned tiny as resources lets
  // MCP hosts (Claude Desktop's paperclip, Claude Code's @-mentions) pull
  // tiny context into a conversation without the model first guessing to
  // call a tool. Same data as tiny_whoami / tiny_memories / tiny_get — read
  // through the same authed api, so an unauthenticated read returns a
  // logged-out placeholder rather than crashing the client's resource pane.

  const resourceText = (uri: string, text: string, mimeType = 'text/markdown') => ({
    contents: [{ uri, mimeType, text }],
  })

  server.registerResource('identity', 'tiny://me', {
    title: 'Your tiny identity',
    description: 'Who you are on tiny.technology and the tinys you own (same data as tiny_whoami).',
    mimeType: 'application/json',
  }, async (uri) => {
    try {
      const me = await api.get('/api/me')
      return resourceText(uri.href, JSON.stringify(me, null, 2), 'application/json')
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return resourceText(uri.href, 'Not logged in — run `npx tiny-tech login` or call tiny_login.', 'text/plain')
      throw e
    }
  })

  server.registerResource('memories', 'tiny://memories', {
    title: 'Your tiny memory',
    description: 'Your most recent cross-agent memories, formatted for reading (same data as tiny_memories).',
    mimeType: 'text/markdown',
  }, async (uri) => {
    try {
      const d = await api.get('/api/learnings?limit=50')
      const items = (d.learnings || []).map((l: any) => `- ${l.content}`).join('\n')
      const body = items
        ? `# What tiny remembers about you\n\n${items}`
        : '# What tiny remembers about you\n\n_No memories stored yet._'
      return resourceText(uri.href, body)
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return resourceText(uri.href, 'Not logged in — run `npx tiny-tech login` or call tiny_login.', 'text/plain')
      throw e
    }
  })

  // Dynamic per-tiny resource: tiny://tiny/<name>. The list callback enumerates
  // the tinys the user owns (from /api/me) so they appear individually in a
  // client's resource browser; reads return the full record like tiny_get.
  server.registerResource('tiny', new ResourceTemplate('tiny://tiny/{name}', {
    list: async () => {
      try {
        const me = await api.get('/api/me')
        const owned: any[] = me?.tinys || me?.user?.tinys || []
        return {
          resources: owned.map((t: any) => {
            const name = typeof t === 'string' ? t : (t.name || t.slug)
            return {
              uri: `tiny://tiny/${name}`,
              name: `tiny/${name}`,
              title: name,
              description: `The ${name} tiny's full record (prompt, knowledge, config).`,
              mimeType: 'application/json',
            }
          }).filter((r: any) => r.uri !== 'tiny://tiny/undefined'),
        }
      } catch {
        return { resources: [] } // logged out — nothing to enumerate
      }
    },
  }), {
    title: 'A tiny you own',
    description: 'The full record of one of your tinys — system prompt, knowledge, branding, config.',
    mimeType: 'application/json',
  }, async (uri, { name }) => {
    const slug = Array.isArray(name) ? name[0] : name
    try {
      const r = await api.post('/api/tiny', { name: slug })
      if (!r?.systemPrompt && !r?.isOwner) {
        return resourceText(uri.href, `'${slug}' doesn't exist or you don't own it.`, 'text/plain')
      }
      return resourceText(uri.href, JSON.stringify(r, null, 2), 'application/json')
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return resourceText(uri.href, 'Not logged in — run `npx tiny-tech login` or call tiny_login.', 'text/plain')
      throw e
    }
  })

  // ── Boot ──────────────────────────────────────────────────────────────

  await mountForgedTools() // no-op when logged out

  if (!api.authenticated) {
    process.stderr.write('tiny-tech: not logged in — tools will prompt for `npx tiny-tech login` (or call tiny_login)\n')
  } else {
    process.stderr.write(`tiny-tech: serving as @${api.user?.login} (${registeredForged.size} forged tools mounted)\n`)
  }

  // 🫀 Device presence: while the MCP server lives, the device shows
  // online on /devices. Revocation (web UI) stops the loop gracefully.
  const device = loadDevice()
  if (device) {
    startHeartbeatLoop(device, () => {
      process.stderr.write('tiny-tech: device revoked — presence stopped (re-enroll with `npx tiny-tech login`)\n')
    })
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
