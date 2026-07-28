// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('sql-escape')

let escapeLike: (input: string) => string
beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('sql.ts') /* @vite-ignore */)
  escapeLike = mod.escapeLike
})

// escapeLike backs the /list prefix filter and /tools/browse search. It MUST
// be paired with `LIKE ? ESCAPE '\'`. If it regresses, a user-supplied `%`
// stops being literal and becomes match-all — silently ignoring the filter
// (a `%` prefix returns every public tiny). This locks the behavior since the
// two call sites now share it.
describe.skipIf(!present)('escapeLike', () => {
  it('escapes the LIKE wildcards % and _', () => {
    expect(escapeLike('50%')).toBe('50\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('%_%')).toBe('\\%\\_\\%')
  })

  it('escapes the escape char itself (backslash) first', () => {
    // a literal backslash must become \\ so ESCAPE '\' reads it as one literal
    expect(escapeLike('a\\b')).toBe('a\\\\b')
    // and a backslash before a wildcard doesn't create a stray escape
    expect(escapeLike('\\%')).toBe('\\\\\\%')
  })

  it('leaves normal text untouched', () => {
    expect(escapeLike('hello-world')).toBe('hello-world')
    expect(escapeLike('tiny.ai 123')).toBe('tiny.ai 123')
    expect(escapeLike('')).toBe('')
  })

  it('coerces nullish input to empty string (no throw)', () => {
    expect(escapeLike(undefined as any)).toBe('')
    expect(escapeLike(null as any)).toBe('')
  })
})
