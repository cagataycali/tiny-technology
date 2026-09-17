/**
 * POST /api/devices/endpoint/chat — session-gated ONE agent turn on an ENDPOINT
 * device (a robot/printer/arm at its own authenticated HTTPS API).
 *
 *   POST { deviceId, prompt }  →  { ok, result }   |   { ok:false, error, unreachable|timeout|unauthorized }
 *
 * Why this exists next to ../route.ts: that file is the READ proxy (telemetry,
 * snapshot) and runs on Edge, which 504s any response whose first byte takes
 * >25s. A chat turn on a robot is a full agent run — the worker allows it 90s —
 * so it needs the Node runtime, and a route file has exactly one runtime.
 *
 * Who calls it: `npx tiny-tech`'s local use_device tool. Its only other path
 * was the relay mailbox, and an endpoint device never polls a mailbox — the
 * envelope sat unclaimed for an hour and the tool reported "still working". The
 * web chat's use_device (lib/chat/tools/platform.ts) already dialed the worker
 * directly with the internal key; a laptop has no such key, so this is the
 * session-authenticated door to the same worker call.
 *
 * The device's bearer never comes near here — the worker holds it. userId comes
 * from the SESSION, never the body: the worker scopes the lookup by owner.
 */
import { getSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const maxDuration = 120

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
/** Strictly above the worker's 90s device budget, so ITS typed {timeout:true}
 *  answer wins the race and "still thinking" stays distinct from "unreachable". */
const CHAT_MS = 100_000

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const body = await req.json().catch(() => ({} as any))
  const deviceId = String(body?.deviceId || '')
  const prompt = String(body?.prompt || '').trim()
  if (!deviceId || !prompt) return json({ ok: false, error: 'deviceId and prompt required' }, 400)

  let res: Response
  try {
    res = await fetch(`${WORKER_URL}/device/endpoint/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ userId: session.sub, deviceId, action: 'chat', prompt }),
      cache: 'no-store',
      signal: AbortSignal.timeout(CHAT_MS),
    })
  } catch (e: any) {
    const timeout = /abort|timeout/i.test(String(e?.message || e))
    return json(
      timeout
        ? { ok: false, error: 'The device is still working on it.', timeout: true }
        : { ok: false, error: 'Could not reach the device registry.', retryable: true },
      timeout ? 504 : 503,
    )
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    return json({
      ok: false,
      error: data.error || `worker ${res.status}`,
      unreachable: data.unreachable,
      timeout: data.timeout,
      unauthorized: data.unauthorized,
    }, res.status === 200 ? 502 : res.status)
  }
  // Dashboards answer {reply|result|text}; hand back what it said as a string.
  const r = data.result
  const said = typeof r === 'string' ? r : (r?.reply ?? r?.result ?? r?.text ?? r)
  return json({ ok: true, result: said })
}
