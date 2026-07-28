package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * First Android unit tests — ModelPricing is pure Kotlin (no android.* deps), so
 * it runs on the local JVM (./gradlew :app:testDebugUnitTest). Guards the subtle
 * bits that keep the per-turn "~$" estimate agreeing with web's lib/model-pricing.ts:
 * first-substring-match ordering, the cache-read split/clamp, and formatCost's
 * threshold + locale.
 */
class ModelPricingTest {

    private val EPS = 1e-9

    @Test fun `unknown model returns null`() {
        assertNull(ModelPricing.estimateCost("some-unlisted-model", 1000, 1000, 0))
        assertNull(ModelPricing.estimateCost(null, 1000, 1000, 0))
        assertNull(ModelPricing.estimateCost("", 1000, 1000, 0))
    }

    @Test fun `basic input plus output cost, no cache`() {
        // sonnet-5 = $3/M input, $15/M output. 1M in + 1M out = 3 + 15 = 18.
        val c = ModelPricing.estimateCost("claude-sonnet-5", 1_000_000, 1_000_000, 0)!!
        assertEquals(18.0, c, EPS)
    }

    @Test fun `cache reads bill at one tenth the input rate`() {
        // opus-4-8 = $5/M in. 1M input where 1M is cached → 1M * 5 * 0.1 = 0.5, no output.
        val cached = ModelPricing.estimateCost("claude-opus-4-8", 1_000_000, 0, 1_000_000)!!
        assertEquals(0.5, cached, EPS)
        // Same tokens with NO cache reads bills full: 1M * 5 = 5.0.
        val fresh = ModelPricing.estimateCost("claude-opus-4-8", 1_000_000, 0, 0)!!
        assertEquals(5.0, fresh, EPS)
        assertTrue("cached must be cheaper than fresh", cached < fresh)
    }

    @Test fun `cache tokens are clamped to input tokens`() {
        // cacheRead (5M) > input (500k): cached clamps to 500k, freshInput → 0 (not
        // negative). haiku-4 = $1/M in → 0 fresh + 500k*1*0.1 = 0.05 (per 1e6).
        val c = ModelPricing.estimateCost("claude-haiku-4", 500_000, 0, 5_000_000)!!
        assertEquals(0.05, c, EPS)
    }

    @Test fun `negative token counts floor to zero — never throws`() {
        // A partial/garbled usage event can carry a negative count. The old
        // coerceIn(0, inputTokens) threw when inputTokens < 0 (min 0 > max); floor
        // each count at 0 first, matching iOS max(0,…) / web Number()||0.
        // Negative input → 0 fresh; the discounted-cache term is also 0 → $0.
        assertEquals(0.0, ModelPricing.estimateCost("claude-sonnet-5", -100, 0, 0)!!, EPS)
        // Negative output contributes nothing (clamped), input still bills.
        assertEquals(3.0, ModelPricing.estimateCost("claude-sonnet-5", 1_000_000, -5, 0)!!, EPS)
        // Negative cacheRead clamps up to 0, so the whole input bills as fresh.
        assertEquals(3.0, ModelPricing.estimateCost("claude-sonnet-5", 1_000_000, 0, -1)!!, EPS)
        // All-negative: no throw, $0.
        assertEquals(0.0, ModelPricing.estimateCost("claude-sonnet-5", -1, -1, -1)!!, EPS)
    }

    @Test fun `more specific model id wins over legacy prefix`() {
        // "claude-opus-4-8" ($5/$25) must match before the generic "claude-opus-4"
        // legacy row ($15/$75). 1M out → opus-4-8 = 25, legacy = 75.
        val specific = ModelPricing.estimateCost("claude-opus-4-8", 0, 1_000_000, 0)!!
        assertEquals(25.0, specific, EPS)
        // A bare legacy id still lands on the $15/$75 row.
        val legacy = ModelPricing.estimateCost("claude-opus-4-1", 0, 1_000_000, 0)!!
        assertEquals(75.0, legacy, EPS)
    }

    @Test fun `gpt-5 variants do not collide with the base gpt-5 row`() {
        // "gpt-5-mini" ($0.25/$2) and "gpt-5-nano" ($0.05/$0.4) precede "gpt-5"
        // ($1.25/$10), so the specific rows win.
        assertEquals(2.0, ModelPricing.estimateCost("gpt-5-mini", 0, 1_000_000, 0)!!, EPS)
        assertEquals(0.4, ModelPricing.estimateCost("gpt-5-nano", 0, 1_000_000, 0)!!, EPS)
        assertEquals(10.0, ModelPricing.estimateCost("gpt-5", 0, 1_000_000, 0)!!, EPS)
    }

    @Test fun `gemini flash-lite does not bill at the pricier flash rate`() {
        // "gemini-2.5-flash-lite" ($0.1/$0.4) CONTAINS the "gemini-2.5-flash"
        // ($0.3/$2.5) needle, so flash-lite must precede flash in the table —
        // exactly the gpt-5/opus-4 substring-swallow trap, but untested until now.
        // A reorder would silently bill flash-lite at 3× input / 6× output.
        assertEquals(0.4, ModelPricing.estimateCost("gemini-2.5-flash-lite", 0, 1_000_000, 0)!!, EPS)
        assertEquals(0.1, ModelPricing.estimateCost("gemini-2.5-flash-lite", 1_000_000, 0, 0)!!, EPS)
        // A plain flash id still lands on the pricier row.
        assertEquals(2.5, ModelPricing.estimateCost("gemini-2.5-flash", 0, 1_000_000, 0)!!, EPS)
        assertEquals(0.3, ModelPricing.estimateCost("gemini-2.5-flash", 1_000_000, 0, 0)!!, EPS)
    }

    @Test fun `model id match is case-insensitive`() {
        val lower = ModelPricing.estimateCost("claude-sonnet-5", 0, 1_000_000, 0)!!
        val upper = ModelPricing.estimateCost("CLAUDE-SONNET-5", 0, 1_000_000, 0)!!
        assertEquals(lower, upper, EPS)
    }

    /**
     * 💸 The dotted spelling used to cost 3× the real price.
     *
     * OpenRouter writes versions with a DOT (`anthropic/claude-opus-4.8`) while
     * this table is written with dashes, so a dotted id missed every specific Opus
     * row and landed on the generic `claude-opus-4` legacy row: 15/75 instead of
     * 5/25. Row ORDER was right the whole time — the id was spelled a way no row
     * was written in. `anthropic/claude-sonnet-4.5` is this app's own OpenRouter
     * preset placeholder (ModelConfigStore.kt), so that spelling is what users type.
     */
    @Test fun `dotted and dashed spellings of one model cost the same`() {
        assertEquals(25.0, ModelPricing.estimateCost("anthropic/claude-opus-4.8", 0, 1_000_000, 0)!!, EPS)
        assertEquals(15.0, ModelPricing.estimateCost("anthropic/claude-sonnet-4.5", 0, 1_000_000, 0)!!, EPS)
        // The legacy row still keeps its own higher rate, dotted or not.
        assertEquals(75.0, ModelPricing.estimateCost("claude-opus-4.1", 0, 1_000_000, 0)!!, EPS)
    }

    /** Folding must not cost a row to a dotted NAMESPACE or a dotted NEEDLE. */
    @Test fun `folding keeps dotted namespaces and dotted needles priced`() {
        assertEquals(15.0, ModelPricing.estimateCost("global.anthropic.claude-sonnet-5", 0, 1_000_000, 0)!!, EPS)
        assertEquals(10.0, ModelPricing.estimateCost("gemini-2.5-pro", 0, 1_000_000, 0)!!, EPS)
        assertEquals(0.4, ModelPricing.estimateCost("google/gemini-2.5-flash-lite", 0, 1_000_000, 0)!!, EPS)
        assertEquals(2.0, ModelPricing.estimateCost("gpt-5-mini-2025-08-07", 0, 1_000_000, 0)!!, EPS)
    }

    @Test fun `formatCost thresholds and precision`() {
        assertEquals("<\$0.0001", ModelPricing.formatCost(0.00005))
        assertEquals("\$0.0042", ModelPricing.formatCost(0.0042))
        assertEquals("\$1.23", ModelPricing.formatCost(1.23))
        // exactly zero is not the "<" case (guard is usd > 0)
        assertEquals("\$0.0000", ModelPricing.formatCost(0.0))
        // >= 1 switches to 2-decimal form
        assertEquals("\$12.50", ModelPricing.formatCost(12.5))
    }
}
