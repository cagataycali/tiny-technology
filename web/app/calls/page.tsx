"use client";
/**
 * /calls — call recordings, replayable like podcast episodes: the web third
 * of the surface iOS CallRecordingsView and Android CallRecordingsSheet ship.
 * Every finished voice call streams as ONE stitched WAV from the worker
 * (/voice/recording/:id — built on first listen, then R2-cached; the mic
 * track is the wall clock, each reply mixed at its journaled ms). The list
 * is session-authed (/api/voice/sessions, cookie); playback URLs are the
 * public-but-unguessable posture the replay assets already use, so native
 * <audio controls> can stream them directly — play/pause/seek for free.
 */
import { useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import { deadlineFor } from "@/lib/deadlines";
import { callOutcome } from "@/lib/voice/outcome";
import { refusalFromStatusAnswer, tooLongToStitch, type RecordingStatusAnswer } from "@/lib/voice/playback";

type CallSession = {
  id: string;
  tiny_name?: string;
  status?: string;
  started_at?: number;
  duration_ms?: number;
  segment_count?: number;
  // ⚠️ The recorded reason the call ended abnormally — decoded, because the
  // filter below ADMITS `status === "error"` rows and without this field one
  // drew exactly like a call the person hung up on themselves. The column
  // reaches here already (VOICE_LIST_SQL selects it, /api/voice/sessions
  // passes rows through verbatim); it was dropped on this line. Diagnostic
  // text — `callOutcome` translates, never render it raw.
  error?: string | null;
};

const WORKER = "https://plugin.tiny.technology";

const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export default function CallsPage() {
  const [sessions, setSessions] = useState<CallSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  // Why a recording wouldn't play, keyed by call id. `<audio>`'s own answer to
  // a 413 is to grey out its play button and say nothing, so the reason has to
  // be fetched and rendered by us — see `playFailed` below.
  const [playError, setPlayError] = useState<Record<string, string>>({});
  // Spoken copy outcome for screen readers — the visible "✓ copied" swap sits
  // under a STATIC aria-label, which announces nothing (wallet copyUrl parity).
  const [copyMsg, setCopyMsg] = useState("");

  useEffect(() => {
    // Deadlined: `sessions` starts null and this fetch is the ONLY thing that
    // ever leaves null — both branches below set it, and the catch sets the
    // error. So a hung request holds the two pulsing skeleton bones on screen
    // forever: the page looks like it's still loading rather than broken, so
    // nobody reloads.
    fetch("/api/voice/sessions", { signal: AbortSignal.timeout(deadlineFor("/api/voice/sessions")) })
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok) {
          setError(d?.error === "login required"
            ? "Sign in to see your call recordings."
            : d?.error || "Couldn't load calls.");
          setSessions([]);
          return;
        }
        // Only finished calls stitch (live ones 409); hide sub-2s pocket dials
        // and zero-segment rows.
        // ⚠️ A zero count is "nothing we can offer", NOT "no audio exists".
        // Teardown's counters live only in the Durable Object's memory, so a
        // teardown on a fresh instance used to overwrite a real count with 0
        // while the PCM segments sat in R2 intact (fixed worker-side: the row
        // update is monotonic now). This filter is still right — a 0 row has
        // no mix markers, so its stitch really does 404 — but it hides a row
        // whose audio may be recoverable, so do not read it as proof the call
        // was lost.
        setSessions((d.sessions || []).filter((s: CallSession) =>
          (s.status === "ended" || s.status === "error")
          && (s.duration_ms || 0) > 2000
          && (s.segment_count || 0) > 0));
      })
      .catch(() => {
        setError("Couldn't load calls — check your connection.");
        setSessions([]);
      });
  }, []);

  const share = async (id: string, tinyName: string) => {
    // Await + catch, never fire-and-forget: on insecure contexts / denied
    // permission / older Safari the write REJECTS (or clipboard is absent
    // entirely), and claiming "✓ copied" would send the user off to paste
    // nothing — the share silently failing at the far end. Mirrors the
    // devices/wallet copy flows.
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(`${WORKER}/voice/recording/${id}`);
      setCopied(id);
      setCopyFailed(null);
      setCopyMsg(`Share link for the call with ${tinyName} copied`);
    } catch {
      setCopyFailed(id);
      setCopied(null);
      setCopyMsg("Copy failed — select the recording URL from the player instead");
    }
    setTimeout(() => {
      setCopied((c) => (c === id ? null : c));
      setCopyFailed((c) => (c === id ? null : c));
      // Clear so re-copying the same call re-announces (identical text
      // back-to-back won't re-announce in a live region).
      setCopyMsg("");
    }, 2000);
  };

  // `<audio>` fired onError: the element knows only that it can't play this.
  // Ask the same-origin status route what the worker actually said, and put a
  // sentence on the row. Never leave it silent — a dead play button with no
  // explanation is exactly the defect this fixes, so an unreadable answer still
  // gets `playbackRefusal`'s generic line.
  // ⚠️ The translation itself is `refusalFromStatusAnswer`, not inline here: a
  // rule inside a component closure has no caller, so the only pin available was
  // a grep for this call site — and a mutant that asked the route WHY and threw
  // the answer away survived it.
  const playFailed = async (id: string) => {
    let answer: RecordingStatusAnswer = null;
    try {
      const r = await fetch(`/api/voice/recording-status/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(deadlineFor("/api/voice/recording-status")),
      });
      answer = await r.json();
    } catch {
      /* answer stays null — the generic line, never silence */
    }
    setPlayError((p) => ({ ...p, [id]: refusalFromStatusAnswer(answer).text }));
  };

  return (
    <main id="main" className="min-h-screen bg-black text-white">
      <SiteHeader />
      <div className="mx-auto max-w-2xl px-5 pb-16 pt-8">
        <h1 className="text-2xl font-bold">📼 Call recordings</h1>
        <p className="mt-1 text-sm text-white/50">
          Finished voice calls, replayable like podcast episodes.
        </p>

        {/* Copy outcomes for screen readers (visible feedback is a text swap
            under a static aria-label — silent to AT) */}
        <span role="status" aria-live="polite" className="sr-only">{copyMsg}</span>

        <div className="mt-8 space-y-6">
          {sessions === null && (
            // Skeleton shell (devices/wallet pattern): mirror the ready
            // layout — title row + share pill + the audio-player bar — so
            // recordings swap IN calm instead of popping over a bare text
            // line (the stitch-backed list can be slow). Bones aria-hidden;
            // one sr-only status carries the meaning; animate-pulse is
            // neutralized by the reduced-motion global reset.
            <>
              <span role="status" className="sr-only">Loading your call recordings…</span>
              {[0, 1].map((i) => (
                <div key={i} aria-hidden="true" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-3.5 rounded" style={{ width: `${40 - i * 10}%`, background: "rgba(255,255,255,0.1)" }} />
                      <div className="h-2.5 w-32 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
                    </div>
                    <div className="h-6 w-14 rounded-lg border border-white/10" />
                  </div>
                  <div className="mt-3 h-10 w-full rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
                </div>
              ))}
            </>
          )}
          {error && <p className="text-white/50">{error}</p>}
          {sessions !== null && !error && sessions.length === 0 && (
            <p className="text-white/40">No calls yet — 📞 a tiny and it&apos;ll land here.</p>
          )}
          {(sessions || []).map((s) => (
            <div key={s.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">📞 {s.tiny_name || "tiny"}</div>
                  <div className="mt-0.5 text-xs text-white/40">
                    {s.started_at
                      ? new Date(s.started_at * 1000).toLocaleString([], {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })
                      : ""}
                    {s.duration_ms ? ` · ${clock(s.duration_ms)}` : ""}
                  </div>
                  {/* Why the call ended, when it didn't end the way calls end.
                      Absent on a clean hangup — a badge on every row says
                      nothing. The duration above is the reason this matters:
                      a 20-second row reads as a short call, so the fact that
                      the service dropped 20 seconds in has to be ON the row.
                      ⚠️ `outcome.text`, never `s.error`: the column holds
                      `upstream closed: 1011 …`, written for the worker tail. */}
                  {(() => {
                    const outcome = callOutcome(s.status, s.error);
                    return outcome ? (
                      <div
                        className="mt-1 text-xs"
                        style={{ color: "rgba(var(--tiny-danger-rgb), 0.75)" }}
                      >
                        ⚠️ {outcome.text}
                      </div>
                    ) : null;
                  })()}
                </div>
                <button
                  onClick={() => share(s.id, s.tiny_name || "tiny")}
                  className="tap-target shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-white/60 hover:bg-white/10"
                  style={copyFailed === s.id ? { color: "var(--tiny-danger)", borderColor: "rgba(var(--tiny-danger-rgb), 0.4)" } : undefined}
                  aria-label={`Copy share link for the call with ${s.tiny_name || "tiny"}`}
                >
                  {copied === s.id ? "✓ copied" : copyFailed === s.id ? "⚠️ couldn't copy" : "share"}
                </button>
              </div>
              {/* preload=none — opening the page must not stitch every call */}
              <audio
                controls
                preload="none"
                src={`${WORKER}/voice/recording/${s.id}`}
                className="mt-3 w-full"
                aria-label={`Recording of the call with ${s.tiny_name || "tiny"}`}
                onError={() => playFailed(s.id)}
              />
              {/* ⚠️ Why the play failed — because `<audio>` cannot say. Its whole
                  answer to a 413/409/404 is a greyed-out play button: the
                  worker's reason IS in the response body and the element throws
                  it away, so a person who taps play on a call that can never
                  stitch gets a dead control and no explanation. Asked on error
                  only (never on load), same-origin so the body is readable. */}
              {playError[s.id] ? (
                <div
                  role="status"
                  className="mt-1 text-xs"
                  style={{ color: "rgba(var(--tiny-danger-rgb), 0.75)" }}
                >
                  ⚠️ {playError[s.id]}
                </div>
              ) : tooLongToStitch(s.segment_count) ? (
                // Knowable BEFORE the tap: `segment_count` is already on the row
                // and ~30 segments cannot fit the 40MB stitch cap. Saying so up
                // front beats a play button that is guaranteed to fail.
                <div className="mt-1 text-xs text-white/40">
                  ⚠️ this call is too long to replay in one piece
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
