/**
 * 📍 Geolocation — shared device-position plumbing for the map surfaces
 * and agent context injection.
 *
 * Ported from agi-diy's GeolocationTracker (agi-diy/docs/context-injector.js):
 * same watchPosition contract, same `### Location` markdown block the agent
 * reads (coords, ±accuracy, altitude, speed in km/h) — extended with a
 * heading line the original tracked but never rendered. The pure formatters
 * live apart from the browser singleton so they test without a DOM.
 */

export type GeoFix = {
  lat: number
  lng: number
  /** meters, null when the platform won't say */
  accuracy: number | null
  /** meters above sea level */
  altitude: number | null
  /** meters/second — null when stationary or unknown (browser contract) */
  speed: number | null
  /** degrees clockwise from true north; null when not moving */
  heading: number | null
  /** ms epoch */
  timestamp: number
}

/** Map a browser GeolocationPosition into our plain fix shape. */
export function fixFromPosition(pos: GeolocationPosition): GeoFix {
  const c = pos.coords
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
    altitude: c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : null,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    timestamp: pos.timestamp,
  }
}

/** m/s → km/h, one decimal. Null passes through (stationary/unknown). */
export function speedKmh(speedMs: number | null): number | null {
  if (speedMs == null || !Number.isFinite(speedMs) || speedMs < 0) return null
  return Math.round(speedMs * 3.6 * 10) / 10
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** 0-360° → compass point. Out-of-range/non-finite → null. */
export function headingCardinal(deg: number | null): string | null {
  if (deg == null || !Number.isFinite(deg)) return null
  const norm = ((deg % 360) + 360) % 360
  return CARDINALS[Math.round(norm / 45) % 8]
}

/**
 * The agent-facing context block — agi-diy's exact `### Location` grammar
 * (context-injector.js getContextString) so tinys read the same shape on
 * every platform. Returns '' for no fix: callers can append unconditionally.
 */
export function locationContext(fix: GeoFix | null): string {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return ''
  const lines = ['### Location']
  lines.push(`- **Coordinates**: ${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`)
  if (fix.accuracy != null) lines.push(`- **Accuracy**: ±${Math.round(fix.accuracy)}m`)
  if (fix.altitude != null) lines.push(`- **Altitude**: ${Math.round(fix.altitude)}m`)
  const kmh = speedKmh(fix.speed)
  if (kmh != null && kmh > 0) lines.push(`- **Speed**: ${kmh.toFixed(1)} km/h`)
  const cardinal = headingCardinal(fix.heading)
  if (cardinal != null) lines.push(`- **Heading**: ${cardinal} (${Math.round(fix.heading as number)}°)`)
  return lines.join('\n')
}

/**
 * Compact shape for the x-tiny-metadata header (rides the same channel the
 * 404 page's weather context uses). 4-decimal coords ≈ 11m — enough for the
 * agent, not the user's doorstep.
 */
export function locationMetadata(fix: GeoFix | null): Record<string, unknown> | null {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null
  const meta: Record<string, unknown> = {
    lat: Number(fix.lat.toFixed(4)),
    lng: Number(fix.lng.toFixed(4)),
  }
  if (fix.accuracy != null) meta.accuracyM = Math.round(fix.accuracy)
  const kmh = speedKmh(fix.speed)
  if (kmh != null && kmh > 0) meta.speedKmh = kmh
  const cardinal = headingCardinal(fix.heading)
  if (cardinal != null) meta.heading = cardinal
  return meta
}

/**
 * Fold a live fix into the chat's metadata prop just before it rides the
 * x-tiny-metadata header. The prop is heterogeneous today — '.' on the home
 * tiny, '' on slug pages, a weather object on the 404 — so: objects gain a
 * `location` key, truthy scalars get wrapped beside it, and with no fix the
 * metadata passes through untouched (header stays byte-identical to before).
 */
export function mergeLocationMeta(metadata: unknown, fix: GeoFix | null): unknown {
  const loc = locationMetadata(fix)
  if (!loc) return metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>), location: loc }
  }
  return metadata ? { note: metadata, location: loc } : { location: loc }
}

// ───────────────────────────────────────────────────────────────────────────
// Browser singleton — one watchPosition shared by the map and the chat, so
// enabling the map background doesn't double the GPS duty cycle.
// ───────────────────────────────────────────────────────────────────────────

type GeoListener = (fix: GeoFix) => void

class GeoWatcher {
  private watchId: number | null = null
  private listeners = new Set<GeoListener>()
  last: GeoFix | null = null
  error: string | null = null

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator
  }

  /** Subscribe to fixes; starts the watch on first listener. Returns unsubscribe. */
  subscribe(fn: GeoListener): () => void {
    this.listeners.add(fn)
    if (this.last) fn(this.last)
    this.start()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private start() {
    if (!this.supported || this.watchId != null) return
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.last = fixFromPosition(pos)
        this.error = null
        this.listeners.forEach((fn) => fn(this.last as GeoFix))
      },
      (err) => {
        this.error = err.message
      },
      // agi-diy's exact watch options (map.js startLocationTracking)
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    )
  }

  private stop() {
    if (this.watchId != null && this.supported) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
    }
  }
}

export const geoWatcher = new GeoWatcher()
