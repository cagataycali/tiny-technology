import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The README states numbers the code defines: the BYO-key provider count,
 * the platform fee, the session lifetime, the web framework major. Each
 * has already gone stale at least once in this repo's history ("~10
 * providers", "Proprietary" beside an Apache LICENSE). These assertions
 * derive every number from the object the README cites — never a
 * hand-copied expectation — so repricing PLATFORM_FEE_MICRO or adding a
 * provider fails here until the README agrees with the code again.
 */
const repoRoot = join(process.cwd(), '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  .replace(/\s+/g, ' ') // claims wrap across lines; match on one space

describe('README numbers agree with the code they cite', () => {
  it('BYO-key provider count (PROVIDER_PRESETS minus the three non-BYOK keys)', () => {
    const src = readFileSync(join(repoRoot, 'web/lib/chat/model-config.ts'), 'utf8')
    const body = src.match(/PROVIDER_PRESETS[\s\S]*?^};/m)?.[0] ?? ''
    const keys = Array.from(body.matchAll(/^ {2}(\w+): \{/gm)).map((m) => m[1])
    // `default` is the house key, `webllm` needs no key, `custom` is the
    // escape hatch — the exclusion the store copy's own test established.
    const byok = keys.filter((k) => !['default', 'webllm', 'custom'].includes(k))
    expect(keys.length).toBeGreaterThanOrEqual(5) // the parse found the object
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen']
    const stated = words[byok.length] ?? String(byok.length)
    expect(readme).toContain(`${stated} BYO-key providers`)
  })

  it('platform fee (PLATFORM_FEE_MICRO)', () => {
    const src = readFileSync(join(repoRoot, 'worker/src/payments.ts'), 'utf8')
    const micro = Number(src.match(/PLATFORM_FEE_MICRO = (\d+)/)?.[1])
    expect(Number.isFinite(micro)).toBe(true)
    expect(readme).toContain(`$${micro / 1_000_000} per *paid* invocation`)
  })

  it('session lifetime (SESSION_TTL)', () => {
    const src = readFileSync(join(repoRoot, 'web/lib/auth.ts'), 'utf8')
    const expr = src.match(/SESSION_TTL = ([\d* ]+)/)?.[1] ?? ''
    // eslint-disable-next-line no-eval -- a literal product of numbers from our own source
    const days = eval(expr) / 86_400
    expect(Number.isFinite(days)).toBe(true)
    expect(readme).toContain(`${days} days`)
  })

  it('web framework major (package.json "next")', () => {
    const dep: string = JSON.parse(
      readFileSync(join(repoRoot, 'web/package.json'), 'utf8'),
    ).dependencies.next
    const major = dep.match(/(\d+)/)?.[1]
    expect(major).toBeTruthy()
    expect(readme).toContain(`Next.js_${major}`) // the badge
    expect(readme).toContain(`Next.js ${major}`) // the layout table
  })
})
