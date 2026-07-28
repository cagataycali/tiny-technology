/**
 * /api/chat/tool-result — the device half of result-returning client tools.
 *
 *   POST { toolUseId, payload } → { ok }
 *
 * Client-side tools used to be fire-and-forget (server callback no-ops, the
 * phone acts on the SSE beforeToolCallEvent and the model never sees what
 * happened). For generative tools that's wrong — the model should SEE the
 * image it asked for. So: the device executes, uploads media via /api/media,
 * then posts {toolUseId, payload} here; the chat route's tool callback is
 * polling the worker mailbox for exactly that toolUseId and returns the
 * outcome (image bytes included) into the agent loop as the tool result.
 *
 * Session-authed (Bearer or cookie) — the worker row is stamped with the
 * session's userId, and the polling callback reads user-scoped, so results
 * can't be injected across accounts.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { toolUseId, payload } = await req.json().catch(() => ({} as any))
  if (!toolUseId) return json({ ok: false, error: 'toolUseId required' }, 400)

  const res = await fetch(`${WORKER_URL}/device/tool-result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      userId: session.sub,
      toolUseId: String(toolUseId),
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
    }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (res.error) return json({ ok: false, error: res.error }, 424)
  return json({ ok: true })
}
