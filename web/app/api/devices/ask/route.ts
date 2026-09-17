/**
 * /api/devices/ask — a device asks its owner's tiny and renders the answer.
 *
 * The reTerminal Sticky flow: hold the AI button, speak (or type via the
 * paired surface) → the device uploads audio via /api/media (or sends text
 * directly) → POSTs here → the worker authenticates the device token,
 * transcribes if needed, runs an owner-scoped agent turn (the scheduled-job
 * pipeline), and returns { text, card? } — prose for the wall plus an
 * optional card-spec the e-ink renders natively.
 *
 * NO session, same as /api/devices/transcript: the caller is an enrolled
 * device with nobody logged in. The device token both authenticates and
 * resolves the owner in the worker (DEVICE_EVENT_AUTH_SQL), so a spoofed
 * userId in the body is meaningless — it is never forwarded. Deliberately
 * off the 50/day IP limiter like heartbeat/event/transcript: a wall
 * display's questions are not a per-IP quota.
 *
 * ONE deliberate deviation from the transcript route's 10s bound: the body
 * of this call is a full agent turn (job-run holds the model for up to 50s,
 * the worker waits 60s — scheduler.ts), so the proxy waits 75s. A 10s bound
 * here would kill every real answer mid-flight.
 */
// Node runtime, same reason as job-run: this proxy holds a NON-streaming
// response for up to 75s, and Edge 504s any response whose first byte takes
// >25s. Edge here meant every slow (tool-using) ask died even after the
// downstream budgets were raised.
export const runtime = 'nodejs'
export const maxDuration = 90

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const { deviceId, token, text, audioUrl, stream, tiny } = await req.json().catch(() => ({} as any))
  const q = String(text ?? '').trim()
  const a = String(audioUrl ?? '').trim()
  // Universe switch ("THE UNIVERSE ON THE GLASS"): optional target slug.
  // Forwarded verbatim when present — the worker owns resolution (public /
  // private / unknown / priced) and its refusals carry the sentences.
  // Clamped to the worker's own raw max so an essay never travels.
  const t = String(tiny ?? '').trim().slice(0, 64)
  // The typer opt-in (STREAMING_UI.md): "1" asks the worker for SSE and this
  // proxy PIPES it through untouched. String, the device-API zod idiom.
  const wantStream = String(stream ?? '') === '1'
  if (!deviceId || !token || (!q && !a)) {
    return json({ ok: false, error: 'deviceId, token and text or audioUrl required' }, 400)
  }

  const res = await fetch(`${WORKER_URL}/device/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      deviceId: String(deviceId),
      token: String(token),
      text: q.slice(0, 4000),
      // Passed through UNsliced (the transcript route's lesson): the worker
      // refuses a bad/oversized URL with a 400; a URL truncated here would
      // pass that check while pointing at nothing.
      audioUrl: a,
      ...(t ? { tiny: t } : {}),
      ...(wantStream ? { stream: '1' } : {}),
    }),
    signal: AbortSignal.timeout(75_000),
  }).catch(() => null)

  if (!res) return json({ ok: false, error: 'registry unreachable' }, 424)

  // SSE passthrough: the worker answered event-stream — hand the body over
  // byte-for-byte, don't await json() (that would buffer the whole typer).
  // The worker may also DECLINE to stream (an older worker build): the
  // Content-Type check, not the request flag, decides which arm runs, so a
  // mixed deploy degrades to the classic JSON reply instead of breaking.
  if (wantStream && res.ok &&
      (res.headers.get('content-type') || '').includes('text/event-stream')) {
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
  const data = await res.json().catch(() => ({} as any))
  if (!res.ok || data.error) {
    // 401 passes through (revoked device → the firmware reopens its portal);
    // 422 passes through (bad audio — retriable with a new recording);
    // 404/402/400 pass through (universe refusals: unknown-or-private slug,
    // priced tiny, oversize slug — the sentence must arrive with its honest
    // status, not a generic 424); everything else collapses to 424 like the
    // sibling device routes.
    const passthrough = [400, 401, 402, 404, 422]
    const status = passthrough.includes(res.status) ? res.status : 424
    return json({ ok: false, error: data.error || 'ask failed' }, status)
  }
  return json({ ok: true, text: data.text, ...(data.card ? { card: data.card } : {}) })
}
