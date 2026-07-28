/**
 * /api/prefs — session-scoped user preferences (worker user_prefs D1).
 *
 *   GET  ?key=theme        → { ok, value }   (null if unset)
 *   POST { key, value }    → { ok }          (empty value clears)
 *
 * Key allowlist keeps this from becoming a general KV dump — add keys
 * as features grow (theme was first; disabled_tools lives agent-side).
 */
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const ALLOWED_KEYS = new Set(['theme', 'custom_css', 'custom_js'])

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const internalHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const key = new URL(req.url).searchParams.get('key') || ''
  if (!ALLOWED_KEYS.has(key)) return json({ ok: false, error: 'unknown key' }, 400)

  const data = await fetch(
    `${WORKER_URL}/prefs?userId=${encodeURIComponent(session.sub)}&key=${encodeURIComponent(key)}`,
    { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, value: data.value ?? null })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { key, value } = await req.json().catch(() => ({} as any))
  if (!ALLOWED_KEYS.has(String(key))) return json({ ok: false, error: 'unknown key' }, 400)

  const data = await fetch(`${WORKER_URL}/prefs`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ userId: session.sub, key: String(key), value: String(value ?? '') }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true })
}
