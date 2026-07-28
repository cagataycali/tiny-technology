/**
 * POST /api/run-tool — validate/execute user-forged tools (issue #8).
 *
 * MUST be Node.js runtime: Vercel's Edge runtime forbids `new Function`
 * ("Code generation from strings disallowed"), which broke create_tool in
 * production. The edge chat route calls this internally.
 *
 *   { action: 'validate', code }        → { ok } | { ok:false, error }
 *   { action: 'run', code, args }       → { ok, result } | { ok:false, error }
 */
import { validateToolCode, runUserTool } from '@/lib/user-tools'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  const key = req.headers.get('x-internal-key') || ''
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 })
  }

  const { action, code, args } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return new Response(JSON.stringify({ ok: false, error: 'code required' }), { status: 400 })
  }

  try {
    if (action === 'validate') {
      const check = validateToolCode(code)
      return new Response(JSON.stringify(check), { headers: { 'Content-Type': 'application/json' } })
    }
    if (action === 'run') {
      const check = validateToolCode(code)
      if (!check.ok) return new Response(JSON.stringify(check), { headers: { 'Content-Type': 'application/json' } })
      const result = await runUserTool(code, args || {})
      return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), { status: 400 })
  } catch (error: any) {
    return new Response(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 300) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
