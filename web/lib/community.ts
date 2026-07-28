/**
 * /community response normalizer — the home page render loop assumes a
 * strict shape (users[].tinys[], numeric totals). A malformed or error
 * response would otherwise crash the whole page, so we normalize rather
 * than trust. Pure + tested (tests/community.test.ts).
 */

export type CommunityUser = {
  login: string;
  name: string;
  avatar: string;
  joined: number;
  tinyCount: number;
  /** accent: the tiny's own theme color (worker attaches valid 6-hex from
      the KV record) — the constellation renders each star in true color. */
  tinys: { name: string; created: number; accent?: string }[];
};

export type CommunityData = {
  users: CommunityUser[];
  /** Real COUNT(*) of registered builders, independent of ?limit — the worker
      returns it on every /community response (verified live; Chat.tsx's hero
      stat already relies on it at ?limit=1). `users` is only a PAGE, so this is
      the number a "N builders" label may claim. Older payloads omit it →
      undefined, which lib/chat/universe-counts treats as "page is all we know"
      rather than coercing to 0. */
  totalUsers?: number;
  totalPublicTinys: number;
  totalMessages: number;
  /** slug → 0..1 trust (PageRank over public tiny-consults-tiny edges) */
  trust: Record<string, number>;
  /** Raw public tiny-consults-tiny edges (slug pairs, weight ≥ 1) — the
      constellation's consult lines. Older worker payloads omit it → []. */
  consults: { src: string; dst: string; weight: number }[];
};

export type ProfileShape = {
  login: string;
  name: string;
  avatar: string;
  joined: number;
  /** Live public follows (count only — the list is deliberately unexposed) */
  followers: number;
  /** 🏅 Reputation the network granted them (points, not money — the worker
      keeps it in its own table, deliberately out of the money ledger).
      Older worker payloads omit it → 0. */
  reputation: number;
  tinys: { name: string; created: number; accent?: string }[];
  tools: { name: string; description: string; params?: Record<string, string>; code?: string; created: number }[];
};

/**
 * /profile response normalizer — the builder-profile page maps over
 * .tinys and .tools, so a response with a login but missing/non-array
 * arrays would crash the page. Returns null when there's no usable
 * login (the 404 path). Pure + tested.
 */
export function normalizeProfile(data: any): ProfileShape | null {
  if (!data || typeof data.login !== "string") return null;
  return {
    login: data.login,
    name: typeof data.name === "string" ? data.name : "",
    avatar: typeof data.avatar === "string" ? data.avatar : "",
    joined: Number(data.joined) || 0,
    followers: Math.max(0, Number(data.followers) || 0),
    reputation: Math.max(0, Number(data.reputation) || 0),
    tinys: Array.isArray(data.tinys)
      ? data.tinys
          .filter((t: any) => t && typeof t.name === "string")
          .map((t: any) => ({
            ...t,
            // created renders as `new Date(created * …)` in Profile.tsx — a
            // non-numeric-truthy value (e.g. "2024-01") passes the truthiness
            // guard there and yields "alive since Invalid Date". Coerce to a
            // finite number (0 = unknown → the URL fallback fires) so only a
            // real timestamp reaches the date math. Matches the house idiom.
            created: Number.isFinite(Number(t.created)) ? Number(t.created) : 0,
            // Same accent guard as normalizeCommunity — renders into styles.
            accent:
              typeof t.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(t.accent)
                ? t.accent
                : undefined,
          }))
      : [],
    tools: Array.isArray(data.tools)
      ? data.tools.filter((t: any) => t && typeof t.name === "string")
      : [],
  };
}

export function normalizeCommunity(data: any): CommunityData {
  const users: CommunityUser[] = Array.isArray(data?.users)
    ? data.users
        .filter((u: any) => u && typeof u.login === "string")
        .map((u: any) => ({
          login: u.login,
          name: typeof u.name === "string" ? u.name : "",
          avatar: typeof u.avatar === "string" ? u.avatar : "",
          joined: Number(u.joined) || 0,
          tinyCount: Number(u.tinyCount) || (Array.isArray(u.tinys) ? u.tinys.length : 0),
          tinys: Array.isArray(u.tinys)
            ? u.tinys
                .filter((t: any) => t && typeof t.name === "string")
                // Re-validate the accent client-side (it renders straight
                // into SVG fills) — drop anything but a 6-digit hex.
                .map((t: any) =>
                  typeof t.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(t.accent)
                    ? t
                    : { ...t, accent: undefined })
            : [],
        }))
    : [];
  // Trust map: only well-shaped {slug: finite 0..1} entries survive — this
  // renders into the home page, so a crafted/broken value must not.
  const trust: Record<string, number> = {};
  if (data?.trust && typeof data.trust === "object" && !Array.isArray(data.trust)) {
    for (const [k, v] of Object.entries(data.trust)) {
      const n = Number(v);
      if (typeof k === "string" && k && Number.isFinite(n) && n > 0 && n <= 1) trust[k] = n;
    }
  }
  // Consult edges: only well-shaped {src, dst, weight} slug pairs survive —
  // rendered straight into the /universe SVG, so a malformed entry (missing
  // slug, self-loop, NaN weight) must not. Bounded to the worker's own cap.
  const consults: CommunityData["consults"] = Array.isArray(data?.consults)
    ? data.consults
        .filter((e: any) =>
          e && typeof e.src === "string" && e.src &&
          typeof e.dst === "string" && e.dst && e.src !== e.dst)
        .slice(0, 300)
        .map((e: any) => ({
          src: e.src,
          dst: e.dst,
          weight: Number.isFinite(Number(e.weight)) && Number(e.weight) > 0 ? Number(e.weight) : 1,
        }))
    : [];
  // `|| 0` is wrong for totalUsers specifically: 0 and "absent" mean different
  // things here. An older worker payload without the field must fall back to
  // "we only have the page", while a genuine 0 is a real (empty) census — so
  // keep undefined undefined and only coerce what parses as a finite number.
  // `Number(null)` is 0 and `Number('')` is 0, so a bare Number() would turn an
  // explicit null/blank into a census claiming an empty platform — the very
  // reading this field exists to avoid. Only a number or a numeric string counts.
  const rawUsers = data?.totalUsers;
  const totalUsers =
    (typeof rawUsers === 'number' || (typeof rawUsers === 'string' && rawUsers.trim() !== ''))
      ? Number(rawUsers)
      : NaN;
  return {
    users,
    ...(Number.isFinite(totalUsers) && totalUsers >= 0
      ? { totalUsers: Math.floor(totalUsers) }
      : {}),
    totalPublicTinys: Number(data?.totalPublicTinys) || 0,
    totalMessages: Number(data?.totalMessages) || 0,
    trust,
    consults,
  };
}

/**
 * Size a GitHub avatar at the source instead of downloading the 460px default
 * for a small box. avatars.githubusercontent.com honours ?s=<px> (square), so
 * a grid of ~50 avatars in 32–40px boxes fetches ~80px thumbnails, not 50×
 * full-res images. Only rewrite githubusercontent URLs — any other avatar host
 * (or a data: URI) is returned untouched, and a non-string/empty input yields
 * "" so the caller's `avatar ?` fallback (initial letter) still fires.
 *
 * `size` is the CSS box in px; we request 2× for retina. Callers pass their
 * rendered box size (Community 40 → s=80, the drawer 32 → s=64). Pure + tested.
 */
export function githubAvatar(url: unknown, size: number): string {
  if (typeof url !== "string" || !url) return "";
  if (!url.includes("githubusercontent.com")) return url;
  // 2× for DPR; clamp to a sane floor so a 0/negative/NaN size can't emit
  // ?s=0 (GitHub then serves the full-res default — the opposite of the intent).
  const px = Math.max(1, Math.round(Number(size) || 0) * 2);
  return `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
}

/** "#8b5cf6" → "139,92,246" — feeds rgba(...) strings for per-tiny accents
 *  (constellation stars, universe chips, OG card). Callers pass a validated
 *  6-digit hex (normalizeCommunity guarantees it on `tinys[].accent`). */
export function hexRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

/** 1880100 → "1.9M", 45300 → "45K" — headline-sized, not precise.
 *  Defensive: a non-finite or negative input (a NaN from a bad upstream
 *  Number(...), a stray negative) must never render as "NaN"/"-5" on a card
 *  or the public OG image — clamp to "0". */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  // Thresholds sit at the point where the NEXT tier down would round up past
  // its own ceiling, not at the round power of ten: e.g. 999_500 through
  // 999_999 rounds to "1000K" in the K tier (Math.round(n/1e3)=1000), so it
  // must render as "1.0M" instead; likewise 999_950_000+ would be "1000.0M".
  if (n >= 999_950_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}
