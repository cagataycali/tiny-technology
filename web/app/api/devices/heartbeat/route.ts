/**
 * /api/devices/heartbeat — device presence (tiny-node PR2).
 *
 * NO session: daemons/CLIs authenticate with their device token, which the
 * worker verifies against its stored hash. Deliberately NOT behind the
 * 50/day IP limiter — a daemon heartbeats continuously; the token check
 * is the gate, and a wrong token 401s without revealing whether the
 * device id exists.
 */
export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, capabilities } = await req.json().catch(() => ({} as any))
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
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) return json({ ok: false, error: data.error || 'heartbeat failed' }, res.status === 401 ? 401 : 424)
  return json({ ok: true })
}
