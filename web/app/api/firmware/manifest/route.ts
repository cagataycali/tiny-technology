/**
 * /api/firmware/manifest — the one stable name a deployed tiny can poll.
 *
 *   POST { channel, version, url, sha256 }   session → point a channel  → { ok }
 *   GET  ?channel=<name>                     session → read a channel   → { bundle? }
 *   PUT  { deviceId, token, channel }         device-token → read        → { bundle? }
 *
 * Session verbs (POST/GET) carry the OWNER's identity; the device verb (PUT)
 * authenticates with the device token in-body and no session, the same split
 * /api/devices/relay uses — a necklace's flash is readable by whoever picks it
 * up, so it cannot hold the account bearer JWT.
 *
 * It stores a POINTER, not a manifest. /api/media keys are unguessable per
 * upload, which is why a pollable name is needed at all and equally why the
 * manifest JSON must not be copied here: the device fetches it by url and checks
 * it against sha256, so a second copy would be one edit from disagreeing with
 * the artifact being verified.
 *
 * Ownership is ALWAYS server-side: `userId` comes from the session for POST/GET
 * and from the device token's stored hash for PUT. Neither caller can name an
 * account, so no device can be pointed at another owner's build.
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

// 10s bound on every worker round-trip, as on the sibling device routes. PUT is
// a polling surface — an opted-in board asks on a slow cadence forever — so a
// connect-but-never-respond worker would otherwise pin each invocation to CF
// wall-clock.
const T = () => ({ signal: AbortSignal.timeout(10_000) })

// Carry the worker's HTTP ok/status alongside the parsed body, the same reason
// /api/devices does: a non-2xx with a non-JSON body (522 blip, 500 mid-redeploy,
// an HTML error page) parses to {} with no `error` key, and a caller reading only
// `data.error` would see a clean success. Here that success would be `bundle:
// null` — "you are up to date" — so an outage would silently stop OTA for the
// fleet and nothing would ever report it.
async function relay(p: Promise<Response>): Promise<{ data: any; ok: boolean; status: number; transient: boolean }> {
  try {
    const res = await p
    return { data: await res.json().catch(() => ({})), ok: res.ok, status: res.status, transient: false }
  } catch (e: any) {
    return { data: { error: String(e?.message || e) }, ok: false, status: 0, transient: true }
  }
}

/** Session → point one of MY channels at a published bundle */
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { channel, version, url, sha256, force } = await req.json().catch(() => ({} as any))
  if (!channel || !version || !url || !sha256) {
    return json({ ok: false, error: 'channel, version, url and sha256 required' }, 400)
  }

  const { data, ok, status, transient } = await relay(fetch(`${WORKER_URL}/firmware/publish`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      userId: session.sub,
      channel: String(channel), version: String(version),
      url: String(url), sha256: String(sha256),
      // Forwarded explicitly (the lanUrl rule): omitted unless truthy so the
      // worker's downgrade refusal stays the default posture.
      ...(force ? { force: '1' } : {}),  // string, not boolean: worker schema is Str
    }),
    ...T(),
  }))

  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  // A 400 from the worker is a DECISION about the pointer — a non-https url, a
  // host the firmware won't take code from, a sha that isn't 64 hex. Whoever ran
  // publish_ota.py can fix every one of those, so pass the sentence and the code
  // through rather than flattening them into a retryable 503.
  if (status === 400) return json({ ok: false, error: data.error || 'bad bundle' }, 400)
  // 409 is also a DECISION, not weather: the channel refuses to move backwards
  // (downgrade guard). publish_ota.py resolves it with force:true — pass the
  // sentence through so the operator reads WHY, not a flattened 503.
  if (status === 409) return json({ ok: false, error: data.error || 'downgrade refused' }, 409)
  if (!ok || data.error) {
    return json({ ok: false, error: data.error || `worker ${status}`, retryable: true }, 503)
  }
  return json({ ok: true, channel: data.channel, version: data.version })
}

/** Session → what is this channel currently pointing at? */
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const channel = new URL(req.url).searchParams.get('channel')
  if (!channel) return json({ ok: false, error: 'channel required' }, 400)

  const { data, ok, status, transient } = await relay(fetch(
    `${WORKER_URL}/firmware/current?userId=${encodeURIComponent(session.sub)}` +
      `&channel=${encodeURIComponent(channel)}`,
    { headers: internalHeaders(), cache: 'no-store', ...T() }
  ))

  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  if (!ok || data.error) {
    return json({ ok: false, error: data.error || `worker ${status}`, retryable: true }, 503)
  }
  // `null` is a real answer — nothing published on this channel yet.
  return json({ ok: true, bundle: data.bundle ?? null })
}

/** Device → ask my own channel what to run (token auth, no session) */
export async function PUT(req: Request) {
  const { deviceId, token, channel } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !channel) {
    return json({ ok: false, error: 'deviceId, token and channel required' }, 400)
  }

  const { data, ok, status, transient } = await relay(fetch(`${WORKER_URL}/firmware/device-current`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      deviceId: String(deviceId), token: String(token), channel: String(channel),
    }),
    ...T(),
  }))

  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  // A revoked device must see 401 and stop asking, not a code that reads as "the
  // registry had a bad day" and loops on a battery forever.
  if (status === 401 || data.error === 'unauthorized') {
    return json({ ok: false, error: data.error || 'unauthorized' }, 401)
  }
  if (!ok || data.error) {
    return json({ ok: false, error: data.error || `worker ${status}`, retryable: true }, 503)
  }
  return json({ ok: true, bundle: data.bundle ?? null })
}
