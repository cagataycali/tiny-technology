// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isDefinitelyOffline, gateSend, describeStreamFailure, failureBannerLabel } from '../lib/chat/connectivity'

/**
 * v5 D3 — nothing in web ever read navigator.onLine, so losing wifi surfaced
 * as "Connection lost: Failed to fetch": the browser's words for a dead local
 * network, rendered as though the tiny's server had faulted.
 */

describe('isDefinitelyOffline', () => {
  it('only false is trustworthy — true and undefined are not claims of reachability', () => {
    // navigator.onLine === true just means an interface is up; a captive
    // portal or dead uplink still reads online, so the gate must not fire.
    expect(isDefinitelyOffline(false)).toBe(true)
    expect(isDefinitelyOffline(true)).toBe(false)
    expect(isDefinitelyOffline(undefined)).toBe(false) // SSR / no navigator
  })
})

describe('gateSend', () => {
  it('lets every send through unless the browser is definitely offline', () => {
    expect(gateSend(true, true)).toEqual({ send: true })
    expect(gateSend(undefined, false)).toEqual({ send: true })
  })

  it('declines an offline send and promises the composer only when true', () => {
    const typed = gateSend(false, true)
    expect(typed.send).toBe(false)
    expect((typed as any).message).toContain('still in the composer')

    // Retry buttons / follow-up chips / deep links have no composer text to
    // keep — promising it would be a lie the UI can't honour.
    const programmatic = gateSend(false, false)
    expect(programmatic.send).toBe(false)
    expect((programmatic as any).message).not.toContain('composer')
    expect((programmatic as any).message).toContain('offline')
  })

  it('never blames the server in either message', () => {
    for (const keepsDraft of [true, false]) {
      const m = (gateSend(false, keepsDraft) as any).message
      expect(m).not.toMatch(/Connection lost|failed to fetch|server/i)
    }
  })
})

describe('describeStreamFailure', () => {
  it('a drop while offline is named as OUR side of the wire', () => {
    const msg = describeStreamFailure({ online: false, message: 'Failed to fetch' })
    expect(msg).toContain('offline')
    expect(msg).not.toContain('Connection lost')
    expect(msg).not.toContain('Failed to fetch') // the browser's words, not ours
  })

  it('keeps the existing copy when the network is not known-down', () => {
    expect(describeStreamFailure({ online: true, message: 'boom' })).toBe('Connection lost: boom')
    expect(describeStreamFailure({ online: undefined })).toBe('Connection lost: stream error')
  })

  it('a truncation keeps its own complete copy (no double-prefix), online or off', () => {
    // The [DONE] detector's message already reads as a full sentence — c32.
    const cut = 'The reply was cut off — the connection closed early. Retry to continue.'
    expect(describeStreamFailure({ online: true, truncated: true, message: cut })).toBe(cut)
    expect(describeStreamFailure({ online: false, truncated: true, message: cut })).toBe(cut)
  })
})

describe('failureBannerLabel', () => {
  it('says offline while offline, regardless of partial content', () => {
    expect(failureBannerLabel({ online: false, hasContent: true })).toBe("You're offline.")
    expect(failureBannerLabel({ online: false, hasContent: false })).toBe("You're offline.")
  })

  it('back online, the banner returns to the cut-off/failed distinction', () => {
    // The banner outlives the failure: reconnecting must stop the offline claim.
    expect(failureBannerLabel({ online: true, hasContent: true })).toBe('Response was cut off.')
    expect(failureBannerLabel({ online: true, hasContent: false })).toBe('Response failed.')
  })
})
