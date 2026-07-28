/**
 * Relative-time formatters (extracted from four hand-rolled copies:
 * ActivityHUD/MessagesHUD `ago`, wallet `relative`, devices `relativeSeen`).
 *
 * Two deliberate vocabularies — do not merge them:
 *  - ago(): compact "5s/3m/2h/1d" for tight HUD rows (no " ago" suffix).
 *  - relativeAgo(): prose "just now" / "5m ago" / "2h ago" for page surfaces,
 *    with a per-surface fallback ("" on the wallet ledger, "never" on devices).
 *
 * Coerce + finite-guard on every path: timestamps come raw off worker payloads
 * (TYPED number, validated nowhere), and a NaN falls through every strict-<
 * branch to render the literal "NaNd ago"; Number(null)/Number("") are 0
 * (finite!), which would read as ~20656 days since the Unix epoch. A real
 * timestamp is seconds-since-1970, always > 0 — anything else hits the guard.
 *
 * `nowMs` is injectable so tests are deterministic; callers omit it.
 */
export function ago(ts: number, nowMs: number = Date.now()): string {
  const n = Number(ts);
  const s = Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(nowMs / 1000 - n)) : 1;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function relativeAgo(sec: number | undefined, fallback = "", nowMs: number = Date.now()): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const d = Math.max(0, Math.floor(nowMs / 1000) - n);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
