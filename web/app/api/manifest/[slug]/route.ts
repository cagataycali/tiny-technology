/**
 * Per-tiny PWA manifest — every tiny is installable as its own app.
 * Linked from app/[slug] metadata; icon = the platform icon set.
 *
 * ⚠️ Icons MUST be square with `sizes` matching real pixel dimensions.
 * Chrome re-fetches and diffs installed-PWA manifest icons in the BROWSER
 * process on every navigation to the app's scope. The old entries — tiny.png
 * declared 174x188 and the 1200x630 OG card declared as an icon — hit a
 * CHECK() in that path and crashed the entire browser (EXC_BREAKPOINT in
 * CrBrowserMain, SIGTRAP) for anyone with the PWA installed. Do NOT add
 * non-square or size-mismatched icons here.
 */
export const runtime = 'edge'

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  // 10s bound: this manifest is re-fetched by Chrome on every navigation to an
  // installed PWA's scope — a hung worker would pin each fetch to the platform
  // wall-clock. Timeout → catch → the branded fallback manifest. House rule.
  const tiny = await fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(slug)}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(() => ({}))

  // The worker returns the not-exists sentinel under `response` (get.ts), not
  // `message` — the old `.message` check was dead (masked only by the `&&
  // tiny.name` guard, since a missing tiny has no name). Check both fields so
  // this stays correct regardless of which the worker uses (see pass 138).
  const sentinel = 'tiny.technology is not exists'
  const exists = tiny.response !== sentinel && tiny.message !== sentinel && tiny.name
  const name = exists ? tiny.name : 'tiny'
  // 🎨 Installed-app chrome wears the tiny's own background (same rule as
  // the page's theme-color meta, c20): splash + titlebar melt into the
  // page instead of defaulting to pure black over e.g. luna's #0b0a1a.
  // Strict 6-hex — a malformed stored value must not reach the manifest.
  const bg = exists && /^#[0-9a-fA-F]{6}$/.test(tiny?.theme?.bg || '')
    ? tiny.theme.bg : '#000000'

  const manifest = {
    name: `${name} — tiny AI`,
    short_name: name.slice(0, 12),
    description: exists && !tiny.private
      ? String(tiny.systemPrompt || '').slice(0, 140)
      : 'Chat with this AI on tiny.technology',
    start_url: `/${name}`,
    scope: `/${name}`,
    display: 'standalone',
    background_color: bg,
    theme_color: bg,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }

  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
