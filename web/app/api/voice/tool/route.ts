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

export const runtime = 'edge'

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
  ]
  const tool = roster.find((t: any) => t.toolSpec?.name === toolName)
  if (!tool) return json({ ok: false, error: `'${toolName}' is not available on the voice bridge` }, 404)

  try {
    // invoke() zod-validates args against the tool's own schema, then runs
    // the same callback chat runs.
    const result = await (tool as any).invoke(args ?? {})
    return json({ ok: true, result })
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err).slice(0, 500) }, 200)
  }
}
