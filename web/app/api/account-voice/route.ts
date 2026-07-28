/**
 * /api/account-voice — session-scoped, cross-device default live-call voice.
 *
 *   GET              → { ok, voice }   ('' = unset → calls fall back to marin)
 *   POST { voice }   → { ok, voice }   ('' clears)
 *
 * The account voice is the fallback for tinys that don't set their own per-tiny
 * voice (resolution: per-tiny voice → this account voice → 'marin', applied in
 * app/api/voice/session). Non-secret, so this bridge passes it straight through
 * to the worker (internal-key channel), unlike model-config's api key.
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

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const data = await fetch(
    `${WORKER_URL}/account-voice?userId=${encodeURIComponent(session.sub)}`,
    { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, voice: String(data.voice || '') })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const body = await req.json().catch(() => null)
  // An ABSENT `voice` is not an empty one. `String(undefined ?? '')` is '', and
  // '' is an explicit CLEAR downstream — so a truncated/malformed body used to
  // erase a default the user had set, with a 200 in reply. Require the field.
  if (!body || typeof body !== 'object' || typeof (body as any).voice !== 'string') {
    return json({ ok: false, error: "voice required (send '' to clear)" }, 400)
  }
  const voice = (body as any).voice as string

  const res = await fetch(`${WORKER_URL}/account-voice`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ userId: session.sub, voice }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  const data = res
    ? await res.json().catch(() => ({ error: 'bad worker response' }))
    : { error: 'account-voice upstream unreachable' }

  // A rejected voice is the CALLER's error, not a failed dependency — 424 would
  // send a client retrying a value that can never work.
  if (data.error) return json({ ok: false, error: data.error }, res?.status === 400 ? 400 : 424)
  return json({ ok: true, voice: String(data.voice || '') })
}
