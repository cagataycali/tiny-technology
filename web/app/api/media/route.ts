/**
 * /api/media — upload proxy for device-generated media
 * (on-device genAI tools: generate_image now, speak audio next).
 *
 *   POST { data(base64), contentType }                    → { key, url }  (session)
 *   POST { data, contentType, deviceId, token }            → { key, url }  (device)
 *
 * The worker stores bytes in R2 under an unguessable UUID key and serves
 * them publicly at /media/:key — histories and tool results carry URLs,
 * never base64, so every client (web/iOS/Android/Telegram) renders the
 * same generated media.
 *
 * Ownership is ALWAYS server-side, never asserted by the caller: from the
 * session for a client (Bearer or cookie — same getSession the chat route
 * uses), or from the device token's stored hash for a device. So neither can
 * attribute media to another account.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { data, contentType, deviceId, token } = await req.json().catch(() => ({} as any))

  // A device uploads on its own token, with NO session: the necklace can't hold
  // the account bearer JWT, because a wearable's flash is readable by whoever
  // picks it up. The worker resolves the owner from (deviceId, token_hash) and
  // ignores anything the caller claims, so this proxy just forwards the pair —
  // it never stamps a userId for a device, and a bad token 401s there.
  const asDevice = !!(deviceId && token)
  const session = asDevice ? null : await getSession(req)
  if (!asDevice && !session) return json({ ok: false, error: 'login required' }, 401)

  if (!data || !contentType) return json({ ok: false, error: 'data and contentType required' }, 400)

  const res = await fetch(`${WORKER_URL}/media/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      ...(asDevice
        ? { deviceId: String(deviceId), token: String(token) }
        : { userId: session!.sub }),
      data: String(data),
      contentType: String(contentType),
    }),
    // Uploads carry megabytes — give the worker more room than the 10s
    // polling routes, but still bounded (edge wall-clock is finite).
    signal: AbortSignal.timeout(30_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  // "unknown device" is an AUTH failure like "unauthorized" — a device whose
  // token was revoked must see 401 and stop retrying, not a 424 that reads as
  // "registry had a bad day, try again" and loops forever.
  if (res.error) {
    const auth = res.error === 'unauthorized' || res.error === 'unknown device'
    return json({ ok: false, error: res.error }, auth ? 401 : 424)
  }
  return json({ ok: true, key: res.key, url: res.url, bytes: res.bytes })
}
