/**
 * Pending-attachment honesty (v5 D2). c43 taught the composer to remember
 * your unsent words; the files staged beside them still vanish. You pick
 * three photos, tab away, come back — the draft text is there, the paperclip
 * row is empty, and nothing ever said so. Worse than losing them is losing
 * them invisibly: the draft reads "here are the shots you asked for" with no
 * shots, and hitting send delivers that.
 *
 * We deliberately do NOT persist the payloads. base64/dataUrl are exactly
 * what `persistableAttachments` strips before every transcript write, for the
 * quota reason c33 made expensive to relearn — a few camera shots would evict
 * the conversation itself. (IndexedDB could hold them for real; that's a
 * bigger cycle than this, and the note in the backlog stays.)
 *
 * So we persist the RECEIPT — names only, tiny — and the composer tells you
 * what it couldn't keep. A user who knows can re-pick in two taps; a user who
 * doesn't sends an empty promise.
 */
export const pendingAttachmentsKey = (name: string) => `chat_pending_files_${name}`

/** Names only, and few: this is a notice, not an inventory. */
export const MAX_REMEMBERED = 6
const MAX_NAME_LEN = 60

export type PendingReceipt = { names: string[]; count: number }

export type ReceiptWrite =
  | { action: 'write'; value: PendingReceipt }
  | { action: 'remove' }

/**
 * `count` is the TRUE total even when `names` is capped — "3 more" is only
 * honest if the count isn't the truncated one.
 */
export function receiptFor(attachments: { name?: string }[] | undefined): ReceiptWrite {
  if (!attachments?.length) return { action: 'remove' }
  const names = attachments
    .slice(0, MAX_REMEMBERED)
    .map((a) => (a.name || 'file').slice(0, MAX_NAME_LEN))
  return { action: 'write', value: { names, count: attachments.length } }
}

/** Shape-guarded read — a corrupt or hand-edited key must not reach the UI. */
export function parseReceipt(raw: string | null): PendingReceipt | null {
  if (!raw) return null
  try {
    const r = JSON.parse(raw)
    if (!r || !Array.isArray(r.names)) return null
    const names = r.names.filter((n: unknown) => typeof n === 'string' && n).slice(0, MAX_REMEMBERED)
    const count = typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0
      ? Math.floor(r.count)
      : names.length
    if (count === 0) return null
    // A count below the names we hold is incoherent (hand-edited) — trust the
    // names, which are the part we show.
    return { names, count: Math.max(count, names.length) }
  } catch { return null }
}

/**
 * The sentence the composer shows once, on restore. Returns null when there's
 * nothing to say — including when files are ALREADY staged (a fresh pick, or
 * the same tab that never went away: telling someone their files are gone
 * while they can see them is worse than silence).
 */
export function describeLostAttachments(
  receipt: PendingReceipt | null,
  stagedNow: number,
): string | null {
  if (!receipt || stagedNow > 0) return null
  const shown = receipt.names.slice(0, 3)
  const hidden = receipt.count - shown.length
  const list = shown.join(', ')
  const tail = hidden > 0 ? ` and ${hidden} more` : ''
  const noun = receipt.count === 1 ? 'file' : 'files'
  return `📎 ${receipt.count} ${noun} didn't survive the reload — re-attach ${list}${tail} before sending.`
}
