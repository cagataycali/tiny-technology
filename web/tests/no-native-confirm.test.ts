// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every destructive flow uses the house useConfirm() dialog — the on-brand,
 * portaled, focus-returning replacement its own docblock promises. Chat.tsx
 * was the LAST holdout (7 native confirm() calls, migrated c9); this guard
 * keeps the next quick fix from reaching for window.confirm()/alert()/
 * prompt() and quietly breaking the overlay grammar again.
 */
const ROOTS = ['app', 'components']
// window.confirm( / bare confirm("string" — but NOT `await confirm({`
// (the useConfirm API takes an options OBJECT, natives take a string).
const BANNED = [
  /window\.confirm\s*\(/,
  /window\.alert\s*\(/,
  /window\.prompt\s*\(/,
  /[^.\w]confirm\(\s*["'`]/,
  /[^.\w]alert\(\s*["'`]/,
]

// Comments may legitimately DISCUSS the natives ("instead of a native
// window.confirm()…") — strip them before matching so prose can't trip the
// guard (c3 lesson). Line-comment strip requires whitespace/line-start before
// // so protocol slashes (https://) survive.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsxFiles(p))
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('no native confirm/alert/prompt', () => {
  const repo = join(__dirname, '..')
  for (const root of ROOTS) {
    it(`${root}/ uses the house dialog only`, () => {
      for (const file of tsxFiles(join(repo, root))) {
        const src = stripComments(readFileSync(file, 'utf8'))
        for (const banned of BANNED) {
          expect(src, `${file} calls a native dialog ${banned}`).not.toMatch(banned)
        }
      }
    })
  }
})
