/**
 * ?q= deep-link decision (extracted from Chat.tsx's mount effect) — shared
 * "ask my AI" links land on an answer, not an unsent input box.
 *
 * Rules: ?q= auto-sends unless &send=0 (prefill only); a locked private tiny
 * or a share view never auto-sends on someone else's behalf — prefill so the
 * question survives login. No query → nothing.
 *
 * Pure so the once-per-(tiny, query) guard in Chat.tsx stays a two-liner:
 * the old module-scope one-shot flag ran ONCE PER JS SESSION, so client-side
 * nav to a second tiny with ?q= silently dropped the deep link entirely.
 */
export type DeepLinkDecision =
  | { action: 'none' }
  | { action: 'prefill'; text: string }
  | { action: 'send'; text: string }

export function decideDeepLink(args: {
  query?: string | null
  search: string // window.location.search
  locked: boolean // private tiny, not yet authorized
  viewingShare: boolean
}): DeepLinkDecision {
  if (!args.query) return { action: 'none' }
  const autoSend = new URLSearchParams(args.search).get('send') !== '0'
  if (autoSend && !args.locked && !args.viewingShare) return { action: 'send', text: args.query }
  return { action: 'prefill', text: args.query }
}

/** Strip ?q= and &send= before sending so a refresh doesn't re-ask. */
export function stripDeepLinkParams(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('q')
  url.searchParams.delete('send')
  return url.toString()
}
