/**
 * /api/voice/sessions — list the signed-in user's voice sessions (recent
 * first). Session-authed; the worker query is user-scoped.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const res: any = await fetch(
    `${WORKER_URL}/voice/sessions?userId=${encodeURIComponent(session.sub)}`,
    { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (res?.error) return json({ ok: false, error: res.error }, 502)
  return json({ ok: true, sessions: res?.sessions || [] })
}
