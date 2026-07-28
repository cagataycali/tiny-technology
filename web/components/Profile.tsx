/**
 * Builder profile — server component for tiny.technology/@<login>.
 *
 * Shows a builder's public face: GitHub identity, their public tinys,
 * and their forged tools (expandable: params + source + one-click
 * install). Data comes from the worker's public /profile endpoint
 * (private tinys never leave the worker; tool code is public by design).
 */
import Link from "next/link";
import { type ProfileTool } from "./ProfileToolCard";
import ProfileTools from "./ProfileTools";
import FollowButton from "./FollowButton";
import SiteHeader from "./SiteHeader";
import { normalizeProfile, githubAvatar, hexRgb, type ProfileShape } from "@/lib/community";
import { pluralize } from "@/lib/utils";

export type ProfileData = ProfileShape & { tools: ProfileTool[] };

// Distinguish a genuine "no such builder" (404 / empty normalize) from a
// transient fetch failure (thrown, timeout, 5xx). Same lesson as Community's
// `failed` flag: collapsing both to null told the caller to render the
// "unclaimed — claim this name" pitch on a REAL builder's profile during a
// worker blip (and profiles aren't even claimable tinys, so the pitch is
// nonsense there). The caller renders a calm retry for `failed` instead.
export type ProfileResult =
  | { status: "ok"; profile: ProfileData }
  | { status: "not-found" }
  | { status: "failed" };

export async function getProfile(login: string): Promise<ProfileResult> {
  try {
    const workerUrl = process.env.TINY_WORKER_URL || "https://plugin.tiny.technology";
    const res = await fetch(
      `${workerUrl}/profile?login=${encodeURIComponent(login)}`,
      // 10s bound (house rule): a connect-but-never-respond worker would
      // otherwise pin this no-store render to the platform wall-clock.
      { cache: "no-store", signal: AbortSignal.timeout(10_000) }
    );
    // A 404 is a genuine not-found; any other non-2xx (5xx/503) is the worker
    // failing, not the builder missing — surface it as `failed` so the caller
    // shows a retry, not the "unclaimed" pitch.
    if (res.status === 404) return { status: "not-found" };
    if (!res.ok) return { status: "failed" };
    const profile = normalizeProfile(await res.json()) as ProfileData | null;
    return profile ? { status: "ok", profile } : { status: "not-found" };
  } catch {
    return { status: "failed" };
  }
}

/** Calm retry state when the profile fetch itself failed (worker outage /
 *  timeout), mirroring Community's `failed` branch — never the "unclaimed"
 *  pitch, which would libel a real builder's handle as available. */
export function ProfileUnavailable({ login }: { login: string }) {
  return (
    <main id="main" className="min-h-screen bg-black text-white flex flex-col">
      {/* Chrome even on the failure state — stranded is the worst place to
          have no way back (c11 screenshot QA: profiles had NO nav at all). */}
      <SiteHeader />
      <div className="flex-1 flex items-center justify-center px-4">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-bold" style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}>
          @{login}
        </h1>
        <p role="alert" className="text-gray-400 text-sm">
          Couldn&apos;t load this profile just now — it&apos;s usually momentary.
        </p>
        {/* Self-nav retry (full reload re-runs the server fetch). A dynamic
            `/@login` href isn't a statically-known page route, so no
            next/link lint directive is needed here. */}
        <a
          href={`/@${login}`}
          className="inline-block px-5 py-2.5 rounded-2xl text-sm font-semibold border transition-all hover:scale-105 active:scale-100"
          style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)", color: "var(--tiny-accent)" }}
        >
          Try again →
        </a>
      </div>
      </div>
    </main>
  );
}

export default function Profile({ profile }: { profile: ProfileData }) {
  const joinedDate = profile.joined
    // en-US here is DELIBERATE (unlike the client panels, c36): Profile is
    // server-rendered, where `undefined` locale means the DEPLOYMENT's ICU
    // locale — not the viewer's — and varies by host.
    ? new Date(profile.joined * (profile.joined < 1e12 ? 1000 : 1)).toLocaleDateString("en-US", { year: "numeric", month: "long" })
    : null;

  return (
    <main id="main" className="min-h-screen bg-black text-white">
      {/* Shared site chrome — /universe has it, profiles didn't (c11
          screenshot QA): no way back, no brand anchor. One grammar now. */}
      <SiteHeader />
      <div className="max-w-4xl mx-auto px-4 py-16">
        {/* Identity */}
        <div className="flex items-center gap-5 mb-12">
          {profile.avatar ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={githubAvatar(profile.avatar, 80)}
              alt={profile.login}
              width={80}
              height={80}
              decoding="async"
              className="w-20 h-20 rounded-full border-2"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)" }}
            />
          ) : (
            <div
              className="w-20 h-20 rounded-full border-2 flex items-center justify-center text-3xl font-bold"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)", color: "var(--tiny-accent)" }}
            >
              {(profile.login || "?")[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1
              // font-rounded: display titles speak the iOS wordmark voice
              className="text-3xl font-bold truncate font-rounded"
              style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}
            >
              @{profile.login}
            </h1>
            <div className="text-gray-400 truncate">{profile.name}</div>
            <div className="text-xs text-gray-400 mt-1">
              <a
                href={`https://github.com/${profile.login}`}
                target="_blank"
                rel="noreferrer"
                className="hover:opacity-80"
                style={{ color: "var(--tiny-accent)" }}
              >
                github.com/{profile.login}
              </a>
              {joinedDate && <span> · building since {joinedDate}</span>}
              {/* 🤝 Followers (graph stage 6) — count only, list unexposed */}
              {profile.followers > 0 && (
                <span> · {pluralize(profile.followers, "follower")}</span>
              )}
              {/* 🏅 Reputation — standing the network granted them (points, not
                  money). Shown next to followers because it's earned the same
                  way: by other people's gestures. */}
              {profile.reputation > 0 && (
                <span> · {pluralize(profile.reputation, "point")}</span>
              )}
            </div>
          </div>
          {/* 🕸️ Follow (graph stage 6): the user-gesture social edge —
              hidden for visitors who are logged out or viewing themselves */}
          <div className="ml-auto flex-shrink-0">
            <FollowButton login={profile.login} />
          </div>
        </div>

        {/* Tinys */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 font-rounded" style={{ color: "var(--tiny-accent)" }}>
            {profile.tinys.length} public tiny{profile.tinys.length === 1 ? "" : "s"}
          </h2>
          {profile.tinys.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {profile.tinys.map((t) => (
                /* Link, not <a>: a tiny card jumps to another in-app route —
                   a raw anchor forces a full document reload (black flash,
                   re-fetch, lost state) where next/link hands off client-side
                   and paints instantly (same rule as /devices, the footer). */
                <Link
                  key={t.name}
                  href={`/${t.name}`}
                  className="rounded-[14px] border p-4 transition-all hover:scale-[1.02] neon-card no-underline"
                  // True-color cards (c27): the card wears its tiny's own
                  // accent — hairline + name match its page/star/chip.
                  style={t.accent ? { borderColor: `rgba(${hexRgb(t.accent)},0.35)` } : undefined}
                >
                  <div className="font-semibold" style={{ color: t.accent || "var(--tiny-accent)" }}>
                    /{t.name}
                  </div>
                  {/* "alive since" beats repeating the URL the card title
                      already shows — tinys are living things, age is signal */}
                  <div className="text-xs text-gray-500 mt-1">
                    {t.created
                      ? `alive since ${new Date(t.created * (t.created < 1e12 ? 1000 : 1)).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
                      : `tiny.technology/${t.name}`}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-400">No public tinys yet.</div>
          )}
        </section>

        {/* Forged tools */}
        <section>
          <h2 className="text-xl font-semibold mb-4 font-rounded" style={{ color: "var(--tiny-accent)" }}>
            {profile.tools.length} forged tool{profile.tools.length === 1 ? "" : "s"}
          </h2>
          {/* Client island: session-aware — the owner gets a delete
              action per card (DELETE /api/tools) */}
          <ProfileTools tools={profile.tools} ownerLogin={profile.login} />
        </section>

        <div className="mt-16 text-center text-xs text-gray-500">
          {/* "The Tiny Universe" lives at /universe since the drawer
              redesign — the old label promised a page this didn't open */}
          <Link href="/universe" className="hover:opacity-80" style={{ color: "var(--tiny-accent)" }}>
            ← The Tiny Universe
          </Link>
        </div>
      </div>
    </main>
  );
}
