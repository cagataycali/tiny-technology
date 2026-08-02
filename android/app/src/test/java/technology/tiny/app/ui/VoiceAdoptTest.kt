package technology.tiny.app.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🎙️ Adopting an already-enrolled Nicla Voice — [VoiceAdopt]'s two rules.
 *
 * The bug these serve: a Voice enrolled from another client sat in the fleet
 * reading offline forever, because `NiclaVoiceGateway.start()` returns at
 * `_unit.value ?: return` and only `register()` sets `_unit` — whose one caller
 * was BLE provisioning, which mints a NEW row and orphans the old one.
 *
 * Both functions are pure so the failure MESSAGES are testable without a radio
 * or a server, which is the whole point: every branch here exists because a
 * generic "adopt failed" sent the user to the wrong place. The iOS twin is
 * VoiceDevicePanel.adopt() in Panels.swift; tests/nicla-android-parity.test.ts
 * pins the two against each other.
 */
class VoiceAdoptTest {

    // ── scanFailure: WHICH failure, not "couldn't find it" ───────────────────

    @Test fun `a denied permission is not a missing necklace`() {
        // The necklace may be right there. Sending the user to hunt for it when
        // the app cannot legally scan is the failure this branch exists to stop.
        val m = VoiceAdopt.scanFailure("unauthorized")
        assertTrue(m, m.contains("permission"))
        assertTrue("must not blame the necklace: $m", !m.contains("Bring it closer"))
    }

    @Test fun `a radio switched off is not a missing necklace`() {
        val m = VoiceAdopt.scanFailure("poweredOff")
        assertTrue(m, m.contains("turned off"))
        assertTrue("must not blame the necklace: $m", !m.contains("Bring it closer"))
    }

    @Test fun `a phone with no radio says so instead of asking for a scan`() {
        val m = VoiceAdopt.scanFailure("unsupported")
        assertTrue(m, m.contains("no Bluetooth adapter"))
    }

    @Test fun `a real miss names both causes the user can act on`() {
        // "idle" = the scan ran and saw nothing. TWO things the user can do,
        // and the second one matters: another phone holding the board is the
        // single most likely reason an owned necklace is invisible here.
        val m = VoiceAdopt.scanFailure("idle")
        assertTrue(m, m.contains("Bring it closer"))
        assertTrue("the other-phone case must be named: $m", m.contains("Release"))
    }

    @Test fun `every scan state gets a distinct sentence`() {
        // A shared message would defeat the point of naming the cause at all.
        val states = listOf("unauthorized", "poweredOff", "unsupported", "idle", "scanning")
        val messages = states.map { VoiceAdopt.scanFailure(it) }
        // "scanning" and "idle" share the fallback; the other three are distinct.
        assertEquals(4, messages.toSet().size)
        assertTrue("no message may be blank", messages.none { it.isBlank() })
    }

    // ── claimFailure: never install a credential that authenticates nothing ──

    @Test fun `a token in hand is a success`() {
        val ok = JSONObject().put("ok", true).put("device_token", "dt_abc123")
        assertNull(VoiceAdopt.claimFailure(ok))
        assertEquals("dt_abc123", VoiceAdopt.token(ok))
    }

    @Test fun `a 404 is a real answer, not an outage`() {
        // The worker says "not yours, revoked, or an endpoint device". The
        // user's next move (enroll fresh) differs from what they should do on
        // an outage (retry), so this must NOT read as a connection problem.
        val gone = JSONObject().put("ok", false).put("error", "device not found").put("_status", 404)
        val m = VoiceAdopt.claimFailure(gone)
        assertNotNull(m)
        assertTrue(m!!, m.contains("Set it up again"))
        assertTrue("a 404 must not be reported as a connection fault: $m", !m.contains("connection"))
    }

    @Test fun `a transport failure is reported as one`() {
        // null = the call threw. Distinct from a server that answered badly:
        // retrying is the right advice here and only here-plus-424.
        val m = VoiceAdopt.claimFailure(null)
        assertNotNull(m)
        assertTrue(m!!, m.contains("reach the server"))
    }

    @Test fun `ok true with no token is still a failure`() {
        // The trap this closes: storing "" in the token store installs a
        // credential that authenticates nothing, and the break surfaces LATER
        // as an unexplained offline necklace instead of here, where the user is
        // looking at the button they just pressed.
        assertNotNull(VoiceAdopt.claimFailure(JSONObject().put("ok", true)))
        assertNotNull(VoiceAdopt.claimFailure(JSONObject().put("ok", true).put("device_token", "")))
    }

    @Test fun `a 424 adopt failure is retryable, not fatal`() {
        // The route's own code for "worker answered, but no usable token".
        val m = VoiceAdopt.claimFailure(
            JSONObject().put("ok", false).put("error", "adopt failed").put("_status", 424)
        )
        assertNotNull(m)
        assertTrue(m!!, m.contains("try again"))
    }

    @Test fun `the 404 branch is checked before the empty-token branch`() {
        // A 404 body carries NO device_token, so if the order flipped, every
        // "not yours" would be reported as the generic server failure and the
        // user would retry forever against a row that will never come back.
        val gone = JSONObject().put("_status", 404)
        assertTrue(VoiceAdopt.claimFailure(gone)!!.contains("Set it up again"))
    }
}
