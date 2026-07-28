package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the concurrent-stream history helpers (web stream-registry.ts parity).
 * Timestamps are passed explicitly so the "started Ns ago" math is deterministic
 * (the fns default nowMs to System.currentTimeMillis() in production).
 */
class StreamRegistryTest {

    @Test fun `live partial with text marks in-progress and includes the body`() {
        val out = annotateLivePartial("Half an answer", startedAtMs = 0, nowMs = 3_000)
        assertTrue("flags still-writing", out.contains("STILL WRITING"))
        assertTrue("shows elapsed seconds", out.contains("3s ago"))
        assertTrue("carries the partial body", out.contains("Half an answer"))
    }

    @Test fun `empty live partial uses the nothing-written-yet wording`() {
        val out = annotateLivePartial("   ", startedAtMs = 0, nowMs = 2_000)
        assertTrue(out.contains("nothing written yet"))
        assertTrue(out.contains("2s ago"))
    }

    @Test fun `elapsed seconds round and never drop below one`() {
        // 400ms → rounds toward 0 but is clamped to a 1s floor.
        assertTrue(annotateLivePartial("x", 0, 400).contains("1s ago"))
        // 1500ms → rounds to 2s (half-up).
        assertTrue(annotateLivePartial("x", 0, 1_500).contains("2s ago"))
    }

    @Test fun `historyText wraps a live sibling even when empty`() {
        val out = historyText(text = "", isLive = true, startedAtMs = 0, nowMs = 1_000)
        assertTrue("empty live message still contributes a partial marker", out.contains("parallel turn"))
    }

    @Test fun `historyText placeholders a blank non-live message`() {
        // Strict providers reject empty text blocks — blank completed turns become "…".
        assertEquals("…", historyText(text = "", isLive = false, startedAtMs = 0, nowMs = 1_000))
        assertEquals("…", historyText(text = "   ", isLive = false, startedAtMs = 0, nowMs = 1_000))
    }

    @Test fun `historyText passes through a completed non-live message unchanged`() {
        assertEquals("Final answer.", historyText("Final answer.", isLive = false, startedAtMs = 0, nowMs = 1_000))
    }
}
