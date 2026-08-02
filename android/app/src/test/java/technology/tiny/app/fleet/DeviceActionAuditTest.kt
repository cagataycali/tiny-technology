package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The relay reply's device-actions audit (use_device P4) — the contract that
 * un-lies "Mail app opened 📬": whatever the proxied model claims, the reply
 * carries one factual line per attempted device action, and the web-side
 * agent relays THAT. Every silent-failure layer gets its own honest wording:
 * scheme refused, app backgrounded, tool not executable via relay.
 */
class DeviceActionAuditTest {

    @Test fun `a refused scheme says NOT opened and names the allowlist`() {
        val line = DeviceActionAudit.openUrlLine("googlegmail://", resolved = null, foreground = true)
        assertTrue(line.contains("NOT opened"))
        assertTrue(line.contains("scheme not allowlisted"))
        assertTrue(line.contains("mailto")) // the allowlist is spelled out so the agent can self-correct
    }

    @Test fun `a backgrounded open says NOT opened and why`() {
        val line = DeviceActionAudit.openUrlLine("mailto:", resolved = "mailto:", foreground = false)
        assertTrue(line.contains("NOT opened"))
        assertTrue(line.contains("backgrounded"))
    }

    @Test fun `a foreground allowlisted open reports opened`() {
        assertEquals(
            "open_url(mailto:): opened on the phone",
            DeviceActionAudit.openUrlLine("mailto:", resolved = "mailto:", foreground = true),
        )
    }

    @Test fun `an unexecutable relay tool is reported, not silently dropped`() {
        val line = DeviceActionAudit.toolLine("screenshot", handled = false)
        assertTrue(line.contains("NOT executed"))
        assertTrue(line.startsWith("screenshot:"))
        assertEquals("vibrate: ran on the phone", DeviceActionAudit.toolLine("vibrate", handled = true))
    }

    @Test fun `speak reports spoken, quiet-hours, and empty-text outcomes distinctly`() {
        assertTrue(DeviceActionAudit.speakLine(spoke = true, quiet = false).contains("said aloud"))
        assertTrue(DeviceActionAudit.speakLine(spoke = false, quiet = true).contains("quiet hours"))
        assertTrue(DeviceActionAudit.speakLine(spoke = false, quiet = false).contains("empty text"))
    }

    @Test fun `a dispatched round-trip tool says running, not ran — the mailbox carries the real outcome`() {
        val line = DeviceActionAudit.dispatchedLine("meta_take_photo")
        assertTrue(line.startsWith("meta_take_photo:"))
        assertTrue(line.contains("running"))
        assertTrue(line.contains("tool mailbox"))
    }

    @Test fun `no device actions means NO audit block — plain replies stay untouched`() {
        assertEquals("", DeviceActionAudit.render(emptyList()))
    }

    @Test fun `the block is bracketed telemetry appended after a blank line`() {
        val block = DeviceActionAudit.render(listOf("a: ran on the phone", "b: NOT executed"))
        assertEquals("\n\n[device-actions: a: ran on the phone; b: NOT executed]", block)
    }

    @Test fun `the block is bounded — a tool-heavy turn cannot evict the answer (iOS parity)`() {
        val block = DeviceActionAudit.render(List(50) { "tool$it: ran on the phone with a very long descriptive outcome line" })
        // 6500 (truncated answer) + this block must stay inside the 7000 reply cap
        assertTrue(block.length <= 400 + "\n\n[device-actions: ]".length)
        assertTrue(block.endsWith("]"))
    }
}
