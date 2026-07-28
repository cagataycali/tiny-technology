// @vitest-environment jsdom
/**
 * The enroll input takes an IDENTIFIER, not prose — iOS autocapitalize/
 * autocorrect would turn "cagatay-macbook" into "Cagatay-MacBook", and the
 * enrolled name then mismatches ~/.tiny/device.json and shell muscle memory.
 * Same attribute set as the wallet address / claim-tx / onboarding key inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DevicesPage from '../app/devices/page'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ devices: [] }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('device-name input', () => {
  it('carries the identifier-input attributes (no mobile mangling)', async () => {
    render(<DevicesPage />)
    const input = await screen.findByLabelText('New device name')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('maxlength')).toBe('64')
  })
})
