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

type CallSession = {
  id: string;
  tiny_name?: string;
  status?: string;
  started_at?: number;
  duration_ms?: number;
  segment_count?: number;
};

const WORKER = "https://plugin.tiny.technology";

const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export default function CallsPage() {
  const [sessions, setSessions] = useState<CallSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
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
        // and zero-segment rows (no audio journaled — outage casualties; their
        // stitch 404s, the row is dead).
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
              />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
