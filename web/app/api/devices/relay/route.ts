/**
 * /api/devices/relay — cross-network device messaging (tiny-node PR6).
 *
 *   POST { toDevice, payload }          session → send envelope → { id }
 *   GET  ?inReplyTo=<id>                session → fetch reply   → { reply? }
 *   PUT  { deviceId, token, max? }      device-token → poll     → { messages }
 *   PATCH{ deviceId, token, inReplyTo, payload } device-token → reply → { ok }
 *
 * Session verbs (POST/GET) carry the OWNER's identity; device verbs
 * (PUT/PATCH) authenticate with the device token in-body (no session,
 * off the IP limiter like /api/devices/heartbeat — polling is continuous,
 * the token is the gate).
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

// 10s bound on every worker round-trip. This is a polling surface — the
// session GET polls for a device's reply and the device PUT polls undelivered
// envelopes continuously — so a connect-but-never-respond worker would pin each
// invocation to CF wall-clock. AbortError falls into the existing .catch →
// {error} → 424 (relay unavailable), which callers already handle.
const T = () => ({ signal: AbortSignal.timeout(10_000) })

async function workerPost(path: string, body: any) {
  return fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(body),
    ...T(),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
}

/** Session → send an envelope to one of MY devices */
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { toDevice, payload } = await req.json().catch(() => ({} as any))
  if (!toDevice) return json({ ok: false, error: 'toDevice required' }, 400)

  const data = await workerPost('/device/relay/send', {
    userId: session.sub,
    toDevice: String(toDevice),
    // itty body rule: JSON as string
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
  })
  if (data.error) return json({ ok: false, error: data.error }, data.error === 'device not found' ? 404 : 424)
  return json({ ok: true, id: data.id })
}

/** Session → poll for the reply to an envelope I sent */
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const inReplyTo = new URL(req.url).searchParams.get('inReplyTo')
  if (!inReplyTo) return json({ ok: false, error: 'inReplyTo required' }, 400)

  const data = await fetch(
    `${WORKER_URL}/device/relay/recv?userId=${encodeURIComponent(session.sub)}&inReplyTo=${encodeURIComponent(inReplyTo)}`,
    { headers: internalHeaders(), cache: 'no-store', ...T() }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, reply: data.reply ?? null })
}

/** Device → poll undelivered envelopes (token auth, no session) */
export async function PUT(req: Request) {
  const { deviceId, token, max } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token) return json({ ok: false, error: 'deviceId and token required' }, 400)

  const data = await workerPost('/device/relay/poll', {
    deviceId: String(deviceId), token: String(token),
    ...(max ? { max: Number(max) } : {}),
  })
  if (data.error) return json({ ok: false, error: data.error }, data.error === 'unauthorized' ? 401 : 424)
  return json({ ok: true, messages: data.messages || [] })
}

/** Device → reply to an envelope (token auth, no session) */
export async function PATCH(req: Request) {
  const { deviceId, token, inReplyTo, payload } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !inReplyTo) return json({ ok: false, error: 'deviceId, token, inReplyTo required' }, 400)

  const data = await workerPost('/device/relay/reply', {
    deviceId: String(deviceId), token: String(token), inReplyTo: String(inReplyTo),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
  })
  if (data.error) return json({ ok: false, error: data.error }, data.error === 'unauthorized' ? 401 : 424)
  return json({ ok: true })
}
