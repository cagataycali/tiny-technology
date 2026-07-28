/**
 * Composer draft persistence (fresh-lens survey c43): web was the only client
 * that threw away what you'd typed. iOS keeps the composer text and Android
 * mirrors it to SharedPreferences on every keystroke — on the web a reload, a
 * crash, an accidental ⌘W, or a tap through to /wallet mid-sentence lost a
 * long unsent message with no trace. The transcript has survived reloads since
 * forever (chat_messages_<name>); the sentence you hadn't sent yet did not.
 *
 * Deliberately per-tiny (like the transcript): a draft to one tiny shouldn't
 * surface in another's composer.
 */
export const draftKey = (name: string) => `chat_draft_${name}`

/**
 * Cap: a draft is a convenience, not an archive, and it shares the ~5MB
 * localStorage budget with the transcript — which is the thing that must not
 * be evicted. Matches Android's composer-draft cap.
 */
export const DRAFT_MAX = 8000

export type DraftWrite = { action: 'write'; value: string } | { action: 'remove' }

/**
 * Whitespace-only is not a draft — it must REMOVE, not write, or clearing the
 * composer would leave the old text behind to be restored on the next load.
 * The stored value keeps the user's exact text (leading newlines and all);
 * only the emptiness TEST is trimmed.
 */
export function draftWrite(text: string): DraftWrite {
  if (!text || !text.trim()) return { action: 'remove' }
  return { action: 'write', value: text.slice(0, DRAFT_MAX) }
}

export type DraftRestoreInput = {
  saved: string | null
  /** ?q= present — the deep link owns the composer, it's a fresher intent. */
  hasDeepLink: boolean
  /** Read-only share view: its composer isn't the visitor's own. */
  viewingShare: boolean
  /** Never overwrite text the user has already started typing this mount. */
  currentInput: string
}

/** The text to restore, or null to leave the composer alone. */
export function draftRestore(input: DraftRestoreInput): string | null {
  if (input.hasDeepLink || input.viewingShare) return null
  if (input.currentInput) return null
  const saved = input.saved
  if (!saved || !saved.trim()) return null
  return saved.slice(0, DRAFT_MAX)
}
