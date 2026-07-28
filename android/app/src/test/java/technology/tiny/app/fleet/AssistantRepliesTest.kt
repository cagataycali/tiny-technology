package technology.tiny.app.fleet

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure fulfillment logic behind a headless ask/fleet/DM assistant surface —
 * the Android port of iOS Intents.swift. Pure Kotlin + org.json, runs on the
 * local JVM (no Context/network/TTS), exactly like iOS's intents are logic-only.
 */
class AssistantRepliesTest {

    // ---- Ask ---------------------------------------------------------------

    @Test fun `ask prompt carries the brief-no-markdown steer`() {
        val p = AssistantReplies.askPrompt("what's the weather")
        assertTrue(p.contains("1-3 plain sentences"))
        assertTrue(p.endsWith("what's the weather"))
    }

    @Test fun `ask dialog trims a normal answer`() {
        assertEquals("It's sunny.", AssistantReplies.askDialog("  It's sunny.\n"))
    }

    @Test fun `ask dialog falls back when the agent said nothing`() {
        assertEquals("tiny didn't answer — try the app.", AssistantReplies.askDialog(""))
        assertEquals("tiny didn't answer — try the app.", AssistantReplies.askDialog("   "))
        assertEquals("tiny didn't answer — try the app.", AssistantReplies.askDialog(null))
    }

    @Test fun `ask dialog caps a very long answer at 700`() {
        val long = "x".repeat(1000)
        assertEquals(700, AssistantReplies.askDialog(long).length)
    }

    // ---- Fleet status ------------------------------------------------------

    @Test fun `fleet status announces online names`() {
        val res = JSONObject().put("devices", JSONArray()
            .put(JSONObject().put("name", "cag-pixel").put("online", true))
            .put(JSONObject().put("name", "cag-mac").put("online", false))
            .put(JSONObject().put("name", "cag-watch").put("online", true)))
        assertEquals("🟢 2 of 3 online: cag-pixel, cag-watch", AssistantReplies.fleetStatusDialog(res))
    }

    @Test fun `fleet status says all quiet when none online`() {
        val res = JSONObject().put("devices", JSONArray()
            .put(JSONObject().put("name", "a").put("online", false))
            .put(JSONObject().put("name", "b").put("online", false)))
        assertEquals(
            "All quiet — none of your 2 devices are online right now.",
            AssistantReplies.fleetStatusDialog(res),
        )
    }

    @Test fun `fleet status nudges enrollment when no devices`() {
        val res = JSONObject().put("devices", JSONArray())
        assertTrue(AssistantReplies.fleetStatusDialog(res).startsWith("No devices enrolled yet"))
    }

    @Test fun `fleet status distinguishes a network failure from an empty fleet`() {
        // A missing devices array = couldn't reach the fleet, NOT "no devices".
        assertEquals(
            "Couldn't reach your fleet — network or sign-in issue.",
            AssistantReplies.fleetStatusDialog(JSONObject()),
        )
        assertEquals(
            "Couldn't reach your fleet — network or sign-in issue.",
            AssistantReplies.fleetStatusDialog(null),
        )
    }

    @Test fun `online names skips blank-named and offline devices`() {
        val devices = JSONArray()
            .put(JSONObject().put("name", "").put("online", true))       // blank name skipped
            .put(JSONObject().put("name", "keep").put("online", true))
            .put(JSONObject().put("name", "off").put("online", false))   // offline skipped
        assertEquals(listOf("keep"), AssistantReplies.onlineNames(devices))
    }

    // ---- Send DM -----------------------------------------------------------

    @Test fun `dm body normalizes the login, caps the message, tags via`() {
        val body = AssistantReplies.dmBody("@bob ", "x".repeat(3000))
        assertEquals("bob", body.getString("to"))
        assertEquals(2000, body.getString("message").length)
        assertEquals("android-assistant", body.getString("viaTiny"))
    }

    @Test fun `dm result confirms to the normalized login on ok`() {
        val res = JSONObject().put("ok", true)
        assertEquals("💬 Sent to @bob.", AssistantReplies.dmResultDialog(res, "@bob "))
    }

    @Test fun `dm result surfaces the server error verbatim`() {
        val res = JSONObject().put("ok", false).put("error", "no such user")
        assertEquals("Couldn't send: no such user", AssistantReplies.dmResultDialog(res, "bob"))
    }

    @Test fun `dm result falls back to unknown error when none given`() {
        assertEquals("Couldn't send: unknown error", AssistantReplies.dmResultDialog(JSONObject(), "bob"))
        assertEquals("Couldn't send: unknown error", AssistantReplies.dmResultDialog(null, "bob"))
    }

    @Test fun `normalize login strips leading at and surrounding spaces`() {
        assertEquals("alice", AssistantReplies.normalizeLogin("  @alice "))
        assertEquals("alice", AssistantReplies.normalizeLogin("alice"))
    }
}
