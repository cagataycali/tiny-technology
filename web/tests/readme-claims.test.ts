import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
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

  it('built-in tool count (the roster the agent is handed)', () => {
    // The README's capability table says "67 built-in tools" and then claims
    // THIS test guards it. Derive the number the way the roster is actually
    // assembled — every `name: '…'` across the tool modules plus the ones
    // defined inline in the chat route — deduped, because render_ui is
    // declared twice (web and native variants of the same tool).
    const files = [
      ...readdirSync(join(repoRoot, 'web/lib/chat/tools'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(repoRoot, 'web/lib/chat/tools', f)),
      join(repoRoot, 'web/app/api/chat/route.ts'),
    ]
    const names = new Set<string>()
    for (const f of files) {
      // Array.from, not `for…of` over the iterator: tsconfig targets es5
      // without downlevelIteration (same reason line 22 spells it this way).
      Array.from(readFileSync(f, 'utf8').matchAll(/name: '([a-z_0-9]+)'/g)).forEach((m) => names.add(m[1]))
    }
    // Guard the scan itself: a rename that broke the pattern would otherwise
    // read as "the roster shrank" and quietly agree with a stale README.
    expect(names.size).toBeGreaterThan(40)
    expect(names.has('use_device')).toBe(true)
    expect(readme).toContain(`**${names.size} built-in tools**`)
  })

  it('D1 migration count', () => {
    const n = readdirSync(join(repoRoot, 'worker/migrations')).filter((f) => f.endsWith('.sql')).length
    expect(n).toBeGreaterThan(20)
    expect(readme).toContain(`**${n} D1 migrations**`)
    // worker/README.md states the same number in its bindings table.
    const wk = readFileSync(join(repoRoot, 'worker/README.md'), 'utf8').replace(/\s+/g, ' ')
    expect(wk).toContain(`${n} migrations in`)
  })

  it('web test-file count', () => {
    const n = readdirSync(join(repoRoot, 'web/tests'))
      .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')).length
    expect(n).toBeGreaterThan(100)
    expect(readme).toContain(`**${n} test files**`)
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
