/**
 * The worker /get fetch + not-exists sentinel, in ONE place (extracted from
 * four page copies + two API-route compares that each re-derived the rules).
 *
 * The worker's not-exists sentinel is a magic STRING and lands under an
 * inconsistent field — `response` (get.ts) or `message` (older proxy routes) —
 * so every caller had to know to check both. Worse, a 200 sentinel payload has
 * no `name`, so a caller that skipped classification (app/page.tsx before this)
 * would render <Chat name={undefined}>. And the worker can 503 WITH a JSON
 * body, so `res.json()` alone is not an ok-gate — non-2xx is a failed lookup
 * regardless of how parseable the body is.
 *
 * `failed` vs `not-found` is a real distinction for callers: the homepage
 * degrades a failure to the default hero, the [slug] page 404s a not-found.
 */
export const TINY_NOT_EXISTS = 'tiny.technology is not exists'

export type TinyRecord = { name?: string } & Record<string, unknown>

export type GetTinyResult =
  | { status: 'ok'; tiny: TinyRecord }
  | { status: 'not-found' }
  | { status: 'failed' }

/** True when a worker payload is the not-exists sentinel (either field). */
export function isTinyNotExists(payload: unknown): boolean {
  const p = payload as { response?: unknown; message?: unknown } | null
  return p?.response === TINY_NOT_EXISTS || p?.message === TINY_NOT_EXISTS
}

/** Classify a parsed /get payload. Pure — the testable half of getTiny(). */
export function classifyTinyPayload(payload: unknown): GetTinyResult {
  if (!payload || typeof payload !== 'object') return { status: 'failed' }
  if (isTinyNotExists(payload)) return { status: 'not-found' }
  const record = payload as TinyRecord
  // An unnamed 200 payload renders nothing anywhere — treat as not-found
  // (`!tiny.name` was already "the real guard" at every call site).
  if (!record.name) return { status: 'not-found' }
  return { status: 'ok', tiny: record }
}

/** Server-side lookup of a tiny record — degrade, never throw. */
export async function getTiny(slug: string): Promise<GetTinyResult> {
  try {
    const res = await fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authentication': 'Basic ' + btoa('tinyai:tinyai'),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { status: 'failed' }
    return classifyTinyPayload(await res.json())
  } catch {
    return { status: 'failed' }
  }
}
