package technology.tiny.wear

/**
 * WearBriefing — the pure logic of the wrist "briefing" (the Android analog of
 * iOS Briefing.swift / WatchSettings' briefing-prompt presets). A briefing is a
 * one-tap, canned question ("anything new?") the wrist can ask without the user
 * dictating — the same four presets iOS offers, plus resolution of the stored
 * choice and the wrist-steer prefix.
 *
 * Kept pure + here (not inline in a service/UI) so the prompt resolution and the
 * selected-preset rule are JVM-unit-tested NOW; the eventual briefing trigger and
 * the Settings presets section both consume this rather than each re-deriving it.
 * This is slice 1 of the briefing feature — the tested brain before the wiring.
 */
object WearBriefing {

    /** A named briefing prompt the user can pick in Settings. */
    data class Preset(val label: String, val prompt: String)

    /** The four presets, byte-matching iOS WatchSettingsView.presets so the wrist
     *  offers the same briefings on both platforms. The first is the default. */
    val presets: List<Preset> = listOf(
        Preset("Daily brief", "Give me a tiny briefing: anything new, plus one useful or interesting thing. 2 sentences max."),
        Preset("Fleet check", "How is my device fleet? Anything offline or unusual? 2 sentences max."),
        Preset("Motivation", "One short, concrete piece of motivation for right now. 2 sentences max."),
        Preset("What's next", "Based on what you know about me, what should I focus on next? 2 sentences max."),
    )

    /** The prompt asked when the user hasn't chosen one (iOS BriefingIntent's
     *  fallback) — the "Daily brief" preset. */
    val DEFAULT_PROMPT: String = presets.first().prompt

    /** Wrist-steer prefix for a briefing turn — asks for a 1-2 sentence, markdown-
     *  free answer (iOS "[Briefing button on Apple Watch …]" twin). Distinct wording
     *  from WearChat.WRIST_STEER so the server can tell a briefing from a dictation. */
    const val BRIEFING_STEER = "[Briefing from Wear OS watch — answer in 1-2 short sentences, no markdown]"

    /**
     * Resolve the prompt to actually ask: the stored choice if the user set one,
     * else [DEFAULT_PROMPT]. A blank/whitespace-only stored value falls back too
     * (an empty custom prompt must not ask nothing).
     */
    fun resolve(stored: String?): String =
        stored?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_PROMPT

    /** Prepend the briefing steer to the resolved prompt — the exact text POSTed
     *  as the briefing question. */
    fun steer(prompt: String): String = "$BRIEFING_STEER $prompt"

    /**
     * Is [preset] the currently-selected one, given the stored prompt? Matches
     * iOS's checkmark rule: the preset whose prompt equals the stored value, OR
     * the default ("Daily brief") when nothing is stored yet. Used to tick the
     * chosen row in Settings.
     */
    fun isSelected(preset: Preset, stored: String?): Boolean {
        val s = stored?.trim().orEmpty()
        if (s.isEmpty()) return preset.prompt == DEFAULT_PROMPT
        return preset.prompt == s
    }
}
