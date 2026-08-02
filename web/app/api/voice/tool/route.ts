/**
 * /api/voice/tool — server-tool execution for a LIVE voice call.
 *
 *   POST { name, args } → the tool's result JSON   (session-authed)
 *
 * The voice bridge executes device/client tools on the phone/browser, but the
 * chat agent also carries SERVER tools (worker-backed account memory). During
 * a call the client forwards those tool_call frames here; this route runs the
 * SAME tool objects the chat route mounts (lib/chat/tools/memory factories,
 * bound to the caller's session) and hands the result back for tool_result.
 *
 * Deliberately a whitelist: money movers (pay_x402), tiny CRUD, and installs
 * stay chat-only until voice grows a confirm UX.
 */
import { getSession } from '@/lib/auth'
import { makeLearnTool, makeRecallTool, makeUnlearnTool } from '@/lib/chat/tools/memory'
import { makeSendMessageTool, makeReadMessagesTool } from '@/lib/chat/tools/messages'
import { makeNiclaTakePhotoTool, makeNiclaTakeVideoTool, makeNiclaListenTool, makeNiclaStatusTool } from '@/lib/chat/tools/nicla'
import { makeNiclaVoiceStatusTool, makeNiclaVoiceWakesTool, makeNiclaVoiceRecordTool, makeNiclaVoiceTranscriptsTool, makeNiclaVoiceTranscriptTool } from '@/lib/chat/tools/nicla-voice'
import { makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool } from '@/lib/chat/tools/flipper'

export const runtime = 'edge'

/**
 * How long a tool on THIS bridge may wait on hardware.
 *
 * A live call is the tightest caller in the app, and it is the only one whose
 * patience is not written in this repo's route: the browser aborts at
 * `deadlineFor('/api/voice/tool')` and both phones at a flat 30s (Api.swift's
 * `timeoutInterval`, TinyApi.kt's `callTimeout`). So a tool given its full
 * interactive ceiling here cannot finish — 20s leaves every surface headroom,
 * and `exceedsServerBudget` keeps that provable.
 *
 * Passed to the flipper tools for the same reason job-run passes JOB_DEADLINE_S:
 * "a tool that waits longer than this can only ever produce a timeout, never a
 * usable answer or a real explanation." flipper_status's own ceiling is 45s
 * (STATUS_WAIT_S) — three times this bridge's patience — so unbudgeted it could
 * only ever be killed by the client, and the model heard "the tool timed out"
 * instead of the sentence flipper.ts writes for precisely this case: a wait
 * shorter than BLE_ROUND_TRIP_S concludes nothing, and says so, and says where
 * the full 45s is available.
 *
 * ⚠️ NOT passed to the nicla factories, and that is a real gap rather than a
 * decision this rail gets to make: nicla_voice_record's ceiling is
 * `seconds + 25` (145s at its 120s max), so a long recording still outlives
 * every client here — recoverable, because nicla_voice_transcripts reads back
 * what finished after the tool timed out. How long a live call may pause for a
 * capture is a product call on those tools' own loop; c53 already recorded the
 * server-side half of this as out of scope for a web-UI cycle.
 */
export const VOICE_TOOL_BUDGET_S = 20

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { name, args, viaTiny } = await req.json().catch(() => ({} as any))
  const toolName = String(name || '').trim()
  if (!toolName) return json({ ok: false, error: 'name required' }, 400)

  // Still a whitelist: memory + DMs. Money movers (pay_x402), tiny CRUD and
  // installs stay chat-only until voice grows a confirm UX. viaTiny is an
  // optional body field (the client knows which tiny is on the call) —
  // send_message stamps it as the sender surface, same as chat.
  const roster = [
    makeLearnTool(session),
    makeRecallTool(session),
    makeUnlearnTool(session),
    makeSendMessageTool(session, String(viaTiny || '').slice(0, 64)),
    makeReadMessagesTool(session),
    // 💎 The necklace — server round-trip via the relay; the voice model
    // gets text + hosted URLs (blocks are flattened below: the realtime
    // bridge speaks JSON, not content blocks).
    makeNiclaTakePhotoTool(session.sub),
    makeNiclaTakeVideoTool(session.sub),
    makeNiclaListenTool(session.sub),
    makeNiclaStatusTool(session.sub),
    // 🎙️ The voice necklace — must be mounted here too or the model declares
    // the tool (lib/voice/tools.ts) and the bridge 404s it. The recorder is a
    // relay round-trip to the paired PHONE; the transcript tools are reads.
    makeNiclaVoiceStatusTool(session.sub),
    makeNiclaVoiceWakesTool(session.sub),
    makeNiclaVoiceRecordTool(session.sub),
    makeNiclaVoiceTranscriptsTool(session.sub),
    makeNiclaVoiceTranscriptTool(session.sub),
    // 🐬 All three take this bridge's budget — see VOICE_TOOL_BUDGET_S. A
    // spoken "is my Flipper reachable?" is the whole reason they are declared
    // to a web session (lib/voice/tools.ts), and until the bridge forwarded
    // unknown names (Chat.tsx runVoiceTool) it was answered "not available on
    // this device". flipper_listen keeps its refusals: capture is cable-only,
    // and a window this turn cannot host is declined in words.
    makeFlipperStatusTool(session.sub, VOICE_TOOL_BUDGET_S),
    makeFlipperListenTool(session.sub, VOICE_TOOL_BUDGET_S),
    makeFlipperFilesTool(session.sub, VOICE_TOOL_BUDGET_S),
  ]
  const tool = roster.find((t: any) => t.toolSpec?.name === toolName)
  if (!tool) return json({ ok: false, error: `'${toolName}' is not available on the voice bridge` }, 404)

  try {
    // invoke() zod-validates args against the tool's own schema, then runs
    // the same callback chat runs.
    const result = await (tool as any).invoke(args ?? {})
    // Chat tools may answer with content BLOCKS (images + text) — the voice
    // bridge JSON-serializes results, so flatten to the text parts (which
    // carry the hosted URLs) rather than shipping base64 image bytes.
    if (Array.isArray(result)) {
      const text = result.map((b: any) => b?.text).filter(Boolean).join('\n')
      return json({ ok: true, result: { ok: true, text } })
    }
    return json({ ok: true, result })
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err).slice(0, 500) }, 200)
  }
}
