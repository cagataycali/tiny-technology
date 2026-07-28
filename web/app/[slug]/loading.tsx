/**
 * Instant shell for /[slug] (a tiny's page) while its server component
 * resolves the `no-store` worker /get fetch (up to a 10s round-trip). This
 * is the most-shared deep-link surface — without a loading state, opening a
 * shared tiny link stalls on a blank screen until the fetch returns. The App
 * Router streams this skeleton immediately instead. Mirrors Chat's turn-zero
 * shell (fixed header + centered hero/composer, same max-w-4xl chrome) so the
 * swap to the real page is calm, not a jump. animate-pulse is neutralized
 * under prefers-reduced-motion by the global reset in globals.css. Matches the
 * /universe/loading.tsx pattern.
 */
export default function TinyLoading() {
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header — same fixed bar + max-w-4xl chrome as Chat's real header */}
      <header
        className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b"
        style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }}
        aria-hidden="true"
      >
        <div className="max-w-4xl mx-auto px-4 py-3 sm:py-4 flex items-center justify-between gap-3">
          <div className="h-6 w-32 rounded-lg bg-white/10 animate-pulse" />
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-9 h-9 rounded-lg bg-white/5 animate-pulse" />
            <div className="w-9 h-9 rounded-lg bg-white/5 animate-pulse" />
            <div className="w-9 h-9 rounded-lg bg-white/5 animate-pulse" />
          </div>
        </div>
      </header>

      {/* Centered hero + composer skeleton — the turn-zero "Google opening".
          Centers in min-h-[calc(100dvh-10rem)], mirroring the REAL Chat hero
          (Chat.tsx heroMode) EXACTLY: dvh (not vh — on mobile 100vh is the
          URL-bar-retracted height, so a vh-centered composer can sit below the
          fold with the address bar showing) and the -10rem offsets the fixed
          header + dock chrome. A plain min-h-screen here centered ~5rem lower
          than the real page → a visible vertical jump on the skeleton→page swap
          (CLS). Matching the real centering box makes the swap calm. */}
      <main className="min-h-[calc(100dvh-10rem)] flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl flex flex-col items-center gap-5" aria-hidden="true">
          <div className="h-9 w-52 rounded-xl bg-white/10 animate-pulse" />
          <div className="h-4 w-72 max-w-full rounded bg-white/5 animate-pulse" />
          {/* Composer block */}
          <div
            className="w-full h-28 rounded-2xl border bg-white/[0.02] animate-pulse mt-2"
            style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }}
          />
        </div>
        {/* Polite status for AT — the visual skeleton is aria-hidden */}
        <p role="status" className="sr-only">Loading tiny…</p>
      </main>
    </div>
  );
}
