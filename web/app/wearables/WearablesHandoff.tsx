'use client'

import { useEffect } from 'react'
import { buildHandoffUrl, isCallbackVisit } from './handoff'

/**
 * Client half of /wearables: when the page load carries callback params
 * (i.e. the Meta AI app landed here instead of in the native app), forward
 * them into the app via the custom scheme — once, automatically — and keep
 * a manual button visible either way, because the auto-attempt silently
 * does nothing on devices without the app.
 *
 * No state: the query params are read at the moment of use (effect for the
 * auto-attempt, click for the button), so server and client render the same
 * static anchor and there is nothing to hydrate differently.
 */
export default function WearablesHandoff() {
  useEffect(() => {
    const search = window.location.search
    if (isCallbackVisit(search)) {
      // A real callback: try the app immediately. Browsers ignore unknown
      // schemes without navigating away, so the page stays as the fallback.
      window.location.href = buildHandoffUrl(search)
    }
  }, [])

  return (
    <a
      href={buildHandoffUrl('')}
      onClick={(e) => {
        e.preventDefault()
        window.location.href = buildHandoffUrl(window.location.search)
      }}
      className="mt-8 inline-block rounded-xl px-6 py-3 text-base font-semibold"
      style={{ background: 'var(--tiny-accent)', color: '#04140C' }}
    >
      Open in the tiny app
    </a>
  )
}
