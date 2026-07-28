'use client'

import { useEffect, useState } from 'react'
import nextDynamic from 'next/dynamic'
import { mapEnabled, subscribeMapEnabled } from '@/lib/map-pref'
import type { MapPin } from './MapBackground'

// Only fetched once someone opts in — the Maps JS API never loads for
// everyone else (same discipline as the old chat-local backdrop).
const MapBackdrop = nextDynamic(() => import('./MapBackground'), { ssr: false })

const PINS_REFRESH_MS = 60_000

/**
 * 🗺️ The ambient map, app-wide (phase 2: "the map can be enabled in any
 * page"). Mounted once in the root layout; while the shared pref is on,
 * the agi-diy dark map rides fixed at z-index:-1 under EVERY page —
 * universe, profiles, wallet, chat — and html.map-mode drops page-level
 * blacks so it reads through. The chat's 📍 toggle and SiteHeader's map
 * button both flip the same pref; this component is the only thing that
 * mounts the map or owns the class.
 *
 * Presence rides the background too: opted-in tiny users (the 🌍 be-seen
 * heartbeat, /api/location) appear as pins UNDER the chat — people see
 * people using tinys, the agi-diy social-map idea. The ambient grade's
 * multiply layer mutes them into ambiance; the interactive /map stays the
 * place to really look at them.
 */
export default function GlobalMapBackdrop() {
  const [on, setOn] = useState(false)
  const [presence, setPresence] = useState<MapPin[]>([])

  useEffect(() => {
    setOn(mapEnabled())
    return subscribeMapEnabled(setOn)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('map-mode', on)
    return () => document.documentElement.classList.remove('map-mode')
  }, [on])

  // Everyone's pins — public read, polled only while the map is on. `me`
  // drops the viewer's own pin (the live accent dot already shows them).
  useEffect(() => {
    if (!on) {
      setPresence([])
      return
    }
    let stop = false
    const load = () =>
      fetch('/api/location')
        .then((r) => r.json())
        .then((d) => {
          if (stop || !d?.ok) return
          setPresence(
            (d.pins || [])
              .filter((p: any) => p.userId !== d.me && Number.isFinite(p.lat) && Number.isFinite(p.lng))
              .map((p: any) => ({
                id: `presence-${p.userId}`,
                lat: p.lat,
                lng: p.lng,
                label: p.login || p.name || 'tiny user',
              })),
          )
        })
        .catch(() => {})
    load()
    const iv = setInterval(load, PINS_REFRESH_MS)
    return () => {
      stop = true
      clearInterval(iv)
    }
  }, [on])

  return on ? <MapBackdrop follow interactive={false} pins={presence} /> : null
}
