// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * Per-tiny private turn memory (private-tinys feature — "store every turn in
 * vector index so it remembers more things"). The worker's /turns endpoint
 * feeds the SAME `notes` + MEMORY{name} shape that retrieve.ts already reads
 * back into the chat system prompt — that read path shipped with no writer.
 *
 * These cover the pure pieces: the stored-turn snapshot format retrieve.ts
 * surfaces as "- <text>" bullets, and the rolling-window prune arithmetic that
 * keeps the shared MEMORY index bounded for a chatty private tiny.
 *
 * Skips when the worker submodule is absent (CI has no .gitmodules).
 */
warnIfWorkerAbsent('turns-memory')

let formatTurn: (user: string, assistant: string) => string
let pruneCount: (total: number) => number
let MAX_TURNS: number
let MAX_TEXT_BYTES: number

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('turns.ts') /* @vite-ignore */)
  formatTurn = mod.formatTurn
  pruneCount = mod.pruneCount
  MAX_TURNS = mod.MAX_TURNS
  MAX_TEXT_BYTES = mod.MAX_TEXT_BYTES
})

describe.skipIf(!present)('turn snapshot (formatTurn)', () => {
  it('renders the User/Assistant shape retrieve.ts bullets into the prompt', () => {
    expect(formatTurn('what is my api key', 'I stored it as $KEY')).toBe(
      'User: what is my api key\nAssistant: I stored it as $KEY'
    )
  })

  it('trims each side so stray whitespace does not skew the embed', () => {
    expect(formatTurn('  hey  ', '\n hi \n')).toBe('User: hey\nAssistant: hi')
  })

  it('tolerates an empty half (tool-only turn or silent user)', () => {
    expect(formatTurn('', 'just tools ran')).toBe('User: \nAssistant: just tools ran')
    expect(formatTurn('ping', '')).toBe('User: ping\nAssistant: ')
  })

  it('clamps a runaway exchange to MAX_TEXT_BYTES (no index bloat)', () => {
    const huge = 'x'.repeat(MAX_TEXT_BYTES * 3)
    const out = formatTurn(huge, huge)
    expect(out.length).toBe(MAX_TEXT_BYTES)
  })
})

describe.skipIf(!present)('rolling window (pruneCount)', () => {
  it('prunes nothing below the cap', () => {
    expect(pruneCount(0)).toBe(0)
    expect(pruneCount(1)).toBe(0)
    expect(pruneCount(MAX_TURNS)).toBe(0)
  })

  it('drops exactly the overflow past the cap (oldest-first)', () => {
    expect(pruneCount(MAX_TURNS + 1)).toBe(1)
    expect(pruneCount(MAX_TURNS + 50)).toBe(50)
  })

  it('never returns negative on a corrupt/underflow count', () => {
    expect(pruneCount(-5)).toBe(0)
  })
})
