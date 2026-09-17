package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🔇 What `handle` REPORTS about what it did (use_device P4 / rule 23).
 *
 * The relay path feeds this verdict straight into `DeviceActionAudit`, which is
 * the only ground truth the web agent gets about a device action — so what this
 * decides is, in practice, what the user is told happened to their phone. It used
 * to answer a different question than the audit was asking: "do I own this tool
 * name?" rather than "did it run?". Two fates were flattened onto `true`:
 *
 *   * a tool that THREW — `runCatching { … }.getOrElse { true }`, a catch branch
 *     that literally returned success, and
 *   * `play_sound` under quiet hours, which returns early by design.
 *
 * Both then rendered as "ran on the phone". The quiet-hours one is the one with a
 * person on the end: they hear nothing and cannot distinguish a deliberate mute
 * from a broken speaker, while the agent assures them the sound played — one
 * function away from `speakLine`, which has always reported the identical gate
 * honestly.
 *
 * Tested through `earlyOutcome`, the pure extraction `handleUnsafe` itself calls
 * (`resolveOpenUrl` / `vibrateWaveform` pattern — this module has no Robolectric
 * or Mockito, by design). The FAILED path is not reachable without hardware, so
 * it is pinned at the audit layer in DeviceActionAuditTest instead of mocked here.
 */
class DeviceToolsOutcomeTest {

    @Test fun `play_sound during quiet hours is SILENCED_QUIET, never RAN`() {
        val outcome = DeviceTools.earlyOutcome("play_sound", quiet = true)
        assertEquals(DeviceTools.Outcome.SILENCED_QUIET, outcome)
        // RAN renders as "ran on the phone" — the sentence that told a user a
        // sound played in a silent room.
        assertNotEquals(DeviceTools.Outcome.RAN, outcome)
    }

    @Test fun `outside quiet hours play_sound is left to the execution to report`() {
        // null means "not decidable yet" — the caller runs it and answers RAN or
        // FAILED. A wrong non-null here would report success before playing.
        assertNull(DeviceTools.earlyOutcome("play_sound", quiet = false))
    }

    @Test fun `an unowned tool name is UNKNOWN_TOOL — the case the audit was right about`() {
        // This is the fate `toolLine(handled = false)` has always described
        // correctly ("cannot run via the device relay"), so it must stay distinct
        // from a FAILED attempt: telling the user a tool is unsupported when it
        // merely failed teaches them to stop asking for something that works.
        assertEquals(
            DeviceTools.Outcome.UNKNOWN_TOOL,
            DeviceTools.earlyOutcome("generate_image", quiet = false),
        )
        assertEquals(
            DeviceTools.Outcome.UNKNOWN_TOOL,
            DeviceTools.earlyOutcome("screenshot", quiet = true),
        )
    }

    @Test fun `quiet hours silences ONLY play_sound — every other tool still runs`() {
        // The gate is about agent SOUNDS. Vibrate is deliberately still allowed at
        // night (Session.swift: "Remote voice respects quiet hours; vibrate stays
        // allowed"), and muting clipboard or cancel_alerts would be a silent
        // functional regression nobody would attribute to a quiet-hours change.
        for (name in DeviceTools.NAMES - "play_sound") {
            assertNull(
                "quiet hours must not suppress $name — only agent sounds are gated",
                DeviceTools.earlyOutcome(name, quiet = true),
            )
        }
    }

    /**
     * ⚠️ `NAMES` and the `when (name)` switch in `handleUnsafe` are two lists that
     * must agree, and the early return means a name missing from `NAMES` can never
     * reach its own `case` — it is reported to the agent as "cannot run via the
     * device relay" while the code to run it sits right there. Derived from the
     * source rather than transcribed, so adding a case without adding the name
     * fails here instead of shipping as an unreachable branch.
     */
    @Test fun `NAMES covers exactly the tool names handleUnsafe implements`() {
        val src = java.io.File("src/main/java/technology/tiny/app/tools/DeviceTools.kt").readText()
        assertTrue("DeviceTools.kt not found from the test working dir", src.length > 2_000)

        val body = src.substringAfter("private fun handleUnsafe(").substringBefore("\n    }")
        assertTrue("handleUnsafe body not located — re-anchor this pin", body.length in 200..8_000)

        // `"name" ->` at the head of a when-branch, including multi-name branches.
        val cases = Regex("""^\s{12}("[a-z_]+"(?:\s*,\s*"[a-z_]+")*)\s*->""", RegexOption.MULTILINE)
            .findAll(body)
            .flatMap { m -> Regex("\"([a-z_]+)\"").findAll(m.groupValues[1]).map { it.groupValues[1] } }
            .toSet()
        assertTrue("no when-branches parsed out of handleUnsafe — the pin would be vacuous", cases.size >= 6)

        assertEquals(
            "NAMES and handleUnsafe's switch disagree — a name absent from NAMES is " +
                "reported as unsupported and its case is dead code",
            cases, DeviceTools.NAMES,
        )
    }
}
