/**
 * /api/devices/endpoint — session-gated proxy for calling an ENDPOINT device
 * (a robot/printer that lives at its own authenticated HTTPS API).
 *
 *   GET ?deviceId=&action=telemetry  → { ok, result }        (JSON)
 *   GET ?deviceId=&action=snapshot   → image/jpeg bytes      (camera frame)
 *
 * Why GET for both: these are reads, and the snapshot has to be usable as an
 * `<img src>` — which can only issue a GET. The device's bearer credential never
 * comes near this route; the worker holds it and makes the outbound call, so the
 * most a bug here can expose is the robot's own answer.
 *
 * `action` is NOT free-form: it's checked against the same allowlist the worker
 * enforces. The worker is the real gate (it maps action → path), but refusing
 * early keeps a typo'd action from spending a worker round-trip.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Read actions this proxy will forward, and how long each may take.
 *
 * Deliberately excludes `chat`: that's a 90s agent turn belonging to the
 * use_device tool path, and it is a POST-shaped action. A read proxy that could
 * be talked into it would give any page a minute-long worker hold from a GET.
 */
const ACTIONS: Record<string, { image?: boolean; ms: number }> = {
  // Bounded JSON read of already-collected MQTT state.
  telemetry: { ms: 25_000 },
  // A single already-decoded camera frame. Tight, because it is POLLED: a slow
  // frame should lose its turn, not delay the ticks queued behind it. Sits above
  // the worker's own 10s image budget so the worker's typed error wins the race.
  snapshot: { image: true, ms: 15_000 },
}

// The types the worker pins a snapshot to. Re-asserted here for the same reason
// the worker pins it: these bytes are served from OUR origin, so an unexpected
// type reaching a browser as a document is a same-origin script execution. The
// worker already refuses anything else; this is the second lock on the same door,
// because a future worker change must not silently make this route a sink.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const url = new URL(req.url)
  const deviceId = url.searchParams.get('deviceId') || ''
  const action = url.searchParams.get('action') || 'telemetry'
  if (!deviceId) return json({ ok: false, error: 'deviceId required' }, 400)

  const spec = ACTIONS[action]
  if (!spec) {
    return json({ ok: false, error: `unsupported action — use ${Object.keys(ACTIONS).join(' | ')}` }, 400)
  }

  let res: Response
  try {
    res = await fetch(`${WORKER_URL}/device/endpoint/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      // userId comes from the SESSION, never the query: the worker scopes the
      // device lookup by owner, so this is what stops one user reading another's
      // camera by guessing a device id.
      body: JSON.stringify({ userId: session.sub, deviceId, action }),
      cache: 'no-store',
      signal: AbortSignal.timeout(spec.ms),
    })
  } catch (e: any) {
    // Reaching the WORKER failed — distinct from the worker reporting that the
    // DEVICE is unreachable, which arrives as a normal response below.
    return json({ ok: false, error: 'Could not reach the device registry.', retryable: true }, 503)
  }

  if (spec.image) {
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    // The worker answers a failure as JSON even for an image action, so a
    // non-image type here is an error body, not a frame — pass it through as
    // JSON rather than letting an `<img>` render "unknown device" as bytes.
    if (!res.ok || !IMAGE_TYPES.includes(type)) {
      const body = await res.json().catch(() => ({ error: 'camera unavailable' }))
      return json({ ok: false, ...body }, res.status === 200 ? 502 : res.status)
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': type,
        // Never cache a frame: a cached chamber view is a lie about now, and it
        // would make the page's poll interval meaningless.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // These bytes came from a machine we don't control. Even pinned to an
        // image type, deny it any capability if a browser ever treats it as a
        // document.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    // Preserve the worker's own typed distinctions (unreachable / timeout /
    // unauthorized): the page says something different for each, and collapsing
    // them to one error is how a busy printer gets reported as unplugged.
    return json({
      ok: false,
      error: data.error || `worker ${res.status}`,
      unreachable: data.unreachable,
      timeout: data.timeout,
      unauthorized: data.unauthorized,
    }, res.status === 200 ? 502 : res.status)
  }
  return json({ ok: true, result: data.result })
}
