// @vitest-environment jsdom
/**
 * Skip link on every SiteHeader page (backlog v4 C11): chat had one, the
 * standalone pages (/universe with its fully keyboard-operable
 * constellation, /calls, profiles, chain explorer) had none — keyboard
 * users tabbed through the whole chrome on every page. The link lives in
 * SiteHeader; each page provides the id="main" target, pinned by scanning
 * EVERY file that imports SiteHeader and renders a <main>.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import SiteHeader from '../components/SiteHeader'

afterEach(cleanup)

describe('SiteHeader skip link', () => {
  it('is the FIRST focusable, sr-only until focused, targeting #main', () => {
    window.matchMedia = vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
    const { container } = render(<SiteHeader />)
    const first = container.querySelector('a')!
    expect(first.getAttribute('href')).toBe('#main')
    expect(first.className).toContain('sr-only')
    expect(first.className).toContain('focus:not-sr-only')
  })
})

describe('every SiteHeader page provides the target', () => {
  function tsxFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...tsxFiles(p))
      else if (e.isFile() && /\.tsx$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('no page imports SiteHeader and renders a <main> without id="main"', () => {
    const repo = join(__dirname, '..')
    const missing: string[] = []
    for (const root of ['app', 'components']) {
      for (const file of tsxFiles(join(repo, root))) {
        const src = readFileSync(file, 'utf8')
        // import lines only — a comment MENTIONING SiteHeader (Chat.tsx has
        // its own #composer-input skip link) must not drag a file in
        if (!/import SiteHeader/.test(src) || !src.includes('<main')) continue
        if (file.endsWith('SiteHeader.tsx')) continue
        // every <main in the file must carry the target (alternate branches too)
        const mains = src.match(/<main[\s>]/g) || []
        const targets = src.match(/<main[^>]*id="main"/g) || src.match(/id="main"/g) || []
        if (targets.length < mains.length) missing.push(file)
      }
    }
    expect(missing, `SiteHeader pages missing id="main": ${missing.join(', ')}`).toEqual([])
  })
})
