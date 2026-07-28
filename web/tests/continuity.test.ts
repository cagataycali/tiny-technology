// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'

// continuity.ts guards on `typeof window` for reads and uses localStorage
// directly for writes — provide both before import.
const store = new Map<string, string>()
// The two ways a real browser refuses (v13 G2): `setItem` throws
// QuotaExceededError in Safari Private Browsing and when storage is full (the
// large `chat_messages_*` blobs get there), and `removeItem` throws
// SecurityError when site data is blocked outright. Off by default so every
// pre-existing test sees the old happy-path store.
let setThrows = false
let removeThrows = false
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (setThrows) { const e: any = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; throw e }
    store.set(k, String(v))
  },
  removeItem: (k: string) => {
    if (removeThrows) { const e: any = new Error('access denied'); e.name = 'SecurityError'; throw e }
    store.delete(k)
  },
}
;(globalThis as any).window = globalThis

import {
  appendTurn, getTurnLog, clearTurnLog,
  addMemory, getMemories, forgetMemory, forgetMemoryOutcome, clearMemories,
  buildContinuityContext,
} from '../components/chat/continuity'

beforeEach(() => { store.clear(); setThrows = false; removeThrows = false })

describe('turn log', () => {
  it('appends and caps at 200, keeping the newest', () => {
    for (let i = 0; i < 210; i++) appendTurn('t', `q${i}`, `a${i}`)
    const log = getTurnLog('t')
    expect(log).toHaveLength(200)
    expect(log[log.length - 1].q).toBe('q209')
    expect(log[0].q).toBe('q10')
  })

  it('ignores empty turns and clamps long content', () => {
    appendTurn('t', '  ', 'answer')
    appendTurn('t', 'q', '')
    expect(getTurnLog('t')).toHaveLength(0)
    appendTurn('t', 'x'.repeat(900), 'y'.repeat(1200))
    const [turn] = getTurnLog('t')
    expect(turn.q.length).toBe(500)
    expect(turn.a.length).toBe(800)
  })

  it('is scoped per tiny', () => {
    appendTurn('alpha', 'q', 'a')
    expect(getTurnLog('beta')).toHaveLength(0)
    clearTurnLog('alpha')
    expect(getTurnLog('alpha')).toHaveLength(0)
  })
})

describe('memories', () => {
  it('adds, caps at 100, forgets by substring', () => {
    for (let i = 0; i < 105; i++) addMemory('t', `fact number ${i}`)
    expect(getMemories('t')).toHaveLength(100)

    expect(forgetMemory('t', 'fact number 104')).toBe(true)
    expect(getMemories('t').some((m) => m.content === 'fact number 104')).toBe(false)
    expect(forgetMemory('t', 'no such memory')).toBe(false)
  })

  it('clearMemories wipes the store', () => {
    addMemory('t', 'something')
    clearMemories('t')
    expect(getMemories('t')).toHaveLength(0)
  })

  it('empty/undefined forget does NOT wipe the store (model-supplied input)', () => {
    addMemory('t', 'keep me')
    addMemory('t', 'me too')
    // "" substring-matches everything; undefined used to throw on .toLowerCase()
    expect(forgetMemory('t', '')).toBe(false)
    expect(forgetMemory('t', '   ')).toBe(false)
    expect(forgetMemory('t', undefined as unknown as string)).toBe(false)
    expect(getMemories('t')).toHaveLength(2)
  })

  it('corrupt non-array store coerces to [] (no crash at call sites)', () => {
    localStorage.setItem('tiny_memories_t', '{"not":"an array"}')
    expect(getMemories('t')).toEqual([])
    expect(() => addMemory('t', 'fresh start')).not.toThrow()
    expect(getMemories('t')).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🧠 v13 G2 — A CLAIM ABOUT A WRITE THAT NEVER LANDED
// ══════════════════════════════════════════════════════════════════════════════

describe('🔴 a memory claim must follow the WRITE, not the attempt', () => {
  it('addMemory reports FALSE when the store refuses', () => {
    setThrows = true
    expect(addMemory('t', 'my address is 12 Elm Street')).toBe(false)
    expect(getMemories('t')).toHaveLength(0)
    // Non-vacuity: the same call succeeds when the store works, so `false` is
    // about the storage failure and not about the input.
    setThrows = false
    expect(addMemory('t', 'my address is 12 Elm Street')).toBe(true)
    expect(getMemories('t')).toHaveLength(1)
  })

  it('addMemory reports FALSE for empty content — nothing was stored either', () => {
    expect(addMemory('t', '   ')).toBe(false)
    expect(getMemories('t')).toHaveLength(0)
  })

  it('🔴 forget does NOT report success when the write is refused', () => {
    // The measured harm. The array shrinks in memory, so the old
    // `filtered.length < mems.length` return said "forgotten" while the store
    // still held the fact.
    addMemory('t', 'my address is 12 Elm Street')
    addMemory('t', 'i like coffee')
    setThrows = true
    expect(forgetMemory('t', 'address')).toBe(false)
    expect(forgetMemoryOutcome('t', 'address')).toBe('blocked')
    expect(getMemories('t')).toHaveLength(2)
  })

  it('🔴 …and the "forgotten" fact keeps reaching the MODEL', () => {
    // Why the lie is expensive rather than merely untidy: the memory is injected
    // as a system message on every subsequent request, so the agent goes on
    // knowing something it told the user it had dropped.
    addMemory('t', 'my address is 12 Elm Street')
    setThrows = true
    forgetMemory('t', 'address')
    expect(buildContinuityContext('t')).toContain('12 Elm Street')
    // Contrast: a forget that really lands does remove it from the context.
    setThrows = false
    expect(forgetMemory('t', 'address')).toBe(true)
    expect(buildContinuityContext('t')).not.toContain('12 Elm Street')
  })

  it('a no-match is distinguished from a blocked write', () => {
    // Both were `false`. Telling someone "storage is full" over a typo'd match
    // string sends them to clear their browser data for nothing — a confidently
    // wrong diagnosis costs more than a vague one.
    addMemory('t', 'i like coffee')
    expect(forgetMemoryOutcome('t', 'no such memory')).toBe('no-match')
    expect(forgetMemoryOutcome('t', '')).toBe('no-match')
    expect(forgetMemoryOutcome('t', undefined as unknown as string)).toBe('no-match')
    expect(forgetMemoryOutcome('t', 'coffee')).toBe('forgotten')
  })

  it('the boolean and the outcome cannot disagree — one implementation', () => {
    // forgetMemory is the `forget` tool's result contract and forgetMemoryOutcome
    // is what the UI branches on; two copies of "did this match and land?" is
    // how the two answers drift apart.
    for (const blocked of [false, true]) {
      for (const match of ['coffee', 'nothing here', '']) {
        store.clear()
        setThrows = false
        addMemory('t', 'i like coffee')
        setThrows = blocked
        const bool = forgetMemory('t', match)
        // Re-seed: the first call may have consumed the match.
        setThrows = false
        store.clear()
        addMemory('t', 'i like coffee')
        setThrows = blocked
        const outcome = forgetMemoryOutcome('t', match)
        expect(bool).toBe(outcome === 'forgotten')
      }
    }
  })

  it('appendTurn stays silent — a legitimate silence is a PASS', () => {
    // Background bookkeeping after every reply, with no caller claim to falsify.
    // G2's own rule: not every swallow is a bug.
    setThrows = true
    expect(() => appendTurn('t', 'q', 'a')).not.toThrow()
    expect(getTurnLog('t')).toHaveLength(0)
  })
})

describe('🔴 the wipes must not throw out of their caller', () => {
  it('clearMemories/clearTurnLog report false instead of throwing', () => {
    addMemory('t', 'something')
    appendTurn('t', 'q', 'a')
    removeThrows = true
    // /forgetall runs both inside an async IIFE: a throw from the first skipped
    // the second AND the toast, and surfaced as an unhandled rejection.
    expect(() => clearMemories('t')).not.toThrow()
    expect(clearMemories('t')).toBe(false)
    expect(() => clearTurnLog('t')).not.toThrow()
    expect(clearTurnLog('t')).toBe(false)
    // Nothing was actually wiped — which is exactly what the caller must say.
    expect(getMemories('t')).toHaveLength(1)
    expect(getTurnLog('t')).toHaveLength(1)
  })

  it('…and report true on a real wipe', () => {
    addMemory('t', 'something')
    appendTurn('t', 'q', 'a')
    expect(clearMemories('t')).toBe(true)
    expect(clearTurnLog('t')).toBe(true)
    expect(getMemories('t')).toHaveLength(0)
    expect(getTurnLog('t')).toHaveLength(0)
  })
})

describe('buildContinuityContext', () => {
  it('empty state → empty string (no noise in the prompt)', () => {
    expect(buildContinuityContext('t')).toBe('')
  })

  it('includes memories with tags and the last 20 turns only', () => {
    addMemory('t', 'prefers dark mode', ['ui'])
    for (let i = 0; i < 25; i++) appendTurn('t', `q${i}`, `a${i}`)

    const ctx = buildContinuityContext('t')
    expect(ctx).toContain('prefers dark mode')
    expect(ctx).toContain('[ui]')
    expect(ctx).toContain('last 20 turns')
    expect(ctx).toContain('q24')     // newest included
    expect(ctx).not.toContain('q4\n') // older than the window
  })
})
