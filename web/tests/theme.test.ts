// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'

// theme.ts touches localStorage in save/load/approve paths
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

import {
  resolveTheme, isValidHex, hexToRgbTriplet, THEME_PRESETS,
  isCustomJsApproved, approveCustomJs, ensureLegibleAccent,
} from '../lib/theme'

// Same relative-luminance formula the guard uses — asserts the OUTPUT clears
// the floor, not just that it changed.
function lum(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.substring(i, i + 2), 16))
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

beforeEach(() => { store.clear() })

describe('resolveTheme', () => {
  it('preset name resolves to its palette', () => {
    expect(resolveTheme({ preset: 'cyberpunk' })).toEqual({ preset: 'cyberpunk', accent: '#ff00ff', bg: '#0a0a1a' })
    expect(resolveTheme({ preset: ' Nord ' })?.preset).toBe('nord') // trimmed + lowercased
  })

  it('hex overrides win over the preset palette', () => {
    const t = resolveTheme({ preset: 'ocean', accent: '#ff6600' })!
    expect(t.accent).toBe('#ff6600')
    expect(t.bg).toBe(THEME_PRESETS.ocean.bg)
  })

  it('custom hex without preset → preset "custom" with tiny fallbacks', () => {
    const t = resolveTheme({ accent: '#123abc' })!
    expect(t.preset).toBe('custom')
    expect(t.accent).toBe('#123abc')
    expect(t.bg).toBe(THEME_PRESETS.tiny.bg)
  })

  it('INVALID hex falls back rather than injecting into CSS vars', () => {
    // resolveTheme output lands in style.setProperty — a non-hex string
    // here would be a CSS injection vector via the set_theme tool
    const t = resolveTheme({ preset: 'tiny', accent: 'red; } body { display:none' })!
    expect(t.accent).toBe(THEME_PRESETS.tiny.accent)
  })

  it('nothing usable → null', () => {
    expect(resolveTheme({})).toBeNull()
    expect(resolveTheme({ preset: 'no-such-preset' })).toBeNull()
  })
})

describe('hex helpers', () => {
  it('validates 6-digit hex only', () => {
    expect(isValidHex('#00FF88')).toBe(true)
    expect(isValidHex('#0f8')).toBe(false)
    expect(isValidHex('00FF88')).toBe(false)
    expect(isValidHex('#00FF88; }')).toBe(false)
  })

  it('converts to the rgb triplet used in rgba() vars', () => {
    expect(hexToRgbTriplet('#00FF88')).toBe('0, 255, 136')
    expect(hexToRgbTriplet('#000000')).toBe('0, 0, 0')
  })
})

describe('ensureLegibleAccent — WCAG contrast floor', () => {
  it('lifts a near-black accent above the legibility floor', () => {
    // set_theme accepts any 6-hex accent. #050505 as a button fill under a
    // hardcoded #000 glyph (Send/Link/Claim) or as text on the #000 bg is
    // ~1:1 — invisible. The guard must lift it, not pass it through.
    const out = ensureLegibleAccent('#050505')
    expect(out).not.toBe('#050505')
    expect(lum(out)).toBeGreaterThanOrEqual(0.15)
    expect(isValidHex(out)).toBe(true)
  })

  it('lifts a saturated-but-dark accent (dark navy) while keeping it valid hex', () => {
    const out = ensureLegibleAccent('#000033')
    expect(lum(out)).toBeGreaterThanOrEqual(0.15)
    expect(isValidHex(out)).toBe(true)
  })

  it('leaves an already-legible accent UNCHANGED', () => {
    // The classic tiny green and every shipped preset are above the floor.
    expect(ensureLegibleAccent('#00FF88')).toBe('#00FF88')
    for (const p of Object.values(THEME_PRESETS)) {
      expect(ensureLegibleAccent(p.accent)).toBe(p.accent)
    }
  })

  it('passes a non-hex string through untouched (validation happens upstream)', () => {
    expect(ensureLegibleAccent('not-a-hex')).toBe('not-a-hex')
  })
})

describe('custom JS approval (per-script consent)', () => {
  it('approval is bound to the exact script content', async () => {
    const js = 'document.title = "hi"'
    expect(await isCustomJsApproved(js)).toBe(false)
    await approveCustomJs(js)
    expect(await isCustomJsApproved(js)).toBe(true)
    // ONE character of drift invalidates — approving X must not authorize Y
    expect(await isCustomJsApproved(js + ';')).toBe(false)
  })

  it('approving a new script replaces the old approval', async () => {
    await approveCustomJs('script A')
    await approveCustomJs('script B')
    expect(await isCustomJsApproved('script A')).toBe(false)
    expect(await isCustomJsApproved('script B')).toBe(true)
  })

  it('uses a collision-resistant (64-hex SHA-256) fingerprint, not a 32-bit hash', async () => {
    // The stored fingerprint must be SHA-256 hex so an attacker can't craft a
    // different script that collides with an approved one.
    await approveCustomJs('some script')
    const stored = localStorage.getItem('tiny-custom-js-approved') || ''
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
  })
})
