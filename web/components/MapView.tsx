'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import MapBackground, { type MapPin } from '@/components/MapBackground'
import { locationContext, speedKmh, headingCardinal, type GeoFix } from '@/lib/geo'
import { isAuthed } from '@/lib/chat/whoami'

/**
 * 🗺️ /map surface — interactive full-bleed map with the agi-diy grammar:
 * locate-me starts the shared watchPosition (accent marker follows), taps
 * drop pins, and the HUD shows the literal `### Location` block the agent
 * receives — the context isn't invisible telemetry, it's on screen.
 *
 * "visible to tinys" (signed-in only) is the presence opt-in: while on,
 * a coarsened fix beats /api/location (~60s or ~50m of movement) and other
 * opted-in users render as labeled pins; off sends the opt-out DELETE so
 * the pin vanishes immediately.
 */

const BEAT_INTERVAL_MS = 60_000
const BEAT_MOVE_DEG = 0.0005 // ≈ 50m of latitude — a beat-worthy move
const PINS_REFRESH_MS = 60_000

type RemotePin = {
  userId: string
  login?: string | null
  name?: string | null
  lat: number
  lng: number
  speedKmh?: number | null
}

const panel: React.CSSProperties = {
  background: 'rgba(0,0,0,0.8)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(var(--tiny-accent-rgb),0.15)',
}

export default function MapView() {
  const [tracking, setTracking] = useState(false)
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [pins, setPins] = useState<MapPin[]>([])
  const [authed, setAuthed] = useState(false)
  const [visible, setVisible] = useState(false)
  const [remotePins, setRemotePins] = useState<RemotePin[]>([])
  const meRef = useRef<string | null>(null)
  const lastBeatRef = useRef<{ t: number; lat: number; lng: number } | null>(null)

  useEffect(() => {
    isAuthed().then(setAuthed)
  }, [])

  // Everyone's pins — public read, polled while the page is open. `me` lets
  // us drop the viewer's own pin (their live marker already shows them).
  useEffect(() => {
    let stop = false
    const load = () =>
      fetch('/api/location')
        .then((r) => r.json())
        .then((d) => {
          if (stop || !d?.ok) return
          meRef.current = d.me ?? null
          setRemotePins((d.pins || []).filter((p: RemotePin) => p.userId !== d.me))
        })
        .catch(() => {})
    load()
    const iv = setInterval(load, PINS_REFRESH_MS)
    return () => {
      stop = true
      clearInterval(iv)
    }
  }, [])

  // Presence heartbeat — throttled to a cadence (or a real move), never the
  // raw GPS tick rate. Coordinates are pre-coarsened by locationMetadata's
  // 4dp rule server-side too; we send the fix's derived units.
  useEffect(() => {
    if (!visible || !fix) return
    const last = lastBeatRef.current
    const moved =
      !last ||
      Math.abs(fix.lat - last.lat) > BEAT_MOVE_DEG ||
      Math.abs(fix.lng - last.lng) > BEAT_MOVE_DEG
    const due = !last || Date.now() - last.t > BEAT_INTERVAL_MS
    if (!moved && !due) return
    lastBeatRef.current = { t: Date.now(), lat: fix.lat, lng: fix.lng }
    fetch('/api/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: Number(fix.lat.toFixed(4)),
        lng: Number(fix.lng.toFixed(4)),
        speedKmh: speedKmh(fix.speed),
        heading: headingCardinal(fix.heading),
        accuracyM: fix.accuracy,
      }),
    }).catch(() => {})
  }, [visible, fix])

  const toggleVisible = () => {
    setVisible((v) => {
      if (v) {
        // Opt out — the pin should vanish now, not fade at the window edge
        lastBeatRef.current = null
        fetch('/api/location', { method: 'DELETE' }).catch(() => {})
      } else if (!tracking) {
        setTracking(true) // being seen requires a position to be seen at
      }
      return !v
    })
  }

  const dropPin = useCallback((lat: number, lng: number) => {
    setPins((prev) => [
      ...prev,
      { id: `pin-${prev.length + 1}-${lat.toFixed(4)}`, lat, lng, label: `${prev.length + 1}` },
    ])
  }, [])

  const context = locationContext(fix)
  const allPins: MapPin[] = [
    ...pins,
    ...remotePins.map((p) => ({
      id: `user-${p.userId}`,
      lat: p.lat,
      lng: p.lng,
      label: p.login || p.name || 'tiny user',
    })),
  ]

  return (
    <div className="absolute inset-0">
      {/* key remounts the map when tracking flips, so the geolocation
          permission prompt fires on the user's tap — never on page load */}
      <MapBackground
        key={tracking ? 'follow' : 'idle'}
        interactive
        follow={tracking}
        pins={allPins}
        onFix={setFix}
        onMapClick={dropPin}
      />

      {/* control rail */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <button
          onClick={() => {
            setTracking((t) => !t)
            if (tracking) setFix(null)
          }}
          className="rounded-full px-4 py-2 text-sm font-medium transition-colors"
          style={{
            ...panel,
            color: tracking ? 'var(--tiny-accent)' : 'rgba(255,255,255,0.85)',
            borderColor: tracking
              ? 'rgba(var(--tiny-accent-rgb),0.5)'
              : 'rgba(var(--tiny-accent-rgb),0.15)',
          }}
          aria-pressed={tracking}
        >
          {tracking ? '📍 tracking' : '📍 locate me'}
        </button>
        {authed && (
          <button
            onClick={toggleVisible}
            className="rounded-full px-4 py-2 text-sm font-medium transition-colors"
            style={{
              ...panel,
              color: visible ? 'var(--tiny-accent)' : 'rgba(255,255,255,0.85)',
              borderColor: visible
                ? 'rgba(var(--tiny-accent-rgb),0.5)'
                : 'rgba(var(--tiny-accent-rgb),0.15)',
            }}
            aria-pressed={visible}
            title={
              visible
                ? 'Others can see your pin — tap to vanish from the map'
                : 'Show yourself on the map to everyone using tinys'
            }
          >
            {visible ? '🌍 visible to tinys' : '🌍 be seen'}
          </button>
        )}
        {pins.length > 0 && (
          <button
            onClick={() => setPins([])}
            className="rounded-full px-4 py-2 text-sm text-gray-300 transition-colors hover:text-white"
            style={panel}
          >
            clear {pins.length} pin{pins.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* HUD — the exact context block a tiny reads */}
      {tracking && (
        <div
          className="absolute bottom-4 left-3 right-3 mx-auto max-w-md rounded-2xl px-4 py-3"
          style={panel}
          aria-live="polite"
        >
          {context ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-gray-300">
              {context}
            </pre>
          ) : (
            <p className="font-mono text-[11px] text-gray-400">waiting for position…</p>
          )}
          <p className="mt-2 text-[11px] text-gray-500">
            {visible
              ? 'this is what your tiny sees — and your pin is live for others (~11m coarse)'
              : 'this is what your tiny sees — location stays on this device'}
          </p>
        </div>
      )}

      {!tracking && pins.length === 0 && (
        <div
          className="absolute bottom-4 left-3 right-3 mx-auto max-w-md rounded-2xl px-4 py-3 text-center"
          style={panel}
        >
          <p className="text-sm text-gray-400">
            tap the map to drop a pin · locate me to move with you
            {remotePins.length > 0 &&
              ` · ${remotePins.length} tiny ${remotePins.length === 1 ? 'user' : 'users'} on the map`}
          </p>
        </div>
      )}
    </div>
  )
}
