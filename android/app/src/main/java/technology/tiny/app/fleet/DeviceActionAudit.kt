package technology.tiny.app.fleet

/**
 * The honesty half of relay-proxied device actions (use_device P4,
 * web repo docs/use-device-async-design-2026-08-02.md G6).
 *
 * A relay invoke ("open the mail app on my pixel") proxies to the SERVER
 * agent; client-tool events from that stream act on this phone — but some are
 * silently impossible (scheme not allowlisted, app backgrounded, tool not
 * executable via relay at all), and the model, seeing no signal either way,
 * happily claims success. The canonical failure: "Mail app opened 📬" while
 * nothing happened.
 *
 * So the phone now keeps one line per attempted device action describing what
 * ACTUALLY happened, and appends the block to the relay reply. The web-side
 * agent reads ground truth and reports it instead of the proxied model's
 * optimism. Pure — the impure execution stays in DeviceTools/FleetManager.
 */
object DeviceActionAudit {

    /** Outcome line for open_url — the one tool with silent failure layers. */
    fun openUrlLine(raw: String, resolved: String?, foreground: Boolean): String = when {
        resolved == null ->
            "open_url($raw): NOT opened — scheme not allowlisted " +
                "(allowed: https, http, geo, maps→geo, spotify, music, mailto)"
        !foreground ->
            "open_url($resolved): NOT opened — the app is backgrounded and Android blocks background app launches; ask the user to open the tiny app first"
        else -> "open_url($resolved): opened on the phone"
    }

    /** Outcome line for any other client tool the relay path delegates. */
    fun toolLine(name: String, handled: Boolean): String =
        if (handled) "$name: ran on the phone"
        else "$name: NOT executed — this tool cannot run via the device relay on Android"

    /** Round-trip tools run async off the relay turn (use_device P5) — their
     * real outcome posts to the chat's tool-result mailbox the server is
     * polling, so the honest tense here is "running", not "ran". */
    fun dispatchedLine(name: String): String =
        "$name: running on the phone — its outcome posts to the chat's tool mailbox"

    /** Outcome line for speak (special-cased before DeviceTools in the relay path). */
    fun speakLine(spoke: Boolean, quiet: Boolean): String = when {
        spoke -> "speak: said aloud on the phone"
        quiet -> "speak: NOT spoken — quiet hours on the phone"
        else -> "speak: NOT spoken — empty text"
    }

    /**
     * The block appended to a relay reply ("" when the turn used no device
     * actions, so plain Q&A replies stay untouched). Bracketed so the web
     * agent reads it as telemetry, not as the device's prose; bounded (iOS
     * parity) so a tool-heavy turn can never crowd the answer out of the
     * relay's 8KB payload.
     */
    fun render(lines: List<String>): String =
        if (lines.isEmpty()) "" else "\n\n[device-actions: ${lines.joinToString("; ").take(400)}]"
}
