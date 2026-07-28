// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Viewer-locale dates (backlog v4 C8): CLIENT components must pass
 * `undefined` locale to toLocale* so timestamps read in the viewer's own
 * format — memory chips said "Dec 3, 2025" and job runs used a 12-hour
 * clock for everyone. SERVER-rendered components are exempt BY DESIGN:
 * there `undefined` means the deployment's ICU locale, not the viewer's
 * (Profile documents this at its call site). Money (usd()) stays en-US
 * deliberately.
 */
function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsxFiles(p))
    else if (e.isFile() && /\.tsx$/.test(e.name)) out.push(p)
  }
  return out
}

describe('client dates follow the viewer locale', () => {
  it('no "use client" component hardcodes en-US into toLocale*', () => {
    const repo = join(__dirname, '..')
    const offenders: string[] = []
    for (const root of ['components', 'app']) {
      for (const file of tsxFiles(join(repo, root))) {
        const src = readFileSync(file, 'utf8')
        if (!src.includes('"use client"')) continue // server: en-US is deliberate
        if (/toLocale\w*\(\s*["']en-US["']/.test(src)) offenders.push(file)
      }
    }
    expect(offenders, `client files hardcoding en-US dates: ${offenders.join(', ')}`).toEqual([])
  })
})
