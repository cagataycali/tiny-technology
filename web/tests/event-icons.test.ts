// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { iconFor, EMITTED_KINDS, KIND_ICONS } from '../lib/chat/event-icons'

/**
 * Pins iconFor() against the event kinds the worker actually emits
 * (chatgpt-plugin-tinyai/src/*.ts). The regression this guards: the icon map
 * keyed `visit` but the only visit kind is `tiny_visit`, and
 * "tiny_visit".startsWith("visit") is false — so the reserved 👀 icon was dead
 * and every page-visit row fell through to the generic ⚡ fallback.
 */
describe('iconFor', () => {
  it('tiny_visit → 👀 (the regression: was ⚡ when keyed as "visit")', () => {
    expect(iconFor('tiny_visit')).toBe('👀')
  })

  it('prefix matches for the multi-suffix kinds', () => {
    expect(iconFor('job_result')).toBe('⏰')
    expect(iconFor('job_error')).toBe('⏰')
    expect(iconFor('telegram')).toBe('✈️')
    expect(iconFor('telegram_out')).toBe('✈️')
    expect(iconFor('telegram_button')).toBe('✈️')
  })

  it('exact-match kinds', () => {
    expect(iconFor('follow')).toBe('🤝')
    expect(iconFor('dm')).toBe('💬')
  })

  it('unknown kind → ⚡ fallback', () => {
    expect(iconFor('mystery')).toBe('⚡')
    expect(iconFor('')).toBe('⚡')
  })

  /**
   * ⚠️ THE GAP THIS PINS. ⚡ is the right answer for a kind a newer worker
   * invented and the wrong answer for one we ship — and the two render
   * IDENTICALLY, so nothing failed while `pay_alarm` ("🚨 x402 reconciliation
   * needs a human", swept every minute) drew the same glyph as a corrupt event
   * on all three human HUDs. The fallback is unchanged; the ROSTER is what makes
   * a missing glyph fail instead of ship.
   */
  it('EVERY kind the worker emits has a real glyph, not the unknown fallback', () => {
    for (const kind of EMITTED_KINDS) {
      expect(iconFor(kind), `${kind} falls through to ⚡ — add a KIND_ICONS entry`)
        .not.toBe('⚡')
    }
  })

  it('pay_alarm is 🚨 and nothing else is — the loudest event needs its own glyph', () => {
    // Distinctness is the requirement, not the emoji: a reconciliation page that
    // shares a glyph with page views is a page nobody reads.
    expect(iconFor('pay_alarm')).toBe('🚨')
    const others = EMITTED_KINDS.filter((k) => k !== 'pay_alarm').map(iconFor)
    expect(others, 'another kind also renders 🚨').not.toContain('🚨')
  })

  it('every key is a prefix of something real, or a declared reserve', () => {
    // The tiny_visit bug generalised: a key that matches no emitted kind is dead
    // code that reads as coverage. share/learn/push are documented reserves.
    const RESERVES = ['share', 'learn', 'push']
    for (const key of Object.keys(KIND_ICONS)) {
      if (RESERVES.includes(key)) continue
      expect(
        EMITTED_KINDS.some((k) => k.startsWith(key)),
        `KIND_ICONS key "${key}" matches no emitted kind — dead glyph (the tiny_visit bug)`,
      ).toBe(true)
    }
  })

  it('malformed kind (non-string from worker payload) → ⚡, never throws', () => {
    // ActivityHUD passes e.kind straight from the worker event payload; a
    // missing/non-string kind must degrade to ⚡, not throw on .startsWith and
    // crash the HUD render.
    expect(iconFor(undefined as unknown as string)).toBe('⚡')
    expect(iconFor(null as unknown as string)).toBe('⚡')
    expect(iconFor(123 as unknown as string)).toBe('⚡')
    // A numeric kind that stringifies to a matching prefix still resolves
    expect(iconFor({} as unknown as string)).toBe('⚡')
  })
})
