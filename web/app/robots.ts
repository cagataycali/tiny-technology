import type { MetadataRoute } from 'next'

/**
 * Robots policy — allow crawling of public content, point at the dynamic
 * sitemap, and keep crawlers out of API + auth routes (no SEO value, and
 * some are session/internal-key gated).
 */
export default function robots(): MetadataRoute.Robots {
  const base = 'https://tiny.technology'
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // /devices is a session-gated utility surface (client shell that
        // bounces to OAuth) — no index value, same class as /api /og /vcard
        disallow: ['/api/', '/og/', '/vcard/', '/devices'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  }
}
