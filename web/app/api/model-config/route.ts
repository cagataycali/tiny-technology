/**
 * /api/model-config — session-scoped, cross-device BYO-model settings.
 *
 *   GET                 → { ok, config }  (config null = free default;
 *                          NEVER includes the api key — only hasKey:bool)
 *   POST { config }     → { ok }          (persists to the worker, encrypted;
 *                          omit config.apiKey to keep the stored key, ""=clear)
 *
 * The raw API key is a live provider secret: it flows server→worker on save
 * (encrypted at rest) and is read back ONLY by the server-side chat route over
 * the internal-key channel. This bridge never returns it to the browser/app —
 * same trust boundary as /api/integrations over oauth_tokens.
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

  // safe=1 → the worker omits the key and returns hasKey instead.
  const data = await fetch(
    `${WORKER_URL}/model-config?userId=${encodeURIComponent(session.sub)}&safe=1`,
    { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, config: data.config ?? null })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { config } = await req.json().catch(() => ({} as any))
  const c = (config && typeof config === 'object') ? config : {}

  // Pass api_key through ONLY when the client explicitly included it (a settings
  // save that didn't touch the key omits it, so the stored key is preserved).
  const payload: Record<string, unknown> = {
    userId: session.sub,
    provider: String(c.provider ?? ''),
    model_id: String(c.modelId ?? c.model_id ?? ''),
    base_url: String(c.baseUrl ?? c.base_url ?? ''),
    region: String(c.region ?? ''),
    max_tokens: String(c.maxTokens ?? c.max_tokens ?? ''),
    additional_fields: typeof c.additionalFields === 'string'
      ? c.additionalFields
      : (c.additionalFields ? JSON.stringify(c.additionalFields) : String(c.additional_fields ?? '')),
  }
  const rawKey = c.apiKey ?? c.api_key
  if (rawKey !== undefined) payload.api_key = String(rawKey)

  const data = await fetch(`${WORKER_URL}/model-config`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true })
}
