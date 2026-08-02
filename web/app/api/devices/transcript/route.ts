/**
 * /api/devices/transcript — the paired phone POSTs the transcript it produced.
 *
 * The Nicla Voice recorder flow: a `record` relay envelope (or a wake) makes
 * the phone record N seconds, transcribe ON-DEVICE, upload the audio via
 * /api/media — and then store the words here. The transcript outlives the
 * relay envelope (which sweeps in ~1h), so a recording the agent never waited
 * out is still readable later via nicla_voice_transcripts.
 *
 * NO session, same as /api/devices/event: the caller is the enrolled phone,
 * which may have nobody logged in on screen. The device token both
 * authenticates and resolves the owner in the worker (DEVICE_EVENT_AUTH_SQL),
 * so a spoofed userId in the body is meaningless — it is never forwarded.
 * Deliberately off the 50/day IP limiter for the same reason as heartbeat and
 * event: a wearable's output is not a per-IP quota. The worker clamps and
 * validates every field, so this is not a free write into agent ground truth.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, text, label, audioUrl, durationS } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !String(text ?? '').trim()) {
    return json({ ok: false, error: 'deviceId, token and text required' }, 400)
  }

  // 10s bound, matching event/heartbeat/relay: a hung worker would otherwise
  // pin this invocation to CF wall-clock. The body is a transcript, not audio
  // — the bytes went to /api/media; 16KB of text clears in well under 10s.
  const res = await fetch(`${WORKER_URL}/transcript`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      text: String(text).slice(0, 16 * 1024),
      label: String(label ?? '').slice(0, 80),
      // Passed through UNsliced: the worker refuses a bad/oversized URL with a
      // 400, and a URL truncated here would pass that check while pointing at
      // nothing — a silently broken player on every surface that lists it.
      audioUrl: String(audioUrl ?? ''),
      durationS: Math.max(0, Math.floor(Number(durationS) || 0)),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    return json({ ok: false, error: data.error || 'transcript failed' }, res.status === 401 ? 401 : 424)
  }
  // The id goes back to the phone: its relay reply carries {transcriptId} so
  // the waiting tool can hand the agent something fetchable, not just a preview.
  return json({ ok: true, id: data.id })
}

/**
 * GET /api/devices/transcript — read them back. Session-authed, unlike the POST.
 *
 * The POST above is the phone writing as a DEVICE (token in body, no session).
 * Reading is the opposite situation: it's a signed-in human asking for their own
 * transcripts, so it authenticates like /api/events and the userId is taken from
 * the session — never from the query, which would make this an open read of
 * anyone's recordings.
 *
 * Without this the phone was write-only: NiclaRecorder POSTed every take and
 * then listed from its LOCAL index, capped at 50 with the audio in Documents.
 * So the server was described as "the durable copy" while nothing could read it
 * back — a reinstall, a new phone, or the 51st recording silently lost
 * transcripts the server still had. `?id=` returns one in full; no id returns
 * the newest previews.
 */
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const q = new URL(req.url).searchParams
  const id = (q.get('id') || '').trim()
  // Clamp before forwarding (the /api/events lesson): `Number(x) || 0` lets
  // floats, negatives and Infinity through to the worker's D1 LIMIT.
  const nRaw = Math.floor(Number(q.get('limit')))
  const limit = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(nRaw, 50) : 20

  const url = id
    ? `${WORKER_URL}/transcript?userId=${encodeURIComponent(session.sub)}&id=${encodeURIComponent(id)}`
    : `${WORKER_URL}/transcript/list?userId=${encodeURIComponent(session.sub)}&limit=${limit}`

  const res = await fetch(url, {
    headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)

  // Distinguish "worker is down" from "no recordings yet": collapsing a 5xx into
  // an empty list makes an outage read as "you have never recorded anything".
  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)
  const data = await res.json().catch(() => ({} as any))
  if (!res.ok || data.error) {
    return json({ ok: false, error: data.error || 'transcripts unavailable' },
      res.status === 404 ? 404 : 424)
  }
  return id
    ? json({ ok: true, transcript: data.transcript })
    : json({ ok: true, transcripts: data.transcripts || [] })
}
