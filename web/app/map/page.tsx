import SiteHeader from '@/components/SiteHeader'
import MapView from '@/components/MapView'

/**
 * 🗺️ /map — the tiny universe on a real map. Full-bleed dark Google Map
 * (agi-diy's exact styling) under the shared translucent site chrome;
 * locate-me feeds the same fix the chat injects as agent context.
 */

const TITLE = 'Map'
const DESCRIPTION =
  'The tiny universe on a map — see where tinys live, drop pins, and let your tiny know where you are.'

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Self-canonical like /universe: without it the root canonical makes
  // Google fold /map into `/`.
  alternates: { canonical: '/map' },
  openGraph: {
    type: 'website',
    url: '/map',
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'tiny.technology',
  },
  twitter: {
    card: 'summary',
    site: '@tinyaid',
    creator: '@tinyaid',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function MapPage() {
  return (
    <main id="main" className="flex h-[100dvh] flex-col overflow-hidden bg-black text-white">
      <h1 className="sr-only">Map</h1>
      <SiteHeader />
      <div className="relative flex-1">
        <MapView />
      </div>
    </main>
  )
}
