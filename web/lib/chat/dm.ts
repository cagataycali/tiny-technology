/**
 * DM thread-state helpers (extracted from MessagesHUD so the poll/send race
 * rules are pure + unit-tested — they've bitten twice: a stale poll vanished
 * a just-sent message, and a repeated poll drained the unread badge).
 */

export type DmMessage = {
  id: number;
  direction: "sent" | "received";
  body: string;
  viaTiny?: string;
  created: number;
};

export type DmThread = {
  userId: string;
  login: string;
  name: string;
  avatar: string;
  unread: number;
  lastBody: string;
  lastAt: number;
};

/**
 * Decide what the thread view should show after a poll response lands.
 *
 * Stale-response guard: a poll that left BEFORE a send committed can land
 * AFTER the optimistic append — server ids are monotonic (D1 autoincrement),
 * so a response whose tail is OLDER than what's rendered is stale: keep
 * current state. Optimistic fallback ids are negative (unique per send,
 * below every real id) so a missing server id can't hold this guard hostage.
 */
export function mergeThreadPoll(prev: DmMessage[], next: DmMessage[]): { messages: DmMessage[]; hasNew: boolean } {
  const prevMax = prev.length ? prev[prev.length - 1].id : 0;
  const nextMax = next.length ? next[next.length - 1].id : 0;
  if (prevMax > nextMax) return { messages: prev, hasNew: false };
  const hasNew =
    next.length > prev.length ||
    (next.length > 0 && prev.length > 0 && next[next.length - 1].id !== prev[prev.length - 1].id);
  return { messages: next, hasNew };
}

/**
 * Zero the open thread's unread and DERIVE the badge total from the result.
 * Derivation (not decrement) keeps repeated polls idempotent — subtracting a
 * frozen per-open count on every tick drained other threads' badge counts.
 *
 * Match on userId OR login: inbox threads key on the opaque user id, but the
 * ?dm=<login> deep-link opens a peer whose userId IS the login string. Without
 * the login fallback that thread never matched, so its badge only cleared on
 * the next full inbox poll.
 */
export function markThreadRead(threads: DmThread[], peerId: string): { threads: DmThread[]; unread: number } {
  const updated = threads.map((t) => (t.userId === peerId || t.login === peerId ? { ...t, unread: 0 } : t));
  return { threads: updated, unread: updated.reduce((n, t) => n + (t.unread || 0), 0) };
}

/** Optimistic id for a send whose response carried no server id: unique per
 *  send but NEGATIVE, so it sorts below every real D1 id (see mergeThreadPoll). */
export function optimisticId(serverId: unknown, now: number = Date.now()): number {
  return Number(serverId) || -now;
}
