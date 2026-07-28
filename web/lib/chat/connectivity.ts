/**
 * Offline honesty (v5 D3): nothing in the web app ever consulted
 * `navigator.onLine`, so losing wifi produced "Connection lost: Failed to
 * fetch" — the browser's words for "your own network is down", rendered as
 * though the tiny's server had faulted. The user retries into the same void,
 * or worse, concludes the product is broken.
 *
 * Two moments need the truth, and both are pure decisions here:
 *   1. before a send — don't spend a turn on a request that cannot leave
 *   2. after a stream dies — say which side of the wire failed
 *
 * Web deliberately has NO offline send queue (the service worker caches
 * shells only; iOS/Android own that behaviour). So "offline" ends in the
 * composer, not in an outbox — the c43 draft key already makes text left
 * there survive a reload, which is what makes declining the send safe.
 */

import { keptSummary } from './composer-restore'

/**
 * `navigator.onLine === false` is trustworthy (no route to the network);
 * `true` is NOT (it only means an interface is up — a captive portal or dead
 * uplink still reads online). So this gate only ever fires on the reliable
 * direction, and everything else stays on the existing error path.
 */
export function isDefinitelyOffline(online: boolean | undefined): boolean {
  return online === false
}

export type SendGate =
  | { send: true }
  | { send: false; reason: 'offline'; message: string }

/**
 * `keepsDraft` distinguishes the two callers: a typed submit still holds the
 * user's words (they stay in the composer, so we promise that), while a
 * programmatic send — Retry, a follow-up chip, a deep link — has no composer
 * text to keep and must not claim otherwise.
 *
 * ⚠️ `hadAttachments` (c71) exists because that promise was only half true. The
 * gate says "your message is still in the composer", but `onSubmit` calls
 * `setAttachments([])` BEFORE dispatching, and only the TEXT is put back. Files
 * the user picked, dropped, or pasted were gone — and a PASTED image has no
 * source file to re-pick, so the loss is unrecoverable, not merely annoying.
 * Restoring them is the fix; this message must stop over-claiming either way,
 * because a message that promises a side effect which didn't happen is its own
 * bug (the c70 rule, same shape).
 */
export function gateSend(
  online: boolean | undefined,
  keepsDraft: boolean,
  payload: { hasText?: boolean; hasAttachments?: boolean } = {},
): SendGate {
  if (!isDefinitelyOffline(online)) return { send: true }
  if (!keepsDraft) {
    // Retry / follow-up chip / deep link: no composer text to keep. Attachments
    // cannot arrive on this path (only onSubmit passes them), so nothing to say.
    return { send: false, reason: 'offline', message: "You're offline — reconnect and try again." }
  }
  // A files-only submit is legal (onSubmit accepts attachments with no text), so
  // the copy is derived rather than assumed — naming a message they never typed
  // is the same over-claim in the other direction.
  const kept = keptSummary(payload.hasText !== false, !!payload.hasAttachments)
  const verb = kept === 'message' ? 'is' : 'are'
  return {
    send: false,
    reason: 'offline',
    message: `You're offline — your ${kept} ${verb} still in the composer. Send it when you're back.`,
  }
}

export type FailureInput = {
  online: boolean | undefined
  /** Set by the SSE decoder's [DONE] check — the reply started and got cut. */
  truncated?: boolean
  status?: number
  message?: string
}

/**
 * The toast for a dead stream. A drop that happened while the browser reports
 * itself offline is OUR side of the wire — say so, and don't prefix it with
 * "Connection lost:", which reads as the server hanging up.
 */
export function describeStreamFailure(input: FailureInput): string {
  if (input.truncated) return input.message || 'The reply was cut off — retry to continue.'
  if (isDefinitelyOffline(input.online)) {
    return "You went offline mid-reply — the answer stopped there. Retry when you're back.";
  }
  return `Connection lost: ${input.message || 'stream error'}`
}

/** Retry-banner label: the same distinction, in the four words a banner has. */
export function failureBannerLabel(input: FailureInput & { hasContent: boolean }): string {
  if (isDefinitelyOffline(input.online)) return "You're offline."
  return input.hasContent ? 'Response was cut off.' : 'Response failed.'
}
