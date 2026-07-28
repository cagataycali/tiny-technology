/**
 * /api/devices — session-gated device registry proxy (tiny-node PR2).
 *
 *   GET     → { ok, devices: [{ id, name, kind, online, last_seen, ... }] }
 *   POST    { name, platform?, kind?, capabilities? }
 *           → { ok, device_id, device_token }   (token returned ONCE)
 *   DELETE  { deviceId } → { ok }               (revoke — instant kill)
 *
 * The user's session is the enrollment authority; the worker mints and
 * stores only the token's hash. Heartbeats live at /api/devices/heartbeat
 * (device-token auth, no session).
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

// 10s bound on every worker round-trip — none of these fetches had a timeout,
// so a connect-but-never-respond worker held the edge invocation open to CF
// wall-clock (this is the device-registry/heartbeat path, polled every 30s by
// the /devices page). `transient` marks the fetch-threw case (timeout/network)
// so the caller can tell it apart from a worker-returned error body.
const T = () => ({ signal: AbortSignal.timeout(10_000) })
// Carry the worker's HTTP ok/status alongside the parsed body. Without them a
// non-2xx response with a non-JSON body (522 edge blip, 500 mid-redeploy, an
// HTML error page) parses via .json().catch(()=>({})) to {} — no `error` key —
// and every caller below would read a clean success. The sibling
// heartbeat/route.ts gates on `!res.ok`; these handlers must too, or an outage
// masquerades as a legitimate empty/OK result. `transient` marks the
// fetch-threw case (timeout/network) so GET can tell it apart from a
// worker-returned status.
async function relay(p: Promise<Response>): Promise<{ data: any; ok: boolean; status: number; transient: boolean }> {
  try {
    const res = await p
    return { data: await res.json().catch(() => ({})), ok: res.ok, status: res.status, transient: false }
  } catch (e: any) {
    return { data: { error: String(e?.message || e) }, ok: false, status: 0, transient: true }
  }
}

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { data, ok, status, transient } = await relay(fetch(
    `${WORKER_URL}/device/list?userId=${encodeURIComponent(session.sub)}`,
    { headers: internalHeaders(), cache: 'no-store', ...T() }
  ))

  // A transient reach failure must NOT masquerade as 424 "registry not deployed"
  // — the page maps 424 to a permanent "tiny-node is rolling out" dead-end with
  // no recovery, so a worker blip would falsely tell the user the feature is
  // absent. 503 routes to the page's Retry state instead.
  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  // The worker was reached but answered non-2xx. Only a genuine 404 means the
  // route isn't deployed (→ 424 permanent). Every other failure — 5xx internal
  // error, 522 edge blip, HTML error page (parsed to {} with no `error`) — is
  // reachable-but-degraded, so route it to the retryable 503. Without this gate
  // a non-JSON 5xx body fell through to a masked-empty 200 {devices:[]}, making
  // an outage indistinguishable from a user whose devices were all deleted.
  if (!ok) {
    if (status === 404) return json({ ok: false, error: 'registry not deployed' }, 424)
    return json({ ok: false, error: data.error || `worker ${status}`, retryable: true }, 503)
  }
  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, devices: data.devices || [] })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { name, platform, kind, capabilities, url, secret } = await req.json().catch(() => ({} as any))
  if (!String(name || '').trim()) return json({ ok: false, error: 'name required' }, 400)

  // 🤖 An endpoint device (a robot/printer at its own authenticated HTTPS API)
  // carries url+secret instead of being issued a token. The worker validates
  // the URL and stores the secret; nothing here logs or echoes it.
  const isEndpoint = String(kind) === 'endpoint'

  const { data, ok, transient } = await relay(fetch(`${WORKER_URL}/device/enroll`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      userId: session.sub,
      name: String(name),
      platform: String(platform || ''),
      kind: isEndpoint ? 'endpoint' : String(kind || 'cli'),
      // Worker sanitizes shape/size; send as JSON string (itty body rule)
      capabilities: JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
      ...(isEndpoint ? { url: String(url || ''), secret: String(secret || '') } : {}),
    }),
    ...T(),
  }))

  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  // A non-2xx worker response with no parseable `error` must not report
  // success: {ok:true} with an undefined device_token would tell the page a
  // device was enrolled when the worker minted nothing.
  if (!ok || data.error) return json({ ok: false, error: data.error || 'enroll failed' }, 424)
  // An endpoint enroll legitimately has no device_token — don't invent one.
  if (isEndpoint) return json({ ok: true, device_id: data.device_id, kind: 'endpoint', url: data.url })
  return json({ ok: true, device_id: data.device_id, device_token: data.device_token })
}

export async function DELETE(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { deviceId } = await req.json().catch(() => ({} as any))
  if (!deviceId) return json({ ok: false, error: 'deviceId required' }, 400)

  const { data, ok, transient } = await relay(fetch(`${WORKER_URL}/device`, {
    method: 'DELETE',
    headers: internalHeaders(),
    body: JSON.stringify({ userId: session.sub, deviceId: String(deviceId) }),
    ...T(),
  }))

  if (transient) return json({ ok: false, error: data.error, retryable: true }, 503)
  // A non-2xx worker response with no parseable `error` must not report a
  // successful revoke: the page optimistically drops the row on {ok:true}, so a
  // false success would hide a still-live device token from the user.
  if (!ok || data.error) return json({ ok: false, error: data.error || 'revoke failed' }, 424)
  return json({ ok: true, revoked: data.revoked })
}
