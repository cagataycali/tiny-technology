"use client";

/**
 * Replay scrubber (issue #7, careless ReplayMode) — plays a shared
 * conversation back message-by-message instead of dumping the wall of
 * text. Pure view-state over the already-loaded snapshot: the parent
 * slices its message list to `visible`, nothing re-fetches.
 *
 * Controls: play/pause, speed (1×/2×/4×), scrub slider, step buttons.
 */
import { useEffect, useRef, useState } from "react";

const BASE_STEP_MS = 1600; // per message at 1×

export default function ReplayBar({
  total,
  visible,
  onVisibleChange,
  onExit,
}: {
  total: number;
  visible: number;
  onVisibleChange: (n: number) => void;
  onExit: () => void;
}) {
  const [wantsPlay, setWantsPlay] = useState(true);
  const [speed, setSpeed] = useState(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Derived, not synced-in-effect: at the end we're paused regardless of intent
  const playing = wantsPlay && visible < total;

  // Advance while playing
  useEffect(() => {
    if (!playing) return;
    timerRef.current = setTimeout(
      () => onVisibleChange(visible + 1),
      BASE_STEP_MS / speed
    );
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [playing, visible, speed, onVisibleChange]);

  return (
    <div
      className="flex items-center gap-3 px-5 py-3 rounded-2xl border"
      style={{
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(10px)",
        borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
      }}
    >
      {/* -m-1.5 pads hit areas out to ~36px without widening the bar */}
      <button
        onClick={() => {
          if (!playing && visible >= total) onVisibleChange(0); // replay from start
          setWantsPlay(!playing);
        }}
        className="text-lg leading-none p-1.5 -m-1.5 rounded-lg transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
        style={{ color: "var(--tiny-accent)" }}
        aria-label={playing ? "Pause replay" : "Play replay"}
      >
        {playing ? "⏸" : "▶"}
      </button>

      <button
        onClick={() => { setWantsPlay(false); onVisibleChange(Math.max(0, visible - 1)); }}
        className="text-xs text-gray-400 hover:text-white p-1.5 -m-1.5 rounded-lg transition-colors"
        aria-label="Step back"
      >
        ‹
      </button>

      <input
        type="range"
        min={0}
        max={total}
        value={visible}
        onChange={(e) => { setWantsPlay(false); onVisibleChange(Number(e.target.value)); }}
        className="flex-1 accent-current"
        style={{ color: "var(--tiny-accent)" }}
        aria-label="Scrub replay position"
      />

      <button
        onClick={() => { setWantsPlay(false); onVisibleChange(Math.min(total, visible + 1)); }}
        className="text-xs text-gray-400 hover:text-white p-1.5 -m-1.5 rounded-lg transition-colors"
        aria-label="Step forward"
      >
        ›
      </button>

      <span className="text-xs font-mono text-gray-400 whitespace-nowrap">
        {visible}/{total}
      </span>

      <button
        onClick={() => setSpeed(speed === 4 ? 1 : speed * 2)}
        className="text-xs font-mono px-1.5 py-0.5 rounded border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
        style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
        aria-label={`Replay speed ${speed}x — click to change`}
      >
        {speed}×
      </button>

      <button
        onClick={onExit}
        className="text-xs text-gray-400 hover:text-white whitespace-nowrap p-1.5 -m-1.5 rounded-lg transition-colors"
        aria-label="Exit replay"
      >
        show all
      </button>
    </div>
  );
}
