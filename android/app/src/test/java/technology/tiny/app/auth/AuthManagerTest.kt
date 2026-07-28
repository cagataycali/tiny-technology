package technology.tiny.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * sessionExpiryMs is the pure parser behind the launch-time "session expired —
 * sign in again" gate. The wire value is unix SECONDS from
 * app/api/auth/cli/token/route.ts; storage quirks (missing field saved as ""
 * via optString, whitespace, garbage) must all mean "no known expiry", never
 * a false lockout of a working session.
 */
class AuthManagerTest {

    @Test fun `unix seconds parse to epoch millis`() {
        assertEquals(1_784_800_000_000L, sessionExpiryMs("1784800000"))
    }

    @Test fun `whitespace is tolerated`() {
        assertEquals(1_784_800_000_000L, sessionExpiryMs(" 1784800000 "))
    }

    @Test fun `missing field stored as empty string means no expiry`() {
        assertNull(sessionExpiryMs(""))
        assertNull(sessionExpiryMs(null))
    }

    @Test fun `garbage and non-positive values mean no expiry, never a lockout`() {
        assertNull(sessionExpiryMs("not-a-number"))
        assertNull(sessionExpiryMs("2026-07-23T12:00:00Z")) // ISO string ≠ unix seconds
        assertNull(sessionExpiryMs("0"))
        assertNull(sessionExpiryMs("-5"))
    }

    // ── The DECISION, not just the parser (review c4) ──────────────────────
    //
    // Everything above tested sessionExpiryMs. The gate is the COMPARISON that
    // consumes it, and it used to live inline in `isSessionExpired`'s getter
    // where no test could reach it: inverting `<` to `>` there refused every
    // valid session at launch AND waved every expired one through, with all four
    // tests above still green. `nowMs` is injected so the branch is assertable.

    private val now = 1_784_800_000_000L // fixed "now" in millis

    @Test fun `a token past its expiry is expired`() {
        // One second ago, in unix SECONDS on the wire.
        assertTrue(isSessionExpired("${now / 1000 - 1}", now))
        assertTrue(isSessionExpired("${now / 1000 - 86_400}", now)) // yesterday
    }

    @Test fun `a token with time left is NOT expired`() {
        // The half that a flipped comparison breaks silently: a perfectly good
        // 90-day session being sent to the sign-in screen at launch.
        assertFalse(isSessionExpired("${now / 1000 + 1}", now))
        assertFalse(isSessionExpired("${now / 1000 + 90 * 86_400}", now))
    }

    @Test fun `expiring exactly now is not yet expired`() {
        // Boundary: `<` not `<=`. A token is good through its expiry instant —
        // and this is the assertion that catches an off-by-one rewrite.
        assertFalse(isSessionExpired("${now / 1000}", now))
    }

    @Test fun `an unknown expiry never locks anyone out`() {
        // Older installs stored "" (optString of a missing field). Treating
        // "I don't know" as "expired" would sign out every one of them.
        assertFalse(isSessionExpired(null, now))
        assertFalse(isSessionExpired("", now))
        assertFalse(isSessionExpired("   ", now))
        assertFalse(isSessionExpired("not-a-number", now))
        assertFalse(isSessionExpired("0", now))
        assertFalse(isSessionExpired("-5", now))
    }

    @Test fun `seconds are not confused for millis`() {
        // The unit bug this whole helper exists for: if the wire value were
        // compared as-is against a millis clock, EVERY session would read as
        // expired (1.78e9 < 1.78e12) — including one 90 days out.
        val ninetyDaysOut = "${now / 1000 + 90 * 86_400}"
        assertFalse(isSessionExpired(ninetyDaysOut, now))
        // …and the parser's scaling is what makes that true.
        assertEquals(now + 90L * 86_400 * 1000, sessionExpiryMs(ninetyDaysOut))
    }
}
