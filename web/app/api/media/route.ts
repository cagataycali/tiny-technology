/**
 * /api/media — session-authed upload proxy for device-generated media
 * (on-device genAI tools: generate_image now, speak audio next).
 *
 *   POST { data(base64), contentType } → { key, url }
 *
 * The worker stores bytes in R2 under an unguessable UUID key and serves
 * them publicly at /media/:key — histories and tool results carry URLs,
 * never base64, so every client (web/iOS/Android/Telegram) renders the
 * same generated media. userId is stamped server-side from the session
 * (Bearer or cookie — same getSession the chat route uses), so a client
 * can never attribute media to another account.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { data, contentType } = await req.json().catch(() => ({} as any))
  if (!data || !contentType) return json({ ok: false, error: 'data and contentType required' }, 400)

  const res = await fetch(`${WORKER_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({ userId: session.sub, data: String(data), contentType: String(contentType) }),
    // Uploads carry megabytes — give the worker more room than the 10s
    // polling routes, but still bounded (edge wall-clock is finite).
    signal: AbortSignal.timeout(30_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (res.error) return json({ ok: false, error: res.error }, res.error === 'unauthorized' ? 401 : 424)
  return json({ ok: true, key: res.key, url: res.url, bytes: res.bytes })
}
