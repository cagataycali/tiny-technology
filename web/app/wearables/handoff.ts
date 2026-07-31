/**
 * The universal-link → app handoff for /wearables.
 *
 * The Meta AI app calls back into our integration at
 * https://tiny.technology/wearables?… — on a phone with tiny installed,
 * iOS/Android open the app directly and this code never runs. When the web
 * page DOES load (no app installed, or a desktop browser), we forward the
 * callback into the app's existing custom scheme so nothing is lost.
 *
 * Pure module: the URL construction is testable without a browser, and the
 * scheme must stay in lockstep with CFBundleURLSchemes in ios/Tiny/Info.plist
 * and the Android intent filter (tests/wearables-web.test.ts pins all three).
 */
export const APP_SCHEME = 'tinyapp'

/** Builds the in-app destination for a given location.search (with or without '?'). */
export function buildHandoffUrl(search: string): string {
  const qs = search.startsWith('?') ? search.slice(1) : search
  return qs ? `${APP_SCHEME}://wearables?${qs}` : `${APP_SCHEME}://wearables`
}

/** A callback (vs a human just browsing) is a visit that carries query params. */
export function isCallbackVisit(search: string): boolean {
  return (search.startsWith('?') ? search.slice(1) : search).length > 0
}
