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

    /**
     * Outcome line for copy_to_clipboard — the one tool whose no-op is DESTRUCTIVE.
     *
     * ⚠️ Special-cased for the same reason [openUrlLine] is: the tool's own
     * return value cannot carry this. `DeviceTools.handle` reports that the arm
     * executed, and the arm executes either way — so a `text` that was absent,
     * the wrong type, or blank was audited as "ran on the phone" and the web
     * agent went on to tell the user their text was copied. It was not; and on
     * web the same shape ERASED the clipboard, so "nothing happened" is the good
     * case here, not the harmless one.
     *
     * Reads the RAW argument and re-runs [technology.tiny.app.tools.decideClipboardWrite],
     * exactly as this file's open_url line re-runs `resolveOpenUrl`: the audit
     * must state the decision the write actually made, and the only way to be
     * sure of that is to make the same one from the same input.
     */
    fun clipboardLine(raw: Any?): String =
        when (val write = technology.tiny.app.tools.decideClipboardWrite(raw)) {
            is technology.tiny.app.tools.ClipboardWrite.Allowed ->
                "copy_to_clipboard: ${write.note}"
            // The refusal's own words, not a re-wording: it already says what was
            // wrong AND that the user's clipboard is intact, which is the fact
            // the model needs before it claims anything to the user.
            is technology.tiny.app.tools.ClipboardWrite.Refused ->
                "copy_to_clipboard: NOT copied — ${write.error.removePrefix("refused: ")}"
        }

    /**
     * The live-call TOOL RESULT for copy_to_clipboard.
     *
     * ⚠️ A refusal is `ok:false`, unlike the muted `play_sound` above: quiet
     * hours is the phone obeying the user, but a clipboard write that never
     * happened is the model's request UNMET, and it has to know that to say
     * something true out loud. `ok:true` here is how a tiny comes to tell a
     * person, in speech, that their text is ready to paste when the clipboard
     * still holds whatever it held before.
     */
    fun clipboardResult(raw: Any?): org.json.JSONObject =
        when (val write = technology.tiny.app.tools.decideClipboardWrite(raw)) {
            is technology.tiny.app.tools.ClipboardWrite.Allowed ->
                org.json.JSONObject().put("ok", true).put("note", write.note)
            is technology.tiny.app.tools.ClipboardWrite.Refused ->
                org.json.JSONObject().put("ok", false).put("error", write.error)
        }

    /** Outcome line for speak (special-cased before DeviceTools in the relay path). */
    fun speakLine(spoke: Boolean, quiet: Boolean): String = when {
        spoke -> "speak: said aloud on the phone"
        quiet -> "speak: NOT spoken — quiet hours on the phone"
        else -> "speak: NOT spoken — empty text"
    }

    /**
     * Outcome line for any delegated device tool, from what actually happened.
     *
     * ⚠️ This exists because [toolLine]'s Boolean could not tell three different
     * facts apart, and `DeviceTools.handle` answered a different question than
     * the one the audit was asking: it reported "I own this tool name" while the
     * audit printed "ran on the phone". So the two cases the web agent most
     * needed to hear both read as success —
     *
     *   * a tool that THREW (no torch on this device, a revoked vibrate
     *     permission, a clipboard denied to a background app) was a log line
     *     nobody reads plus an audit line vouching for it; and
     *   * `play_sound` under quiet hours, which is `speak`'s exact twin — same
     *     gate, same silent room — except `speak` had a branch that could say so
     *     and `play_sound` fell through to "ran on the phone".
     *
     * The quiet-hours case is the one to keep in mind when editing this: a user
     * who hears nothing cannot tell a deliberate mute from a broken speaker, so
     * the agent claiming a sound played is worse than it saying nothing at all.
     */
    fun outcomeLine(name: String, outcome: technology.tiny.app.tools.DeviceTools.Outcome): String =
        when (outcome) {
            technology.tiny.app.tools.DeviceTools.Outcome.RAN -> "$name: ran on the phone"
            technology.tiny.app.tools.DeviceTools.Outcome.UNKNOWN_TOOL -> toolLine(name, handled = false)
            technology.tiny.app.tools.DeviceTools.Outcome.FAILED ->
                "$name: NOT executed — it failed on the phone (the device refused it or the hardware isn't there)"
            technology.tiny.app.tools.DeviceTools.Outcome.SILENCED_QUIET ->
                "$name: NOT played — quiet hours on the phone"
        }

    /**
     * The live-call TOOL RESULT for a delegated device tool.
     *
     * ⚠️ Same defect, second surface: the voice executor answered a bare
     * `{ok:true}` for every one of these tools, so a `play_sound` the phone
     * deliberately muted came back as plain success and the tiny SAID it had
     * played — to a person who heard nothing. The relay path at least had an
     * audit line; this one had no channel for the fact at all.
     *
     * Reuses [outcomeLine] rather than re-wording it: one sentence, two
     * readers, so the voice call and the web agent can never be told different
     * stories about the same action.
     */
    fun voiceResult(name: String, outcome: technology.tiny.app.tools.DeviceTools.Outcome): org.json.JSONObject {
        val line = outcomeLine(name, outcome)
        // An unowned name is the one FAILING result: the model asked for
        // something this build can't run, and `ok:true` would teach it that it
        // had. Everything else did run, or was suppressed on purpose.
        return if (outcome == technology.tiny.app.tools.DeviceTools.Outcome.UNKNOWN_TOOL) {
            org.json.JSONObject().put("ok", false).put("error", line)
        } else {
            org.json.JSONObject().put("ok", true).put("note", line)
        }
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
