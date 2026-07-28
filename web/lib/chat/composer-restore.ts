/**
 * Giving a declined send's payload back to the composer (fresh-lens survey c70,
 * item G3 — "what was CONSUMED on the first attempt?").
 *
 * G3 asked which failures burn a one-shot resource even when the user is told
 * and their text survives. Three candidates were named and all three came back
 * clean on inspection: `liveCallRef` clears itself on `ended`/`error`,
 * `toggleVoiceMode`'s catch calls `stopVoiceMode()` (which resets the ref), and
 * the two ambient `finally` cooldowns are rate-limiting, not a claim about work
 * done. The real one was next door:
 *
 *   `onSubmit` calls `setAttachments([])` BEFORE `send(...)`, and the offline
 *   gate's restore only ever put the TEXT back — while its toast said "your
 *   message is still in the composer".
 *
 * So a user offline with a picked or pasted file lost the file, was told
 * everything was kept, and had no way to know. Words come back, files don't.
 * ⚠️ And a PASTED image (handlePaste → handleIngestFiles) has no source file to
 * re-pick, so unlike a drag-and-drop it cannot be reproduced at all.
 *
 * Same rule as the draft restore and c70's `/auto` restore: never clobber what
 * the user has done SINCE. An ingest that landed while this send was in flight
 * is newer than the payload we're handing back, so it wins.
 */

/**
 * Whether to write the declined payload back into the composer's attachment
 * list, and what the list should become.
 *
 * Generic over the attachment shape on purpose — this module decides *whether*
 * to restore, and has no business knowing what an attachment contains.
 */
export function restoreAttachments<T>(
  declined: readonly T[] | undefined,
  current: readonly T[],
): { restore: false } | { restore: true; next: T[] } {
  if (!declined || declined.length === 0) return { restore: false }
  // Something arrived while the send was in flight — theirs is newer than ours.
  if (current.length > 0) return { restore: false }
  return { restore: true, next: [...declined] }
}

/**
 * What the offline toast may claim was kept. Derived from the SAME inputs the
 * restore decision uses, so the copy cannot drift from the behaviour: if this
 * says "files", `restoreAttachments` restored them (or the user's own newer
 * files are already there — either way files are in the composer).
 */
export function keptSummary(hadText: boolean, hadAttachments: boolean): 'message and files' | 'files' | 'message' {
  if (hadAttachments) return hadText ? 'message and files' : 'files'
  return 'message'
}
