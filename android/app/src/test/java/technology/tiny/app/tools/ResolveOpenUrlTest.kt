package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * resolveOpenUrl — the open_url scheme allowlist (iOS DeviceTools.swift:50 parity),
 * the security boundary that stops an agent from deep-linking this phone into
 * arbitrary apps. Extracted from the impure openUrl() so the allowlist decision +
 * the maps→geo translation are testable off the android.net.Uri parser; openUrl
 * passes it the parsed scheme and gets back the URL to launch, or null to refuse.
 *
 * Non-negotiable: an unknown/dangerous scheme (intent:, file:, javascript:, …)
 * must resolve to null — a regression here would let the agent launch anything.
 */
class ResolveOpenUrlTest {

    @Test fun `allowlisted web and app schemes pass through unchanged`() {
        assertEquals("https://tiny.technology", resolveOpenUrl("https", "https://tiny.technology"))
        assertEquals("http://example.com", resolveOpenUrl("http", "http://example.com"))
        assertEquals("spotify:track:abc", resolveOpenUrl("spotify", "spotify:track:abc"))
        assertEquals("music://album/1", resolveOpenUrl("music", "music://album/1"))
        assertEquals("geo:37.7,-122.4", resolveOpenUrl("geo", "geo:37.7,-122.4"))
    }

    @Test fun `a maps URL is translated to Android's native geo scheme (not dropped)`() {
        // iOS opens `maps:` directly (Apple Maps); Android's native map scheme is `geo:`,
        // so the everything-after-the-colon payload is re-homed under geo: rather than
        // silently refused. The server advertises `maps:` to every client.
        assertEquals("geo:0,0?q=coffee", resolveOpenUrl("maps", "maps:0,0?q=coffee"))
        assertEquals("geo:37.331,-122.031", resolveOpenUrl("maps", "maps:37.331,-122.031"))
    }

    @Test fun `an iOS-only shortcuts scheme has no Android analog and is refused`() {
        // iOS allowlists `shortcuts:` (Shortcuts.app); there's no Android equivalent, so
        // it's correctly NOT in OPEN_URL_SCHEMES and must resolve to null.
        assertNull(resolveOpenUrl("shortcuts", "shortcuts://run-shortcut?name=x"))
    }

    @Test fun `dangerous or unknown schemes are refused — the security boundary`() {
        // The whole point of the allowlist: the agent can't launch arbitrary intents.
        assertNull(resolveOpenUrl("intent", "intent://scan/#Intent;scheme=zxing;end"))
        assertNull(resolveOpenUrl("file", "file:///data/data/technology.tiny.app/secret"))
        assertNull(resolveOpenUrl("javascript", "javascript:alert(1)"))
        assertNull(resolveOpenUrl("content", "content://com.android.contacts/data"))
        assertNull(resolveOpenUrl("tel", "tel:911"))
    }

    @Test fun `an unparseable URL (null scheme) is refused`() {
        // openUrl passes the parsed scheme; a URL Uri.parse couldn't scheme → null in,
        // null out (openUrl already bailed, but the guard is defense-in-depth).
        assertNull(resolveOpenUrl(null, "not a url"))
        assertNull(resolveOpenUrl(null, ""))
    }
}
