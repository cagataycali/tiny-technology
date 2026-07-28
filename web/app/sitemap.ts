import type { MetadataRoute } from 'next'

export const revalidate = 3600 // rebuild at most hourly

/**
 * Dynamic sitemap from tiny-v2 (via the public /community endpoint) —
 * only live, public tinys are listed. Replaces the stale static
 * public/sitemap.xml + sitemap-generator.js (dead api host).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = 'https://tiny.technology'
  const entries: MetadataRoute.Sitemap = [
    // Trailing slash: the homepage canonical is `alternates.canonical:'/'`,
    // which resolves against metadataBase to `https://tiny.technology/`. Match
    // it exactly here so the sitemap URL and the self-canonical are identical
    // (a bare `base` differs by the slash — a needless duplicate-signal nit).
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    // 🌌 Full universe listing (SSR) — the home page now surfaces the
    // community via the header drawer; crawlers index the list here.
    { url: `${base}/universe`, changeFrequency: 'daily', priority: 0.8 },
  ]

  try {
    const res = await fetch('https://plugin.tiny.technology/community?limit=100', {
      next: { revalidate: 3600 },
      // A hung worker must not stall sitemap generation indefinitely — this is
      // a crawler-facing route rebuilt on revalidate. Cap the wait so a stalled
      // backend degrades to the homepage-only sitemap below (via the catch)
      // instead of holding the render open. Same convention as the home page +
      // Community fetches.
      signal: AbortSignal.timeout(10_000),
    })
    // Non-2xx (worker 5xx carrying a JSON body) → skip the tiny list rather
    // than iterate an error payload; res.json() resolves fine on an error body.
    if (!res.ok) throw new Error(`community ${res.status}`)
    const data = await res.json()
    for (const user of data.users || []) {
      // Builder profile page (/@login) — linked from the home showcase
      if (user.login) {
        entries.push({
          url: `${base}/@${user.login}`,
          changeFrequency: 'weekly',
          priority: 0.4,
        })
      }
      for (const t of user.tinys || []) {
        // `created` is untrusted (this endpoint isn't run through
        // normalizeCommunity). A truthy-but-non-numeric value → new Date(NaN)
        // = Invalid Date, which does NOT throw here but DOES throw later when
        // Next serializes lastModified via .toISOString() — outside this
        // try/catch, 500-ing the ENTIRE sitemap (every URL lost), strictly
        // worse than the intended homepage-only degradation. Only attach a
        // lastModified we've proven serializes.
        const created = Number(t.created)
        const lastModified = Number.isFinite(created) && created > 0 ? new Date(created * 1000) : null
        entries.push({
          url: `${base}/${t.name}`,
          changeFrequency: 'daily',
          priority: 0.6,
          ...(lastModified && !Number.isNaN(lastModified.getTime()) ? { lastModified } : {}),
        })
      }
    }
  } catch {
    // endpoint unreachable → homepage-only sitemap
  }

  return entries
}
