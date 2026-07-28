// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * /about must follow the theme engine, not its own hardcoded palette —
 * it was the last page where a visitor's saved custom theme (or an agent
 * set_theme) was ignored entirely. Source-level guard, same style as the
 * banned-hex approach in globals.css's --tiny-danger consolidation: the
 * regression class is "someone pastes a green back in".
 */
const src = readFileSync(join(__dirname, '../app/about/page.tsx'), 'utf8')

describe('/about theme fidelity', () => {
  it('has no hardcoded accent or accent-derived surface hexes', () => {
    // #00FF88 = the old ACCENT const; #06160E = card fills; #020604 = page bg.
    // All three must come from tokens now.
    for (const banned of [/#00FF88/i, /#06160E/i, /#020604/i]) {
      expect(src).not.toMatch(banned)
    }
  })

  it('has no hex-alpha suffix applied to the accent (invalid on a var())', () => {
    // `${ACCENT}33`-style template concatenation silently produces
    // "var(--tiny-accent)33" — an invalid color the browser drops.
    expect(src).not.toMatch(/\$\{ACCENT\}[0-9a-f]{2}/i)
  })

  it('uses the theme tokens', () => {
    expect(src).toContain('var(--tiny-accent)')
    expect(src).toContain('rgba(var(--tiny-accent-rgb)')
    expect(src).toContain('var(--tiny-bg)')
  })
})
