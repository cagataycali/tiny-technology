/**
 * POST /api/tools/run — execute one of the user's forged tools.
 *
 * Body: { name, args? } → { ok, result } | { ok: false, error }
 *
 * Session-gated version of what the chat agent does with my_* tools:
 * fetch the caller's tool code from the worker, run it in the Node
 * sandbox (/api/run-tool, internal-key gated). Lets the npx tiny-tech
 * MCP server expose forged tools to external agents.
 */
import { kv } from '@vercel/kv'
import { Ratelimit } from '@upstash/ratelimit'
import { getSession } from '@/lib/auth'

export const runtime = 'edge'
export const maxDuration = 60

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  // Per-USER rate limit — this is the one session-gated route that runs
  // user-forged code in the Node sandbox (each call up to 25s of compute via
  // /api/run-tool), and it's MCP-exposed (a leaked CLI token could hammer it).
  // Every other expensive route is throttled; keyed on session.sub (not IP)
  // since it's authenticated. Generous for real MCP use, bounds abuse.
  if (process.env.NODE_ENV !== 'development' && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const ratelimit = new Ratelimit({ redis: kv, limiter: Ratelimit.slidingWindow(200, '1 d') })
      const { success } = await ratelimit.limit(`tools_run_${session.sub}`)
      if (!success) return json({ ok: false, error: 'Tool-run limit reached for today.' }, 429)
    } catch (e) {
      console.warn('tools/run ratelimit unavailable, failing open:', e)
    }
  }

  const { name, args } = await req.json().catch(() => ({} as any))
  if (!name || typeof name !== 'string') return json({ ok: false, error: 'name required' }, 400)
  const toolName = name.replace(/^my_/, '')

  // Fetch the caller's own toolbox — running someone else's tool by name
  // is impossible since lookup is scoped to session.sub
  const data = await fetch(`${WORKER_URL}/tools?userId=${encodeURIComponent(session.sub)}`, {
    headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
  if (data.error) return json({ ok: false, error: data.error }, 424)

  const row = (data.tools || []).find((t: any) => t.name === toolName)
  if (!row) return json({ ok: false, error: `tool '${toolName}' not found — create it first` }, 404)

  // Same internal sandbox hop the chat route uses (Edge can't new Function)
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://tiny.technology'
  const result = await fetch(`${base}/api/run-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({ action: 'run', code: row.code, args: args || {} }),
    signal: AbortSignal.timeout(25_000),
  }).then(r => r.json()).catch(e => ({ ok: false, error: String(e?.message || e) }))

  return json(result, result?.ok === false ? 422 : 200)
}
