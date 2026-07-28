'use client'

import { useEffect, useState } from 'react'
import { mapEnabled, setMapEnabled, subscribeMapEnabled } from '@/lib/map-pref'

/**
 * 🗺️ SiteHeader's ambient-map switch (phase 2: the map is enable-able on
 * any page, not just chat). Flips the same shared pref as the chat's 📍
 * toggle — GlobalMapBackdrop reacts, and the chat's context injection
 * follows, because "map on" and "my tiny sees my position" are one opt-in.
 * Same pin glyph + accent-when-on grammar as the composer button.
 */
export default function MapToggle() {
  const [on, setOn] = useState(false)

  useEffect(() => {
    setOn(mapEnabled())
    return subscribeMapEnabled(setOn)
  }, [])

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Turn the map background off' : 'Turn the map background on'}
      title={on ? 'Map on — your tiny sees your position' : 'Map background — lets your tiny see your position'}
      onClick={() => setMapEnabled(!on)}
      className="p-1.5 rounded-lg transition-colors"
      style={
        on
          ? { color: 'var(--tiny-accent)', background: 'rgba(var(--tiny-accent-rgb),0.15)' }
          : { color: 'rgb(156,163,175)' }
      }
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
      </svg>
    </button>
  )
}
