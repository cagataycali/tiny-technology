package technology.tiny.app.fleet

import org.json.JSONArray
import org.json.JSONObject

/**
 * The PURE fulfillment logic behind a headless "ask tiny" / "fleet status" /
 * "send a tiny message" surface — the Android port of iOS `Intents.swift`
 * (AskTinyIntent / FleetStatusIntent / SendTinyDmIntent). Kept Context-, network-
 * and TTS-free so the correctness-sensitive parts (empty-fleet vs all-offline
 * wording, DM error extraction, answer trimming/caps, `to` normalization) are
 * JVM-unit-testable exactly like iOS's intents are logic-only.
 *
 * These strings are spoken back by the assistant WITHOUT the app opening, so the
 * wording must be self-contained and short. The remaining half — registering the
 * phrases with Google Assistant via App Actions (`shortcuts.xml <capability>` +
 * BIIs) and a headless handler that calls chatOnce/`/api/devices`/`/api/messages`
 * — is publish-gated (Play Store app-verification) and rides the user-owned
 * deploy decision; this pure core is what that handler will call.
 */
object AssistantReplies {

    /** Shown for every surface when there's no token — matches iOS's guard dialog. */
    const val SIGN_IN = "Sign in to the tiny app first."

    // ---- Ask (AskTinyIntent) ------------------------------------------------

    /**
     * Steer the model for the spoken channel: brief, no markdown (iOS AskTiny
     * prepends the same note before chatOnce so Siri's short run returns cleanly).
     */
    fun askPrompt(prompt: String): String =
        "[Asked via Assistant — answer in 1-3 plain sentences, no markdown] $prompt"

    /**
     * Turn a raw chatOnce answer into the spoken dialog: trim, fall back when the
     * agent said nothing, cap to a length the assistant will actually speak (iOS
     * caps the dialog at 700 chars — the value it RETURNS to Shortcuts is uncapped,
     * but a headless spoken reply must be bounded).
     */
    fun askDialog(answer: String?): String {
        val clean = answer?.trim().orEmpty()
        if (clean.isEmpty()) return "tiny didn't answer — try the app."
        return if (clean.length > 700) clean.take(700) else clean
    }

    // ---- Fleet status (FleetStatusIntent) -----------------------------------

    /** Online-device display names (well-formed, online, non-blank name), in order. */
    fun onlineNames(devices: JSONArray?): List<String> {
        if (devices == null) return emptyList()
        val out = ArrayList<String>()
        for (i in 0 until devices.length()) {
            val d = devices.optJSONObject(i) ?: continue
            if (d.optBoolean("online")) d.optString("name").takeIf { it.isNotBlank() }?.let { out.add(it) }
        }
        return out
    }

    /**
     * Compose the spoken fleet-status line (iOS FleetStatusIntent.perform), reusing
     * the shared [FleetCounts] arithmetic so "N of M online" can't drift from the
     * widget/badge. Three distinct outcomes, each self-contained:
     *   - no devices enrolled  → nudge that this phone enrolls on sign-in
     *   - none online          → "All quiet — none of your M …"
     *   - some online          → "🟢 X of M online: names"
     * A null/absent devices array is treated as "couldn't reach the fleet" so the
     * caller doesn't announce a false "no devices" on a network error.
     */
    fun fleetStatusDialog(response: JSONObject?): String {
        val devices = response?.optJSONArray("devices")
            ?: return "Couldn't reach your fleet — network or sign-in issue."
        val total = FleetCounts.totalCount(devices)
        if (total == 0) {
            return "No devices enrolled yet. This phone enrolls when you sign in to the tiny app."
        }
        val online = FleetCounts.onlineCount(devices)
        if (online == 0) {
            return "All quiet — none of your $total devices are online right now."
        }
        val names = onlineNames(devices).joinToString(", ")
        return "🟢 $online of $total online: $names"
    }

    // ---- Send DM (SendTinyDmIntent) -----------------------------------------

    /** Normalize the recipient login the way iOS does: strip leading @ and spaces. */
    fun normalizeLogin(to: String): String = to.trim().trim('@', ' ')

    /** The POST /api/messages body (iOS SendTinyDmIntent): capped message, via tag. */
    fun dmBody(to: String, message: String): JSONObject = JSONObject()
        .put("to", normalizeLogin(to))
        .put("message", message.take(2000))
        .put("viaTiny", "android-assistant")

    /**
     * Spoken result of a DM send (iOS SendTinyDmIntent): ok → confirm to @login,
     * else surface the server's error verbatim (a missing key → "unknown error").
     * The confirmation uses the NORMALIZED login so "@bob " reads back as "@bob".
     */
    fun dmResultDialog(response: JSONObject?, to: String): String {
        val login = normalizeLogin(to)
        if (response?.optBoolean("ok") == true) return "💬 Sent to @$login."
        val err = response?.optString("error").orEmpty().ifEmpty { "unknown error" }
        return "Couldn't send: $err"
    }
}
