/**
 * /api/devices/transcribe — a device turns its own recording into text.
 *
 * Speech-to-text for every device input point, not just the ask: the device
 * uploads audio via /api/media, POSTs the URL here, and gets back the words
 * to drop into whatever field it is editing (a DM reply, the ask composer).
 * No agent turn runs and nothing is sent — the device decides what to do with
 * the text, through the route that field already uses.
 *
 * NO session, same as /api/devices/ask: the caller is an enrolled device with
 * nobody logged in. The worker resolves the owner from the device token and
 * refuses audio that owner did not upload; a spoofed userId in the body is
 * never forwarded. Off the 50/day IP limiter like the sibling device routes.
 *
 * Node runtime + 30s: transcription of a 15 s clip is a few seconds, but the
 * worker reads the audio from R2 and calls the STT model in series, and Edge
 * 504s a response whose first byte takes >25s.
 */
export const runtime = 'nodejs'
export const maxDuration = 35

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, audioUrl } = await req.json().catch(() => ({} as any))
  const a = String(audioUrl ?? '').trim()
  if (!deviceId || !token || !a) {
    return json({ ok: false, error: 'deviceId, token and audioUrl required' }, 400)
  }

  const res = await fetch(`${WORKER_URL}/device/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      // Unsliced, the ask route's lesson: the worker refuses an oversized URL
      // with a 400; one truncated here would point at nothing.
      audioUrl: a,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({} as any))
  if (!res.ok || data.error) {
    // 400 (bad URL), 401 (revoked device), 404 (not this owner's audio) and
    // 422 (nothing transcribed — retriable with a new take) pass through with
    // their sentence; everything else collapses to 424 like the sibling routes.
    const passthrough = [400, 401, 404, 422]
    const status = passthrough.includes(res.status) ? res.status : 424
    return json({ ok: false, error: data.error || 'transcribe failed' }, status)
  }
  return json({ ok: true, text: String(data.text ?? '') })
}
