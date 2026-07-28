// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ago, relativeAgo } from '../lib/relative-time'

// Fixed clock: 2026-07-25T00:00:00Z in ms. Both fns take seconds-since-epoch.
const NOW_MS = 1_784_937_600_000
const NOW_S = NOW_MS / 1000

describe('ago (compact HUD form — "5s/3m/2h/1d", no suffix)', () => {
  it('formats each magnitude band', () => {
    expect(ago(NOW_S - 5, NOW_MS)).toBe('5s')
    expect(ago(NOW_S - 3 * 60, NOW_MS)).toBe('3m')
    expect(ago(NOW_S - 2 * 3600, NOW_MS)).toBe('2h')
    expect(ago(NOW_S - 3 * 86400, NOW_MS)).toBe('3d')
  })

  it('floors a same-second (or future) timestamp to "1s", never "0s"', () => {
    expect(ago(NOW_S, NOW_MS)).toBe('1s')
    expect(ago(NOW_S + 999, NOW_MS)).toBe('1s')
  })

  it('degrades garbage to the "1s" floor — never "NaNd" or epoch-age', () => {
    // NaN falls through every strict-< branch; Number(null)/Number('') are 0
    // (finite!) and would otherwise read as ~20656 days since the epoch.
    expect(ago(NaN, NOW_MS)).toBe('1s')
    expect(ago(undefined as unknown as number, NOW_MS)).toBe('1s')
    expect(ago(null as unknown as number, NOW_MS)).toBe('1s')
    expect(ago('' as unknown as number, NOW_MS)).toBe('1s')
    expect(ago(0, NOW_MS)).toBe('1s')
  })
})

describe('relativeAgo (prose page form — "just now" / "5m ago", per-surface fallback)', () => {
  it('formats each magnitude band with the " ago" suffix', () => {
    expect(relativeAgo(NOW_S - 30, '', NOW_MS)).toBe('just now')
    expect(relativeAgo(NOW_S - 5 * 60, '', NOW_MS)).toBe('5m ago')
    expect(relativeAgo(NOW_S - 2 * 3600, '', NOW_MS)).toBe('2h ago')
    expect(relativeAgo(NOW_S - 3 * 86400, '', NOW_MS)).toBe('3d ago')
  })

  it('clamps a future timestamp to "just now"', () => {
    expect(relativeAgo(NOW_S + 500, '', NOW_MS)).toBe('just now')
  })

  it('returns the caller\'s fallback for garbage — "" (wallet) or "never" (devices)', () => {
    expect(relativeAgo(undefined, '', NOW_MS)).toBe('')
    expect(relativeAgo(NaN, 'never', NOW_MS)).toBe('never')
    expect(relativeAgo(0, 'never', NOW_MS)).toBe('never')
    expect(relativeAgo('x' as unknown as number, 'never', NOW_MS)).toBe('never')
  })
})
