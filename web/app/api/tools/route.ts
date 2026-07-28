/**
 * /api/tools — the signed-in user's own forged-tool box.
 *
 *   GET    → { ok, tools: [{ name, description, params, code, created }] }
 *   POST   { name, description, params?, code } → forge (sandbox-validated)
 *   DELETE { name } → { ok }
 *
 * Session-scoped proxy over the worker's internal /tools CRUD, so the
 * Control panel and the tiny-tech MCP server can manage my_* tools
 * without going through the chat agent.
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

// 10s bound on the worker /tools round-trips (the sandbox-validate hop already
// has its own 25s). None had a timeout, so a hung worker held the invocation
// to CF wall-clock. AbortError falls into each fetch's existing
// .catch(e => ({error})) → 424, so the degrade contract is unchanged.
const T = () => ({ signal: AbortSignal.timeout(10_000) })

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const data = await fetch(
    `${WORKER_URL}/tools?userId=${encodeURIComponent(session.sub)}`,
    { headers: internalHeaders(), cache: 'no-store', ...T() }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({
    ok: true,
    tools: (data.tools || []).map((t: any) => {
      let params: Record<string, string> = {}
      try { params = JSON.parse(t.params_json || '{}') } catch { }
      return { name: t.name, description: t.description || '', params, code: t.code || '', created: t.created }
    }),
  })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { name, description, params, code } = await req.json().catch(() => ({} as any))
  if (!name || !code) return json({ ok: false, error: 'name and code required' }, 400)
  if (typeof code !== 'string' || code.length > 4096) return json({ ok: false, error: 'code must be ≤4KB' }, 400)

  // Same sandbox validation hop the chat agent's create_tool uses
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://tiny.technology'
  const check = await fetch(`${base}/api/run-tool`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ action: 'validate', code }),
    signal: AbortSignal.timeout(25_000),
  }).then(r => r.json()).catch(e => ({ ok: false, error: String(e?.message || e) }))
  if (!check.ok) return json({ ok: false, error: check.error || 'validation failed' }, 422)

  const data = await fetch(`${WORKER_URL}/tools`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      userId: session.sub,
      name: String(name).replace(/^my_/, ''),
      description: description || '',
      params: JSON.stringify(params || {}),
      code,
    }),
    ...T(),
  }).then(r => r.json().then((j: any) => ({ ...j, _status: r.status }))).catch(e => ({ error: String(e?.message || e) }))

  // Pass the worker's real status through — NEVER 502: Cloudflare replaces
  // 502/503 bodies with its own error page, eating the validation message
  const { _status, ...body } = data
  if (body.error) return json({ ok: false, error: body.error }, _status && _status !== 200 ? _status : 424)
  return json(body)
}

export async function DELETE(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { name } = await req.json().catch(() => ({} as any))
  if (!name) return json({ ok: false, error: 'name required' }, 400)

  const data = await fetch(`${WORKER_URL}/tools`, {
    method: 'DELETE',
    headers: internalHeaders(),
    body: JSON.stringify({ userId: session.sub, name: String(name).replace(/^my_/, '') }),
    ...T(),
  }).then(r => r.json().then((j: any) => ({ ...j, _status: r.status }))).catch(e => ({ error: String(e?.message || e) }))

  // Worker 404 (no such tool) passes through as 404; 424 otherwise (502
  // bodies get replaced by Cloudflare's error page)
  if (data.error) return json({ ok: false, error: data.error }, data._status === 404 ? 404 : 424)
  return json({ ok: true })
}
