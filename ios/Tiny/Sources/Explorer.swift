/**
 * 🔗 EXPLORER LINK PRESENTATION (iOS) — what to CALL the chain explorer a receipt
 * links to, and which URLs are safe to link at all.
 *
 * Port of `lib/x402/explorer.ts` (web) / `WalletCore.explorer*` (Android), the
 * last corner of the self-hosted chain's client copy. The server already derives
 * every explorer URL from the network WE signed for and omits it entirely when
 * the chain has no explorer configured, so the URL iOS receives is correct. The
 * LABEL is not: PayQuote says "View on BaseScan →" and Wallet says "View on
 * BaseScan" unconditionally, so on a `tiny` deployment with an explorer the user
 * taps through to their own Blockscout having been told it's Base's.
 *
 * The name comes from the URL's HOST, not from `PaySettled.network`. That field
 * is optional at both sites, and it wouldn't answer the question anyway — `tiny`
 * with a Blockscout at `explorer.lan:4000` and `tiny` with no explorer at all are
 * the same network; only the URL distinguishes them. Only `basescan.org` is
 * special-cased, because that's the one brand this codebase emits; for anything
 * else the host is the one thing that's always true.
 *
 * `href` is the load-bearing half. Both sites did `URL(string: explorer)`, which
 * on Apple platforms happily builds `javascript:…` and `data:…` URLs — and
 * SwiftUI `Link` hands whatever it's given to `openURL`. The field is
 * first-party today (server-derived from an env var), so that's a latent hole
 * rather than a live bug, but the label work parses the URL regardless.
 *
 * PURE (no SwiftUI, no URLSession) so the decisions can be asserted in
 * ExplorerTests instead of eyeballed on a device, and so all three clients answer
 * identically.
 */
import Foundation

enum Explorer {

    /// Longest host we'll put in a caption. A unicode host arrives from
    /// `URL.host` already punycoded (`xn--…`) — the SAFE form to display, since
    /// decoding would render a homograph of a domain the user isn't visiting —
    /// but a 200-character one would wreck the card, so an unshowable host
    /// degrades to the generic wording rather than to nothing.
    private static let maxHostLength = 40

    /**
     * The URL a client may actually open, or nil — the security gate.
     *
     * http/https only, and it must parse into something with a host. Callers must
     * use the RETURNED URL, not `URL(string:)` on their original value, so the
     * check and the navigation can't diverge.
     */
    static func href(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, let u = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        guard let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        // http(s) with no host is nonsense ("http:///tx/0x…") and would open a
        // blank sheet; treat it as no link at all.
        guard let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    /**
     * Display name for the explorer at `raw` — "BaseScan", else its host, else ""
     * (meaning "there's a link but we can't name it", NOT "there's no link").
     */
    static func name(_ raw: String?) -> String {
        guard let u = href(raw), var host = u.host?.lowercased() else { return "" }
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        // Suffix match on a DOT boundary, never `contains`: `basescan.org.evil.tld`
        // and `notbasescan.org` are different sites, and calling either one
        // BaseScan is what makes a wrong label dangerous instead of sloppy.
        if host == "basescan.org" || host.hasSuffix(".basescan.org") { return "BaseScan" }
        // An IPv6 literal is dropped to the generic wording rather than named.
        // Foundation hands back a BRACKETLESS host ("::1") where web's `URL` keeps
        // "[::1]" and java.net.URI's authority keeps "[::1]:8545" — so appending
        // the port here would print "::1:8545", a string that reads as neither an
        // address nor a port, and iOS would be the only client naming it at all.
        guard !host.contains(":") else { return "" }
        // The port belongs in the label when there is one — a self-hosted
        // explorer is typically `http://host:4000`, and "View on 127.0.0.1" would
        // name a different service than the link opens.
        let shown = u.port.map { "\(host):\($0)" } ?? host
        // `_` is allowed: illegal in a hostname, routine on an internal network
        // (`my_explorer.lan`), and kept by all three clients' parsers — so
        // rejecting it would refuse to name a reachable self-hosted explorer.
        guard shown.count <= maxHostLength,
              shown.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "." || $0 == "-" || $0 == ":" || $0 == "_") })
        else { return "" }
        return shown
    }

    /**
     * The link text. "View on BaseScan" on Base, "View on explorer.lan:4000" on a
     * self-hosted chain, "View transaction" when the host isn't nameable.
     *
     * No trailing arrow/glyph — PayQuote appends "→", Wallet uses an SF Symbol,
     * and web/Android add their own; baking one in would double up.
     */
    static func linkLabel(_ raw: String?) -> String {
        let n = name(raw)
        return n.isEmpty ? "View transaction" : "View on \(n)"
    }

    /**
     * VoiceOver phrasing, as a verb phrase (matches Android's `onClickLabel`).
     * Announcing "BaseScan" to someone who can't see the URL is the one case
     * where a wrong label can't be caught by the user.
     */
    static func openHint(_ raw: String?) -> String {
        let n = name(raw)
        return n.isEmpty ? "open the transaction in the block explorer" : "open the transaction on \(n)"
    }
}
