// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { detectInstallMode, shouldShowBanner, type InstallEnv } from '../lib/chat/install-mode'

// Real-world UA strings (trimmed) for the platforms the banner branches on.
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
}

const env = (o: Partial<InstallEnv>): InstallEnv => ({
  userAgent: '', platform: '', maxTouchPoints: 0, standalone: false, ...o,
})

describe('detectInstallMode', () => {
  it('iPhone Safari → ios-safari (Add to Home Screen steps)', () => {
    expect(detectInstallMode(env({ userAgent: UA.iphoneSafari, platform: 'iPhone' }))).toBe('ios-safari')
  })

  it('iPhone Chrome (CriOS) → null — no Share-sheet A2HS to instruct', () => {
    expect(detectInstallMode(env({ userAgent: UA.iphoneChrome, platform: 'iPhone' }))).toBeNull()
  })

  it('iPhone Firefox (FxiOS) → null', () => {
    expect(detectInstallMode(env({ userAgent: UA.iphoneFirefox, platform: 'iPhone' }))).toBeNull()
  })

  it('iPadOS 13+ (masquerades as MacIntel + touch) Safari → ios-safari', () => {
    expect(detectInstallMode(env({ userAgent: UA.ipadOS, platform: 'MacIntel', maxTouchPoints: 5 }))).toBe('ios-safari')
  })

  it('real Mac Safari (MacIntel, no touch) → desktop-qr, NOT ios-safari', () => {
    expect(detectInstallMode(env({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }))).toBe('desktop-qr')
  })

  it('desktop Chrome → desktop-qr', () => {
    expect(detectInstallMode(env({ userAgent: UA.desktopChrome, platform: 'Win32' }))).toBe('desktop-qr')
  })

  it('Android Chrome → null — a "scan to open on your iPhone" QR is nonsensical on a phone; native InstallPrompt covers it', () => {
    expect(detectInstallMode(env({ userAgent: UA.androidChrome, platform: 'Linux armv8l' }))).toBeNull()
  })

  it('Android Firefox → null (no native prompt, but the iPhone-QR copy would be wrong)', () => {
    const androidFirefox = 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0'
    expect(detectInstallMode(env({ userAgent: androidFirefox, platform: 'Linux armv8l' }))).toBeNull()
  })

  it('already installed (standalone) → null on every platform', () => {
    expect(detectInstallMode(env({ userAgent: UA.iphoneSafari, platform: 'iPhone', standalone: true }))).toBeNull()
    expect(detectInstallMode(env({ userAgent: UA.desktopChrome, platform: 'Win32', standalone: true }))).toBeNull()
  })
})

describe('shouldShowBanner (collision avoidance vs the native InstallPrompt)', () => {
  it('desktop-qr + a native prompt available → false (InstallPrompt owns the slot; no double banner)', () => {
    expect(shouldShowBanner('desktop-qr', { nativeInstallAvailable: true })).toBe(false)
  })

  it('desktop-qr + NO native prompt (e.g. desktop Safari/Firefox) → true', () => {
    expect(shouldShowBanner('desktop-qr', { nativeInstallAvailable: false })).toBe(true)
  })

  it('ios-safari shows when the iOS-beta banner is not competing', () => {
    // Safari never fires beforeinstallprompt, so nativeInstallAvailable is
    // moot here; what matters is the iOS-beta banner (already dismissed →
    // slot is free).
    expect(shouldShowBanner('ios-safari', { nativeInstallAvailable: false })).toBe(true)
    expect(shouldShowBanner('ios-safari', { nativeInstallAvailable: false, iosBetaActive: false })).toBe(true)
  })

  it('ios-safari yields the slot while the iOS-beta banner is still eligible (z-90 collision)', () => {
    // InstallPrompt's "Join beta" banner owns the same bottom-center slot at a
    // higher z-index; the A2HS steps stand down until the user dismisses it.
    expect(shouldShowBanner('ios-safari', { nativeInstallAvailable: false, iosBetaActive: true })).toBe(false)
  })

  it('desktop-qr ignores iosBetaActive (different platform, no iOS-beta banner)', () => {
    expect(shouldShowBanner('desktop-qr', { nativeInstallAvailable: false, iosBetaActive: true })).toBe(true)
  })

  it('null mode → false regardless of native availability', () => {
    expect(shouldShowBanner(null, { nativeInstallAvailable: false })).toBe(false)
    expect(shouldShowBanner(null, { nativeInstallAvailable: true })).toBe(false)
  })
})
