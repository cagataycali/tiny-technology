import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The root README is the repo's front door, and nothing else gates it:
 * docs.yml's strict build checks the mkdocs pages, not README.md. A moved
 * screenshot or renamed script rots silently there — this suite derives
 * every relative link, image and anchor from the README itself (never a
 * hand-copied list) and fails on the first target that stopped existing.
 *
 * Resolution is via the repo root (web/'s parent), the same
 * cwd-relative route the other cross-surface parity tests use.
 */
const repoRoot = join(process.cwd(), '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')

function targets(md: string): string[] {
  const found = new Set<string>()
  for (const m of Array.from(md.matchAll(/\]\(([^)\s]+)\)/g))) found.add(m[1])
  for (const m of Array.from(md.matchAll(/src="([^"]+)"/g))) found.add(m[1])
  return Array.from(found)
}

/** GitHub's heading→anchor rule: lowercase, drop punctuation/emoji, spaces
 * to hyphens — WITHOUT trimming, so "## ⚡ Run it locally" yields the
 * leading-hyphen anchor "-run-it-locally". */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

function headingSlugs(md: string): string[] {
  return Array.from(md.matchAll(/^#{1,6}\s+(.+)$/gm)).map((m) => githubSlug(m[1]))
}

const relative = targets(readme).filter((t) => !/^https?:/.test(t))

describe('root README link integrity', () => {
  it('derived a real target set, not an empty scan', () => {
    // If the extraction regex quietly stops matching, every other assertion
    // here passes against nothing — require the derivation to have found
    // roughly what the README actually contains.
    expect(relative.length).toBeGreaterThanOrEqual(30)
  })

  it('every relative link and image target exists', () => {
    const missing = relative
      .map((t) => t.split('#')[0])
      .filter((p) => p.length > 0 && !existsSync(join(repoRoot, p)))
    expect(missing).toEqual([])
  })

  it('every anchor names a heading that renders', () => {
    const broken: string[] = []
    for (const t of relative) {
      if (!t.includes('#')) continue
      const [file, frag] = t.startsWith('#')
        ? ['README.md', t.slice(1)]
        : (t.split('#') as [string, string])
      const slugs = headingSlugs(readFileSync(join(repoRoot, file), 'utf8'))
      if (!slugs.includes(frag)) broken.push(t)
    }
    expect(broken).toEqual([])
  })

  it('the slugger reproduces the emoji-heading edge case', () => {
    // The README's in-page anchor depends on GitHub keeping the hyphen a
    // leading emoji leaves behind; if this rule is wrong, the anchor test
    // above is testing the wrong universe.
    expect(githubSlug('⚡ Run it locally')).toBe('-run-it-locally')
    expect(githubSlug('🚀 Deployment guides')).toBe('-deployment-guides')
  })
})
