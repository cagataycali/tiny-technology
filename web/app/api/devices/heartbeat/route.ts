/**
 * /api/devices/heartbeat — device presence (tiny-node PR2).
 *
 * NO session: daemons/CLIs authenticate with their device token, which the
 * worker verifies against its stored hash. Deliberately NOT behind the
 * 50/day IP limiter — a daemon heartbeats continuously; the token check
 * is the gate, and a wrong token 401s without revealing whether the
 * device id exists.
 *
 * ⚠️ This route is the ONLY path a board's heartbeat takes, so a field it does
 * not destructure does not exist as far as the registry is concerned. `lanUrl`
 * was that field: the firmware sent it on every beat (tiny_node.py run loop),
 * the worker accepted and validated it (DeviceHeartbeatCall), both ends had
 * tests — and all 37 device rows held lan_url='' because this hop dropped it.
 * That is the reported symptom, "says connecting through the cloud but i'm at
 * the same wifi": with no stored address the app has nothing to dial directly.
 * Add nothing to the firmware or the worker without adding it HERE too.
 */
export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, capabilities, lanUrl } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token) return json({ ok: false, error: 'deviceId and token required' }, 400)

  // 10s bound — a daemon heartbeats continuously, so a connect-but-never-
  // respond worker would pin every POST to CF wall-clock. AbortError falls
  // into the existing .catch(()=>null) → 424 "registry unreachable".
  const res = await fetch(`${WORKER_URL}/device/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      ...(capabilities != null ? { capabilities: JSON.stringify(Array.isArray(capabilities) ? capabilities : []) } : {}),
      // Forwarded, not validated: validateLanUrl in the worker is the only
      // guard, and duplicating it here would give the feature two definitions of
      // "private" to disagree about. Omitted when absent so the worker's
      // COALESCE keeps the stored address — a proxy that sent '' on every beat
      // would erase it 2880 times a day.
      ...(lanUrl != null && String(lanUrl).trim() !== '' ? { lanUrl: String(lanUrl) } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) return json({ ok: false, error: data.error || 'heartbeat failed' }, res.status === 401 ? 401 : 424)
  return json({ ok: true })
}
