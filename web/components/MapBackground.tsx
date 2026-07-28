'use client'

import { useEffect, useRef, useState } from 'react'
import { geoWatcher, type GeoFix } from '@/lib/geo'

/**
 * 🗺️ MapBackground — the agi-diy full-screen Google Map, as a component.
 *
 * Port of agi-diy/docs/map.js MapBackground: same all-black lightness-graded
 * dark styles, same pulsing user-location marker, same watchPosition feed —
 * with two upgrades: the marker pulses in the current tiny's accent
 * (var(--tiny-accent)) instead of a hard-coded blue, and pins/interactivity
 * are declarative props instead of imperative calls.
 *
 * `interactive={false}` reproduces the original's ambient background mode
 * (pointer-events none, gestures off, behind everything).
 */

// agi-diy DARK_MAP_STYLES — verbatim (map.js:9-27)
const DARK_MAP_STYLES = [
  { featureType: 'all', elementType: 'labels.text.fill', stylers: [{ saturation: 36 }, { color: '#000000' }, { lightness: 40 }] },
  { featureType: 'all', elementType: 'labels.text.stroke', stylers: [{ visibility: 'on' }, { color: '#000000' }, { lightness: 16 }] },
  { featureType: 'all', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.fill', stylers: [{ color: '#000000' }, { lightness: 20 }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#000000' }, { lightness: 17 }, { weight: 1.2 }] },
  { featureType: 'administrative.locality', elementType: 'all', stylers: [{ visibility: 'on' }] },
  { featureType: 'administrative.neighborhood', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 20 }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 21 }] },
  { featureType: 'road.highway', elementType: 'all', stylers: [{ visibility: 'simplified' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#000000' }, { lightness: 17 }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#000000' }, { lightness: 29 }, { weight: 0.2 }] },
  { featureType: 'road.highway', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 18 }] },
  { featureType: 'road.local', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 16 }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 19 }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }, { lightness: 17 }] },
]

// agi-diy ULTRA_MINIMAL_STYLES — verbatim (map.js:30-39)
const ULTRA_MINIMAL_STYLES = [
  { featureType: 'all', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0a0a0a' }] },
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#111111' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050505' }] },
]

// Public browser key (Maps JS keys are client-exposed by design; restrict by
// referrer in the Google Cloud console). Env override first so deploys can
// rotate without a code change.
const MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || 'AIzaSyDR7Q8EdLxM2u4OY5MsNJCDoMqk48yzstU'

let mapsLoader: Promise<boolean> | null = null

/** Load the Maps JS API once per page (agi-diy loadAPI, promise-cached). */
function loadMapsApi(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  const w = window as any
  if (w.google?.maps?.Map) return Promise.resolve(true)
  if (mapsLoader) return mapsLoader
  mapsLoader = new Promise((resolve) => {
    const cb = '__tinyMapsInit'
    ;(w as any)[cb] = () => {
      delete (w as any)[cb]
      resolve(true)
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_API_KEY}&libraries=marker&callback=${cb}`
    script.async = true
    script.defer = true
    script.onerror = () => {
      delete (w as any)[cb]
      mapsLoader = null
      resolve(false)
    }
    document.head.appendChild(script)
  })
  return mapsLoader
}

/**
 * Imperative bridge for the AGENT's map tools (add_map_marker /
 * fly_to_location / clear_map_markers — agi-diy index.html:2607 port).
 * The mounted MapBackground registers itself here; Chat.tsx's
 * beforeToolCallEvent dispatch calls through. Last mounted map wins
 * (chat background vs /map page — never both visible).
 */
export type TinyMapBridge = {
  addMarker: (p: { lat: number; lng: number; label?: string; color?: string; id?: string }) => void
  removeMarker: (id: string) => void
  flyTo: (lat: number, lng: number, zoom?: number) => void
  flyToMarker: (id: string, zoom?: number) => void
  tourMarkers: (ids: string[], pauseMs?: number) => void
  clearMarkers: () => void
  /** ids of the agent's pins, in insertion order — introspection for QA and
   *  future list-style tools (native bridges expose the same registry) */
  markerIds: () => string[]
}

export function tinyMapBridge(): TinyMapBridge | null {
  if (typeof window === 'undefined') return null
  return (window as any).__tinyMapBridge ?? null
}

export type MapPin = {
  id: string
  lat: number
  lng: number
  /** hex/css color for the teardrop pin body */
  color?: string
  emoji?: string
  label?: string
}

type Props = {
  /** false = ambient background (gestures off, pointer-events none) */
  interactive?: boolean
  /** track + follow the device with the pulsing accent marker */
  follow?: boolean
  styleMode?: 'dark' | 'ultra-minimal'
  pins?: MapPin[]
  onFix?: (fix: GeoFix) => void
  onMapClick?: (lat: number, lng: number) => void
  center?: { lat: number; lng: number }
  zoom?: number
  className?: string
}

/** The tiny accent as a css color, read live off the theme vars. */
function accentColor(): string {
  if (typeof window === 'undefined') return '#00ff88'
  const v = getComputedStyle(document.documentElement).getPropertyValue('--tiny-accent').trim()
  return v || '#00ff88'
}

/**
 * The ambient grade's multiply color (iOS ambientGradeTint parity): light
 * gray leaned toward the tiny's accent. Painted over the map with
 * mix-blend-mode multiply, it makes every tiny's ambient map glow ITS
 * color — the agi-diy black grade plus per-tiny identity. Base is lighter
 * than iOS's (the DARK style is already near-black; multiplying harder
 * would crush the roads).
 */
export function gradeTintCss(accentRgb: string | null | undefined, base = 0.78, lean = 0.3): string {
  const parts = (accentRgb || '').split(',').map((s) => Number(s.trim()))
  const [r, g, b] = parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)
    ? parts
    : [0, 255, 136]
  const mix = (c: number) => Math.round(base * 255 * (1 - lean) + c * lean)
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`
}

function accentGradeTint(): string {
  if (typeof window === 'undefined') return gradeTintCss(null)
  return gradeTintCss(getComputedStyle(document.documentElement).getPropertyValue('--tiny-accent-rgb'))
}

export default function MapBackground({
  interactive = false,
  follow = true,
  styleMode = 'dark',
  pins = [],
  onFix,
  onMapClick,
  center = { lat: 37.7749, lng: -122.4194 },
  zoom = 15,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const userMarkerRef = useRef<any>(null)
  const pinMarkersRef = useRef<Map<string, any>>(new Map())
  const onFixRef = useRef(onFix)
  const onClickRef = useRef(onMapClick)
  onFixRef.current = onFix
  onClickRef.current = onMapClick
  // Flips when the async API load lands — re-runs the pins diff, which
  // otherwise no-ops against a null map for pins present at mount.
  const [ready, setReady] = useState(false)
  const bridgeRef = useRef<TinyMapBridge | null>(null)

  // Map + own-location lifecycle
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    loadMapsApi().then((ok) => {
      if (!ok || cancelled || !containerRef.current) return
      const g = (window as any).google
      const map = new g.maps.Map(containerRef.current, {
        center,
        zoom,
        disableDefaultUI: true,
        zoomControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: interactive ? 'greedy' : 'none',
        styles: styleMode === 'ultra-minimal' ? ULTRA_MINIMAL_STYLES : DARK_MAP_STYLES,
        backgroundColor: '#0a0a0a',
        clickableIcons: false,
      })
      mapRef.current = map
      setReady(true)

      // Agent bridge — imperative pins live in their own registry, apart
      // from the declarative `pins` prop diff. Keyed by id so the agent can
      // remove/fly-to/tour the pins it placed (agi-diy custom-id contract);
      // re-using an id moves that pin.
      const agentMarkers = new Map<string, any>()
      let autoId = 0
      let tourToken = 0
      // An agent fly/tour owns the camera for 30s — the ambient follow
      // (panTo on every GPS tick) stomped gestures mid-flight, which read
      // as "fly_to_marker doesn't work".
      let agentGestureAt = 0
      // Spotlight: while the agent presents, the map-mode wash thins
      // (globals.css html.map-spotlight rule) then fades back after 8s.
      let spotlightTimer: ReturnType<typeof setTimeout> | undefined
      const spotlight = () => {
        if (interactive) return // the /map page has no wash to thin
        document.documentElement.classList.add('map-spotlight')
        clearTimeout(spotlightTimer)
        spotlightTimer = setTimeout(() => document.documentElement.classList.remove('map-spotlight'), 8000)
      }
      const flyTo = (lat: number, lng: number, zoom?: number) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
        agentGestureAt = Date.now()
        spotlight()
        map.panTo({ lat, lng })
        if (zoom != null && Number.isFinite(zoom)) map.setZoom(Math.min(20, Math.max(1, zoom)))
      }
      // id → marker, with a LABEL fallback (native resolvePin parity): the
      // model often skips the optional id on add (the auto "pin-N" is never
      // echoed back), then references the pin by its label.
      const resolveMarker = (ref: string) => {
        if (agentMarkers.has(ref)) return agentMarkers.get(ref)
        const needle = ref.trim().toLowerCase()
        if (!needle) return undefined
        let found: any
        // forEach, not for-of: the root tsc target can't iterate Map values
        agentMarkers.forEach((m) => {
          if (!found && (m.getTitle() || '').toLowerCase() === needle) found = m
        })
        return found
      }
      const flyToMarker = (id: string, zoom?: number) => {
        const pos = resolveMarker(id)?.getPosition()
        if (pos) flyTo(pos.lat(), pos.lng(), zoom)
      }
      const bridge: TinyMapBridge = {
        addMarker: ({ lat, lng, label, color, id }) => {
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
          const key = (id ? String(id) : `pin-${++autoId}`).slice(0, 32)
          agentMarkers.get(key)?.setMap(null)
          agentMarkers.set(
            key,
            new g.maps.Marker({
              map,
              position: { lat, lng },
              icon: {
                path: g.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
                scale: 6,
                fillColor: color || accentColor(),
                fillOpacity: 0.9,
                strokeColor: '#ffffff',
                strokeWeight: 2,
              },
              label: label
                ? { text: String(label).slice(0, 40), color: '#ffffff', fontSize: '10px', fontWeight: 'bold' }
                : undefined,
              // untitled pins still get a hover/a11y name (native parity)
              title: label || "your tiny's pin",
            }),
          )
        },
        removeMarker: (id) => {
          const m = resolveMarker(id)
          if (m) {
            m.setMap(null)
            const keys: string[] = []
            agentMarkers.forEach((v, k) => {
              if (v === m) keys.push(k)
            })
            keys.forEach((k) => agentMarkers.delete(k))
          }
        },
        flyTo,
        flyToMarker,
        tourMarkers: (ids, pauseMs) => {
          const stops = ids.filter((id) => resolveMarker(id)).slice(0, 12)
          if (!stops.length) return
          const pause = Math.min(10_000, Math.max(500, pauseMs ?? 2000))
          const token = ++tourToken
          void (async () => {
            for (const id of stops) {
              if (token !== tourToken) return // a newer tour took over
              flyToMarker(id)
              await new Promise((r) => setTimeout(r, pause))
            }
          })()
        },
        clearMarkers: () => {
          tourToken++
          agentMarkers.forEach((m) => m.setMap(null))
          agentMarkers.clear()
        },
        markerIds: () => Array.from(agentMarkers.keys()),
      }
      ;(window as any).__tinyMapBridge = bridge
      bridgeRef.current = bridge

      if (interactive) {
        map.addListener('click', (e: any) => {
          if (e.latLng && onClickRef.current) onClickRef.current(e.latLng.lat(), e.latLng.lng())
        })
      }

      if (follow) {
        const accent = accentColor()
        // agi-diy's Marker fallback path (works without a Map ID): accent dot,
        // white ring — the pulse ring needs AdvancedMarkers, the glow carries it.
        userMarkerRef.current = new g.maps.Marker({
          map,
          position: center,
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: accent,
            fillOpacity: 0.9,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
          title: 'Your location',
        })
        let firstFix = true
        unsubscribe = geoWatcher.subscribe((fix) => {
          const pos = { lat: fix.lat, lng: fix.lng }
          userMarkerRef.current?.setPosition(pos)
          // Background mode tracks continuously (agi-diy panTo-on-update);
          // interactive mode only snaps on the first fix so panning isn't
          // fought by the GPS. Agent gestures suspend the follow for 30s.
          if (firstFix || (!interactive && Date.now() - agentGestureAt > 30_000)) map.panTo(pos)
          firstFix = false
          onFixRef.current?.(fix)
        })
      }
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      mapRef.current = null
      userMarkerRef.current = null
      pinMarkersRef.current.clear()
      // Unregister only OUR bridge — a sibling map may have replaced it
      if ((window as any).__tinyMapBridge === bridgeRef.current) {
        delete (window as any).__tinyMapBridge
      }
      bridgeRef.current = null
      document.documentElement.classList.remove('map-spotlight')
    }
    // The map mounts once; interactivity/style changes remount via key upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Declarative pins → marker diff (agi-diy addMarker/removeMarker registry)
  useEffect(() => {
    const map = mapRef.current
    const g = (window as any).google
    if (!map || !g?.maps) return
    const markers = pinMarkersRef.current
    const want = new Map(pins.map((p) => [p.id, p]))

    markers.forEach((marker, id) => {
      if (!want.has(id)) {
        marker.setMap(null)
        markers.delete(id)
      }
    })
    want.forEach((pin, id) => {
      const existing = markers.get(id)
      if (existing) {
        existing.setPosition({ lat: pin.lat, lng: pin.lng })
        return
      }
      const marker = new g.maps.Marker({
        map,
        position: { lat: pin.lat, lng: pin.lng },
        icon: {
          path: g.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
          scale: 6,
          fillColor: pin.color || accentColor(),
          fillOpacity: 0.9,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        label: pin.label
          ? { text: pin.label, color: '#ffffff', fontSize: '10px', fontWeight: 'bold' }
          : undefined,
        title: pin.label || '',
      })
      markers.set(id, marker)
    })
  }, [pins, ready])

  if (interactive) {
    return <div ref={containerRef} className={className} aria-hidden="true" style={{ position: 'absolute', inset: 0 }} />
  }
  // Ambient mode: OUR wrapper owns fixed/z-index/pointer-events — Maps JS
  // MUTATES the container's inline styles on init (position:fixed became
  // position:relative on a weekly-channel update, collapsing the uninsized
  // container to 0 height = an invisible background). The inner container
  // keeps explicit width/height so it survives whatever the renderer sets.
  return (
    <div aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' }}>
      <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
      {/* Ambient grade (background only — the interactive /map keeps true
          colors): multiply layer leaning the map toward the accent. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: accentGradeTint(),
          mixBlendMode: 'multiply',
        }}
      />
      {/* The agi-diy .pulse-ring, reborn: the follow keeps you at the camera
          center, so the ring breathes there over your marker (keyframes:
          globals.css tiny-map-pulse). */}
      {follow && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 18,
            height: 18,
            margin: '-9px 0 0 -9px',
            borderRadius: '50%',
            border: '2px solid rgba(var(--tiny-accent-rgb), 0.55)',
            animation: 'tiny-map-pulse 2s ease-out infinite',
          }}
        />
      )}
    </div>
  )
}
