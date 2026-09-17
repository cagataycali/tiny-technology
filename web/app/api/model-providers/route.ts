/**
 * /api/model-providers — session-scoped multi-provider BYO-model credentials
 * ("pizza selection": bedrock + anthropic + openai + … stored side by side).
 *
 *   GET                → { ok, providers:[{provider, modelId, …, hasKey, isActive}] }
 *   GET ?full=1        → same rows INCLUDING the decrypted apiKey. This is the
 *                        cross-device SYNC read (CLI `tiny-tech onboard --pull`,
 *                        iOS/Android settings import). Storing keys server-side
 *                        so the user's own devices can fetch them is the entire
 *                        feature — the trust boundary is the owner's session,
 *                        exactly like /api/integrations returning tokens to the
 *                        session-holder would be. Third parties never pass
 *                        getSession; the browser UI uses the safe read.
 *   POST { provider, modelId?, baseUrl?, region?, maxTokens?,
 *          additionalFields?, apiKey?, isActive? }   → upsert one provider
 *          (apiKey: omit=keep stored, ''=clear, value=replace;
 *           isActive:true → becomes the active chat config)
 *   DELETE { provider } → remove one provider
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

  const full = new URL(req.url).searchParams.get('full') === '1'
  const data = await fetch(
    `${WORKER_URL}/model-providers?userId=${encodeURIComponent(session.sub)}${full ? '&full=1' : ''}`,
    { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  // camelCase for the JS clients (worker speaks snake_case D1 columns)
  const providers = (data.providers || []).map((p: any) => ({
    provider: p.provider,
    modelId: p.model_id || '',
    baseUrl: p.base_url || '',
    region: p.region || '',
    maxTokens: p.max_tokens || 0,
    additionalFields: p.additional_fields || '',
    isActive: Boolean(p.is_active),
    ...(full ? { apiKey: p.apiKey || '' } : { hasKey: Boolean(p.hasKey) }),
  }))
  return json({ ok: true, providers })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const b = await req.json().catch(() => ({} as any))
  if (!b?.provider) return json({ ok: false, error: 'provider required' }, 400)

  const payload: Record<string, unknown> = {
    userId: session.sub,
    provider: String(b.provider),
    model_id: String(b.modelId ?? b.model_id ?? ''),
    base_url: String(b.baseUrl ?? b.base_url ?? ''),
    region: String(b.region ?? ''),
    max_tokens: String(b.maxTokens ?? b.max_tokens ?? ''),
    additional_fields: typeof b.additionalFields === 'string'
      ? b.additionalFields
      : (b.additionalFields ? JSON.stringify(b.additionalFields) : String(b.additional_fields ?? '')),
    is_active: (b.isActive ?? b.is_active) ? '1' : '',
  }
  const rawKey = b.apiKey ?? b.api_key
  if (rawKey !== undefined) payload.api_key = String(rawKey)

  const data = await fetch(`${WORKER_URL}/model-providers`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true })
}

export async function DELETE(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const b = await req.json().catch(() => ({} as any))
  const provider = String(b?.provider || new URL(req.url).searchParams.get('provider') || '')
  if (!provider) return json({ ok: false, error: 'provider required' }, 400)

  const data = await fetch(
    `${WORKER_URL}/model-providers?userId=${encodeURIComponent(session.sub)}&provider=${encodeURIComponent(provider)}`,
    { method: 'DELETE', headers: internalHeaders(), signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true })
}
