/**
 * POST /api/tools/install — copy another builder's forged tool into the
 * signed-in user's own account (profile-page "Use this tool" button).
 *
 *   { login, name }  → { ok, name } | { ok:false, error }
 *
 * The tool is fetched fresh from the author's public profile (never
 * client-supplied code), re-validated in the Node sandbox, then persisted
 * under the CALLER's userId — it runs in their sandbox, as my_<name>.
 */
import { getSession } from '@/lib/auth'
import { usd } from '@/lib/utils'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const { login, name } = await req.json().catch(() => ({} as any))
  if (!login || !name) return json({ ok: false, error: 'login and name required' }, 400)

  // Fetch the tool from the author's public profile (source of truth).
  // 10s bound (the validate hop below already has its own 15s) — a hung worker
  // would otherwise pin this to CF wall-clock; AbortError → existing .catch →
  // null → 'builder not found'.
  const profile = await fetch(
    `${WORKER_URL}/profile?login=${encodeURIComponent(String(login))}`,
    { cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(() => null)
  if (!profile?.login) return json({ ok: false, error: 'builder not found' }, 404)

  const toolRow = (profile.tools || []).find((t: any) => t.name === String(name))
  if (!toolRow?.code) return json({ ok: false, error: 'tool not found' }, 404)

  // Re-validate in the Node sandbox — author's copy may predate current rules
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://tiny.technology'
  const check = await fetch(`${base}/api/run-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({ action: 'validate', code: toolRow.code }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.json()).catch(e => ({ ok: false, error: String(e?.message || e) }))
  if (!check.ok) return json({ ok: false, error: `tool failed validation: ${check.error || 'unknown'}` }, 422)

  // 💸 Paid tool installs (payments PR1): a forged tool priced via set_price
  // (tool:<login>/<name>) is a ONE-TIME PURCHASE. The LLM `marketplace` install
  // path (app/api/chat/route.ts:974) settles before copying — but this direct
  // "Use this tool" button (web + iOS + Android) skipped the charge entirely, so
  // a priced tool installed for FREE here: a full paywall bypass. Mirror the chat
  // path exactly, and CRUCIALLY reuse the SAME idempotency ref
  // (install:<sub>:<login>/<name>) so buying through either surface settles once —
  // a user who already paid via chat installs free here, and vice versa.
  // Settle AFTER validation (a tool that can't pass current sandbox rules must
  // cost nothing) and BEFORE the copy below (its stable ref makes a retry after a
  // transient write failure idempotently free yet still delivering).
  // Armed only when THIS call actually moved money (charged_micro > 0 &&
  // !already_settled) — so a failed persist below can hand the charge back.
  // Mirrors the chat-path install refund discipline (chat/route.ts:1131).
  const installRef = `install:${session.sub}:${login}/${name}`
  let refundInstall = false
  try {
    const toolResource = `tool:${login}/${name}`
    const priced = await fetch(
      `${WORKER_URL}/pay/pricing?resource=${encodeURIComponent(toolResource)}`,
      { signal: AbortSignal.timeout(10_000) }
    ).then(r => r.json()).catch(() => ({ price_micro: 0 }))
    if (Number(priced?.price_micro) > 0) {
      const settle = await fetch(`${WORKER_URL}/pay/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({
          payerId: session.sub,
          resource: toolResource,
          ref: installRef,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.json()).catch(() => null)
      if (!settle || settle.ok !== true) {
        return json({
          ok: false,
          payment_required: true,
          price_micro: Number(priced.price_micro),
          balance_micro: Number(settle?.balance_micro || 0),
          // Money copy via the canonical usd() (Rule B: min-2 frac digits) so
          // this button's paywall reads identically to the chat install path
          // (chat/route.ts:1075) — raw `$${micro/1e6}` printed "$0.5"/"$1" and
          // .toFixed(4) printed "$0.0500", so the SAME purchase looked different
          // depending on whether it ran through chat or the "Use this tool" button.
          error: settle?.error === 'insufficient_balance'
            ? `my_${name} costs ${usd(Number(priced.price_micro))} (one-time). Your wallet has ${usd(Number(settle?.balance_micro || 0))} — top up at /wallet.`
            : 'Payment settlement failed — the tool was not installed.',
        }, 402)
      }
      // Arm the clawback ONLY when this call actually MOVED money — a real
      // debit, not an idempotent replay. An `already_settled` retry was paid
      // (and likely delivered) on an earlier attempt, so a failure here must
      // NOT claw it back; a stable-ref retry after a prior refund also reports
      // already_settled, so nothing re-arms (no double-refund). Same guard as
      // the chat install path (chat/route.ts:1086).
      if (Number(settle.charged_micro) > 0 && !settle.already_settled) refundInstall = true
    }
  } catch { /* pricing outage → free install (never block on our own hiccup) */ }

  // Persist under the CALLER's account. Capture the worker's HTTP status so a
  // failed persist can't be mistaken for success: the worker signals failure
  // by a non-2xx status and/or an `error` field, but may also return a bare
  // { ok:false } with no error — reporting {ok:true} then would tell the user
  // the tool installed when it didn't. Treat anything that isn't an explicit
  // success as a failure (mirrors app/api/tools/route.ts).
  const stored = await fetch(`${WORKER_URL}/tools`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({
      userId: session.sub,
      name: toolRow.name,
      description: `${toolRow.description || toolRow.name} [from @${profile.login}]`,
      params: JSON.stringify(toolRow.params || {}),
      code: toolRow.code,
    }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json().then((j: any) => ({ ...j, _status: r.status })))
    .catch(e => ({ ok: false, error: String(e?.message || e), _status: 0 }))

  const { _status, ...body } = stored as any
  const persisted = _status >= 200 && _status < 300 && body.error === undefined
  if (!persisted) {
    // Settle-before-serve: a PAID install whose storage write failed (MAX_TOOLS
    // 429, durable D1 error, transport blip) must hand the charge back — the
    // user paid for a tool they never received. Idempotent /pay/refund by the
    // stable ref; a no-op when the install was free (refundInstall stays false).
    // Without this the direct "Use this tool" button billed but never delivered,
    // the exact gap the chat install path closes (chat/route.ts:1131).
    if (refundInstall) {
      const rf = await fetch(`${WORKER_URL}/pay/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({ ref: installRef }),
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.json()).catch(() => null)
      if (!rf?.ok) console.error('install-refund-failed', JSON.stringify({ ref: installRef, err: rf?.error || 'unreachable' }))
    }
    return json({ ok: false, error: body.error || 'install failed — the tool was not saved' },
      _status && _status >= 400 ? _status : 502)
  }
  return json({ ok: true, name: body.name || toolRow.name, updated: !!body.updated })
}
