/**
 * /api/location — map-presence proxy (maps-location loop c5).
 *
 *   GET     → { ok, me, pins: [{ userId, login, name, avatar, lat, lng,
 *               speedKmh, heading, updated }] }   (public — pins are data
 *               users explicitly opted into showing everyone)
 *   POST    { lat, lng, speedKmh?, heading?, accuracyM? } → { ok }
 *               (session-gated: beating IS the opt-in; userId comes from the
 *               session, never the body)
 *   DELETE  → { ok }   (session-gated opt-out — pin vanishes immediately)
 *
 * Same relay discipline as /api/devices: 10s timeout on every worker
 * round-trip, and non-2xx/transport failures surface as errors instead of
 * parsing to a clean-looking {}.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const internalHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

const T = () => ({ signal: AbortSignal.timeout(10_000) })

async function relay(p: Promise<Response>): Promise<{ data: any; ok: boolean; status: number }> {
  try {
    const res = await p
    return { data: await res.json().catch(() => ({})), ok: res.ok, status: res.status }
  } catch (e: any) {
    return { data: { error: String(e?.message || e) }, ok: false, status: 0 }
  }
}

export async function GET(req: Request) {
  // Session is optional — anyone may see the map; `me` lets the client
  // skip rendering the viewer's own pin on top of their live marker.
  const session = await getSession(req)
  const { data, ok } = await relay(
    fetch(`${WORKER_URL}/location/list`, { headers: internalHeaders(), cache: 'no-store', ...T() })
  )
  if (!ok) return json({ ok: false, error: data?.error || 'presence unavailable' }, 502)
  return json({ ok: true, me: session?.sub ?? null, pins: data?.pins || [] })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  let body: any = {}
  try { body = await req.json() } catch {}
  const lat = Number(body?.lat)
  const lng = Number(body?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ ok: false, error: 'lat and lng required' }, 400)
  }

  const { data, ok, status } = await relay(
    fetch(`${WORKER_URL}/location/heartbeat`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        userId: session.sub,
        lat,
        lng,
        speedKmh: body?.speedKmh,
        heading: body?.heading,
        accuracyM: body?.accuracyM,
      }),
      ...T(),
    })
  )
  if (!ok) return json({ ok: false, error: data?.error || 'heartbeat failed' }, status || 502)
  return json({ ok: true })
}

export async function DELETE(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { data, ok, status } = await relay(
    fetch(`${WORKER_URL}/location`, {
      method: 'DELETE',
      headers: internalHeaders(),
      body: JSON.stringify({ userId: session.sub }),
      ...T(),
    })
  )
  if (!ok) return json({ ok: false, error: data?.error || 'opt-out failed' }, status || 502)
  return json({ ok: true })
}
