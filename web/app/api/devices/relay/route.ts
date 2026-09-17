/**
 * /api/devices/relay — cross-network device messaging (tiny-node PR6).
 *
 *   POST { toDevice, payload }          session → send envelope → { id }
 *   GET  ?inReplyTo=<id>                session → fetch reply   → { reply? }
 *   PUT  { deviceId, token, max? }      device-token → poll     → { messages }
 *   PATCH{ deviceId, token, inReplyTo, payload } device-token → reply → { ok }
 *
 * Session verbs (POST/GET) carry the OWNER's identity; device verbs
 * (PUT/PATCH) authenticate with the device token in-body (no session,
 * off the IP limiter like /api/devices/heartbeat — polling is continuous,
 * the token is the gate).
 */
import { getSession } from '@/lib/auth'
import { relaySend, type RelaySendKind } from '@/lib/chat/relay-send'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const internalHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

// 10s bound on every worker round-trip. This is a polling surface — the
// session GET polls for a device's reply and the device PUT polls undelivered
// envelopes continuously — so a connect-but-never-respond worker would pin each
// invocation to CF wall-clock. AbortError falls into the existing .catch →
// {error} → 424 (relay unavailable), which callers already handle.
const T = () => ({ signal: AbortSignal.timeout(10_000) })

/**
 * One HTTP status per relay verdict, so a client can act without reading prose.
 *
 * 424 stays the "the relay itself let us down" code the clients already handle;
 * the three decisions the user can act on get codes that say whose problem it is.
 * 401 is deliberately NOT used for `server_key`: it was tiny's own credential
 * that was refused upstream, and a 401 tells a perfectly signed-in user to log
 * in again.
 *
 * ⚠️ **NOTHING HERE MAY BE A 5xx**, however right that looks on paper. A proxy
 * whose upstream rejected its key is textbook 502 — but iOS's
 * `Api.statusOwnsTheMessage` (Api.swift) says the app knows better than the
 * server for 401/0/5xx, so `Api.post` DISCARDS the body and shows "Server
 * hiccup (HTTP 502) — usually passes, try again". For `no_envelope` that is the
 * exact opposite of the sentence's advice — the envelope may already be queued,
 * and "try again" is how the device runs the command twice. For `server_key` it
 * promises a wait will fix a config fault. Both then read like the failure this
 * increment exists to stop guessing about. So `server_key` and `no_envelope`
 * ride 424, where the app prefers the server's own words. "every status the
 * route answers lets the sentence through on iOS" (tests/relay-send.test.ts)
 * reads that rule out of Api.swift rather than trusting this comment.
 */
const RELAY_SEND_STATUS: Record<Exclude<RelaySendKind, 'queued'>, number> = {
  no_such_device: 404,
  too_big: 413,
  bad_request: 400,
  server_key: 424,
  relay_fault: 424,
  unreachable: 424,
  no_envelope: 424,
}

async function workerPost(path: string, body: any) {
  return fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(body),
    ...T(),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
}

/** Session → send an envelope to one of MY devices */
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { toDevice, payload } = await req.json().catch(() => ({} as any))
  if (!toDevice) return json({ ok: false, error: 'toDevice required' }, 400)

  // ⚠️ Two defects lived in the four lines this replaced.
  //
  // `if (data.error) … data.error === 'device not found' ? 404 : 424` picked the
  // status by STRING-MATCHING the worker's prose, so every other refusal — an
  // 8KB payload, tiny's own internal key being rejected — arrived as 424 Failed
  // Dependency, which is not what any of them are.
  //
  // Worse: with no `error` and no `id` it fell through to `{ ok: true, id:
  // undefined }`. `id` vanishes in JSON.stringify, so iOS's device panels
  // (TinyLive.clipResult/frameResult) took the guard branch, found no error, and
  // showed "Couldn't reach the relay." — a claim about the network for a relay
  // that answered. **A success is an envelope id; there is nothing else it can be.**
  const sent = await relaySend({
    worker: WORKER_URL, headers: internalHeaders(),
    userId: session.sub, toDevice: String(toDevice),
    // itty body rule: JSON as string
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
    ...T(),
  })
  if (!sent.queued) return json({ ok: false, error: sent.error, delivered: sent.delivered, retryable: sent.retryable }, RELAY_SEND_STATUS[sent.kind])
  return json({ ok: true, id: sent.id })
}

/** Session → poll for the reply to an envelope I sent */
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const inReplyTo = new URL(req.url).searchParams.get('inReplyTo')
  if (!inReplyTo) return json({ ok: false, error: 'inReplyTo required' }, 400)

  const data = await fetch(
    `${WORKER_URL}/device/relay/recv?userId=${encodeURIComponent(session.sub)}&inReplyTo=${encodeURIComponent(inReplyTo)}`,
    { headers: internalHeaders(), cache: 'no-store', ...T() }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, reply: data.reply ?? null })
}

/** Device → poll undelivered envelopes (token auth, no session) */
export async function PUT(req: Request) {
  const { deviceId, token, max } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token) return json({ ok: false, error: 'deviceId and token required' }, 400)

  const data = await workerPost('/device/relay/poll', {
    deviceId: String(deviceId), token: String(token),
    ...(max ? { max: Number(max) } : {}),
  })
  if (data.error) return json({ ok: false, error: data.error }, data.error === 'unauthorized' ? 401 : 424)
  return json({ ok: true, messages: data.messages || [] })
}

/** Device → reply to an envelope (token auth, no session) */
export async function PATCH(req: Request) {
  const { deviceId, token, inReplyTo, payload } = await req.json().catch(() => ({} as any))
  if (!deviceId || !token || !inReplyTo) return json({ ok: false, error: 'deviceId, token, inReplyTo required' }, 400)

  const data = await workerPost('/device/relay/reply', {
    deviceId: String(deviceId), token: String(token), inReplyTo: String(inReplyTo),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
  })
  if (data.error) return json({ ok: false, error: data.error }, data.error === 'unauthorized' ? 401 : 424)
  return json({ ok: true })
}
