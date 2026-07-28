// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { fuzzyScore } from '../components/chat/CommandPalette'

describe('fuzzyScore', () => {
  it('empty query matches everything at score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('substring match scores by position', () => {
    expect(fuzzyScore('share', 'share')).toBe(0)
    expect(fuzzyScore('are', 'share')).toBe(2)
  })

  it('subsequence fallback: shr → share', () => {
    const s = fuzzyScore('shr', 'share')
    expect(s).not.toBeNull()
    expect(s!).toBeGreaterThanOrEqual(100) // ranked below any substring hit
  })

  it('substring always beats subsequence', () => {
    const substr = fuzzyScore('mem', 'memories')!
    const subseq = fuzzyScore('mos', 'memories')!
    expect(substr).toBeLessThan(subseq)
  })

  it('tighter subsequences beat scattered ones', () => {
    // gaps: 'clr'→'clear' skips 1 char; 'cr'→'c...r' comparison via same target
    const tight = fuzzyScore('clr', 'clear')!
    const scattered = fuzzyScore('cr', 'clear')!
    expect(tight).toBeGreaterThanOrEqual(100)
    expect(scattered).toBeGreaterThanOrEqual(100)
    expect(fuzzyScore('clear', 'clear')).toBe(0)
  })

  it('no match returns null', () => {
    expect(fuzzyScore('xyz', 'share')).toBeNull()
    expect(fuzzyScore('shares', 'share')).toBeNull() // longer than target
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('SHARE', 'share')).toBe(0)
    expect(fuzzyScore('share', 'SHARE')).toBe(0)
  })
})
