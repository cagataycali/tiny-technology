// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { rovingTabStop, nextRadioId } from '../lib/chat/use-radio-group'

// Pure cores behind the ARIA radiogroup keyboard engine (Onboarding model +
// BYOK provider pickers, ModelSettings on-device model picker). The hook now
// delegates to these — a regression here silently breaks Tab/arrow nav across
// every radiogroup, with no compile error to catch it.

describe('rovingTabStop — which radio owns the single tab stop', () => {
  it('empty group → null (nothing focusable, no crash)', () => {
    expect(rovingTabStop([], null)).toBeNull()
    expect(rovingTabStop([], 'x')).toBeNull()
  })

  it('the checked radio is the tab stop when it is in the group', () => {
    expect(rovingTabStop(['a', 'b', 'c'], 'b')).toBe('b')
    expect(rovingTabStop(['a', 'b', 'c'], 'c')).toBe('c')
  })

  it('falls back to the first radio when nothing is checked yet', () => {
    // The group must still be reachable by Tab before any selection — the ARIA
    // radio pattern requires exactly one tab stop at all times.
    expect(rovingTabStop(['a', 'b', 'c'], null)).toBe('a')
    expect(rovingTabStop(['a', 'b', 'c'], undefined)).toBe('a')
  })

  it('falls back to the first radio when the selection is not in the group', () => {
    // A stale selection (id removed from the list) must not orphan the tab stop.
    expect(rovingTabStop(['a', 'b', 'c'], 'zzz')).toBe('a')
    expect(rovingTabStop(['a', 'b', 'c'], '')).toBe('a')
  })
})

describe('nextRadioId — arrow-key movement with wrap-around', () => {
  it('empty group → null', () => {
    expect(nextRadioId([], null, 1)).toBeNull()
    expect(nextRadioId([], 'x', -1)).toBeNull()
  })

  it('moves forward one step', () => {
    expect(nextRadioId(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(nextRadioId(['a', 'b', 'c'], 'b', 1)).toBe('c')
  })

  it('moves backward one step', () => {
    expect(nextRadioId(['a', 'b', 'c'], 'c', -1)).toBe('b')
    expect(nextRadioId(['a', 'b', 'c'], 'b', -1)).toBe('a')
  })

  it('wraps around both ends (radios are a ring)', () => {
    expect(nextRadioId(['a', 'b', 'c'], 'c', 1)).toBe('a') // last → first
    expect(nextRadioId(['a', 'b', 'c'], 'a', -1)).toBe('c') // first → last
  })

  it('starts from index 0 when nothing (or a stale id) is selected', () => {
    // base = 0 → forward lands on ids[1], backward wraps to the last.
    expect(nextRadioId(['a', 'b', 'c'], null, 1)).toBe('b')
    expect(nextRadioId(['a', 'b', 'c'], undefined, 1)).toBe('b')
    expect(nextRadioId(['a', 'b', 'c'], 'gone', 1)).toBe('b')
    expect(nextRadioId(['a', 'b', 'c'], null, -1)).toBe('c')
  })

  it('a single-radio group returns that radio in either direction', () => {
    expect(nextRadioId(['only'], 'only', 1)).toBe('only')
    expect(nextRadioId(['only'], 'only', -1)).toBe('only')
    expect(nextRadioId(['only'], null, 1)).toBe('only')
  })
})
