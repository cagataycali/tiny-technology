/**
 * ModelPricing — per-turn USD estimate, a 1:1 port of the web's
 * lib/model-pricing.ts (and mirrored by android's ModelPricing.kt) so the
 * "~$" a user sees on iOS agrees with the web and android to the cent.
 *
 * Rates are point-in-time LIST prices (USD per MILLION tokens, updated
 * 2026-07); BYOK means the user pays their provider directly, so this makes
 * that cost visible per turn. Estimates are labeled "~" in the UI. An unknown
 * model → nil (no estimate shown, never a wrong number).
 */
import Foundation

enum ModelPricing {
    struct Rate { let input: Double; let output: Double }

    // Ordered: first substring match wins, so more-specific ids come first.
    // opus-4-6/7/8 MUST precede the generic claude-opus-4 row, which would
    // otherwise substring-swallow them at the legacy 4.0/4.1 rate (3× the real
    // cost). This ordering bug is called out in lib/model-pricing.ts — the
    // OpusRowOrdering test locks it here too.
    private static let pricing: [(String, Rate)] = [
        // Anthropic (direct + Bedrock ids)
        ("claude-fable-5", Rate(input: 10, output: 50)),
        ("claude-opus-4-8", Rate(input: 5, output: 25)),
        ("claude-opus-4-7", Rate(input: 5, output: 25)),
        ("claude-opus-4-6", Rate(input: 5, output: 25)),
        ("claude-opus-4", Rate(input: 15, output: 75)), // legacy 4.0/4.1
        ("claude-sonnet-5", Rate(input: 3, output: 15)),
        ("claude-sonnet-4", Rate(input: 3, output: 15)),
        ("claude-haiku-4", Rate(input: 1, output: 5)),
        ("claude-3-5-haiku", Rate(input: 0.8, output: 4)),
        // OpenAI
        ("gpt-5-mini", Rate(input: 0.25, output: 2)),
        ("gpt-5-nano", Rate(input: 0.05, output: 0.4)),
        ("gpt-5", Rate(input: 1.25, output: 10)),
        ("gpt-4o-mini", Rate(input: 0.15, output: 0.6)),
        ("gpt-4o", Rate(input: 2.5, output: 10)),
        ("o3", Rate(input: 2, output: 8)),
        ("o4-mini", Rate(input: 1.1, output: 4.4)),
        // Google
        ("gemini-2.5-pro", Rate(input: 1.25, output: 10)),
        ("gemini-2.5-flash-lite", Rate(input: 0.1, output: 0.4)),
        ("gemini-2.5-flash", Rate(input: 0.3, output: 2.5)),
        // DeepSeek / others
        ("deepseek-chat", Rate(input: 0.27, output: 1.1)),
        ("deepseek-reasoner", Rate(input: 0.55, output: 2.19)),
        ("llama-3.3-70b", Rate(input: 0.59, output: 0.79)),
        ("mixtral-8x7b", Rate(input: 0.24, output: 0.24)),
    ]

    /// One spelling for a version number, so the table can be written once.
    ///
    /// ⚠️ Providers disagree about the separator INSIDE a version: Anthropic
    /// direct and Bedrock say `claude-opus-4-8`, OpenRouter says
    /// `anthropic/claude-opus-4.8`. The table is written the first way, so a
    /// dotted id missed every specific Opus row and fell through to the generic
    /// `claude-opus-4` legacy row — billing a 5/25 model at 15/75, THREE TIMES
    /// its real list price, on the one label a BYOK user reads to learn what a
    /// turn cost. `anthropic/claude-sonnet-4.5` is this app's own OpenRouter
    /// placeholder (ModelConfig.swift), so the dotted spelling is what users type.
    ///
    /// Both sides are folded, because needles carry dots too (`gemini-2.5-pro`).
    /// Dots separating NAME parts fold harmlessly:
    /// `global.anthropic.claude-sonnet-4-6` still contains its needle after.
    static func foldVersionSeparators(_ s: String) -> String {
        s.lowercased().replacingOccurrences(of: ".", with: "-")
    }

    static func rate(for modelId: String?) -> Rate? {
        guard let modelId else { return nil }
        let id = foldVersionSeparators(modelId)
        for (needle, rate) in pricing where id.contains(foldVersionSeparators(needle)) { return rate }
        return nil
    }

    // Cached input reads bill at a fraction of the input rate across all major
    // providers (OpenAI/Anthropic/Google land near 10-25%); 0.1 is a
    // conservative-low common denominator for a "~" estimate.
    private static let cacheReadMultiplier = 0.1

    /// Estimated USD for a turn, or nil when the model isn't in the table.
    static func estimateCost(modelId: String?, inputTokens: Int, outputTokens: Int, cacheReadInputTokens: Int = 0) -> Double? {
        guard let rate = rate(for: modelId) else { return nil }
        let input = max(0, inputTokens)
        let output = max(0, outputTokens)
        // Cached reads are counted INSIDE inputTokens by the providers; split
        // them out and charge the discounted rate so the estimate isn't
        // inflated for long-lived (cache-heavy) conversations.
        let cached = min(max(0, cacheReadInputTokens), input)
        let freshInput = input - cached
        return (Double(freshInput) * rate.input
                + Double(cached) * rate.input * cacheReadMultiplier
                + Double(output) * rate.output) / 1_000_000
    }

    /// "$0.0042" | "$1.23" | "<$0.0001" — compact display form.
    static func formatCost(_ usd: Double) -> String {
        if usd > 0 && usd < 0.0001 { return "<$0.0001" }
        return String(format: usd >= 1 ? "$%.2f" : "$%.4f", usd)
    }
}
