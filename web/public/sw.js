/* tiny.technology service worker v1
 * Patterns from careless sw.js (strategy tiers, push payload shape) and
 * agi-diy sw.js (SHOW_NOTIFICATION postMessage, API-host skip list).
 */
// v2: purges any query-string navigations the v1 handler wrongly cached
// v3: dev kill switch — on localhost the SW intercepts NOTHING. Dev chunk
//     URLs under /_next/static/ are not content-hashed, so cache-first
//     serves stale modules after any dependency change ("module factory is
//     not available"). The SW update channel (byte-diff on navigation)
//     delivers this version even when the page itself is stuck on stale
//     chunks. Cache bumped v2→v3 so activation purges the poisoned cache.
// v4: notification icon/badge → square icon-192 (tiny.png is 174x188 —
//     Android rendered it squished in every push notification)
// v5: brand mark redesign (meta-agent orbit node, scripts/gen-logo.mjs) —
//     purge the precached old-sprout icon-192 so pushes show the new mark
// (no v6: the loudness ladder below changes no cached asset. Every bump above
//  exists to PURGE something stale; this file is not itself cacheable — the
//  fetch handler skips it (not /_next/static/, not a navigation, not in the
//  media regex), so the browser's own SW update check delivers it and a bump
//  would only evict working caches for nothing.)
const CACHE = 'tiny-v5'
const DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1'
// icon-192 precached: it's the notification icon/badge — offline pushes
// need it from cache (tiny.png dropped: nothing references it anymore)
const SHELL = ['/', '/icon-192.png', '/manifest.webmanifest']
const SKIP_HOSTS = ['plugin.tiny.technology', 'api.openai.com', 'anthropic.com', 'amazonaws.com', 'googleapis.com']

self.addEventListener('install', (e) => {
  if (DEV) { self.skipWaiting(); return }
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => DEV || k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  if (DEV) return // never intercept in dev — let the network serve fresh chunks
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Never cache API/model hosts or our own API routes (SSE streams!)
  if (SKIP_HOSTS.some((h) => url.hostname.includes(h)) || url.pathname.startsWith('/api/')) return

  // Hashed immutable assets: cache-first
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
        return res
      }))
    )
    return
  }

  // Navigations: network-first with offline fallback. Only cache clean
  // shell URLs (no query string) — ?share=/?q= are per-view links, not
  // cacheable shells, and caching them by full URL both risks serving one
  // view's shell to another request offline and bloats the cache with
  // one-off entries. On failure, fall back to the page's cached shell or /.
  if (req.mode === 'navigate') {
    const cacheable = url.search === ''
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok && cacheable) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
        return res
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('/')))
    )
    return
  }

  // Static media: cache-first
  if (/\.(png|svg|ico|jpg|jpeg|webp|woff2?|mp4)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
        return res
      }))
    )
  }
})

/**
 * 🔔 How loudly a push arrives — the WEB twin of lib/push/loudness.ts
 * (AMBIENT_TAG_PREFIXES / webNotificationLoudness), mirrored here because a
 * service worker has no bundler and cannot import it.
 * tests/push-loudness.test.ts compares the two so they cannot drift.
 *
 * ⚠️ THIS FILE USED TO SET `vibrate: [100, 50, 100]` AND `renotify: true` FOR
 * EVERY TAG, which is not the absence of a loudness decision but the loud end
 * chosen for every case at once — the same defect Android had at the quiet end
 * and iOS had at this one. `renotify` is the sharp part: `tiny-visit-<slug>` is
 * stable per tiny, so each visit REPLACES the last notification, and renotify
 * makes every replacement re-alert. The worker throttles that push to one per
 * 5 min per tiny *because* it repeats; this file then made the repetition the
 * loudest thing about it.
 *
 * ⚠️⚠️ `silent: true` AND `vibrate` TOGETHER THROW A TypeError (Notifications
 * spec, "create a notification" step 2) — and showNotification is awaited inside
 * waitUntil below, so a throw shows NOTHING AT ALL. The two arms are therefore
 * exclusive: never add `silent` alongside the `vibrate` line, or "too loud"
 * becomes "never arrives".
 *
 * ⚠️ `silent` is not Baseline (Firefox ignores it). An unknown dictionary member
 * is dropped, not thrown, so where it is unsupported the notification falls back
 * to the device's own default — quieter than the forced buzz it replaces, never
 * louder. Degrading monotonically is what makes it worth setting.
 */
const AMBIENT_TAG_PREFIXES = ['tiny-visit-']

function notificationLoudness(tag) {
  const t = String(tag || '')
  return AMBIENT_TAG_PREFIXES.some((p) => t.startsWith(p))
    ? { silent: true, renotify: false }
    : { vibrate: [100, 50, 100], renotify: true }
}

// Web Push — payload: { title, body, icon?, tag?, data?: { url? }, actions? }
self.addEventListener('push', (e) => {
  let data = { title: 'tiny', body: 'New activity on your tiny' }
  try { if (e.data) data = { ...data, ...e.data.json() } }
  catch (_) { if (e.data) data.body = e.data.text() }
  // Non-empty either way — renotify with an empty tag is spec step 3's TypeError.
  const tag = data.tag || 'tiny-notification'
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      ...notificationLoudness(tag),
      data: data.data || {},
      actions: data.actions || [],
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  if (e.action === 'dismiss') return
  const rawUrl = (e.notification.data && e.notification.data.url) || '/'
  // Resolve against our origin and force same-origin — the URL comes from the
  // push payload; navigate()/openWindow must not be steered off-site.
  let url = '/'
  try { const u = new URL(rawUrl, self.location.origin); if (u.origin === self.location.origin) url = u.pathname + u.search }
  catch (_) { url = '/' }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin))
      if (existing) {
        // NAVIGATE the existing tab to the target — just focusing it (the old
        // behavior) left the user on whatever page they had open, so the
        // notification's destination (/@visitor, /slug, a job result) was
        // silently dropped. postMessage still fires for any in-app handling.
        existing.postMessage({ type: 'notification-click', data: e.notification.data })
        if (typeof existing.navigate === 'function') {
          return existing.navigate(url).then((c) => (c || existing).focus()).catch(() => existing.focus())
        }
        return existing.focus()
      }
      return self.clients.openWindow(url)
    })
  )
})

// Page → SW messages (agi-diy pattern): local notifications while backgrounded
self.addEventListener('message', (e) => {
  const msg = e.data || {}
  if (msg.type === 'SHOW_NOTIFICATION') {
    // Same ladder as the push handler — a page-posted notification carries the
    // same tags, so hardcoding loudness here would re-open the hole on the
    // other half of the file. The default tag is unique per call, so it never
    // matches an ambient prefix and this path stays loud unless a caller passes
    // a genuinely ambient tag.
    const tag = msg.tag || `tiny-${Date.now()}`
    self.registration.showNotification(msg.title || 'tiny', {
      body: msg.body,
      icon: msg.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      ...notificationLoudness(tag),
      data: { url: msg.url || '/' },
      actions: msg.actions || [],
    })
  }
  if (msg.type === 'SKIP_WAITING') self.skipWaiting()
})
