/**
 * Instant shell for /universe while its server component resolves the
 * `no-store` community fetch (up to a worker round-trip). Without this,
 * navigating here stalls on a blank screen until the fetch returns; the
 * App Router streams this skeleton immediately instead. Mirrors the real
 * Community layout (header + 2-col card grid) so the swap is calm, not a
 * jump. animate-pulse is neutralized under prefers-reduced-motion by the
 * global reset in globals.css.
 */
import SiteHeader from "@/components/SiteHeader";

export default function UniverseLoading() {
  return (
    <main id="main" className="min-h-screen bg-black text-white">
      {/* The real page's shared sticky chrome — same component, so the
          skeleton→page swap can't jump. */}
      <SiteHeader />
      <section className="border-t" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
        <div className="max-w-4xl mx-auto px-4 py-16">
          {/* Header: title + stats line */}
          <div className="flex flex-col items-center gap-3 mb-10" aria-hidden="true">
            <div className="h-7 w-56 rounded-lg bg-white/10 animate-pulse" />
            <div className="h-4 w-72 rounded bg-white/5 animate-pulse" />
          </div>

          {/* Builder cards — same 2-col grid the real listing uses */}
          <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-[14px] border p-5"
                style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-white/10 animate-pulse" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 w-24 rounded bg-white/10 animate-pulse" />
                    <div className="h-3 w-16 rounded bg-white/5 animate-pulse" />
                  </div>
                  <div className="h-6 w-14 rounded-full bg-white/5 animate-pulse" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <div key={j} className="h-6 w-20 rounded-full bg-white/5 animate-pulse" />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Polite status for AT — the visual skeleton is aria-hidden */}
          <p role="status" className="sr-only">Loading the Tiny Universe…</p>
        </div>
      </section>
    </main>
  );
}
