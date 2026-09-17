/**
 * 🌈 The tiny logo — one source for every surface that wants it.
 *
 * Onboarding's landing page draws it centered with a typewriter tagline;
 * the main TUI plays it as a boot splash while the agent initializes, then
 * unmounts so Ink leaves the last frame sitting in scrollback above the
 * header. Same glyphs, same rainbow, one file — the block letters live
 * HERE and nowhere else, so the two screens cannot drift apart.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'

export const LOGO = [
  '  ██   ▀            ',
  '▄▄██▄▄ ▄▄ ▄▄ ▄▄  ▄▄ ▄▄',
  '  ██   ██ ██▀ ██ ██ ██',
  '  ██   ██ ██  ██ ██▄██',
  '  ▀▀▀  ▀▀ ▀▀  ▀▀  ▄▄█▀',
]
export const RAINBOW = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'] as const

/** One frame of the logo — the diagonal rainbow phase is `frame`. */
export function LogoFrame({ frame }: { frame: number }) {
  return (
    <Box flexDirection="column">
      {LOGO.map((line, y) => (
        <Text key={y}>
          {[...line].map((ch, x) => (
            <Text key={x} color={RAINBOW[(x + y + frame) % RAINBOW.length]}>{ch}</Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Boot splash: animate until BOTH a minimum beat has passed (so a fast init
 * doesn't reduce it to a flicker) and `until` has settled (so a slow init
 * keeps the colors cycling instead of showing a frozen screen). The caller
 * unmounts on `onDone`; whatever frame was last drawn stays in the terminal.
 *
 * `until` is awaited with the caller's error swallowed — a failed init is
 * the CALLER's error to re-throw after the splash steps aside, not the
 * splash's to hang on.
 */
export function Splash({ minMs = 1100, until, onDone }: {
  minMs?: number
  until?: Promise<unknown>
  onDone: () => void
}) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 90)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    let live = true
    const min = new Promise((r) => setTimeout(r, minMs))
    const gate = until ? until.catch(() => {}) : Promise.resolve()
    Promise.all([min, gate]).then(() => { if (live) onDone() })
    return () => { live = false }
  }, [])
  return (
    <Box flexDirection="column" paddingTop={1}>
      <LogoFrame frame={frame} />
    </Box>
  )
}
