"use client";

// App-wide error boundary (Next.js App Router). Without this, ANY throw during
// a server-component render — e.g. the plugin.tiny.technology worker being down
// or returning non-JSON on the home/tiny page fetches — shows Next's generic
// 500 overlay. This converts that into a recoverable, on-brand screen with a
// retry (reset re-renders the segment; the button also offers a full reload).
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("App render error:", error);
  }, [error]);

  return (
    <div
      style={{
        // dvh, not vh: on mobile 100vh is the URL-bar-RETRACTED (largest)
        // height, so with the address bar showing this centering box is taller
        // than the visible area and the recovery buttons can center below the
        // fold — the one screen where reaching "Try again" matters most. dvh
        // tracks the live viewport. Matches globals.css + the overlay sheets.
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
        background: "#000",
        color: "#fff",
        fontFamily: "sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "2.5rem" }} aria-hidden="true">⚡</div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Something glitched</h1>
      {/* role=alert: failures announce to AT (house announcement grammar) */}
      <p role="alert" style={{ color: "rgba(255,255,255,0.6)", maxWidth: "28rem" }}>
        tiny.technology hit a snag loading this page. It&apos;s usually momentary —
        give it another try.
      </p>
      {/* digest is Next's server-error correlation id — for an SSR throw the
          real message is withheld from the client and only this hash is sent.
          Surface it so a user can quote it when reporting and the owner can
          grep server logs for the matching error. */}
      {error.digest && (
        <p style={{ color: "rgba(255,255,255,0.35)", fontFamily: "monospace", fontSize: "0.75rem" }}>
          Reference: {error.digest}
        </p>
      )}
      {/* Segment error boundary — the root layout (and globals.css) still
          render, so Tailwind interaction classes are available here */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
        <button
          onClick={reset}
          className="transition-all hover:scale-105 active:scale-100"
          style={{
            padding: "0.6rem 1.4rem",
            borderRadius: "0.75rem",
            fontWeight: 700,
            color: "#000",
            background: "var(--tiny-accent, #00FF88)",
            border: "none",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        {/* Deliberately a plain <a>, not <Link>: on an errored render the
            client router itself may be part of the wreckage — a full
            document navigation is the reliable escape hatch. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="transition-all hover:scale-105 active:scale-100 hover:border-white/40"
          style={{
            padding: "0.6rem 1.4rem",
            borderRadius: "0.75rem",
            color: "var(--tiny-accent, #00FF88)",
            border: "1px solid rgba(255,255,255,0.2)",
            textDecoration: "none",
          }}
        >
          Go home
        </a>
      </div>
    </div>
  );
}
