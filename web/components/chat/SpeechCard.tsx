"use client";

/**
 * SpeechCard — playback card for the agent's `speak` tool (the native
 * play-button-plus-transcript UI that used to come from ElevenLabs
 * components, now backed by on-device Kokoro TTS via lib/voice/tts.ts).
 *
 * Playing state comes from the tts module's external store, so autoplay
 * (Chat triggers it on the live tool event) and the card's own button stay
 * in sync, and only one utterance ever plays at a time.
 */

import { useSyncExternalStore } from "react";
import { subscribeSpeech, getSpeechState, playSpeech, stopSpeech, type SpeechState } from "@/lib/voice/tts";

// getServerSnapshot must return the SAME reference every call, or React
// flags it as uncached and re-renders forever during hydration
const SERVER_SNAPSHOT: SpeechState = { id: null, status: null };

export default function SpeechCard({ id, text, voice }: { id: string; text: string; voice?: string }) {
  const state = useSyncExternalStore(subscribeSpeech, getSpeechState, () => SERVER_SNAPSHOT);
  const mine = state.id === id;
  const loading = mine && state.status === "loading";
  const playing = mine && state.status === "playing";

  return (
    <div
      className="px-4 py-3 rounded-xl border flex items-start gap-3"
      style={{ background: "rgba(var(--tiny-accent-rgb),0.06)", borderColor: "rgba(var(--tiny-accent-rgb),0.25)" }}
    >
      <button
        type="button"
        aria-label={mine ? "Stop playback" : "Play speech"}
        aria-pressed={mine}
        title={mine ? "Stop" : "Play"}
        onClick={() => (mine ? stopSpeech() : void playSpeech(id, text, { voice, mode: "neural" }))}
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-transform hover:scale-105 ${loading ? "animate-pulse" : ""}`}
        style={{ background: "var(--tiny-accent)", color: "#000" }}
      >
        {mine ? (
          // Stop (also shown while the voice model loads — cancel is valid)
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 ml-0.5">
            <path d="M8 5.14v13.72c0 .86.93 1.4 1.68.96l11.04-6.86a1.12 1.12 0 000-1.92L9.68 4.18A1.12 1.12 0 008 5.14z" />
          </svg>
        )}
      </button>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 select-none">
          🔊 {loading ? "preparing voice…" : playing ? "speaking" : "spoken reply"}
          {voice ? <span className="ml-1.5 normal-case tracking-normal">· {voice}</span> : null}
        </div>
        <div className="mt-1 text-sm text-gray-300 whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}
