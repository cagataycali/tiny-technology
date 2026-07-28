/**
 * POST /api/job-run — execute a scheduled job's prompt (called by the
 * worker's cron, X-Internal-Key guarded). Runs a single non-streaming agent
 * turn as the job's tiny WITH the owner's capability set: forged my_* tools,
 * the tiny's OpenAPI skills, MCP servers from the tiny config, server memory
 * (learn/recall/unlearn) and use_telegram — so "every morning, check X and
 * message me on Telegram" actually works. The owner's identity is the
 * job's user_id, forwarded by the worker on the internal-key channel.
 */
import { Agent } from '@strands-agents/sdk'
import { createModel, parseAdditionalFields, preflightModelCheck } from '@/lib/chat/model'
import { http } from '@/tools/http'
import { parseOpenAPI } from '@/lib/utils'
import { buildMcpClients, resultText, friendlyError } from '@/lib/chat/helpers'
import { makeLearnTool, makeRecallTool, makeUnlearnTool, makeConflictsTool, makeGraphNeighborsTool } from '@/lib/chat/tools/memory'
import { makeForgedTools, buildDynamicTools, makeUseTelegramTool, makeUseDeviceTool, makeWalletTool } from '@/lib/chat/tools/platform'
import { parseDisabledTools, filterTools, dedupeToolsByName } from '@/lib/chat/tool-filter'

export const runtime = 'edge'
export const maxDuration = 120

const WORKER = 'https://plugin.tiny.technology'
const internalHeaders = () => ({ 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' })

export async function POST(req: Request) {
  // Internal callers only (the worker cron)
  const key = req.headers.get('x-internal-key') || ''
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const tiny = body?.tiny
  const prompt = body?.prompt
  const userId = body?.userId ? String(body.userId) : ''
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'prompt required' }), { status: 400 })
  }

  // Preflight the env-configured provider BEFORE the context fetch fan-out:
  // a misconfiguration (TINY_MODEL_PROVIDER set, its key absent) should fail
  // every job instantly with an actionable message in the result/event feed
  // — not burn three worker round-trips and surface a provider stack trace.
  const preflightError = preflightModelCheck({})
  if (preflightError) {
    return new Response(JSON.stringify({ ok: false, error: `job model misconfigured: ${preflightError}` }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Owner context in parallel — mirrors the chat route's fetch fan-out.
    // userId authorizes owner access on the internal-key channel: /get
    // resolves the FULL prompt/knowledge for a PRIVATE tiny (without it a
    // job pointed at the owner's private tiny answers as a generic
    // assistant), /tools returns the owner's forged tools, /prefs their
    // manage_tools disable list.
    const [tinyData, userToolRows, disabledToolsRaw] = await Promise.all([
      fetch(`${WORKER}/get?name=${encodeURIComponent(tiny || 'tiny')}`
        + (userId ? `&userId=${encodeURIComponent(userId)}` : ''), {
        headers: internalHeaders(),
      }).then(r => r.json()).catch(() => ({})),
      userId
        ? fetch(`${WORKER}/tools?userId=${encodeURIComponent(userId)}`, { headers: internalHeaders() })
            .then(r => r.json()).then(d => d.tools || []).catch(() => [])
        : Promise.resolve([]),
      userId
        ? fetch(`${WORKER}/prefs?userId=${encodeURIComponent(userId)}&key=disabled_tools`, { headers: internalHeaders() })
            .then(r => r.json()).then(d => String(d.value || '')).catch(() => '')
        : Promise.resolve(''),
    ])

    // MCP servers from the tiny's stored config (owner headers included —
    // /get was called with the internal key). URL validation happens inside
    // buildMcpClients (SSRF guard).
    let mcpConfigRaw: unknown = tinyData?.mcpServers ?? tinyData?.mcp_servers
    if (typeof mcpConfigRaw === 'string') {
      try { mcpConfigRaw = JSON.parse(mcpConfigRaw) } catch { mcpConfigRaw = undefined }
    }
    const mcpClients = buildMcpClients(mcpConfigRaw)

    // The tiny's own OpenAPI skills → dynamic tools (same sanitize/dedupe
    // path as chat — operationIds are user-controlled)
    const skillFns = tinyData?.skills || parseOpenAPI(tinyData?.schema, tinyData?.name, tinyData?.worker)
    const dynamicTools = buildDynamicTools(skillFns)

    // Memory tools take the session shape but only read .sub — the job
    // owner's id fills the same role here.
    const jobIdentity = userId ? { sub: userId, login: 'scheduled-job' } : null
    const forgedTools = makeForgedTools(userToolRows)

    // Honor the owner's manage_tools disable list; protected tools are
    // exempt inside parseDisabledTools, and dedupe keeps built-ins first
    // (a skill named `http` must not shadow the real one).
    const namedTools = filterTools(dedupeToolsByName([
      http,
      makeUseTelegramTool(userId || null),
      makeUseDeviceTool(userId || null),
      // READ-ONLY wallet — lets scheduled jobs answer money questions
      // ("alert me when my balance drops under $1") without being able to
      // move a cent; every spend path stays behind an explicit user step.
      makeWalletTool(userId || null),
      makeLearnTool(jobIdentity),
      makeRecallTool(jobIdentity),
      makeUnlearnTool(jobIdentity),
      makeConflictsTool(jobIdentity),
      makeGraphNeighborsTool(jobIdentity),
      ...forgedTools,
      ...dynamicTools,
    ]), parseDisabledTools(disabledToolsRaw))

    const capabilityNote = [
      'the http tool for web/API access',
      'use_telegram to proactively message the owner\'s authorized Telegram chats (if they connected a bot — a "no bot" error means they haven\'t)',
      'learn/recall/unlearn for the owner\'s persistent memory graph (learn supersedes outdated facts + links related ones; recall hops=1 walks connections; memory_conflicts finds contradictions)',
      'wallet to READ the owner\'s balance + recent transactions (read-only — no tool here can spend)',
      forgedTools.length ? `their forged tools (${forgedTools.map((t: any) => t.name).join(', ')})` : '',
      dynamicTools.length ? `this tiny's API skills (${dynamicTools.map((t: any) => t.name).slice(0, 10).join(', ')})` : '',
      mcpClients.length ? 'the tiny\'s connected MCP servers' : '',
    ].filter(Boolean).join('; ')

    const agent = new Agent({
      // Same provider factory as chat: TINY_MODEL_PROVIDER env selects the
      // provider (default openai), per-provider env keys/model ids apply,
      // and STRANDS_ADDITIONAL_REQUEST_FIELDS rides through (e.g. Bedrock's
      // anthropic_beta 1M context). No BYOK here — jobs are headless; the
      // server's own credentials run them.
      model: createModel({ additionalFields: parseAdditionalFields(undefined) }),
      printer: false,
      tools: dedupeToolsByName([...namedTools, ...mcpClients]),
      systemPrompt: `You are ${tinyData.name || tiny || 'tiny'}, running a SCHEDULED background job (no user present — do the work, produce a concise result).
System Prompt: ${tinyData.systemPrompt || ''}
Knowledge Base: ${tinyData.systemKnowledge || ''}
You have ${capabilityNote}. If the job asks you to notify or message the owner, actually do it with use_telegram — don't just describe what you would send.
Keep the final answer under 250 words; it is stored as the job result and surfaced to the user later.`,
    })

    // Must finish BEFORE the worker cron's 60s fetch abort (scheduler.ts) —
    // otherwise the worker gives up first, records the job as FAILED and
    // pushes a "❌ failed" notification even when the agent actually
    // succeeded, and the real result (returned ~70s) is discarded. 50s leaves
    // margin for network + response overhead under the worker's 60s patience.
    const result = await Promise.race([
      agent.invoke(prompt),
      new Promise((_, rej) => setTimeout(() => { try { agent.cancel() } catch { }; rej(new Error('job timeout')) }, 50_000)),
    ])

    return new Response(JSON.stringify({ ok: true, result: resultText(result).slice(0, 2000) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    // friendlyError unwraps nested provider JSON (Google double-encodes,
    // OpenAI wraps in {error:{message}}) — the job result lands in the
    // user's event feed, where a raw provider blob is unreadable.
    return new Response(JSON.stringify({ ok: false, error: friendlyError(error).slice(0, 300) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
