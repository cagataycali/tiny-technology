"use client";

// Root error boundary (Next.js App Router). `app/error.tsx` only catches
// throws in segments BELOW the root layout — if `app/layout.tsx` itself (or
// ThemeProvider) throws during render, that boundary never mounts and Next
// falls back to its own unstyled white 500 page. global-error is the only
// thing that catches a root-layout failure. It REPLACES the root layout, so
// it must render its own <html>/<body> and can rely on NOTHING from it —
// globals.css isn't loaded here, so every style is inline and self-contained
// (no Tailwind classes, no CSS custom properties).
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root render error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          // dvh, not vh: on mobile 100vh is the URL-bar-RETRACTED (largest)
          // height, so with the address bar showing this centering box is
          // taller than the visible area and the recovery buttons can center
          // below the fold. dvh tracks the live viewport. (globals.css isn't
          // loaded here — this boundary replaces the root layout — so the
          // value must be inline, but dvh is a plain CSS unit, no class needed.)
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.25rem",
          background: "#000",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "2.5rem" }} aria-hidden="true">⚡</div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>Something glitched</h1>
        {/* role=alert so the failure announces to assistive tech */}
        <p role="alert" style={{ color: "rgba(255,255,255,0.6)", maxWidth: "28rem", margin: 0 }}>
          tiny.technology hit a snag loading. It&apos;s usually momentary —
          give it another try.
        </p>
        {/* digest = Next's server-error correlation id (the only detail sent to
            the client for an SSR throw). Surface it so a user can quote it and
            the owner can match it in server logs. */}
        {error.digest && (
          <p style={{ color: "rgba(255,255,255,0.35)", fontFamily: "monospace", fontSize: "0.75rem", margin: 0 }}>
            Reference: {error.digest}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
          <button
            onClick={reset}
            style={{
              padding: "0.6rem 1.4rem",
              borderRadius: "0.75rem",
              fontWeight: 700,
              color: "#000",
              background: "#00FF88",
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {/* Plain <a>: on a root-layout failure the client router is likely
              part of the wreckage — a full document navigation is the reliable
              escape hatch. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            style={{
              padding: "0.6rem 1.4rem",
              borderRadius: "0.75rem",
              color: "#00FF88",
              border: "1px solid rgba(255,255,255,0.2)",
              textDecoration: "none",
            }}
          >
            Go home
          </a>
        </div>
      </body>
    </html>
  );
}
