import type { MetadataRoute } from 'next'

// Root PWA manifest — the platform app. Per-tiny installable manifests are
// served by /api/manifest/[slug] (each tiny becomes its own app icon).
//
// ⚠️ Icons MUST be square, standard sizes (192/512), and `sizes` MUST match
// the real pixel dimensions. Chrome runs a manifest-update icon diff in the
// BROWSER process on every visit to an installed PWA — non-square/mislabeled
// icons (the old 174x188 tiny.png) hit a CHECK() and crash the whole browser
// (EXC_BREAKPOINT in CrBrowserMain). icon-192/512 are tiny.png centered on a
// square transparent canvas; the maskable variant has a black bg + safe zone.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tiny AI — create your own AI by chatting',
    short_name: 'tiny',
    description: 'Create, share and chat with AI agents. Free, forever.',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
