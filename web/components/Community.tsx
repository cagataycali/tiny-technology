/**
 * Community showcase — server component for the home page.
 *
 * Lists registered users (GitHub avatar + name) and their public tinys so
 * visitors can see what Tiny AI is and how it works.
 */

import { normalizeCommunity, compact, type CommunityUser } from "@/lib/community";
import { universeCounts, COMMUNITY_PAGE } from "@/lib/chat/universe-counts";
import UniverseDirectory from "./UniverseDirectory";

async function getCommunity() {
  try {
    // limit=100 is the worker's hard cap — half the truncation of the old
    // 50 while a real cursor remains worker-side roadmap. The response also
    // carries `totalUsers` (a real COUNT(*)), so the header can name the whole
    // population even though these rows are one page (v10 A4).
    const res = await fetch(`https://plugin.tiny.technology/community?limit=${COMMUNITY_PAGE}`, {
      // Fresh on every request — deletes/creates must show immediately
      cache: "no-store",
      // A hung worker must not hold this SSR render open indefinitely: without
      // a deadline the fetch never rejects on a slow/stalled backend, so the
      // `failed` retry state below (designed for exactly this) stays
      // unreachable and /universe just spins. 10s cap → AbortError → catch →
      // the calm "Try again". Same convention as the home page's /get fetch.
      signal: AbortSignal.timeout(10_000),
    });
    // Treat a non-2xx (worker 5xx/503 carrying a JSON body) as a failure, not
    // an empty universe: res.json() resolves fine on an error body, so without
    // the r.ok gate normalizeCommunity would coerce it to users:[] and pitch
    // "be the first builder" during a worker outage.
    if (!res.ok) throw new Error(`community ${res.status}`);
    return { ...normalizeCommunity(await res.json()), failed: false };
  } catch {
    // Distinguish a fetch failure from a genuinely empty universe: returning
    // the empty-list shape here would tell visitors the platform has zero
    // builders (and pitch "be the first") when really the worker is just
    // unreachable. Flag it so the render shows a calm retry instead.
    // totalUsers stays undefined, not 0: the failed branch renders the retry
    // state, and "0 builders" is the exact false claim the `failed` flag exists
    // to prevent.
    return { users: [] as CommunityUser[], totalUsers: undefined as number | undefined, totalPublicTinys: 0, totalMessages: 0, trust: {}, consults: [], failed: true };
  }
}

export default async function Community() {
  const { users, totalUsers, totalPublicTinys, totalMessages, trust, consults, failed } = await getCommunity();
  const counts = universeCounts({
    shown: users.length,
    totalUsers,
    totalPublicTinys,
    limit: COMMUNITY_PAGE,
  });

  if (failed) {
    return (
      <section className="bg-black text-white border-t" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
        <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-3">
          <h2 className="text-2xl sm:text-4xl font-bold font-rounded" style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}>
            The Tiny Universe
          </h2>
          <p role="alert" className="text-gray-400 text-sm">
            Couldn&apos;t load the universe just now — it&apos;s usually momentary.
          </p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- self-nav retry, not a client route */}
          <a
            href="/universe"
            className="inline-block px-5 py-2.5 rounded-2xl text-sm font-semibold border transition-all hover:scale-105 active:scale-100"
            style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)", color: "var(--tiny-accent)" }}
          >
            Try again →
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-black text-white border-t" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
      {/* This component now renders ONLY on /universe (its own page, no fixed
          chrome) — it left the home flow in 8f7d47c when the Universe moved
          into the header drawer. The old pb-40 was a band-aid for the home
          page's fixed composer; here it just left ~10rem of dead space at the
          bottom, so it's back to a normal py rhythm. */}
      <div className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-10">
          <h2
            // font-rounded: display titles speak the iOS wordmark voice
            // (SF Rounded on Apple platforms, system stack elsewhere)
            // text-4xl ≈ the iOS display-title scale (40pt onboarding/hero
            // titles) — the page header earns display presence on desktop
            className="text-2xl sm:text-4xl font-bold mb-2 font-rounded"
            style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}
          >
            The Tiny Universe
          </h2>
          <p className="text-gray-400 text-sm tabular-nums" {...(counts.title ? { title: counts.title } : {})}>
            {users.length > 0
              ? <>
                  {totalMessages > 0 && <><span style={{ color: "var(--tiny-accent)" }}>{compact(totalMessages)}</span> messages · </>}
                  {/* `users` is one page; `counts.builders` names the real
                      COUNT(*) when the worker sent one, so a page length never
                      sits next to the genuine totalPublicTinys total. */}
                  {counts.builders} · {counts.tinys} — built by chatting. Free, forever.
                </>
              : <>Be the first builder — sign in with GitHub and create your AI by chatting. Free, forever.</>}
          </p>
        </div>

        {users.length === 0 && (
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, not a page */}
            <a
              href="/api/auth?return_to=/"
              className="inline-block px-6 py-3 rounded-2xl font-semibold transition-all hover:scale-105 active:scale-100"
              style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb),0.3)" }}
            >
              Sign in with GitHub →
            </a>
          </div>
        )}

        {/* 🔭 Constellation + search + card grid — the client half. One
            query drives both views; users/trust serialize as plain JSON. */}
        {users.length > 0 && <UniverseDirectory users={users} trust={trust} consults={consults} totalPublicTinys={totalPublicTinys} />}
      </div>
    </section>
  );
}
