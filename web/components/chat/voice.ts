"use client";

/**
 * speechSynthesis TTS (COMPARISON.md §2.14) — the zero-download voice.
 * lib/voice/tts.ts uses it as the instant fallback while (or instead of)
 * the on-device Kokoro model loads. Speech-to-text moved to lib/voice/
 * (whisper in a worker, VAD auto-send) — the old Web Speech dictation that
 * lived here went with it.
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;
// Chrome-desktop bug (ancient, still open): long utterances auto-PAUSE
// after ~15s of speech and never resume — the reply goes silent
// mid-sentence with `speaking` still true. A periodic resume() while an
// utterance lives keeps it talking; resume() is a no-op when nothing is
// paused, so the heartbeat is harmless on well-behaved engines.
let resumeTimer: ReturnType<typeof setInterval> | null = null;

function clearHeartbeat(): void {
  if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
}

/** Speak text aloud; speaking again stops the previous utterance.
 *  Returns false when unsupported. onDone fires when playback ends/stops. */
export function speak(text: string, onDone?: () => void): boolean {
  if (!speechSupported()) return false;
  stopSpeaking();
  // Strip markdown noise for the ear: code blocks, links, emphasis marks
  const clean = text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
  if (!clean) { onDone?.(); return true; }
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = navigator.language || "en-US";
  u.onend = () => { clearHeartbeat(); currentUtterance = null; onDone?.(); };
  u.onerror = () => { clearHeartbeat(); currentUtterance = null; onDone?.(); };
  currentUtterance = u;
  window.speechSynthesis.speak(u);
  clearHeartbeat();
  resumeTimer = setInterval(() => {
    if (!currentUtterance) { clearHeartbeat(); return; }
    window.speechSynthesis.resume();
  }, 8000);
  return true;
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  clearHeartbeat();
  currentUtterance = null;
  window.speechSynthesis.cancel();
}
