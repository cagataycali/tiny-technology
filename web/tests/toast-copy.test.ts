// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One error grammar: "Couldn't X — <recovery>" (majority house style),
 * never bare "Failed" / "Failed to X" — a failure toast without a recovery
 * instruction is a dead end, and two grammars for one failure class reads
 * as two apps. Server-passthrough `d.error || "…"` fallbacks are OURS and
 * must follow it too. console.warn/log lines are logs, not user copy —
 * only toast/setError call sites are policed.
 */
const ROOTS = ['app', 'components']
const BANNED = [
  /toast(\.error)?\(\s*"Failed/,
  /toast(\.error)?\([^)]*\|\|\s*"Failed/,
  /setError\(\s*"Failed/,
]

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsxFiles(p))
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('toast copy grammar', () => {
  const repo = join(__dirname, '..')
  for (const root of ROOTS) {
    it(`${root}/ has no user-facing "Failed" copy`, () => {
      for (const file of tsxFiles(join(repo, root))) {
        const src = readFileSync(file, 'utf8')
        for (const banned of BANNED) {
          expect(src, `${file} shows a bare "Failed" to the user`).not.toMatch(banned)
        }
      }
    })
  }
})
