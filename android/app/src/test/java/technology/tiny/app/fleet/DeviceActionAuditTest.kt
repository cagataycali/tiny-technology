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

    /**
     * 🔇 The audit's own class of bug: three different fates read as success.
     *
     * `DeviceTools.handle` answered "do I own this name?" while this file printed
     * "ran on the phone" — so a tool that THREW and a `play_sound` muted by quiet
     * hours were both reported to the web agent as done. The quiet-hours case is
     * the one with a person on the end of it: they hear nothing, and cannot tell
     * a deliberate mute from a broken speaker, while the agent assures them it
     * played. `speak` has always had an honest line for the identical gate one
     * function away, which is what makes this an omission rather than a design.
     */
    @Test fun `a device tool that THREW is not reported as having run`() {
        val line = DeviceActionAudit.outcomeLine(
            "flashlight", technology.tiny.app.tools.DeviceTools.Outcome.FAILED,
        )
        assertTrue("a failure must not read as a run: $line", line.contains("NOT executed"))
        assertTrue(line.startsWith("flashlight:"))
        // and it must NOT claim the relay can't run it — that is a different fact
        // (this phone owns the tool; the attempt failed), and the agent would
        // otherwise tell the user to stop asking for something that does work.
        assertTrue(
            "a throw must not be reported as an unsupported tool: $line",
            !line.contains("cannot run via the device relay"),
        )
    }

    @Test fun `play_sound muted by quiet hours says NOT played, never ran`() {
        val line = DeviceActionAudit.outcomeLine(
            "play_sound", technology.tiny.app.tools.DeviceTools.Outcome.SILENCED_QUIET,
        )
        assertTrue("quiet hours must be named: $line", line.contains("quiet hours"))
        assertTrue("the room was silent, so never 'ran': $line", !line.contains("ran on the phone"))
        assertTrue(line.contains("NOT played"))
    }

    @Test fun `a tool that ran, and one this phone does not own, keep their old wording`() {
        assertEquals(
            "vibrate: ran on the phone",
            DeviceActionAudit.outcomeLine("vibrate", technology.tiny.app.tools.DeviceTools.Outcome.RAN),
        )
        // UNKNOWN_TOOL is the case toolLine(handled=false) was always right about,
        // so it must keep saying exactly that — the web agent has learned to read it.
        assertEquals(
            DeviceActionAudit.toolLine("generate_image", handled = false),
            DeviceActionAudit.outcomeLine(
                "generate_image", technology.tiny.app.tools.DeviceTools.Outcome.UNKNOWN_TOOL,
            ),
        )
    }

    @Test fun `every outcome has a distinct sentence — no two fates read alike`() {
        // The defect was two fates sharing one sentence, so pin the partition
        // itself rather than four wordings: a new Outcome added without a line
        // here fails instead of silently inheriting another's meaning.
        val lines = technology.tiny.app.tools.DeviceTools.Outcome.values()
            .map { DeviceActionAudit.outcomeLine("play_sound", it) }
        assertEquals("two outcomes render the same audit line: $lines", lines.size, lines.toSet().size)
    }

    /**
     * 🔊 The same lie, on the surface where a PERSON hears it.
     *
     * The live-voice executor answered `{ok:true}` for every one of these tools
     * regardless of what happened, so a `play_sound` the phone muted for quiet
     * hours came back as plain success and the tiny said aloud that it had
     * played it — to someone sitting in silence. The relay path at least had an
     * audit line to correct; the voice tool result had no channel for the fact
     * at all, which is why nothing could have caught this downstream.
     */
    @Test fun `a muted play_sound is not a plain ok on the voice call either`() {
        val res = DeviceActionAudit.voiceResult(
            "play_sound", technology.tiny.app.tools.DeviceTools.Outcome.SILENCED_QUIET,
        )
        // Still ok — nothing broke, the phone did what it was configured to do.
        assertTrue("a deliberate mute is not a failure: $res", res.optBoolean("ok"))
        // …but the model must be TOLD, or it reports a sound the room never heard.
        assertTrue("the voice result says nothing about the mute: $res", res.optString("note").contains("quiet hours"))
        assertTrue(res.optString("note").contains("NOT played"))
    }

    @Test fun `a failed tool is ok-but-noted, and an unowned one is a real error`() {
        val failed = DeviceActionAudit.voiceResult(
            "flashlight", technology.tiny.app.tools.DeviceTools.Outcome.FAILED,
        )
        assertTrue("a throw must be named: $failed", failed.optString("note").contains("NOT executed"))

        // UNKNOWN_TOOL is the one outcome that must fail: the model asked for
        // something this build cannot run, and ok:true teaches it that it can.
        val unknown = DeviceActionAudit.voiceResult(
            "generate_image", technology.tiny.app.tools.DeviceTools.Outcome.UNKNOWN_TOOL,
        )
        assertTrue("an unrunnable tool reported success: $unknown", !unknown.optBoolean("ok"))
        assertTrue(unknown.optString("error").contains("NOT executed"))
    }

    @Test fun `the voice call and the web agent are told the SAME sentence`() {
        // Two surfaces describing one action must share the parser, not agree by
        // coincidence — a second wording is a second thing to drift.
        for (o in technology.tiny.app.tools.DeviceTools.Outcome.values()) {
            val res = DeviceActionAudit.voiceResult("play_sound", o)
            val said = if (res.optBoolean("ok")) res.optString("note") else res.optString("error")
            assertEquals("voice and relay disagree about $o", DeviceActionAudit.outcomeLine("play_sound", o), said)
        }
    }

    @Test fun `every outcome answers the voice call — none falls through to nothing`() {
        for (o in technology.tiny.app.tools.DeviceTools.Outcome.values()) {
            val res = DeviceActionAudit.voiceResult("vibrate", o)
            val said = if (res.optBoolean("ok")) res.optString("note") else res.optString("error")
            assertTrue("$o produced an empty voice result", said.isNotBlank())
        }
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
