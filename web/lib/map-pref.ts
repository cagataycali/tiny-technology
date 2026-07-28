/**
 * 🗺️ Ambient-map preference — ONE key, every surface.
 *
 * The 📍 composer toggle, the SiteHeader map button, and the global
 * backdrop all read/write this. Same key the chat's context injection
 * follows ('tiny-geo-context'), so "the map is on" and "my tiny sees my
 * position" stay one concept — agi-diy's map_enabled + geolocation
 * toggles, folded into a single opt-in.
 *
 * setMapEnabled dispatches 'tiny:geo' so every mounted surface reacts in
 * the same tick; the 'storage' listener covers other tabs.
 */

const KEY = 'tiny-geo-context'
const EVENT = 'tiny:geo'

export function mapEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setMapEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: on }))
  }
}

/** Subscribe to pref flips (this tab + others). Returns unsubscribe. */
export function subscribeMapEnabled(fn: (on: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => fn(mapEnabled())
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}
