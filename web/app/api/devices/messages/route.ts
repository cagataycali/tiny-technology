/**
 * /api/devices/messages — an enrolled device on the DM rail.
 *
 * The reTerminal Sticky's messages app: compose on the e-ink keyboard →
 * POST here with its own `tind_` token → the worker resolves the OWNER from
 * (deviceId, token_hash) and dispatches to the same DM handlers every other
 * client uses (docs/research/MESSAGES_TRANSPORT.md in sticky-the-reterminal).
 *
 * NO session, same as /api/devices/ask and /transcript: the caller is a wall
 * display with nobody logged in. A spoofed userId in the body is meaningless —
 * it is never read, let alone forwarded; identity comes from the token hash.
 *
 *   POST { deviceId, token, op: "send"|"inbox"|"thread"|"unread",
 *          to?, body?, attachments?, with?, limit? }
 *
 * 10s bound like /api/messages (this is the badge/inbox path, not an agent
 * turn); 503 on worker failure, never masked-empty — the device keeps its
 * unread state instead of clearing a badge over a blip.
 */
export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({} as any))
  const { deviceId, token, op } = payload
  if (!deviceId || !token || !op) {
    return json({ ok: false, error: 'deviceId, token and op required' }, 400)
  }
  try {
    const res = await fetch(`${WORKER_URL}/device/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return json({ ok: false, error: 'messages unavailable' }, 503)
  }
}
