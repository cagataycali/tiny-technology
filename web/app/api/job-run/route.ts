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
import { makeNiclaTakePhotoTool, makeNiclaTakeVideoTool, makeNiclaListenTool, makeNiclaStatusTool } from '@/lib/chat/tools/nicla'
import { makeNiclaVoiceStatusTool, makeNiclaVoiceWakesTool, makeNiclaVoiceRecordTool, makeNiclaVoiceTranscriptsTool, makeNiclaVoiceTranscriptTool } from '@/lib/chat/tools/nicla-voice'
import { makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool } from '@/lib/chat/tools/flipper'
import { parseDisabledTools, filterTools, dedupeToolsByName } from '@/lib/chat/tool-filter'

export const runtime = 'edge'
export const maxDuration = 120

const WORKER = 'https://plugin.tiny.technology'
const internalHeaders = () => ({ 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' })

/**
 * How long the agent gets before we cancel it. Must finish BEFORE the worker
 * cron's 60s fetch abort (scheduler.ts) — otherwise the worker gives up first,
 * records the job FAILED and pushes a "❌ failed" notification even though the
 * agent succeeded, and the real result (returned ~70s) is discarded.
 *
 * Also passed to the device tools as their poll budget: a tool that waits
 * longer than this can only ever produce "job timeout", never a usable answer
 * or a real explanation.
 */
export const JOB_DEADLINE_S = 50

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
      // 💎 Scheduled jobs can use the necklace ("check the room hourly").
      // All four, same as chat and voice: a job that can photograph a room and
      // listen to it has no business being denied a 6-frame clip of it, and
      // "record a video every morning" is exactly what scheduling is for.
      makeNiclaTakePhotoTool(userId || null, JOB_DEADLINE_S),
      makeNiclaTakeVideoTool(userId || null, JOB_DEADLINE_S),
      makeNiclaListenTool(userId || null, JOB_DEADLINE_S),
      makeNiclaStatusTool(userId || null, JOB_DEADLINE_S),
      // 🎙️ The voice necklace: read-only, so no budget to clamp — both tools
      // hit the registry and the event ring, never the board. A job like "tell
      // me each morning if the necklace heard anything overnight" is the point.
      makeNiclaVoiceStatusTool(userId || null),
      makeNiclaVoiceWakesTool(userId || null),
      // 🎤 The recorder commands the paired PHONE via its relay mailbox, so
      // unlike the board's read tools it CAN be scheduled ("record a voice note
      // when I say the wake word each morning") — and it polls, so it takes the
      // job deadline like the Vision tools. The transcript reads are cheap.
      makeNiclaVoiceRecordTool(userId || null, JOB_DEADLINE_S),
      makeNiclaVoiceTranscriptsTool(userId || null),
      makeNiclaVoiceTranscriptTool(userId || null),
      makeFlipperStatusTool(userId || null),
      makeFlipperListenTool(userId || null, JOB_DEADLINE_S),
      makeFlipperFilesTool(userId || null, JOB_DEADLINE_S),
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
      // An unmentioned tool is an unused tool: the model won't reach for the
      // necklace on "check the room hourly" unless it's told it has one.
      'nicla_take_photo / nicla_take_video / nicla_listen / nicla_status for the owner\'s tiny necklace (a camera + mic worn on their chest — check nicla_status first; an offline necklace is an expected, reportable outcome, not a job failure)',
      // The two necklaces are NOT interchangeable, and a job that reaches for a
      // camera tool on the mic-only board wastes its whole 50s deadline failing.
      'nicla_voice_status / nicla_voice_wakes for the owner\'s tiny VOICE necklace — a different board: mic only, no camera, no WiFi. The board cannot be commanded, only read: its on-device wake-word matches are forwarded by the paired phone. An empty wake log while no phone is relaying it means nothing was reportable, NOT that the owner was silent',
      // The recorder is the PHONE's mic, and a job runs with nobody watching —
      // the model must know it needs the app open, or "record and summarize"
      // jobs burn their deadline waiting on a backgrounded phone.
      'nicla_voice_record to record N seconds through the owner\'s PHONE mic (the paired tiny app transcribes on-device) — needs the app open on the phone; "not listening" is a reportable outcome. nicla_voice_transcripts / nicla_voice_transcript read the stored transcripts, including recordings that finished after a tool timed out',
      // Passive speech needs its own line. The recorder above needs the app open
      // NOW, so a job asked what was said this morning reads its options as
      // "record (nobody's there) or read clips someone triggered" and reports it
      // has no way — while the answer is already in the same store, requiring
      // nothing of the moment.
      'For what was actually SAID near the owner earlier, read nicla_voice_transcripts and look for label "necklace-live": the Nicla VISION necklace streams its mic to the paired phone whenever its live card is open, and the phone transcribes on-device and files each segment there. Nothing has to be recording now for these to exist, and an empty result means the live card was not open, NOT that nobody spoke',
      // A Flipper capture needs a HUMAN at the device (present the card, press the
      // remote), so it is nearly always the wrong thing for an unattended job —
      // but flipper_status/flipper_files are fine, and a job told nothing about
      // any of them would instead report "I have no way to check your Flipper".
      'flipper_status / flipper_files for the owner\'s Flipper Zero (reachable only while plugged into a machine running the tiny CLI — "unreachable" is a reportable outcome, not a failure). flipper_listen also exists but BLOCKS for its window and needs a person at the device to present a card or press a remote, so do not use it in unattended work unless the job explicitly asks for a capture at a moment someone will be there',
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

    // See JOB_DEADLINE_S — leaves margin for network + response overhead under
    // the worker cron's 60s patience.
    const result = await Promise.race([
      agent.invoke(prompt),
      new Promise((_, rej) => setTimeout(() => { try { agent.cancel() } catch { }; rej(new Error('job timeout')) }, JOB_DEADLINE_S * 1000)),
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
