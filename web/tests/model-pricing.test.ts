// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { rateFor, estimateCost, formatCost } from '../lib/model-pricing'
import { FALLBACKS } from '../lib/model-registry'

describe('rateFor', () => {
  it('matches by substring — Bedrock-prefixed ids resolve', () => {
    expect(rateFor('global.anthropic.claude-sonnet-5')).toEqual({ input: 3, output: 15 })
    expect(rateFor('claude-sonnet-5')).toEqual({ input: 3, output: 15 })
  })

  it('current-generation Claude rates (list prices, verified 2026-07)', () => {
    expect(rateFor('claude-fable-5')).toEqual({ input: 10, output: 50 })
    // opus-4-8 must NOT fall through to the legacy claude-opus-4 row (15/75)
    expect(rateFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 })
    expect(rateFor('anthropic.claude-opus-4-6')).toEqual({ input: 5, output: 25 })
    expect(rateFor('claude-opus-4-1')).toEqual({ input: 15, output: 75 }) // legacy keeps its rate
    expect(rateFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 })
    expect(rateFor('claude-3-5-haiku')).toEqual({ input: 0.8, output: 4 })
  })

  it('specific ids win over general (gpt-5-mini before gpt-5)', () => {
    expect(rateFor('gpt-5-mini-2025-08-07')!.input).toBe(0.25)
    expect(rateFor('gpt-5-2025-08-07')!.input).toBe(1.25)
  })

  it('unknown or missing model → null', () => {
    expect(rateFor('some-custom-finetune')).toBeNull()
    expect(rateFor(undefined)).toBeNull()
    expect(rateFor('')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('computes per-million rates', () => {
    // 1M in + 1M out on sonnet = $3 + $15
    expect(estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
    // typical turn: 5K in, 500 out on sonnet = 0.015 + 0.0075
    expect(estimateCost('claude-sonnet-5', { inputTokens: 5000, outputTokens: 500 })).toBeCloseTo(0.0225, 6)
  })

  it('null for unpriced models', () => {
    expect(estimateCost('mystery-model', { inputTokens: 1000, outputTokens: 1000 })).toBeNull()
  })

  it('discounts cached input reads (10% of input rate)', () => {
    // sonnet input $3/M: 1M input of which 1M cached → 1M * 3 * 0.1 = $0.30
    expect(estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 })).toBeCloseTo(0.3, 6)
    // half cached: 500K fresh @ $3 + 500K cached @ $0.30 = 1.5 + 0.15 = $1.65
    expect(estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 500_000 })).toBeCloseTo(1.65, 6)
  })

  it('no cache field → all input at full rate (unchanged behavior)', () => {
    expect(estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3)
  })

  it('clamps cache reads to input tokens (never negative fresh)', () => {
    // bogus cacheRead > input: charge everything at the cached rate, no negative
    const c = estimateCost('claude-sonnet-5', { inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: 999999 })!
    expect(c).toBeGreaterThanOrEqual(0)
    expect(c).toBeCloseTo((1000 * 3 * 0.1) / 1_000_000, 9)
  })

  it('floors NEGATIVE token counts at 0 (a garbled event must not emit a negative cost)', () => {
    // A partial/garbled usage event can carry a negative count; `Number(x)||0`
    // alone would pass it through and emit a NEGATIVE "cost" that drags down the
    // Chat.tsx `usd += c` accumulator. Android/iOS floor at 0 — web must too.
    expect(estimateCost('claude-sonnet-5', { inputTokens: -5000, outputTokens: 0 })).toBe(0)
    expect(estimateCost('claude-sonnet-5', { inputTokens: 0, outputTokens: -5000 })).toBe(0)
    // a negative cacheRead floors to 0 → all input billed at the full rate
    const c = estimateCost('claude-sonnet-5', { inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: -999 })!
    expect(c).toBeCloseTo((1000 * 3) / 1_000_000, 9)
    // mixed: negative input floored, positive output still charged, never negative
    const m = estimateCost('claude-sonnet-5', { inputTokens: -100, outputTokens: 500 })!
    expect(m).toBeGreaterThanOrEqual(0)
    expect(m).toBeCloseTo((500 * 15) / 1_000_000, 9)
  })

  it('never returns NaN when a provider omits a token field (would poison /cost)', () => {
    // A partial usage object (one field undefined) must not yield NaN — the
    // /cost accumulator adds the result and NaN there corrupts the whole total.
    const a = estimateCost('claude-sonnet-5', { outputTokens: 500 } as any)
    const b = estimateCost('claude-sonnet-5', { inputTokens: 5000 } as any)
    const c = estimateCost('claude-sonnet-5', {} as any)
    for (const v of [a, b, c]) {
      expect(v).not.toBeNull()
      expect(Number.isFinite(v as number)).toBe(true)
    }
    // output-only still charges the output tokens correctly
    expect(a).toBeCloseTo((500 * 15) / 1_000_000, 9)
  })
})

/**
 * 💸 THE PRICE A DOTTED MODEL ID USED TO GET.
 *
 * The table matches by SUBSTRING and is written with dash-separated versions
 * (`claude-opus-4-8`). OpenRouter spells the same model `anthropic/claude-opus-4.8`
 * — so it missed every specific Opus row and landed on the generic
 * `claude-opus-4` legacy row: 15/75 instead of 5/25, **three times the real list
 * price**, shown on the one label a BYOK user reads to find out what a turn cost.
 *
 * The comments in all three copies of this table warn about exactly that
 * fall-through. They didn't help, because the trap wasn't row ORDER — it was that
 * an id can be spelled a way no row is written in. So these tests don't inspect
 * the table; they PRICE THE MODEL IDS THE APP ACTUALLY SHIPS, taken from
 * lib/model-registry's own FALLBACKS, in both spellings.
 */
describe('a version separator must not change the price', () => {
  it('dotted and dashed spellings of one model cost the same', () => {
    // The exact id in lib/model-registry FALLBACKS.openrouter.
    expect(rateFor('anthropic/claude-opus-4.8')).toEqual({ input: 5, output: 25 })
    expect(rateFor('anthropic/claude-opus-4.8')).toEqual(rateFor('claude-opus-4-8'))
    expect(rateFor('anthropic/claude-sonnet-4.5')).toEqual(rateFor('claude-sonnet-4-5'))
    // …and the legacy row still keeps its own (higher) rate, dotted or not.
    expect(rateFor('claude-opus-4.1')).toEqual({ input: 15, output: 75 })
  })

  it('the fold does not break ids whose dots separate NAME parts', () => {
    // Bedrock's dotted namespace, and Google's dotted version, are both real
    // shipped spellings — folding must not cost either of them their row.
    expect(rateFor('global.anthropic.claude-sonnet-5')).toEqual({ input: 3, output: 15 })
    expect(rateFor('us.anthropic.claude-haiku-4-5-v1:0')).toEqual({ input: 1, output: 5 })
    expect(rateFor('gemini-2.5-pro')).toEqual({ input: 1.25, output: 10 })
    expect(rateFor('google/gemini-2.5-flash-lite')).toEqual({ input: 0.1, output: 0.4 })
    expect(rateFor('gpt-5-mini-2025-08-07')!.input).toBe(0.25)
  })

  it('every priced id in the shipped registry gets ONE rate, whatever the spelling', () => {
    // Derived, not hand-listed (c29's rule): the ids come from the registry the
    // provider pickers actually offer. A row added there with a spelling this
    // table can't see becomes a red test instead of a wrong number.
    const ids = Object.values(FALLBACKS).flat()
    expect(ids.length).toBeGreaterThanOrEqual(40) // the derivation is load-bearing
    const disagreed: string[] = []
    for (const id of ids) {
      const a = rateFor(id)
      const b = rateFor(id.replace(/\./g, '-'))
      const c = rateFor(id.replace(/-(\d)(?=\.|-|$)/g, '.$1'))
      if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(a) !== JSON.stringify(c)) {
        disagreed.push(`${id}: ${JSON.stringify(a)} vs ${JSON.stringify(b)} vs ${JSON.stringify(c)}`)
      }
    }
    expect(disagreed).toEqual([])
  })

  it('no shipped Anthropic id is priced at the LEGACY opus rate unless it is legacy', () => {
    // The specific failure, stated as the thing it costs: nothing the app offers
    // today is a 4.0/4.1 Opus, so nothing it offers should price at 15/75.
    const legacy = { input: 15, output: 75 }
    const mispriced = Object.values(FALLBACKS).flat().filter(id => {
      const r = rateFor(id)
      return r && r.input === legacy.input && r.output === legacy.output
    })
    expect(mispriced).toEqual([])
  })
})

describe('formatCost', () => {
  it('4 decimals under $1, 2 above', () => {
    expect(formatCost(0.0225)).toBe('$0.0225')
    expect(formatCost(1.5)).toBe('$1.50')
  })

  it('floors tiny costs to <$0.0001', () => {
    expect(formatCost(0.00003)).toBe('<$0.0001')
    expect(formatCost(0)).toBe('$0.0000')
  })
})
