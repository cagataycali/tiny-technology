package technology.tiny.app.chat

import java.util.Locale

/**
 * Model pricing — USD per MILLION tokens, matched by substring against the
 * resolved model id. A direct port of the web's lib/model-pricing.ts (rates,
 * ordering and the cache-read discount all mirror it 1:1) so Android's per-turn
 * "~$" estimate agrees with the web. BYOK means the user pays their provider
 * directly; this makes that list-price cost visible per turn. iOS ships NO cost
 * estimate, so this is a web-parity feature that exceeds the iOS app.
 *
 * Rates are point-in-time list prices (web table, 2026-07); estimates are
 * labeled "~" in the UI. Unknown models → null (no estimate shown).
 */
object ModelPricing {
    private data class Rate(val input: Double, val output: Double)

    // Ordered: first substring match wins, so more specific ids come first
    // (e.g. opus-4-8 must precede the generic claude-opus-4 legacy row).
    private val PRICING: List<Pair<String, Rate>> = listOf(
        "claude-fable-5" to Rate(10.0, 50.0),
        "claude-opus-4-8" to Rate(5.0, 25.0),
        "claude-opus-4-7" to Rate(5.0, 25.0),
        "claude-opus-4-6" to Rate(5.0, 25.0),
        "claude-opus-4" to Rate(15.0, 75.0), // legacy 4.0/4.1
        "claude-sonnet-5" to Rate(3.0, 15.0),
        "claude-sonnet-4" to Rate(3.0, 15.0),
        "claude-haiku-4" to Rate(1.0, 5.0),
        "claude-3-5-haiku" to Rate(0.8, 4.0),
        "gpt-5-mini" to Rate(0.25, 2.0),
        "gpt-5-nano" to Rate(0.05, 0.4),
        "gpt-5" to Rate(1.25, 10.0),
        "gpt-4o-mini" to Rate(0.15, 0.6),
        "gpt-4o" to Rate(2.5, 10.0),
        "o3" to Rate(2.0, 8.0),
        "o4-mini" to Rate(1.1, 4.4),
        "gemini-2.5-pro" to Rate(1.25, 10.0),
        "gemini-2.5-flash-lite" to Rate(0.1, 0.4),
        "gemini-2.5-flash" to Rate(0.3, 2.5),
        "deepseek-chat" to Rate(0.27, 1.1),
        "deepseek-reasoner" to Rate(0.55, 2.19),
        "llama-3.3-70b" to Rate(0.59, 0.79),
        "mixtral-8x7b" to Rate(0.24, 0.24),
    )

    // Cached input reads bill at a fraction of the input rate across all major
    // providers (OpenAI/Anthropic/Google all land near 10-25%); 0.1 is a
    // conservative-low common denominator for a "~" estimate (web parity).
    private const val CACHE_READ_MULTIPLIER = 0.1

    /**
     * One spelling for a version number, so the table can be written once.
     *
     * ⚠️ Providers disagree about the separator INSIDE a version: Anthropic direct
     * and Bedrock say `claude-opus-4-8`, OpenRouter says
     * `anthropic/claude-opus-4.8`. The table is written the first way, so a dotted
     * id missed every specific Opus row and fell through to the generic
     * `claude-opus-4` legacy row — billing a 5/25 model at 15/75, THREE TIMES its
     * real list price, on the one label a BYOK user reads to learn what a turn
     * cost. `anthropic/claude-sonnet-4.5` is this app's own OpenRouter preset
     * placeholder (ModelConfigStore.kt), so the dotted spelling is what users type.
     *
     * Both sides are folded, because needles carry dots too (`gemini-2.5-pro`).
     * Dots separating NAME parts fold harmlessly:
     * `global.anthropic.claude-sonnet-5` still contains its needle after.
     */
    fun foldVersionSeparators(s: String): String = s.lowercase(Locale.US).replace('.', '-')

    // Folded once at class-init, not per call: this runs for every turn's label.
    private val FOLDED_PRICING: List<Pair<String, Rate>> =
        PRICING.map { foldVersionSeparators(it.first) to it.second }

    private fun rateFor(modelId: String?): Rate? {
        if (modelId.isNullOrEmpty()) return null
        val id = foldVersionSeparators(modelId)
        return FOLDED_PRICING.firstOrNull { id.contains(it.first) }?.second
    }

    /** Estimated USD for a turn, or null when the model isn't in the table. */
    fun estimateCost(modelId: String?, inputTokens: Int, outputTokens: Int, cacheReadInputTokens: Int): Double? {
        val rate = rateFor(modelId) ?: return null
        // Floor the raw counts at 0 FIRST — a partial/garbled usage event can carry a
        // negative token count, and `coerceIn(0, inputTokens)` throws when inputTokens
        // is negative (Kotlin requires min ≤ max). iOS/web clamp before dividing for
        // the same reason (ModelPricing.swift:66 max(0,…); model-pricing.ts Number()||0).
        val input = inputTokens.coerceAtLeast(0)
        val output = outputTokens.coerceAtLeast(0)
        // Cached reads are counted inside inputTokens by the providers; split them
        // out and charge the discounted rate so the estimate isn't inflated for
        // long-lived conversations (which cache heavily). Clamp so cached ≤ input.
        val cached = cacheReadInputTokens.coerceIn(0, input)
        val freshInput = input - cached
        return (
            freshInput * rate.input +
                cached * rate.input * CACHE_READ_MULTIPLIER +
                output * rate.output
            ) / 1_000_000.0
    }

    /** "$0.0042" | "$1.23" | "<$0.0001" — compact display form (web formatCost). */
    fun formatCost(usd: Double): String {
        if (usd > 0 && usd < 0.0001) return "<$0.0001"
        return "$" + String.format(Locale.US, if (usd >= 1) "%.2f" else "%.4f", usd)
    }
}
