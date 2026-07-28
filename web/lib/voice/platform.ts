/**
 * Pure platform gate for on-device voice models (Whisper STT + Kokoro TTS).
 *
 * iOS — every browser there is WebKit — can't hold these ~80MB models: loading
 * and compiling one in a worker overruns iOS Safari's per-tab memory cap and
 * WebKit HARD-KILLS the tab ("Aw Snap") before any JS try/catch can fire, so
 * there's no graceful fallback to catch. The only safe move is to not attempt
 * them on iOS: the 🎙 live-transcription mode hides its button, and neural TTS
 * falls straight through to speechSynthesis (built into iOS Safari, zero
 * download). Native voice-call (📞) is the real iOS voice path anyway.
 *
 * Kept DOM-free (takes the two navigator fields it needs) so it's unit-testable
 * without stubbing navigator. iPadOS 13+ masquerades as "MacIntel" with touch
 * points — the same catch install-mode.ts uses.
 */
export function isIOSPlatform(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1)
  );
}

/** Live-navigator convenience wrapper. SSR-safe (false when no navigator). */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return isIOSPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
}

/**
 * Voice replay is owner-only (records are private by default). This MUST fail
 * CLOSED: a session row whose stored owner is falsy (null / empty string) is
 * NOT the caller's — an earlier `owner && owner !== viewer` guard let such a
 * row through because `&&` short-circuits, exposing the full session + R2 audio
 * manifest to any logged-in user. Access requires a non-empty owner that
 * exactly matches the viewer. Pure so the access gate is unit-testable.
 */
export function ownsVoiceSession(sessionOwnerId: unknown, viewerId: unknown): boolean {
  return (
    typeof sessionOwnerId === "string" && sessionOwnerId !== "" &&
    typeof viewerId === "string" && viewerId !== "" &&
    sessionOwnerId === viewerId
  );
}
