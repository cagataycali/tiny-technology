package technology.tiny.app.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The explorer link — the last place an Android user reads Base's name on a chain
 * that isn't Base.
 *
 * PayReceiptCard's `ExplorerLink` and Wallet's payout link both rendered
 * "↗ View on BaseScan" with `onClickLabel = "open the transaction on BaseScan"`
 * while the URL beside them came from the server's deployment-correct derivation.
 * On a self-hosted chain with an explorer configured, the label and the
 * destination disagreed — and the TalkBack announcement disagreed too, which is
 * the copy a user has no way to double-check.
 *
 * What's pinned here is what a screenshot can't check: that a lookalike host is
 * never called BaseScan, that losing the NAME never costs the user the LINK, and
 * that `uriHandler.openUri` isn't handed a scheme nobody vetted.
 */
class WalletExplorerTest {

    private val TX = "0x" + "ab".repeat(32)

    // -- explorerHref: which URLs may be opened at all --

    @Test fun `http and https pass through — the returned string is the checked one`() {
        assertEquals("https://basescan.org/tx/$TX", WalletCore.explorerHref("https://basescan.org/tx/$TX"))
        // http, not only https: a self-hosted explorer on a LAN typically has no
        // TLS, and refusing it would drop the proof link on the very deployment
        // this track exists for.
        assertEquals("http://127.0.0.1:4000/tx/0xabc", WalletCore.explorerHref("http://127.0.0.1:4000/tx/0xabc"))
    }

    @Test fun `a non-http scheme is refused — openUri resolves an intent for anything`() {
        assertNull(WalletCore.explorerHref("javascript:alert(1)"))
        assertNull(WalletCore.explorerHref("data:text/html,<script>alert(1)</script>"))
        assertNull(WalletCore.explorerHref("intent://scan/#Intent;scheme=zxing;end"))
        assertNull(WalletCore.explorerHref("file:///data/data/technology.tiny.app/x"))
        // Case and surrounding whitespace must not defeat the check — it runs on a
        // PARSED URI's lowercased scheme, not on a prefix test of the raw string.
        assertNull(WalletCore.explorerHref("  JavaScript:alert(1)"))
    }

    @Test fun `null, empty, relative and host-less strings yield no link`() {
        assertNull(WalletCore.explorerHref(null))
        assertNull(WalletCore.explorerHref(""))
        assertNull(WalletCore.explorerHref("   "))
        assertNull(WalletCore.explorerHref("basescan.org/tx/0xabc")) // scheme-less
        assertNull(WalletCore.explorerHref("/tx/0xabc")) // relative
        // Parses, but has no host: opening it shows a blank page, which is worse
        // than showing no link.
        assertNull(WalletCore.explorerHref("http:///tx/0xabc"))
    }

    // -- explorerName: the brand we emit, else the host, else nothing --

    @Test fun `BaseScan on both Base deployments — the only brand this repo emits`() {
        assertEquals("BaseScan", WalletCore.explorerName("https://basescan.org/tx/$TX"))
        // Sepolia's explorer IS BaseScan; the subdomain is the network, not a
        // different product, so the label must not read "sepolia.basescan.org".
        assertEquals("BaseScan", WalletCore.explorerName("https://sepolia.basescan.org/tx/$TX"))
        assertEquals("BaseScan", WalletCore.explorerName("https://www.basescan.org/tx/$TX"))
    }

    @Test fun `a lookalike host is NOT called BaseScan`() {
        // A `contains` check would have named both of these BaseScan. The FULL host
        // is shown rather than a registrable-domain reduction: hiding the
        // suspicious prefix defeats the point of naming the destination.
        assertEquals("basescan.org.evil.tld", WalletCore.explorerName("https://basescan.org.evil.tld/tx/0xabc"))
        assertEquals("notbasescan.org", WalletCore.explorerName("https://notbasescan.org/tx/0xabc"))
        assertEquals("View on notbasescan.org", WalletCore.explorerLinkLabel("https://notbasescan.org/tx/0xabc"))
    }

    @Test fun `a self-hosted explorer is named by host, port included`() {
        // The port is part of the identity: "View on 127.0.0.1" would name a
        // different service than the link opens.
        assertEquals("127.0.0.1:4000", WalletCore.explorerName("http://127.0.0.1:4000/tx/0xabc"))
        assertEquals("explorer.lan", WalletCore.explorerName("https://explorer.lan/tx/0xabc"))
        assertEquals("explorer.internal.example", WalletCore.explorerName("https://Explorer.Internal.Example/tx/0xabc"))
    }

    @Test fun `the HOST is named, never a userinfo prefix — the one spoof our own label could carry`() {
        // `https://basescan.org@evil.tld/tx/…` goes to evil.tld, and java.net.URI's
        // AUTHORITY is the whole "basescan.org@evil.tld" — so unlike web's
        // URL.hostname and Foundation's URL.host, Android has to strip the userinfo
        // by hand. Without the strip, our own label would read "View on
        // basescan.org@evil.tld"… and the BaseScan branch would not even be the
        // problem; the label itself becomes the spoof.
        assertEquals("evil.tld", WalletCore.explorerName("https://basescan.org@evil.tld/tx/0xabc"))
        assertEquals("View on evil.tld", WalletCore.explorerLinkLabel("https://basescan.org@evil.tld/tx/0xabc"))
    }

    @Test fun `an underscore host is kept — illegal in DNS, routine on a LAN`() {
        // java.net.URI's HOST is null here (underscores aren't legal in a
        // server-based authority), which is why the gate reads `authority`: a
        // host-gated check would have dropped the proof link on Android only, on
        // exactly the internal-network deployment this work is for.
        assertEquals("my_explorer.lan:4000", WalletCore.explorerName("http://my_explorer.lan:4000/tx/0xabc"))
        assertEquals("View on my_explorer.lan:4000", WalletCore.explorerLinkLabel("http://my_explorer.lan:4000/tx/0xabc"))
        assertNotNull(WalletCore.explorerHref("http://my_explorer.lan:4000/tx/0xabc"))
    }

    @Test fun `an IPv6 literal is not named — the three clients cannot agree on its shape`() {
        // Authority is "[::1]:8545" here; web's URL keeps "[::1]" and Foundation
        // strips to "::1". Naming it would print a different string on each client,
        // so all three decline — the LINK still works everywhere.
        assertEquals("", WalletCore.explorerName("http://[::1]:8545/tx/0xabc"))
        assertEquals("View transaction", WalletCore.explorerLinkLabel("http://[::1]:8545/tx/0xabc"))
        assertNotNull(WalletCore.explorerHref("http://[::1]:8545/tx/0xabc"))
    }

    @Test fun `an unshowable host loses its NAME but never its LINK`() {
        val long = "https://" + "x".repeat(60) + ".example/tx/0xabc"
        assertEquals("", WalletCore.explorerName(long))
        assertEquals("View transaction", WalletCore.explorerLinkLabel(long))
        // The proof link is still perfectly good — degrading a caption must not
        // cost the user their receipt.
        assertNotNull(WalletCore.explorerHref(long))
    }

    // -- the two strings the composables actually render --

    @Test fun `today's Base copy is reproduced exactly — this change alters no Base UI`() {
        // The five hardcoded strings were the Base ANSWER, not the question.
        // Anything else here would be a regression dressed as a fix.
        assertEquals("View on BaseScan", WalletCore.explorerLinkLabel("https://basescan.org/tx/$TX"))
        assertEquals("View on BaseScan", WalletCore.explorerLinkLabel("https://sepolia.basescan.org/tx/$TX"))
        assertEquals("open the transaction on BaseScan", WalletCore.explorerOpenHint("https://basescan.org/tx/$TX"))
    }

    @Test fun `the self-hosted explorer is named instead of Base — in the TalkBack hint too`() {
        assertEquals("View on 127.0.0.1:4000", WalletCore.explorerLinkLabel("http://127.0.0.1:4000/tx/0xabc"))
        assertEquals(
            "open the transaction on 127.0.0.1:4000",
            WalletCore.explorerOpenHint("http://127.0.0.1:4000/tx/0xabc"),
        )
    }

    @Test fun `the fallback is true on every chain and never empty`() {
        // A caller that decided to render a link must always get text for it; an
        // empty label would ship a tappable void.
        assertEquals("View transaction", WalletCore.explorerLinkLabel(null))
        assertEquals("View transaction", WalletCore.explorerLinkLabel(""))
        assertEquals("open the transaction in the block explorer", WalletCore.explorerOpenHint(null))
    }

    @Test fun `no glyph is baked in — each client adds its own`() {
        // Android prepends "↗", web appends "→", iOS uses an SF Symbol.
        for (url in listOf("https://basescan.org/tx/$TX", "http://127.0.0.1:4000/tx/0xabc", "")) {
            assertFalse(WalletCore.explorerLinkLabel(url).contains("↗"))
            assertFalse(WalletCore.explorerLinkLabel(url).contains("→"))
            assertFalse(WalletCore.explorerOpenHint(url).contains("↗"))
        }
    }

    @Test fun `never says BaseScan for a link that does not go to BaseScan`() {
        // The regression this exists to prevent, as one assertion over every
        // non-Base shape a deployment can produce.
        for (url in listOf(
            "http://127.0.0.1:4000/tx/0xabc",
            "https://explorer.lan/tx/0xabc",
            "https://blockscout.internal:8080/tx/0xabc",
            "",
            null,
        )) {
            assertFalse(WalletCore.explorerLinkLabel(url).lowercase().contains("basescan"))
            assertFalse(WalletCore.explorerOpenHint(url).lowercase().contains("basescan"))
        }
    }

    @Test fun `a real payout URL from the withdraw route survives the round trip`() {
        // The exact shape WalletCore.parseWithdraw hands the composable on a 202
        // (see WalletCoreTest's pending_confirmation case) — the label pipeline has
        // to accept the values our own server produces, not just synthetic ones.
        val paid = WalletCore.explorerHref("https://basescan.org/tx/0xabc")
        assertEquals("View on BaseScan", WalletCore.explorerLinkLabel(paid))
        // …and the same route's tiny-chain output, which is what changes.
        val tiny = WalletCore.explorerHref("http://localhost:4000/tx/0xabc")
        assertEquals("View on localhost:4000", WalletCore.explorerLinkLabel(tiny))
    }
}
