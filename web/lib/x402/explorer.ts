/**
 * 🔗 EXPLORER LINK PRESENTATION — what to CALL the chain explorer a receipt links
 * to, and which URLs are safe to link at all.
 *
 * The last corner of the self-hosted chain's client copy (docs/e2e-gaps-report-
 * 2026-07-25.md §1.2 items 6/7). The server already got this right: every
 * explorer URL is derived from the network WE signed for — `explorerTxUrl` in
 * lib/x402/payer.ts, `explorerFor` in the withdraw route, `tinyExplorerTxUrl`
 * for a self-hosted deployment — and is OMITTED entirely when the chain has no
 * explorer configured. So the URL a client receives is always correct.
 *
 * The LABEL is not. All five render sites hardcode "View on BaseScan" (web
 * PayReceipt, iOS PayQuote + Wallet, Android PayReceiptCard + Wallet), including
 * two Android `onClickLabel` accessibility strings. On a `tiny` deployment with
 * `TINY_CHAIN_EXPLORER_URL` set, the user taps a link to their own Blockscout
 * and is told it's BaseScan — the same class of lie as the on-ramps c-g deleted,
 * except here the user follows it and lands somewhere that doesn't match what
 * they were promised. A screen reader user gets it twice.
 *
 * The name is derived from the URL's HOST, not from the payment's network field.
 * Three reasons, and they're the content of this module:
 *
 *  1. The network name doesn't determine the explorer. `tiny` + a Blockscout at
 *     `explorer.lan:4000` and `tiny` + no explorer at all are the same network;
 *     only the URL distinguishes them.
 *  2. The network field is optional at every render site (PayReceipt reads
 *     `settled.network || active?.network`, iOS persists `network: String?`), and
 *     a label must not disappear because a receipt was thin.
 *  3. A brand name we never emit is a name we'd be guessing. Only `basescan.org`
 *     is special-cased, because that's the only brand this codebase produces; for
 *     anything else the HOST is the one thing that is always true.
 *
 * `explorerHref` is the load-bearing half and NOT cosmetic. The web card renders
 * `<a href={explorer}>` straight from the JSON, so a non-http scheme in that
 * field would be a script-execution sink. It is first-party today (server-derived
 * from an env var, never service-supplied), so this is a latent hole rather than
 * a live bug — but the label work has to parse the URL anyway, and a parse that
 * refuses `javascript:` costs nothing over one that ignores it.
 *
 * PURE (no DOM, no fetch, no env) so all three clients can converge on the same
 * decisions and they can be asserted instead of eyeballed.
 */

/** Hosts whose brand we actually emit — see `explorerTxUrl` / `explorerFor`. */
const BASESCAN = /(^|\.)basescan\.org$/

/**
 * A host safe to put in a label: ASCII only, and short enough not to blow up a
 * caption. Unicode hosts arrive from `URL` already punycoded (`xn--…`), which is
 * the SAFE form to display — decoding it would render a homograph of a host the
 * user isn't visiting — but a 200-character punycode label still breaks the card,
 * so an unshowable host degrades to the generic wording rather than to nothing.
 *
 * `_` is in the set on purpose: underscores are illegal in hostnames and routine
 * on an internal network (`my_explorer.lan`), which is exactly the deployment
 * this work is for. It is NOT in the set on the parse side of any client — all
 * three keep such a host — so excluding it here would have made web the only
 * client that refused to name a reachable self-hosted explorer.
 */
const HOST_OK = /^[a-z0-9._:-]{1,40}$/

/**
 * The URL a client may actually link to, or '' — the security gate.
 *
 * http/https only, and it must parse. Everything else ('' , `javascript:…`,
 * `data:…`, a bare word, a non-string) yields '' so the caller renders no link
 * at all. Callers should use the RETURNED string as the href, not their original
 * value, so the check and the navigation can't diverge.
 */
export const explorerHref = (url: unknown): string => {
  if (typeof url !== 'string' || !url) return ''
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? url : ''
}

/**
 * Display name for the explorer at `url` — 'BaseScan', else its host, else ''.
 *
 * '' means "there is a link but we can't name it", which is the generic-wording
 * case, NOT the no-link case (that's `explorerHref` returning '').
 */
export const explorerName = (url: unknown): string => {
  const href = explorerHref(url)
  if (!href) return ''
  const u = new URL(href)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (BASESCAN.test(host)) return 'BaseScan'
  // The port belongs in the label when there is one: a self-hosted explorer is
  // typically `http://host:4000`, and "View on 127.0.0.1" would name a different
  // thing than the link opens.
  const shown = u.port ? `${host}:${u.port}` : host
  return HOST_OK.test(shown) ? shown : ''
}

/**
 * The link text. "View on BaseScan" on Base, "View on explorer.lan:4000" on a
 * self-hosted chain, and "View transaction" when the host isn't nameable.
 *
 * No trailing arrow/glyph — each client adds its own ("→" on web, an SF Symbol
 * on iOS, "↗" on Android), and baking one in would either double up or force the
 * others to strip it.
 */
export const explorerLinkLabel = (url: unknown): string => {
  const name = explorerName(url)
  return name ? `View on ${name}` : 'View transaction'
}

/**
 * The screen-reader / long-press phrasing, as a verb phrase. Android passes this
 * to `onClickLabel` and iOS to `accessibilityLabel`; both currently say
 * "BaseScan" unconditionally, so a VoiceOver/TalkBack user hears the wrong chain
 * with no way to see the URL and catch it.
 */
export const explorerOpenHint = (url: unknown): string => {
  const name = explorerName(url)
  return name ? `open the transaction on ${name}` : 'open the transaction in the block explorer'
}
