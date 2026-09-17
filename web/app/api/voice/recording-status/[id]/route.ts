/**
 * /api/voice/recording-status/[id] — why a recording wouldn't play.
 *
 * The web player streams the stitched WAV straight from the worker
 * (`<audio src={WORKER}/voice/recording/:id>`), which is right: media elements
 * need no CORS and get play/pause/seek for free. But when that route DECLINES —
 * 409 still live, 413 too long to stitch, 404 nothing journaled, 424 no R2 —
 * it answers a JSON body, and `<audio>`'s entire vocabulary for that is to grey
 * out its own play button. The reason exists and the browser cannot reach it:
 * the worker's `json()` helper sets no `Access-Control-Allow-Origin` (only its
 * WAV success path does), so a cross-origin `fetch` from /calls can see that
 * something failed and never what.
 *
 * ⚠️ SO THIS ROUTE EXISTS FOR THE BODY, NOT THE BYTES. Same-origin, so the
 * refusal is readable; session-authed and owner-checked, because it reports on
 * a private voice record (same posture as /api/voice/replay/[id]). The player
 * still streams direct — this is asked only AFTER an `onError`, which is why a
 * 200 here is reported as a transient rather than a reason.
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

  // Ownership first, and it fails CLOSED via `ownsVoiceSession` — a row with a
  // falsy stored owner is not the caller's. Checked BEFORE touching the
  // recording route so this cannot become an oracle for other people's calls.
  const meta: any = await fetch(
    `${WORKER_URL}/voice/session?id=${encodeURIComponent(id)}`,
    { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (meta?.error) return json({ ok: false, error: meta.error }, 502)
  if (!meta?.session) return json({ ok: false, error: 'not found' }, 404)
  if (!ownsVoiceSession(meta.session.user_id, session.sub)) {
    return json({ ok: false, error: 'not found' }, 404)
  }

  // ⚠️ `Range: bytes=0-1`, so a call that DOES stitch answers 206 with two
  // bytes instead of shipping a 40MB WAV through this route. The stitch itself
  // still runs server-side on a cold call — unavoidable, and the reason this is
  // only ever called after a play already failed.
  const probe = await fetch(`${WORKER_URL}/voice/recording/${encodeURIComponent(id)}`, {
    headers: { Range: 'bytes=0-1' },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)

  if (!probe) return json({ ok: false, status: 0, error: null }, 200)
  if (probe.ok || probe.status === 206) {
    // The route serves audio now. Whatever the player hit was transient (or is
    // the player's own problem) — reporting a cause here would be inventing one.
    return json({ ok: true, status: probe.status, error: null }, 200)
  }
  // The refusal, verbatim. `playbackRefusal` translates it at the surface; this
  // route deliberately does not, so the raw reason stays available to a log.
  const body: any = await probe.json().catch(() => null)
  return json({ ok: false, status: probe.status, error: body?.error ?? null }, 200)
}
