/**
 * /api/devices/adopt — take over a device you already own from a new client.
 *
 *   POST { deviceId } → { ok, device_id, device_token }   (token returned ONCE)
 *
 * Why this exists: enroll (POST /api/devices) hands back the plaintext token
 * exactly once and the worker stores only its SHA-256. So a client that owns a
 * device but has no token — a phone looking at hardware that was paired from a
 * laptop, or a reinstall that lost its Keychain — had one option: enroll the
 * hardware AGAIN. That mints a SECOND row, and the first one never goes offline
 * gracefully; it sits in the fleet forever with a frozen last_seen. That is
 * exactly how the Nicla Voice became unreachable from the iPhone: the phone had
 * the session, could list the row, could even scan the board's BLE beacon, and
 * still could not speak for it.
 *
 * Rotating instead keeps the row, its id, its event history and its transcripts,
 * and issues a token to whoever asked. The OLD token stops working immediately
 * — that is the point, not a side effect: for a BLE peripheral that accepts one
 * central, two clients holding credentials for one device row would fight over
 * a single connection slot. Adoption is a handover, so the loser must be told
 * (its next heartbeat fails) rather than left half-connected.
 *
 * Session-gated, and the worker re-checks ownership against (id, user_id) — this
 * proxy never forwards a caller-supplied userId, so a known device id is not
 * enough to adopt someone else's hardware.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { deviceId } = await req.json().catch(() => ({} as any))
  if (!deviceId) return json({ ok: false, error: 'deviceId required' }, 400)

  const res = await fetch(`${WORKER_URL}/device/rotate-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({ userId: session.sub, deviceId: String(deviceId) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable', retryable: true }, 503)
  const data = await res.json().catch(() => ({} as any))

  // A 404 from the worker is a real answer — "not yours, revoked, or an endpoint
  // device" — and must reach the client as 404, because the caller's next move
  // (enroll it fresh) differs from what it should do on an outage (retry).
  if (res.status === 404) return json({ ok: false, error: 'device not found' }, 404)
  // Never report success without a token. The client stores whatever comes back
  // in the Keychain and then heartbeats with it; {ok:true} carrying undefined
  // would install a credential that authenticates nothing, and the failure would
  // surface later as an unexplained offline device.
  if (!res.ok || data.error || !data.device_token) {
    return json({ ok: false, error: data.error || 'adopt failed' }, 424)
  }
  return json({ ok: true, device_id: data.device_id, device_token: data.device_token })
}
