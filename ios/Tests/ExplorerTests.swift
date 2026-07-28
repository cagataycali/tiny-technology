/**
 * The explorer link — the last place an iOS user reads Base's name on a chain
 * that isn't Base.
 *
 * Both sites (PayQuote's receipt, Wallet's payout) said "View on BaseScan"
 * unconditionally while the URL beside it came from the server's own
 * deployment-correct derivation. On a self-hosted chain with
 * TINY_CHAIN_EXPLORER_URL set, the label and the destination disagreed — and for
 * a VoiceOver user, the label was the only thing available.
 *
 * What's asserted is what neither a screenshot nor a code read catches: that a
 * lookalike host isn't called BaseScan, that losing the NAME never loses the
 * user's proof LINK, and that `URL(string:)`'s willingness to build a
 * `javascript:` URL stops here rather than at `openURL`.
 */
import Testing
import Foundation
@testable import Tiny

private let TX = "0x" + String(repeating: "ab", count: 32)

@Suite("Explorer.href — which URLs iOS may open at all")
struct ExplorerHrefTests {

    @Test("http and https pass through — the returned URL is the checked one")
    func passesHttpAndHttps() {
        #expect(Explorer.href("https://basescan.org/tx/\(TX)")?.absoluteString == "https://basescan.org/tx/\(TX)")
        // http, not just https: a self-hosted explorer on a LAN typically has no
        // TLS, and refusing it would drop the proof link on the deployment this
        // whole track exists for.
        #expect(Explorer.href("http://127.0.0.1:4000/tx/0xabc")?.absoluteString == "http://127.0.0.1:4000/tx/0xabc")
    }

    @Test("a script-scheme URL is refused — SwiftUI Link would hand it to openURL")
    func refusesScriptSchemes() {
        #expect(Explorer.href("javascript:alert(1)") == nil)
        #expect(Explorer.href("data:text/html,<script>alert(1)</script>") == nil)
        // Case and surrounding whitespace must not defeat the check: the scheme
        // is compared after lowercasing a PARSED URL, not by prefix-testing the
        // raw string.
        #expect(Explorer.href("  JavaScript:alert(1)") == nil)
        #expect(Explorer.href("FILE:///etc/passwd") == nil)
    }

    @Test("nil, empty, relative and host-less strings yield no link")
    func refusesUnusableStrings() {
        #expect(Explorer.href(nil) == nil)
        #expect(Explorer.href("") == nil)
        #expect(Explorer.href("/tx/0xabc") == nil)
        // "http:///tx/…" parses on Apple platforms but has no host; opening it
        // shows a blank sheet, which is worse than showing no link.
        #expect(Explorer.href("http:///tx/0xabc") == nil)
    }
}

@Suite("Explorer.name — the brand we emit, else the host, else nothing")
struct ExplorerNameTests {

    @Test("BaseScan on both Base deployments — the only brand this repo produces")
    func namesBaseScan() {
        #expect(Explorer.name("https://basescan.org/tx/\(TX)") == "BaseScan")
        // Sepolia's explorer IS BaseScan; the subdomain is the network, not a
        // different product, so the label must not read "sepolia.basescan.org".
        #expect(Explorer.name("https://sepolia.basescan.org/tx/\(TX)") == "BaseScan")
        #expect(Explorer.name("https://www.basescan.org/tx/\(TX)") == "BaseScan")
    }

    @Test("a lookalike host is NOT called BaseScan")
    func rejectsLookalikeHosts() {
        // A `contains` check would have called both of these BaseScan. The full
        // host is shown rather than a registrable-domain reduction, because
        // hiding the suspicious prefix defeats the point of naming the place.
        #expect(Explorer.name("https://basescan.org.evil.tld/tx/0xabc") == "basescan.org.evil.tld")
        #expect(Explorer.name("https://notbasescan.org/tx/0xabc") == "notbasescan.org")
    }

    @Test("a self-hosted explorer is named by host, port included")
    func namesSelfHostedByHost() {
        // The port is part of the identity: "View on 127.0.0.1" would name a
        // different service than the link opens.
        #expect(Explorer.name("http://127.0.0.1:4000/tx/0xabc") == "127.0.0.1:4000")
        #expect(Explorer.name("https://explorer.lan/tx/0xabc") == "explorer.lan")
        #expect(Explorer.name("https://Explorer.Internal.Example/tx/0xabc") == "explorer.internal.example")
    }

    @Test("an unshowable host loses its NAME but never its LINK")
    func longHostDegradesToGenericWording() {
        let long = "https://" + String(repeating: "x", count: 60) + ".example/tx/0xabc"
        #expect(Explorer.name(long) == "")
        #expect(Explorer.linkLabel(long) == "View transaction")
        // The proof link itself is still perfectly good — degrading the caption
        // must not cost the user their receipt.
        #expect(Explorer.href(long) != nil)
    }

    @Test("the HOST is named, never a userinfo prefix — the one spoof our label could carry")
    func stripsUserinfo() {
        // `https://basescan.org@evil.tld/tx/…` goes to evil.tld. All three clients
        // parse it the same way; all three must name the destination, not the
        // decoration. (Foundation's URL.host already excludes userinfo — this test
        // pins that, since the Android port has to strip it by hand.)
        #expect(Explorer.name("https://basescan.org@evil.tld/tx/0xabc") == "evil.tld")
        #expect(Explorer.linkLabel("https://basescan.org@evil.tld/tx/0xabc") == "View on evil.tld")
    }

    @Test("an underscore host is kept — illegal in DNS, routine on a LAN")
    func keepsUnderscoreHost() {
        #expect(Explorer.name("http://my_explorer.lan:4000/tx/0xabc") == "my_explorer.lan:4000")
    }

    @Test("an IPv6 literal is not named — the three clients can't agree on its shape")
    func declinesIPv6() {
        // Foundation hands back "::1" (no brackets), web's URL keeps "[::1]", and
        // java.net.URI's authority keeps "[::1]:8545". Naming it would print a
        // different string per client, and appending the port here would produce
        // "::1:8545" — neither an address nor a port. The LINK still works.
        #expect(Explorer.name("http://[::1]:8545/tx/0xabc") == "")
        #expect(Explorer.linkLabel("http://[::1]:8545/tx/0xabc") == "View transaction")
        #expect(Explorer.href("http://[::1]:8545/tx/0xabc") != nil)
    }

    @Test("no link means no name")
    func noLinkNoName() {
        #expect(Explorer.name(nil) == "")
        #expect(Explorer.name("javascript:alert(1)") == "")
    }
}

@Suite("Explorer.linkLabel / openHint — what PayQuote and Wallet render")
struct ExplorerLabelTests {

    @Test("today's Base copy is reproduced exactly — this change alters no Base UI")
    func matchesExistingBaseCopy() {
        #expect(Explorer.linkLabel("https://basescan.org/tx/\(TX)") == "View on BaseScan")
        #expect(Explorer.linkLabel("https://sepolia.basescan.org/tx/\(TX)") == "View on BaseScan")
        #expect(Explorer.openHint("https://basescan.org/tx/\(TX)") == "open the transaction on BaseScan")
    }

    @Test("the self-hosted explorer is named instead of Base")
    func namesSelfHostedDeployment() {
        #expect(Explorer.linkLabel("http://127.0.0.1:4000/tx/0xabc") == "View on 127.0.0.1:4000")
        #expect(Explorer.openHint("http://127.0.0.1:4000/tx/0xabc") == "open the transaction on 127.0.0.1:4000")
    }

    @Test("the fallback is true on every chain and never empty")
    func fallbackIsNeverEmpty() {
        // A caller that decided to render a link must always get text for it; an
        // empty label would ship a tappable void.
        #expect(Explorer.linkLabel(nil) == "View transaction")
        #expect(Explorer.openHint(nil) == "open the transaction in the block explorer")
        #expect(Explorer.linkLabel("") == "View transaction")
    }

    @Test("no arrow or glyph is baked in — each site adds its own")
    func carriesNoGlyph() {
        // PayQuote appends "→", Wallet uses an SF Symbol, Android prepends "↗".
        for url in ["https://basescan.org/tx/\(TX)", "http://127.0.0.1:4000/tx/0xabc", ""] {
            #expect(!Explorer.linkLabel(url).contains("→"))
            #expect(!Explorer.linkLabel(url).contains("↗"))
            #expect(!Explorer.openHint(url).contains("→"))
        }
    }

    @Test("never says BaseScan for a link that doesn't go to BaseScan")
    func neverMisnamesNonBase() {
        // The regression this exists to prevent, as one assertion over every
        // non-Base shape a deployment can produce.
        for url in ["http://127.0.0.1:4000/tx/0xabc", "https://explorer.lan/tx/0xabc",
                    "https://blockscout.internal:8080/tx/0xabc", "", nil] {
            #expect(!Explorer.linkLabel(url).lowercased().contains("basescan"))
            #expect(!Explorer.openHint(url).lowercased().contains("basescan"))
        }
    }
}
