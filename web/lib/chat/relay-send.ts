/**
 * 🔴 "relay send failed" — a sentence five callers reached for when they had no
 * idea what happened.
 *
 * Every server-side path that hands a device an envelope does the same thing:
 *
 *   const sent = await fetch(`${WORKER}/device/relay/send`, …)
 *       .then(r => r.json()).catch(e => ({ error: String(e) }))
 *   if (sent.error || !sent.id) return { error: sent.error || 'relay send failed' }
 *
 * Three defects, one line:
 *
 *  1. **`r.status` is never read.** A 404 "device not found" and a 503 from a
 *     failing relay arrive identically. The first means *nothing was sent* — the
 *     worker refuses before `RELAY_INSERT_SQL` in every 4xx arm. The second means
 *     *nobody knows whether it was sent.* One of those is a decision, the other is
 *     the absence of one, and telling a user "failed" for the second is a claim
 *     with nothing behind it. (Inc 36 learned this on the enrol route.)
 *  2. **`'relay send failed'` is asserted for the one case where nothing is
 *     known** — a 2xx with neither `error` nor `id`. The relay took the request
 *     and named no envelope; it may well have queued it. "Failed" is a guess.
 *  3. **The worker's terse wire strings go straight to the model**, which reads
 *     them out. `unauthorized` is the worst: it is tiny's OWN internal key being
 *     rejected, and the user hears a word that means "you are not allowed".
 *
 * So the classification lives here, once, and callers cannot write a fallback:
 * `relaySend` returns a union whose refusal arm already carries the sentence, so
 * there is no `||` for a guess to hide in.
 *
 * `delivered` is the field that matters. `'no'` is only ever claimed for the four
 * refusals the worker source proves happen before the INSERT; everything else is
 * `'unknown'` and says so out loud.
 */

/** Which of the relay's answers this was. Callers branch on this, never on prose. */
export type RelaySendKind =
  | 'queued'          // 2xx + an envelope id — the only success
  | 'no_such_device'  // 404: not this account's device (revoked, removed, typo)
  | 'too_big'         // 400: payload over the 8KB envelope limit
  | 'bad_request'     // 400 otherwise: tiny built a malformed request
  | 'server_key'      // 401: OUR X-Internal-Key was rejected. Not the user.
  | 'relay_fault'     // 5xx: the relay broke while deciding
  | 'unreachable'     // the request never got an answer at all
  | 'no_envelope'     // 2xx, no error, no id — the contract broke

export type RelaySendResult =
  | { queued: true; kind: 'queued'; id: string }
  | {
      queued: false
      kind: Exclude<RelaySendKind, 'queued'>
      /** A sentence for a person, naming the cause and what to do about it. */
      error: string
      /** `'no'` only when the relay decided BEFORE queueing. Never guessed. */
      delivered: 'no' | 'unknown'
      /** Whether an IDENTICAL retry could plausibly succeed. */
      retryable: boolean
    }

/** The worker's own wire strings, from worker/src/relay.ts. */
const WIRE = {
  notFound: 'device not found',
  tooBig: 'payload must be valid JSON ≤8KB',
  unauthorized: 'unauthorized',
  missing: 'userId and toDevice required',
}

/** Mid-sentence: `nothing was sent to <who>`. */
const named = (deviceName?: string | null) =>
  deviceName ? `"${deviceName}"` : 'that device'

/** Sentence-initial. A quoted name needs no capital; the anonymous fallback does. */
const Named = (deviceName?: string | null) =>
  deviceName ? `"${deviceName}"` : 'That device'

/**
 * What the relay did, from what it actually told us.
 *
 * `status` is optional on purpose: a transport that never produced a response
 * (a thrown fetch, an abort) has no status, and neither does a caller that only
 * has a parsed body. An absent status is treated as *unknown*, never as 200 —
 * the body then has to carry the whole verdict, which is exactly what it does.
 */
export function classifyRelaySend(input: {
  status?: number
  body?: unknown
  /** The thrown transport error, when there was no response at all. */
  threw?: unknown
  deviceName?: string | null
}): RelaySendResult {
  const { status, deviceName } = input
  const who = named(deviceName)
  const body = (input.body ?? null) as Record<string, unknown> | null
  const wire = typeof body?.error === 'string' ? body.error.trim() : ''
  const id = typeof body?.id === 'string' ? body.id.trim() : ''

  // No response at all. The socket may have died after the relay read the
  // request, so this is the loudest `unknown` of the set.
  if (input.threw !== undefined || status === 0) {
    const detail = String((input.threw as any)?.message ?? input.threw ?? 'no response').slice(0, 120)
    return {
      queued: false, kind: 'unreachable', delivered: 'unknown', retryable: true,
      error: `tiny could not reach the device relay (${detail}), so it is not known whether the request reached ${who}. Worth trying once more.`,
    }
  }

  // A 5xx is the relay breaking mid-decision. It may have inserted the envelope
  // and failed afterwards; claiming "not sent" here would be inventing a fact.
  if (typeof status === 'number' && status >= 500) {
    return {
      queued: false, kind: 'relay_fault', delivered: 'unknown', retryable: true,
      error: `The device relay is failing (HTTP ${status}), so it is not known whether the request reached ${who}. Worth trying once more.`,
    }
  }

  // ⚠️ Prose, matched deliberately — and the reason it is SAFE to match is that
  // every branch below is keyed on the worker's own constant strings and falls
  // through to a generic sentence carrying `wire` verbatim when they change. A
  // reworded worker degrades the wording, never the verdict.
  if (wire) {
    if (wire === WIRE.notFound || status === 404) {
      return {
        queued: false, kind: 'no_such_device', delivered: 'no', retryable: false,
        error: `${Named(deviceName)} is not on this account — it may have been revoked, removed in Devices, or never finished enrolling. Nothing was sent.`,
      }
    }
    if (wire === WIRE.tooBig) {
      return {
        queued: false, kind: 'too_big', delivered: 'no', retryable: false,
        error: `The instruction is too large for one relay envelope (8KB limit), so nothing was sent to ${who}. Shorten it and send again.`,
      }
    }
    if (wire === WIRE.unauthorized || status === 401) {
      return {
        queued: false, kind: 'server_key', delivered: 'no', retryable: false,
        error: `The device relay rejected tiny's own server key, so nothing was sent to ${who}. That is a server-side configuration fault — the user's login is fine and there is nothing they can do about it.`,
      }
    }
    if (wire === WIRE.missing || status === 400) {
      return {
        queued: false, kind: 'bad_request', delivered: 'no', retryable: false,
        error: `tiny sent the device relay a malformed request (${wire}), so nothing reached ${who}. That is a bug in tiny, not something the user did wrong.`,
      }
    }
    // Unrecognised refusal WITH a reason: pass the reason on, keep the verdict
    // honest. A 4xx is a decision; anything else is not known to be one.
    const decided = typeof status === 'number' && status >= 400 && status < 500
    return {
      queued: false, kind: decided ? 'bad_request' : 'relay_fault',
      delivered: decided ? 'no' : 'unknown', retryable: !decided,
      error: decided
        ? `The device relay refused the request (${wire}), so nothing was sent to ${who}.`
        : `The device relay answered with an error (${wire}), so it is not known whether the request reached ${who}.`,
    }
  }

  if (id) return { queued: true, kind: 'queued', id }

  // ⚠️ THE ONE THE OLD LINE GOT WRONG. No error, no id: the relay took the
  // request and named no envelope. The insert may well have happened, so a retry
  // can double-execute on the device — say that instead of "failed".
  return {
    queued: false, kind: 'no_envelope', delivered: 'unknown', retryable: false,
    error: `The device relay accepted the request but returned no envelope id, so its reply cannot be matched to it. It may still have reached ${who} — check before sending the same thing again.`,
  }
}

/**
 * How long a send may hang before it becomes an `unreachable` — 10s, the same
 * bound `/api/devices/relay` already put on its own worker round-trips.
 *
 * ⚠️ A DEFAULT, not an option nobody sets. All four tool callers hand-rolled
 * this fetch with no signal at all, which `tests/deadlines.test.ts` records as a
 * standing server-side gap (`lib/chat/tools/` is exempted wholesale for exactly
 * this). An insert into D1 does not take ten seconds; a relay that has stopped
 * answering will otherwise hold the agent's turn until the route's own ceiling
 * kills it, and the user is told nothing at all rather than "it is not known
 * whether this arrived".
 */
const SEND_DEADLINE_MS = 10_000

/**
 * Send one envelope and say what happened. The only correct way to reach
 * `/device/relay/send` from the server side.
 *
 * `r.json()` is used rather than `text()`+parse so the many existing fetch mocks
 * (which implement `json` alone) keep working; a body that is not JSON at all —
 * a Cloudflare error page — lands as an unparsed body, which is exactly the
 * no-error-no-id case, with the status carrying the verdict.
 */
export async function relaySend(opts: {
  worker: string
  headers: Record<string, string>
  userId: string
  toDevice: string
  /** Already-stringified JSON, per the itty body rule. */
  payload: string
  deviceName?: string | null
  /** Overrides `SEND_DEADLINE_MS` — a caller with a tighter budget of its own. */
  signal?: AbortSignal
}): Promise<RelaySendResult> {
  const { worker, headers, userId, toDevice, payload, deviceName, signal } = opts
  let res: Response | null = null
  try {
    res = await fetch(`${worker}/device/relay/send`, {
      method: 'POST', headers,
      body: JSON.stringify({ userId, toDevice, payload }),
      signal: signal ?? AbortSignal.timeout(SEND_DEADLINE_MS),
    })
  } catch (e) {
    return classifyRelaySend({ threw: e, deviceName })
  }
  // A mock or a transport with no status must not be read as 200 — pass it
  // through as absent and let the body decide.
  const status = typeof res.status === 'number' ? res.status : undefined
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return classifyRelaySend({ status, body, deviceName })
}
