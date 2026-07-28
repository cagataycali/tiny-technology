/**
 * Per-peer DM draft keeping (fresh-lens survey c68 — lens = "a value scoped to
 * one SUBJECT still on screen after the subject changed").
 *
 * 🔴 THE DEFECT THIS REPLACES SENT A PRIVATE MESSAGE TO THE WRONG PERSON.
 * `MessagesHUD` held ONE `draft` string for every conversation. Each peer
 * transition — an inbox row click, ← back, Escape, a `?dm=` deep link — reset
 * `msgs` and `threadLoaded` and left `draft` exactly where it was. So the
 * composer rendered `placeholder="Message B…"` and `aria-label="Message B"`
 * over text written for A, and `send()` reads the peer that is open NOW. One
 * tap of ↑ (or Enter, which is wired) delivered A's message to B, with the only
 * warning being text the user had already stopped looking at.
 *
 * That file already knew this was harmful in the other direction: its send
 * guard is commented "…`setDraft("")` wipes the reply now being typed there".
 * It protected against CLEARING the wrong thread's draft and not against
 * CARRYING one into the wrong thread — which is the half that misdirects.
 *
 * Keeping drafts per peer (rather than clearing on every switch) is the same
 * call `draft.ts` made for the main composer: a half-written reply is worth
 * something, and hopping to the inbox to check a name is a normal thing to do
 * mid-sentence. Restoring it under the right name is strictly better than
 * either dropping it or showing it under the wrong one.
 *
 * ⚠️ Deliberately IN-MEMORY, unlike `draft.ts`'s localStorage-backed composer.
 * Durability across reloads is a different lens (v5 D1) and it would need a
 * `chat_dm_draft_*` family in `local-keys.ts` with its own erase-cost note;
 * the harm here is misdirection WITHIN a session. If a later cycle wants
 * persistence, the key function below is already the right key.
 */

/**
 * Matches the composer's own `maxLength={2000}` (MessagesHUD input), so a
 * restored draft can never be longer than what the field would have accepted.
 *
 * ⚠️ Not the same cap as `app/api/messages/route.ts`'s `message.slice(0, 2000)`
 * — that one is a SILENT server-side truncation and is tracked separately as
 * backlog v9 A2 (a cross-client change). This one only bounds what we hold.
 */
export const DM_DRAFT_MAX = 2000

/**
 * How many peers' drafts to retain. Bounded because the map lives for the whole
 * page session and nothing ever prunes it otherwise; the one being dropped is
 * always the least-recently-typed, and the one on screen was by definition just
 * touched, so it can never be the victim.
 */
export const DM_DRAFT_KEEP = 20

export type DmDrafts = Record<string, string>

/**
 * The identity a draft is filed under.
 *
 * MUST be `login || userId` — the same identity `loadThread` fetches with and
 * `markThreadRead` matches on. The `?dm=<login>` deep-link peer carries
 * `userId = login` while the inbox row for the same person carries a numeric
 * id, so keying on the raw `userId` would file two drafts for one conversation
 * and the deep-linked view would look empty. (Exactly the bug that once left
 * the unread badge lit — see MessagesHUD's markThreadRead comment.)
 */
export function dmDraftKey(peer: { login?: string; userId: string } | null | undefined): string | null {
  if (!peer) return null
  const key = peer.login || peer.userId
  return key ? String(key) : null
}

/** The draft for `key`, or '' — never undefined, so it can feed a value= directly. */
export function getDmDraft(drafts: DmDrafts, key: string | null): string {
  if (!key) return ''
  return drafts[key] ?? ''
}

/**
 * Record `text` against `key`.
 *
 * Whitespace-only REMOVES rather than writes (the `draft.ts` rule): otherwise
 * clearing the composer and switching away would restore the old text on the
 * way back, which is the same surprise in slow motion. The stored value keeps
 * the user's exact text; only the emptiness test is trimmed.
 *
 * Re-writing an existing key refreshes its recency, so the trim below evicts by
 * last-typed rather than first-seen.
 */
export function setDmDraft(drafts: DmDrafts, key: string | null, text: string): DmDrafts {
  if (!key) return drafts
  if (!text || !text.trim()) return clearDmDraft(drafts, key)

  // Delete-then-insert: object key order is insertion order, and an in-place
  // overwrite would keep the ORIGINAL position — making the trim evict the
  // draft you are actively typing in a long session.
  const next: DmDrafts = { ...drafts }
  delete next[key]
  next[key] = text.slice(0, DM_DRAFT_MAX)

  const keys = Object.keys(next)
  if (keys.length > DM_DRAFT_KEEP) {
    for (const stale of keys.slice(0, keys.length - DM_DRAFT_KEEP)) delete next[stale]
  }
  return next
}

/**
 * Forget `key`'s draft.
 *
 * Callers clear by the key they SENT to, not by whatever is on screen when the
 * POST resolves — switching threads during an in-flight send used to leave the
 * delivered text in the shared draft, where it reappeared under the new peer's
 * name. Both stale and misdirected.
 */
export function clearDmDraft(drafts: DmDrafts, key: string | null): DmDrafts {
  if (!key || !(key in drafts)) return drafts
  const next = { ...drafts }
  delete next[key]
  return next
}
