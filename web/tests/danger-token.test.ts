// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One destructive red for the whole app: --tiny-danger (globals.css), created
 * because delete/revoke/error reds had drifted across #ff5050, #ff6b6b,
 * #ff4444, #ff8888, rgb(255,80,80) and rgb(255,107,107). c7 migrated the last
 * eleven hardcoded sites; this guard keeps the next inline red from starting
 * the drift over. Inline styles must use var(--tiny-danger) /
 * rgba(var(--tiny-danger-rgb), α); the token VALUE (#f87171) lives only in
 * globals.css.
 */
const ROOTS = ['app', 'components', 'lib']
const BANNED = [
  /#ff4444/i, /#ff5050/i, /#ff6b6b/i, /#ff8888/i, /#f87171/i,
  // c21: the wallet's debit red + the thrice-inlined warning orange (now
  // --tiny-warn; its VALUE, like danger's, lives only in globals.css)
  /#ff7070/i, /#ff9d6b/i,
  /255,\s*80,\s*80/, /255,\s*107,\s*107/,
]

// Manual walk — the repo's @types/node predates readdirSync's `recursive`.
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('--tiny-danger token fidelity', () => {
  const repo = join(__dirname, '..')
  for (const root of ROOTS) {
    it(`${root}/ has no hardcoded danger reds`, () => {
      for (const file of tsFiles(join(repo, root))) {
        const src = readFileSync(file, 'utf8')
        for (const banned of BANNED) {
          expect(src, `${file} contains banned danger red ${banned}`).not.toMatch(banned)
        }
      }
    })
  }
})
