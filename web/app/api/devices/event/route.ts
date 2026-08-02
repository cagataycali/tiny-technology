/**
 * /api/devices/event — a device pushes something it NOTICED onto its owner's
 * event ring.
 *
 * The rest of the device API is pull: the relay hands a device work and waits.
 * That fits "take a photo"; it does not fit a Nicla Voice wake word, which
 * fires when it fires and which nothing asked for. This is the push half.
 *
 * NO session, same as /api/devices/heartbeat: the caller is the device (or, for
 * the Nicla Voice, whichever phone is gatewaying it over BLE — the board has no
 * WiFi), and there may be nobody logged in on screen. The device token both
 * authenticates and resolves the owner, so a device can only write to its own
 * user's ring. Deliberately off the 50/day IP limiter for the same reason as
 * heartbeat — a wearable's events are not a per-IP quota — but the worker
 * allowlists `kind`, so this is not a free-text write into agent ground truth.
 */
export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, kind, detail } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !kind) {
    return json({ ok: false, error: 'deviceId, token and kind required' }, 400)
  }

  // 10s bound, matching heartbeat/relay: a hung worker would otherwise pin this
  // invocation to CF wall-clock, and a gateway phone posts one of these per wake.
  const res = await fetch(`${WORKER_URL}/device/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      kind: String(kind),
      detail: String(detail ?? '').slice(0, 300),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    return json({ ok: false, error: data.error || 'event failed' }, res.status === 401 ? 401 : 424)
  }
  return json({ ok: true })
}
