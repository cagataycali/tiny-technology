package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bitemporal freshness → live? classification behind the server-learnings list.
 * A learning is archived ONLY when explicitly "closed" (superseded); every other
 * value — including a missing field defaulting to "live" — reads live. Matches the
 * memory graph's rule (MemoryGraph.kt:105 `freshness != "closed"`), iOS's live
 * StatusDot (Panels.swift:1372-1373 `== "live"` treated as live) and web's split
 * (MemoryPanel.tsx:282 `freshness !== "closed"` = live).
 */
class MemoryUniverseTest {

    @Test fun `closed is archived, everything else is live`() {
        assertFalse(learningIsLive("closed"))
        assertTrue(learningIsLive("live"))
    }

    @Test fun `absent or unknown freshness reads live`() {
        // The parser passes optString("freshness", "live"); an empty/absent field
        // or any unexpected value must NOT be mistaken for archived.
        assertTrue(learningIsLive("live"))
        assertTrue(learningIsLive(""))
        assertTrue(learningIsLive("open"))
    }

    // ── githubAvatar: source-size a GitHub avatar (web lib/community.ts:136 parity) ──
    // Web documents its twin as "Pure + tested"; Android's had no coverage. Pins the
    // branches: non-github passthrough, the ?/& query join, 2×-DPR sizing, and the
    // floor-1 clamp that stops a 0/negative size from emitting ?s=0 (which makes
    // GitHub serve the full-res default — the opposite of the thumbnail intent).

    @Test fun `githubAvatar passes through empty and non-github urls untouched`() {
        assertEquals("", githubAvatar("", 40))
        assertEquals("https://example.com/a.png", githubAvatar("https://example.com/a.png", 40))
        // A data: URI (no githubusercontent host) must survive verbatim.
        assertEquals("data:image/png;base64,AAAA", githubAvatar("data:image/png;base64,AAAA", 80))
    }

    @Test fun `githubAvatar appends s with a question mark when the url has no query`() {
        // 40px box → 2×-DPR → s=80 (web Community 40 → s=80).
        assertEquals(
            "https://avatars.githubusercontent.com/u/1?s=80",
            githubAvatar("https://avatars.githubusercontent.com/u/1", 40),
        )
    }

    @Test fun `githubAvatar joins with an ampersand when the url already has a query`() {
        assertEquals(
            "https://avatars.githubusercontent.com/u/1?v=4&s=64",
            githubAvatar("https://avatars.githubusercontent.com/u/1?v=4", 32),
        )
    }

    @Test fun `githubAvatar clamps a zero or negative size to s=1, never s=0`() {
        // ?s=0 would make GitHub serve the full-res default — the opposite of the
        // thumbnail intent — so the floor is 1 (web Math.max(1, …)).
        assertEquals(
            "https://avatars.githubusercontent.com/u/1?s=1",
            githubAvatar("https://avatars.githubusercontent.com/u/1", 0),
        )
        assertEquals(
            "https://avatars.githubusercontent.com/u/1?s=1",
            githubAvatar("https://avatars.githubusercontent.com/u/1", -10),
        )
    }

    // ── compact: headline-stat abbreviator (byte-twin of web lib/community.ts
    // compact() + iOS CommunityFmt.compact, Panels.swift:35). Both references
    // document the tier thresholds as sitting where the tier BELOW would round up
    // past its own ceiling — Android had NO coverage, and its old impl diverged
    // three ways (no B tier, M-boundary at 1_000_000 not 999_500, truncation not
    // rounding). Pins the exact edge cases the twins call out.

    @Test fun `compact renders the representative small and mid values`() {
        assertEquals("1.9M", compact(1_880_100)) // web/iOS doc example
        assertEquals("45K", compact(45_300))     // web/iOS doc example
        assertEquals("0", compact(0))
        assertEquals("999", compact(999))
        assertEquals("1K", compact(1_000))
    }

    @Test fun `compact rounds the K tier, never truncates`() {
        // Old Android used toInt() for k>=100 → 45_800 would truncate to "45K".
        // The twins use Math.round → "46K".
        assertEquals("46K", compact(45_800))
        assertEquals("151K", compact(150_800))
        assertEquals("999K", compact(999_499))
    }

    @Test fun `compact tier boundaries sit where the lower tier would overflow`() {
        // 999_500 rounds to "1000K" in the K tier, so it must promote to "1.0M"
        // (web community.ts:159-163, iOS Panels.swift:37-38). Old Android's
        // 1_000_000 boundary rendered "999K" here.
        assertEquals("1.0M", compact(999_500))
        assertEquals("999.9M", compact(999_949_999))
        // …and the same overflow guard promotes the M tier to "B".
        assertEquals("1.0B", compact(999_950_000))
    }

    @Test fun `compact keeps the M and B decimals that Android used to drop`() {
        // Old Android printed a bare Int ("150M") for m>=100; the twins keep the
        // "%.1f" ("150.0M"). Same for the billions tier.
        assertEquals("150.0M", compact(150_000_000))
        assertEquals("2.0B", compact(2_000_000_000))
    }
}
