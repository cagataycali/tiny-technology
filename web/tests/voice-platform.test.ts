// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isIOSPlatform, ownsVoiceSession } from '../lib/voice/platform'

// On-device voice models (Whisper STT, Kokoro TTS) OOM-kill the iOS Safari tab,
// so they must be gated off on every iOS browser (all WebKit). This pins the
// pure detection both liveVoiceSupported() and the TTS neural latch depend on.
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
}

describe('isIOSPlatform', () => {
  it('iPhone Safari → iOS (models gated off)', () => {
    expect(isIOSPlatform(UA.iphoneSafari, 'iPhone', 5)).toBe(true)
  })

  it('iPhone Chrome (CriOS, still WebKit) → iOS', () => {
    expect(isIOSPlatform(UA.iphoneChrome, 'iPhone', 5)).toBe(true)
  })

  it('iPadOS 13+ (masquerades as MacIntel + touch) → iOS', () => {
    expect(isIOSPlatform(UA.ipadOS, 'MacIntel', 5)).toBe(true)
  })

  it('desktop Mac Safari (MacIntel, no touch) → NOT iOS — the model runs fine', () => {
    expect(isIOSPlatform(UA.macSafari, 'MacIntel', 0)).toBe(false)
  })

  it('desktop Chrome → NOT iOS', () => {
    expect(isIOSPlatform(UA.desktopChrome, 'Win32', 0)).toBe(false)
  })

  it('Android Chrome → NOT iOS (native app + WebGPU handle it)', () => {
    expect(isIOSPlatform(UA.androidChrome, 'Linux armv8l', 5)).toBe(false)
  })
})

// Voice replay is owner-only; the gate MUST fail closed. Regression: the route
// guarded with `owner && owner !== viewer`, so a row whose stored owner was
// null/empty short-circuited past the check and leaked the session + R2 audio
// manifest to any logged-in user.
describe('ownsVoiceSession (voice-replay owner gate — fail closed)', () => {
  it('grants access when a non-empty owner exactly matches the viewer', () => {
    expect(ownsVoiceSession('user-alice', 'user-alice')).toBe(true)
  })

  it('denies a different owner', () => {
    expect(ownsVoiceSession('user-alice', 'user-mallory')).toBe(false)
  })

  it('DENIES a null/empty owner (the fail-open bug) even though the check used to skip', () => {
    expect(ownsVoiceSession(null, 'user-mallory')).toBe(false)
    expect(ownsVoiceSession('', 'user-mallory')).toBe(false)
    expect(ownsVoiceSession(undefined, 'user-mallory')).toBe(false)
  })

  it('denies when the viewer id is missing/empty (no anonymous match)', () => {
    expect(ownsVoiceSession('user-alice', '')).toBe(false)
    expect(ownsVoiceSession('user-alice', null)).toBe(false)
  })

  it('does not treat two empty ids as a match', () => {
    expect(ownsVoiceSession('', '')).toBe(false)
  })

  it('ignores non-string owner types (never a match)', () => {
    expect(ownsVoiceSession(123 as any, '123')).toBe(false)
    expect(ownsVoiceSession({ toString: () => 'x' } as any, 'x')).toBe(false)
  })
})
