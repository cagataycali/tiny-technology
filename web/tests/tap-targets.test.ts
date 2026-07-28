// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Touch targets on precision-critical surfaces (backlog v3 item 9): the
 * copy buttons and network radios on the money pages measured 22–30px —
 * and picking the wrong network is a permanent-400 class of mistake.
 * `.tap-target` extends the HIT rectangle to 44px (WCAG 2.5.8) while the
 * pill stays visually compact; jsdom can't measure pseudo-elements, so the
 * contract is pinned at the source level.
 */
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

describe('tap targets', () => {
  it('globals.css defines the 44px hit-area utility', () => {
    const css = read('../app/globals.css')
    expect(css).toContain('.tap-target::after')
    expect(css).toMatch(/width:\s*max\(100%,\s*44px\)/)
    expect(css).toMatch(/height:\s*max\(100%,\s*44px\)/)
  })

  it('every small pill on the money/calls surfaces carries it', () => {
    const wallet = read('../app/wallet/page.tsx')
    // 2 copy buttons + 2 network radio groups + the retry pill the
    // tripwire below caught on its first run (the survey had missed it)
    expect(wallet.match(/className="tap-target /g)?.length).toBe(5)
    const calls = read('../app/calls/page.tsx')
    expect(calls.match(/className="tap-target /g)?.length).toBe(1)
  })

  it('no NEW sub-40px interactive pill ships without it (money surfaces)', () => {
    // Heuristic tripwire: a py-1/py-1.5 button className on these two pages
    // must include tap-target. Catches the next compact pill at review time.
    for (const page of ['../app/wallet/page.tsx', '../app/calls/page.tsx']) {
      const src = read(page)
      const smallPills = src.match(/className="[^"]*\bpy-1(\.5)?\b[^"]*"/g) || []
      const unguarded = smallPills.filter((c) => !c.includes('tap-target'))
      expect(unguarded, `${page}: ${unguarded.join('\n')}`).toEqual([])
    }
  })
})
