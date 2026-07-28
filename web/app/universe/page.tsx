import Community from '@/components/Community'
import SiteHeader from '@/components/SiteHeader'

/**
 * 🌌 /universe — the full SSR Tiny Universe listing. Crawlers (and the
 * drawer's "see all" link) get the complete builders + public-tinys list
 * that used to render on the home page (where it overlapped the fixed
 * composer). Same server component, its own page, no fixed chrome.
 */

const TITLE = 'The Tiny Universe'
const DESCRIPTION =
  'Builders and their public tinys — AIs created by chatting at tiny.technology. Free, forever.'

export const metadata = {
  // Short title — the root layout's title.template ('%s · tiny') appends the
  // brand, so this renders "The Tiny Universe · tiny". The old
  // "…— tiny.technology" string got the suffix too → brand three times over.
  title: TITLE,
  description: DESCRIPTION,
  // Self-canonical: without this, the root layout's canonical would make
  // Google treat /universe as a duplicate of `/` (it's a distinct indexable
  // page, sitemap priority 0.8). Relative → resolves against metadataBase.
  alternates: { canonical: '/universe' },
  // Next shallow-merges metadata: a child that omits `openGraph`/`twitter`
  // inherits the ROOT layout's blocks WHOLESALE — so a /universe share
  // previously unfurled as the homepage (og:url=https://tiny.technology,
  // title "tiny technology", "We're a software, together."), and og:url even
  // contradicted this page's canonical (/universe). Define both here so the
  // card matches the page. url is relative → resolves against metadataBase.
  openGraph: {
    type: 'website',
    url: '/universe',
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'tiny.technology',
    // No images here: opengraph-image.tsx in this segment renders a live
    // constellation snapshot (file-based metadata wins over config anyway;
    // listing both would leave a stale say.jpeg contender).
  },
  // summary_large_image, NOT the root's player card: a listing page has no
  // embeddable video, and inheriting would show the homepage title plus a
  // player pointing at the homepage. A large-image card is the correct shape.
  // No twitter.images either — crawlers fall back to og:image, which is the
  // generated constellation card.
  twitter: {
    card: 'summary_large_image',
    site: '@tinyaid',
    creator: '@tinyaid',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function UniversePage() {
  return (
    <main id="main" className="min-h-screen bg-black text-white">
      {/* This standalone page needs an h1 for landmark/heading order — the
          shared Community component leads with an h2 (correct when it's a
          section embedded elsewhere), so carry the page title in a
          visually-hidden h1 rather than demote the reusable component. */}
      <h1 className="sr-only">The Tiny Universe</h1>
      {/* Shared site chrome (components/SiteHeader) — one nav grammar across
          the standalone pages. */}
      <SiteHeader />
      <Community />
    </main>
  )
}
