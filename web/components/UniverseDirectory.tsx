"use client";

/**
 * 🔭 Universe directory — the client half of /universe: one search field
 * driving BOTH views of the same data (iOS-parity: the native Universe
 * panel is a `.searchable` List). Typing dims non-matching stars in the
 * constellation in place (layout stays put) and filters the card grid
 * below it. Community.tsx (server) keeps the fetch + failed/empty states
 * and hands users/trust down as plain JSON props.
 */

import { useState } from "react";
import Link from "next/link";
import { IconBolt } from "./chat/icons";
import { githubAvatar, hexRgb, type CommunityUser } from "@/lib/community";
import { hiddenTinyCount } from "@/lib/chat/universe-counts";
import UniverseConstellation from "./UniverseConstellation";

/** Chips per card. The worker itself only embeds 8 tinys per builder, so this
 *  is the display cap, not the reason tinys go missing (v10 A4). */
const CHIPS = 8;

export default function UniverseDirectory({
  users,
  trust,
  consults = [],
  totalPublicTinys,
}: {
  users: CommunityUser[];
  trust: Record<string, number>;
  consults?: { src: string; dst: string; weight: number }[];
  /** The worker's real public-tiny total — the constellation footer compares it
      against the stars it drew (≤8 per builder). */
  totalPublicTinys?: number;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? users.filter((u) =>
        u.login.toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q) ||
        u.tinys.some((t) => t.name.toLowerCase().includes(q)))
    : users;

  return (
    <>
      <UniverseConstellation users={users} trust={trust} query={query} consults={consults} totalPublicTinys={totalPublicTinys} />

      <div className="mb-6 max-w-md mx-auto">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Escape clears (iOS .searchable behavior; type=search's native
          // clear-on-Escape isn't guaranteed cross-browser). stopPropagation
          // so a non-empty clear doesn't also fire page-level Escape handlers.
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search builders & tinys"
          aria-label="Search builders and tinys"
          className="w-full rounded-[10px] border bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-500"
          style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
        />
      </div>

      {/* Live result count for AT — the visual filter (dimmed stars, fewer
          cards) is silent to screen readers; iOS .searchable announces
          results. Only speaks while a query is active, so page load and
          clearing stay quiet. */}
      <p aria-live="polite" className="sr-only">
        {q ? `${shown.length} builder${shown.length === 1 ? "" : "s"} matching` : ""}
      </p>
      {q && shown.length === 0 && (
        <p role="status" className="text-sm text-gray-400 text-center py-8">
          No builders or tinys match &ldquo;{query.trim()}&rdquo;
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {shown.map((u) => (
          <div
            key={u.login}
            // 14px radius = the iOS tinyCard signature (Theme.swift) — the
            // web card language tracks it so both clients read as one app.
            className="rounded-[14px] border p-5 neon-card"
            style={{ backdropFilter: "blur(10px)" }}
          >
            <div className="flex items-center gap-3 mb-3">
              {u.avatar ? (

                <img
                  // GitHub serves 460px by default; s=80 (40px box × 2 DPR)
                  // covers this — ~50 avatars, big transfer cut. Shared helper
                  // so the Universe drawer sizes identically (lib/community).
                  src={githubAvatar(u.avatar, 40)}
                  alt={u.login}
                  width={40}
                  height={40}
                  loading="lazy"
                  decoding="async"
                  className="w-10 h-10 rounded-full border flex-shrink-0"
                  style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)" }}
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-full border flex items-center justify-center font-bold flex-shrink-0"
                  style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)", color: "var(--tiny-accent)" }}
                >
                  {(u.login || "?")[0].toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                {/* Link, not <a>: builder-profile nav is internal — a raw
                    anchor full-reloads (black flash, lost state) where
                    next/link transitions client-side. */}
                <Link
                  href={`/@${u.login}`}
                  className="block text-sm font-semibold truncate hover:opacity-80"
                  style={{ color: "var(--tiny-accent)" }}
                >
                  @{u.login}
                </Link>
                <div className="text-xs text-gray-400 truncate">{u.name}</div>
              </div>
              <div
                className="ml-auto text-xs px-2 py-1 rounded-full whitespace-nowrap tabular-nums"
                style={{ background: "rgba(var(--tiny-accent-rgb),0.1)", color: "var(--tiny-accent)" }}
              >
                {u.tinyCount} tiny{u.tinyCount === 1 ? "" : "s"}
              </div>
            </div>

            {u.tinys.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {u.tinys.slice(0, CHIPS).map((t) => (
                  <Link
                    key={t.name}
                    href={`/${t.name}`}
                    className="px-3 py-1 rounded-full text-xs border transition-all hover:scale-105 active:scale-100 neon-chip"
                    // True-color chips (c26): the chip IS the tiny, so it
                    // wears the tiny's own accent like its constellation
                    // star; unthemed tinys keep the page accent (.neon-chip).
                    style={t.accent ? {
                      background: `rgba(${hexRgb(t.accent)},0.12)`,
                      borderColor: `rgba(${hexRgb(t.accent)},0.35)`,
                      color: t.accent,
                    } : undefined}
                    {...(trust[t.name] ? { title: `Consulted by other tinys — trust ${Math.round(trust[t.name] * 100)}/100` } : {})}
                  >
                    {/* 🕸️ Trust badge (graph stage 6): ⚡ marks tinys other
                        tinys actually consult — PageRank over public
                        consulted edges, not a vanity metric. The glyph is
                        decorative; sr-only text carries the meaning that
                        was otherwise hover-tooltip-only. */}
                    {trust[t.name] ? (
                      <>
                        <IconBolt className="w-3 h-3 inline-block align-[-1px] mr-0.5" style={{ color: t.accent || "var(--tiny-accent)" }} />
                        <span className="sr-only">trusted — consulted by other tinys: </span>
                      </>
                    ) : null}/{t.name}
                  </Link>
                ))}
                {/* Overflow comes from tinyCount, NOT tinys.length: the worker
                    embeds at most 8 tinys per builder, so `tinys.length > 8`
                    could never be true and a builder with 20 showed 8 chips
                    with no link to the rest (v10 A4). Links to the profile —
                    where the full list lives — instead of dead-ending as inert
                    text. */}
                {hiddenTinyCount(u.tinyCount, Math.min(u.tinys.length, CHIPS)) > 0 && (
                  <Link
                    href={`/@${u.login}`}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors no-underline"
                  >
                    +{hiddenTinyCount(u.tinyCount, Math.min(u.tinys.length, CHIPS))} more →
                  </Link>
                )}
              </div>
            ) : (
              <div className="text-xs text-gray-400">No public tinys yet</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
