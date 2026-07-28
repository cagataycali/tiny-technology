/**
 * Model pricing (COMPARISON.md §2.18, careless cost-estimation) — USD per
 * MILLION tokens, matched by substring against the model id. BYOK means the
 * user pays their provider directly; this makes that cost visible per turn.
 *
 * Rates are point-in-time list prices (updated 2026-07); estimates are
 * labeled "~" in the UI. Unknown models → null (no estimate shown).
 */

type Rate = { input: number; output: number }

// Ordered: first substring match wins, so put more specific ids first.
const PRICING: [string, Rate][] = [
  // Anthropic (direct + Bedrock ids) — list prices per platform.claude.com
  // (verified 2026-07). Order matters: opus-4-6/7/8 must precede the generic
  // claude-opus-4 row, which otherwise substring-swallows them at the old
  // 4.0/4.1-era rate (users were shown 3× the real cost).
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 15, output: 75 }], // legacy 4.0/4.1
  ['claude-sonnet-5', { input: 3, output: 15 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  // OpenAI
  ['gpt-5-mini', { input: 0.25, output: 2 }],
  ['gpt-5-nano', { input: 0.05, output: 0.4 }],
  ['gpt-5', { input: 1.25, output: 10 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6 }],
  ['gpt-4o', { input: 2.5, output: 10 }],
  ['o3', { input: 2, output: 8 }],
  ['o4-mini', { input: 1.1, output: 4.4 }],
  // Google
  ['gemini-2.5-pro', { input: 1.25, output: 10 }],
  ['gemini-2.5-flash-lite', { input: 0.1, output: 0.4 }],
  ['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
  // DeepSeek / others (popular OpenAI-compat picks)
  ['deepseek-chat', { input: 0.27, output: 1.1 }],
  ['deepseek-reasoner', { input: 0.55, output: 2.19 }],
  ['llama-3.3-70b', { input: 0.59, output: 0.79 }],
  ['mixtral-8x7b', { input: 0.24, output: 0.24 }],
]

/**
 * One spelling for a version number, so the table can be written once.
 *
 * ⚠️ THE BUG THIS FIXES, and it was a WRONG NUMBER, not a missing one.
 * Providers disagree about the separator inside a version: Anthropic direct and
 * Bedrock say `claude-opus-4-8`, OpenRouter says `anthropic/claude-opus-4.8`.
 * The table is written the first way, so the dotted id missed every specific
 * Opus row and fell through to the generic `claude-opus-4` legacy row —
 * **billing a 5/25 model at 15/75, three times its real list price**, on the one
 * screen a BYOK user consults to find out what a turn costs. The comments above
 * warn about exactly this fall-through; the dotted spelling walked straight past
 * them. And `openrouter` is not exotic: it is a shipped preset whose own model
 * placeholder (`anthropic/claude-sonnet-4.5`) is dotted on web, iOS and Android.
 *
 * Both sides are normalized, because needles carry dots too (`gemini-2.5-pro`) —
 * folding only the id would have broken every Google row to fix the Anthropic
 * ones. Dots that separate NAME parts rather than version parts survive the fold
 * harmlessly: `global.anthropic.claude-sonnet-4-6` becomes
 * `global-anthropic-claude-sonnet-4-6`, which still contains its needle.
 */
function foldVersionSeparators(s: string): string {
  return s.toLowerCase().replace(/\./g, '-')
}

const FOLDED_PRICING: [string, Rate][] = PRICING.map(([needle, rate]) => [foldVersionSeparators(needle), rate])

export function rateFor(modelId: string | undefined | null): Rate | null {
  if (!modelId) return null
  const id = foldVersionSeparators(modelId)
  for (const [needle, rate] of FOLDED_PRICING) {
    if (id.includes(needle)) return rate
  }
  return null
}

// Cached input reads bill at a fraction of the input rate across all
// major providers (OpenAI/Anthropic/Google all land near 10-25%); 0.1 is
// a conservative-low common denominator for a "~" estimate.
const CACHE_READ_MULTIPLIER = 0.1

/** Estimated USD for a turn, or null when the model isn't in the table. */
export function estimateCost(
  modelId: string | undefined | null,
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number }
): number | null {
  const rate = rateFor(modelId)
  if (!rate) return null
  // Coerce token fields to finite, NON-NEGATIVE numbers — a provider that
  // omits one (the type says required, but events can arrive partial) would
  // otherwise make the arithmetic NaN, and since we return a number (not null)
  // that NaN poisons the whole /cost running total ($NaN forever). Floor at 0
  // too: a partial/garbled event can carry a NEGATIVE count, which would emit a
  // negative "cost" that drags down the accumulator (Chat.tsx `usd += c`).
  // Android/iOS clamp identically (ModelPricing.kt:65 coerceAtLeast(0),
  // ModelPricing.swift:66 max(0,…)) — keep the three estimates in agreement.
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0)
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0)
  // Cached reads are counted inside inputTokens by the providers; split
  // them out and charge the discounted rate so the estimate isn't inflated
  // for long-lived conversations (which cache heavily). Floor at 0 then clamp
  // to inputTokens (matches Android's coerceIn(0, input)).
  const cached = Math.min(Math.max(0, Number(usage.cacheReadInputTokens) || 0), inputTokens)
  const freshInput = inputTokens - cached
  return (
    freshInput * rate.input +
    cached * rate.input * CACHE_READ_MULTIPLIER +
    outputTokens * rate.output
  ) / 1_000_000
}

/** "$0.0042" | "$1.23" | "<$0.0001" — compact display form. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.0001) return '<$0.0001'
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`
}
