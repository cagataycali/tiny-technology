/**
 * Client fetch deadlines, and the one rule that makes them safe.
 *
 * A `fetch()` with no signal can stay pending indefinitely (a hung worker, a
 * proxy that accepts and never answers, a sleeping radio). Every button on this
 * app guards itself with `if (busy) return` and clears the flag in a `.finally`
 * — so a request that never settles never clears the flag, and the ONLY control
 * that could retry stays disabled until a manual reload. TelegramSettings
 * already learned this ("without it a hung worker leaves the fetch pending
 * forever — .finally never runs, so `loading` never clears"); ~40 other client
 * fetches never got the treatment.
 *
 * ⚠️ The trap this module exists to prevent: a deadline SHORTER than the
 * server's own budget doesn't fail fast, it LIES. Our money routes deliberately
 * run long — `/api/wallet/withdraw` sets `maxDuration = 60`, `/api/x402/pay`
 * sets 180, the faucet 30, and `claim` gives the worker 20s for on-chain
 * verification. A blanket 10s client cap would abort those mid-settlement and
 * hand the user an "unknown outcome" for a payment the server was about to
 * complete successfully — on irreversible transfers that's strictly worse than
 * waiting, because the recovery copy tells them not to retry.
 *
 * So a deadline is only ever a BACKSTOP for a server that has stopped
 * answering, never a competitor to a server still working. Every budget here is
 * the route's own limit plus headroom, and `exceedsServerBudget` is the test
 * that keeps it that way.
 */

/**
 * The default: reads and cheap mutations that proxy the worker.
 *
 * ⚠️ This is deliberately 15s, NOT 10s. The house proxy budget is
 * `AbortSignal.timeout(10_000)` — 66 of them across 33 route files — so a 10s
 * client cap is EQUAL to the server's own, and `exceedsServerBudget` rejects
 * equal budgets for a reason: whoever wins that race is a coin flip, and the
 * client losing it renders a timeout for a request the route answered. The
 * server's 10s cap is the thing that should fire first, converting a hang into
 * a real 503 the surface can explain; this deadline only covers the case where
 * the route itself never answers.
 */
export const QUICK_MS = 15_000

/**
 * Calls that leave our origin entirely — `plugin.tiny.technology` straight from
 * the browser, with no route of ours in the middle.
 *
 * There is no `maxDuration` and no internal proxy cap to sit above here, so the
 * equal-budget reasoning above simply doesn't apply: the client deadline IS the
 * only budget. 10s matches what the surfaces that already deadline these calls
 * chose by hand (CommandPalette, UniverseDrawer, Community), so this constant
 * names the existing house number rather than inventing a new one.
 */
export const EXTERNAL_MS = 10_000

/**
 * Deadlines for the routes whose own budget reaches or exceeds the default.
 * Keyed by route path so the guard test can compare each entry against the
 * `maxDuration` / internal `AbortSignal.timeout` the route actually declares —
 * and, more importantly, prove that no route is MISSING from this table.
 */
export const ROUTE_DEADLINE_MS: Record<string, number> = {
  // maxDuration = 300 (a full model turn + tool loop). Streaming callers use
  // c32's `streamOutcome` instead; this is for anyone who ever fetches it flat.
  '/api/chat': 330_000,
  // maxDuration = 180 (quote → sign → settle → confirm against a third party).
  '/api/x402/pay': 195_000,
  // maxDuration = 120 (runs a scheduled job's whole agent turn).
  '/api/job-run': 135_000,
  // maxDuration = 60 (signs + broadcasts a payout on-chain).
  '/api/wallet/withdraw': 75_000,
  // maxDuration = 60 (executes a user tool, which may call out).
  '/api/tools/run': 75_000,
  // maxDuration = 30 (mints trial credit on the self-hosted chain).
  '/api/wallet/faucet': 45_000,
  // maxDuration = 30 (generates/uploads media through R2).
  '/api/run-tool': 45_000,
  // 30s internal (media bytes through the worker).
  '/api/media': 45_000,
  // 25s internal (tool listing hits the registry).
  '/api/tools': 40_000,
  // The route gives the worker 20s for tx verification on `claim`; the other
  // actions are 10s reads. One budget for the endpoint = the widest of them.
  '/api/wallet': 35_000,
  // ⚠️ The one entry whose route declares NO budget of its own — and therefore
  // the one the guard below cannot check: `routeBudgets()` reads maxDuration and
  // internal AbortSignal.timeout out of each route file and `continue`s on 0, so
  // /api/voice/tool has always read as "nothing to outlive". Its real ceiling is
  // the tools it MOUNTS and waits on: flipper_status/files poll a relay for
  // `VOICE_TOOL_BUDGET_S` (20s, named in the route), the widest of them.
  //
  // Missing from this table, it fell through to QUICK_MS = 15s — below every
  // hardware tool on that bridge, which is exactly the lie this module's header
  // describes: the browser aborted with "the tool timed out" while the server was
  // still legitimately waiting, replacing an answer that names the cause. 20s
  // server → 35_000 is the same mapping /api/wallet's 20s uses, and it stays
  // above the phones' own 30s ceiling on this route (Api.swift's
  // timeoutInterval, TinyApi.kt's callTimeout) so all three surfaces let the
  // SERVER decide the outcome.
  '/api/voice/tool': 35_000,
  // 15s internal — exactly QUICK_MS, so these MUST be listed or they race.
  '/api/control': 25_000,
  '/api/telegram': 25_000,
  '/api/tools/install': 25_000,
  // Calls a robot's own API through the worker: 25s internally for telemetry
  // (the widest of its actions), so the client must sit above that. The camera
  // snapshot inside it is far tighter (15s) and doesn't set the budget — one
  // deadline per endpoint = the widest action, same rule as /api/wallet.
  '/api/devices/endpoint': 40_000,
}

/**
 * Dynamic-segment routes: a caller's real URL is `/api/x402/chat/some-slug`, so
 * an exact-match table can never hold it. Keyed by the static prefix.
 */
export const ROUTE_PREFIX_DEADLINE_MS: Record<string, number> = {
  // maxDuration = 300, and internally up to 240s for the paid model turn.
  '/api/x402/chat/': 330_000,
}

/** The deadline to use for a client fetch to `path` (query string tolerated). */
export function deadlineFor(path: string): number {
  const clean = path.split('?')[0].split('#')[0]
  const exact = ROUTE_DEADLINE_MS[clean]
  if (exact !== undefined) return exact
  // Longest matching prefix wins, so a more specific dynamic route can be added
  // under a broader one later without reordering the object.
  let best = 0
  let found: number | undefined
  for (const [prefix, ms] of Object.entries(ROUTE_PREFIX_DEADLINE_MS)) {
    if (clean.startsWith(prefix) && prefix.length > best) { best = prefix.length; found = ms }
  }
  return found ?? QUICK_MS
}

/**
 * True when `clientMs` would abort a request the server is still allowed to be
 * working on — the bug this module prevents. Headroom must be POSITIVE: equal
 * budgets race, and the client losing that race is indistinguishable from a
 * genuine timeout.
 */
export function exceedsServerBudget(clientMs: number, serverMs: number): boolean {
  return clientMs <= serverMs
}

/**
 * A user-facing reason for a settled-vs-timed-out distinction.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` (jsdom/undici) — older
 * paths and manual aborts surface `AbortError`. Callers that already have a
 * "couldn't reach it" branch don't need this; the ones that must NOT invite a
 * retry (money) do, which is why the name asks about the deadline rather than
 * about failure in general.
 */
export function isDeadlineError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * What a caught client-fetch failure actually was, for surfaces that must react
 * differently to each.
 *
 * `cancelled` is the WebAuthn case: dismissing the biometric sheet rejects with
 * `NotAllowedError`, and that is the user doing exactly what they meant to — an
 * error toast for it is noise. AuthButton spelled this as
 * `if (e.name !== "NotAllowedError")` at two call sites; the rule lives here now
 * so a third flow can't forget it.
 *
 * The cancel test comes first defensively, but note it is NOT load-bearing
 * today: `NotAllowedError` is not in `isDeadlineError`'s set, so the two
 * branches are disjoint. What IS load-bearing is that a cancel never falls
 * through to `'other'` — that is the branch that toasts an error at someone who
 * deliberately dismissed a prompt.
 */
export type FetchFailure = 'cancelled' | 'timeout' | 'other'

export function classifyFetchFailure(e: unknown): FetchFailure {
  const name = (e as { name?: unknown } | null | undefined)?.name
  if (name === 'NotAllowedError') return 'cancelled'
  if (isDeadlineError(e)) return 'timeout'
  return 'other'
}

/**
 * Await a deadlined fetch and, if the deadline is what killed it, rethrow an
 * error the caller can tell apart from an abort it caused itself.
 *
 * ⚠️ The problem this solves, found wiring Chat's share flow: `AbortError` is
 * NOT unique to fetch. `navigator.share()` rejects with `AbortError` when the
 * user dismisses the OS share sheet, and Chat's share handler ends in
 * `if (err.name !== 'AbortError')` precisely to keep that cancel silent. Put a
 * deadline on the fetch in the same try and a real timeout inherits that
 * silence — the user gets NO feedback at all, which is worse than the raw
 * message c52 was fixing. Same collision shape at the two stream sites
 * (`Chat.tsx:1492/1600`), where `AbortError` means "the user hit stop".
 *
 * So don't ask "was this an abort?" — ask "was this MY deadline?". The flag is
 * set at the only place that knows, the await of the deadlined call.
 */
export const DEADLINE_FLAG = '__tinyDeadline'

export function isTaggedDeadline(e: unknown): boolean {
  return !!(e as Record<string, unknown> | null | undefined)?.[DEADLINE_FLAG]
}

export async function fetchWithDeadline(
  input: string,
  init: RequestInit & { deadlineMs?: number } = {},
): Promise<Response> {
  const { deadlineMs, ...rest } = init
  const ms = deadlineMs ?? deadlineFor(input)
  try {
    return await fetch(input, { ...rest, signal: AbortSignal.timeout(ms) })
  } catch (e) {
    if (isDeadlineError(e)) {
      // Tag rather than replace: keep the original error's identity for logs,
      // add the one bit the caller can't otherwise recover.
      try { (e as Record<string, unknown>)[DEADLINE_FLAG] = true } catch { /* frozen */ }
      const tagged = isTaggedDeadline(e)
        ? e
        : Object.assign(new Error('timed out'), { name: 'TimeoutError', [DEADLINE_FLAG]: true })
      throw tagged
    }
    throw e
  }
}

/**
 * User-facing copy for a caught failure, or `null` when there is nothing honest
 * to say (a cancel).
 *
 * The reason this exists: `AbortSignal.timeout` rejects with the message
 * "signal timed out" (or "The operation was aborted"), so every
 * `toast.error(e.message)` in the app turns a deadline into machine noise the
 * moment the deadline is added. `fallback` stays the caller's own wording for
 * genuine failures.
 */
export function failureMessage(e: unknown, fallback: string): string | null {
  switch (classifyFetchFailure(e)) {
    case 'cancelled': return null
    case 'timeout': return 'Timed out — check your connection and try again'
    default: {
      const msg = (e as { message?: unknown } | null | undefined)?.message
      return typeof msg === 'string' && msg ? msg : fallback
    }
  }
}
