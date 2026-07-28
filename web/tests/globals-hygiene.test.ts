// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * globals.css hygiene (backlog v3 item 13): dead commented-out code invites
 * cargo-cult edits — a commented @font-face pointed at font files that don't
 * even exist in public/, and `/* prop: value; *​/` fossils sat inside live
 * rules for months. Prose comments (the file is rich with good ones) are
 * untouched: the ban targets DECLARATION-shaped comments only.
 */
describe('globals.css hygiene', () => {
  const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8')

  it('has no commented-out @font-face', () => {
    expect(css).not.toMatch(/\/\*\s*@font-face/)
  })

  it('has no commented-out declarations (/* prop: value; */)', () => {
    // A single CSS declaration frozen in a comment — prose never matches
    // (it has words before any colon, not a lone `prop:` token).
    const fossils = css.match(/\/\*\s*[a-z-]+\s*:\s*[^*{}]{1,60};\s*\*\//g) || []
    expect(fossils, `commented-out declarations: ${fossils.join(' ')}`).toEqual([])
  })

  it('references no font files absent from public/', () => {
    expect(css).not.toContain('BerkeleyMono')
  })
})
