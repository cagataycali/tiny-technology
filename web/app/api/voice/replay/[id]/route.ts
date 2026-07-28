/**
 * /api/voice/replay/[id] — replay manifest for one voice session: the D1 row
 * plus the R2 asset URLs (events.jsonl + per-direction PCM segments). The
 * replay page fetches this, then pulls the assets directly from the worker.
 *
 * Ownership: the session must belong to the signed-in user (voice records are
 * private by default; public sharing rides the existing shares table later).
 */
import { getSession } from '@/lib/auth'
import { ownsVoiceSession } from '@/lib/voice/platform'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { id } = await params
  if (!id) return json({ ok: false, error: 'id required' }, 400)

  const res: any = await fetch(
    `${WORKER_URL}/voice/session?id=${encodeURIComponent(id)}`,
    { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (res?.error) return json({ ok: false, error: res.error }, 502)
  if (!res?.session) return json({ ok: false, error: 'not found' }, 404)
  // Owner-only (voice records are private by default). ownsVoiceSession fails
  // CLOSED — the old inline `user_id && user_id !== sub` guard let a row with a
  // falsy (null/empty) user_id THROUGH (the `&&` short-circuits, skipping the
  // ownership check) and exposed the full session + R2 audio manifest to ANY
  // logged-in user. A record with no resolvable owner is not the caller's.
  if (!ownsVoiceSession(res.session.user_id, session.sub)) {
    return json({ ok: false, error: 'not found' }, 404)
  }
  return json({ ok: true, session: res.session, manifest: res.manifest })
}
