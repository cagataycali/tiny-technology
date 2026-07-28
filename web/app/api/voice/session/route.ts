/**
 * /api/voice/session — start a real speech-to-speech call with a tiny.
 *
 *   POST { tiny } → { sessionId, wsUrl, ticket }   (session-authed)
 *
 * This is the thin front for the worker's VoiceSession Durable Object
 * (docs/voice-sessions-design.md). It:
 *   1. resolves the user's BYO OpenAI key — v1 is BYO-key ONLY (zero platform
 *      cost): the x-tiny-model-* headers if the device has an OpenAI selection,
 *      else the user's synced model-config if it's OpenAI, else a clear error;
 *   2. fetches the tiny's config for its per-tiny `voice` + persona;
 *   3. calls the worker to mint the DO + a single-use connect ticket;
 *   4. returns the ws URL the browser dials plus the ticket.
 *
 * The OpenAI key is handed to the worker over the internal-key channel and
 * lives only in the DO for the session's lifetime — it never touches the
 * browser (the browser only gets the sessionId + ticket).
 */
import { getSession } from '@/lib/auth'
import { buildVoiceTools } from '@/lib/voice/tools'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const WS_BASE = WORKER_URL.replace(/^http/, 'ws')

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Resolve the user's OpenAI API key, BYO-only. Returns the key or null. */
async function resolveOpenAIKey(req: Request, userId: string): Promise<{ key: string; model?: string } | null> {
  const h = req.headers
  const headerProvider = (h.get('x-tiny-model-provider') || '').toLowerCase()
  const headerKey = h.get('x-tiny-model-api-key') || ''
  // Device-local OpenAI selection wins (same precedence as the chat route).
  if (headerProvider === 'openai' && headerKey) {
    return { key: headerKey, model: h.get('x-tiny-model-id') || undefined }
  }
  // Else the synced (cross-device) model-config, but only if it's OpenAI.
  const synced: any = await fetch(
    `${WORKER_URL}/model-config?userId=${encodeURIComponent(userId)}`,
    { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
  ).then(r => r.json()).catch(() => null)
  const cfg = synced?.config
  if (cfg?.provider?.toLowerCase() === 'openai' && cfg?.apiKey) {
    return { key: cfg.apiKey, model: cfg.model_id || undefined }
  }
  return null
}

const VOICE_NAMES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']

/** A concise persona instruction for the realtime model — voice wants a tight
 *  spoken-style brief, not the full chat soul prompt. */
function buildVoiceInstructions(tiny: any): string {
  const name = tiny?.name || 'tiny'
  const persona = String(tiny?.systemPrompt || '').trim()
  const knowledge = String(tiny?.systemKnowledge || '').trim()
  const parts = [
    `You are ${name}, a living AI at tiny.technology/${name}. You are speaking out loud in a live voice call — be warm, natural, and concise. Never mention that you are an AI model or narrate tool use; just talk like ${name}.`,
  ]
  if (persona) parts.push(`Your essence:\n${persona}`)
  if (knowledge) parts.push(`What you know:\n${knowledge.slice(0, 4000)}`)
  return parts.join('\n\n')
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { tiny, context } = await req.json().catch(() => ({} as any))
  const tinyName = String(tiny || '').trim()
  if (!tinyName) return json({ ok: false, error: 'tiny required' }, 400)
  // Client-built continuity context (memories + recent turns) — the same
  // context chat injects into every turn, so the VOICE agent knows what the
  // chat agent knows. Capped: session.update instructions aren't unbounded.
  const continuity = String(context || '').slice(0, 6000)

  // BYO OpenAI key gate (v1). No key → a clear, actionable error.
  const creds = await resolveOpenAIKey(req, session.sub)
  if (!creds) {
    return json({
      ok: false,
      error: 'Voice needs your own OpenAI API key. Add an OpenAI key in model settings, then start a call.',
      code: 'byok_required',
    }, 402)
  }

  // Fetch the tiny for its per-tiny voice + persona.
  const tinyData: any = await fetch(
    `${WORKER_URL}/get?name=${encodeURIComponent(tinyName)}&userId=${encodeURIComponent(session.sub)}`,
    { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
  ).then(r => r.json()).catch(() => null)
  if (!tinyData || tinyData.error || !tinyData.name) {
    return json({ ok: false, error: 'tiny not found' }, 404)
  }

  // Voice resolution: the tiny's OWN voice (an owner's explicit per-tiny
  // choice) wins; else the caller's account-default voice; else 'marin'. So
  // your own tinys inherit your account voice unless a tiny overrides it, while
  // other people's tinys keep their owner's chosen voice.
  const perTinyVoice = VOICE_NAMES.includes(String(tinyData.voice || '')) ? String(tinyData.voice) : ''
  let voice = perTinyVoice
  if (!voice) {
    const acct: any = await fetch(
      `${WORKER_URL}/account-voice?userId=${encodeURIComponent(session.sub)}`,
      { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
    ).then(r => r.json()).catch(() => null)
    if (acct?.voice && VOICE_NAMES.includes(String(acct.voice))) voice = String(acct.voice)
  }
  if (!voice) voice = 'marin'
  let instructions = buildVoiceInstructions(tinyData)
  if (continuity) instructions += `\n\nWhat you remember about this user (continuity — treat as your own memory, don't recite it):\n${continuity}`

  // Mint the DO + single-use ticket on the worker.
  const created: any = await fetch(`${WORKER_URL}/voice/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    body: JSON.stringify({
      userId: session.sub,
      tinyName,
      voice,
      instructions,
      openaiKey: creds.key,
      // The chat agent's tool roster for THIS session type (inline-chat
      // design: the voice agent has the same tools). The client executes
      // over the DO's tool_call/tool_result bridge.
      tools: buildVoiceTools(req.headers.get('x-tiny-session') || ''),
      // Only override the realtime model if the user picked a realtime one;
      // otherwise the DO's default (gpt-realtime-2.1-mini) is right.
      ...(creds.model && creds.model.includes('realtime') ? { model: creds.model } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (!created?.ok || !created?.sessionId || !created?.ticket) {
    return json({ ok: false, error: created?.error || 'could not start session' }, 502)
  }

  const wsUrl = `${WS_BASE}/voice/connect/${created.sessionId}?ticket=${encodeURIComponent(created.ticket)}`
  return json({ ok: true, sessionId: created.sessionId, wsUrl, voice })
}
