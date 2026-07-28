import Link from "next/link";
import TinyLogo from "@/components/TinyLogo";
import MapToggle from "@/components/MapToggle";

/**
 * Sticky site chrome for the standalone pages (/universe, /@profile) —
 * the chat header's grammar (black/80 + blur + accent hairline) so moving
 * between the chat and these pages feels like one app. Extracted from
 * /universe (c5) when profiles turned out to have no chrome at all
 * (c11 screenshot QA): every standalone page keeps the way back sticky-
 * reachable, like a native nav bar.
 */
export default function SiteHeader() {
  return (
    <>
    {/* ⏭️ Skip link (Chat's pattern, c37) — every SiteHeader page renders
        keyboard-heavy content below the chrome (the /universe constellation
        is fully keyboard-operable); pages provide the id="main" target. */}
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-4 focus:py-2 focus:rounded-lg"
      style={{ background: "var(--tiny-accent)", color: "#000" }}
    >
      Skip to content
    </a>
    <header
      className="sticky top-0 z-40 border-b"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(12px)", borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
    >
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
        {/* Link, not <a>: internal page nav — a raw anchor forces a full
            document reload (black flash, lost state) where next/link hands
            off client-side and paints instantly. */}
        <Link href="/" className="text-sm text-gray-400 hover:text-white transition-colors">
          ← back to tiny
        </Link>
        {/* 🗺️ ambient-map switch — the map is enable-able from ANY page
            (phase 2); shares the chat 📍 toggle's pref via lib/map-pref */}
        <span className="ml-auto"><MapToggle /></span>
        <span className="flex items-center gap-1.5 font-rounded font-bold text-sm select-none" aria-hidden="true" style={{ color: "var(--tiny-accent)" }}>
          {/* the mark inherits --tiny-accent live, so it re-colors with the
              theme just like the wordmark next to it */}
          <TinyLogo size={20} />
          tiny
        </span>
      </div>
    </header>
    </>
  );
}
