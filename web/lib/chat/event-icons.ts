/**
 * Event-kind → icon mapping for the Activity HUD. Kept as a pure module so the
 * prefix-matching logic is unit-testable and the keys can be pinned against
 * EMITTED_KINDS below — the kinds the worker actually emits.
 *
 * iconFor() matches by PREFIX (so `job` covers job_result/job_error, `telegram`
 * covers all three telegram_* kinds) — which means single-word keys must be an
 * actual PREFIX of a real kind. `tiny_visit` is keyed in full precisely because
 * the bare `visit` prefix never matched "tiny_visit" (it starts with "tiny"),
 * leaving 👀 unreachable. `tool` reaches the real `tool-update` kind;
 * share/learn/push are forward-looking reserves and match nothing today.
 *
 * 💻 `device` covers `device_result` — a use_device task whose reply landed
 * after the 45s wait (relay.ts buildLateReplyEvent). The event ring is the only
 * place a late completion can surface, so this glyph is how the user SEES that
 * their laptop finished.
 *
 * 🚨 `pay_alarm` is keyed IN FULL, like tiny_visit: a bare `pay` prefix would
 * also swallow any future pay_* kind that is NOT an emergency, and this glyph
 * must mean exactly one thing. Every `pay_*` kind is therefore keyed in full —
 * the money kinds (money-events.ts) are ordinary good news and must never be
 * able to inherit the siren.
 *
 * ⛔ vs ⏰: `job` is a PREFIX key, so it also swallowed `job_missed` — the event
 * that means a one-shot will NEVER run — and drew it with the same glyph as a
 * job that finished. Keyed in full, like tiny_visit and pay_alarm.
 *
 * 🚫 `device_missed` is the same collision on the device side, and the pair is
 * the clearest illustration of why full keys matter: 💻 `device_result` means
 * "your laptop finished the task", `device_missed` means "your laptop never
 * picked it up and the task is gone" (relay-missed.ts). Under the bare `device`
 * prefix the second renders as the first — not a missing glyph, a confidently
 * WRONG one, on the only surface that reports the loss.
 *
 * A full key only beats a prefix key if the matcher prefers the more specific
 * one, which is why iconFor() sorts by key length rather than trusting the order
 * these are written in. Relying on literal order would make the correctness of
 * this table depend on nothing a reader (or a formatter) has any reason to
 * preserve.
 */
export const KIND_ICONS: Record<string, string> = {
  job: "⏰", job_missed: "⛔", telegram: "✈️", tiny_visit: "👀", learn: "🧬", device: "💻",
  device_missed: "🚫", pay_alarm: "🚨",
  pay_earned: "💵", pay_received: "💰", pay_withdrawn: "🏦", pay_refunded: "↩️",
  push: "🔔", share: "🔗", tool: "🔧", follow: "🤝", dm: "💬",
};

/**
 * ⚠️ EVERY KIND THE WORKER CAN EMIT — the roster that makes a missing glyph
 * FAIL A TEST instead of rendering.
 *
 * iconFor's ⚡ and the prompt's ℹ are graceful defaults, and they are right for a
 * kind a newer worker invented. They are NOT an acceptable resting place for a
 * kind we ship, because a shipped kind and an unknown one render IDENTICALLY —
 * so the gap is invisible from the call site. `pay_alarm` ("🚨 x402
 * reconciliation needs a human", reconcile-alarm.ts, swept every minute from
 * index.ts) drew the same ⚡ as a corrupt event on all three human HUDs, and the
 * same ℹ as a page view in the agent's prompt. The highest-severity event in the
 * system was the one indistinguishable from noise.
 *
 * Hand-kept, because the worker is a separate deploy: `emitEvent` takes a free
 * `kind: string`, so there is no type to import and no exhaustive switch to
 * break. Derived by grepping `emitEvent(` across chatgpt-plugin-tinyai/src.
 * When you add an emit site there, add its kind here — the test will tell you
 * what glyph is missing on which surface.
 */
export const EMITTED_KINDS = [
  "job_result", "job_error",              // scheduler.ts
  "dm",                                   // messages.ts
  "follow",                               // learnings.ts
  "tiny_visit",                           // visit.ts
  "device_result",                        // relay.ts (late reply, buildLateReplyEvent)
  "tool-update",                          // tool-updates.ts
  "telegram", "telegram_out", "telegram_button",  // telegram.ts, telegram-api.ts
  "pay_alarm",                            // reconcile-alarm.ts ALARM_EVENT_KIND
  // 💵 money-events.ts MONEY_EVENT_KINDS — payments.ts (invoke settle, P2P
  // transfer) and withdrawals.ts (paid, failed+refunded). Before those, every
  // path that moved real value was silent while a page view rang a bell.
  "pay_earned", "pay_received", "pay_withdrawn", "pay_refunded",
  // ⛔ scheduler.ts JOB_ABANDONED_KIND — a one-shot given up on ('skip-stale').
  // Every other job outcome already spoke; the one meaning "this will never
  // happen", the only one the user must act on, was silent.
  "job_missed",
  // 🚫 relay.ts MISSED_KIND, swept from index.ts (relay-missed.ts) — an
  // invoke envelope no device ever polled, now past the relay's retention
  // window. use_device had already promised "The task was delivered".
  "device_missed",
] as const;

/**
 * Keys longest-first, so a kind keyed IN FULL always beats a shorter prefix key
 * that also matches it (`job_missed` over `job`). Computed once at module load,
 * not per call — this runs for every row of every HUD render.
 */
const KIND_KEYS_BY_SPECIFICITY = Object.keys(KIND_ICONS).sort((a, b) => b.length - a.length);

export function iconFor(kind: string): string {
  // Coerce: the runtime value comes straight from the worker event payload
  // (ActivityHUD passes e.kind unvalidated), so a missing/non-string kind would
  // throw on .startsWith and crash the HUD render. String() makes the fallback
  // ⚡ the graceful degrade for a malformed kind.
  const k = String(kind ?? "");
  for (const key of KIND_KEYS_BY_SPECIFICITY) {
    if (k.startsWith(key)) return KIND_ICONS[key];
  }
  return "⚡";
}
