#!/usr/bin/env node
/**
 * gen-multi-device.mjs — the "every surface" lineup: one canvas showing the SAME
 * tiny on five real devices, built from the committed raw captures.
 *
 * Why it exists: the launch thread's closing post (`social/x-launch-thread.md`
 * 9/9) claims "iOS + iPadOS + Apple Watch … Android + Wear OS … One AI. One
 * memory. Every surface." That is the thread's whole payoff and it was the last
 * [NEEDS ASSET] in it. A claim that broad needs a picture that SHOWS the breadth,
 * and until both wrist shots existed (watch-01-chat / wear-01-chat) one couldn't
 * be built — a lineup missing a device family would have undersold the exact
 * claim it's there to prove.
 *
 * Two output sizes, because the two platforms crop differently:
 *   final/multi-device-1600x900.png    16:9  — X/Twitter in-timeline (X crops tall
 *                                       images; a 4:5 card gets guillotined there)
 *   final/multi-device-1080x1350.png   4:5   — Instagram feed
 * Same layout engine, so the two can't drift apart.
 *
 * ⚠️ NOT to physical scale, deliberately. Real heights are ~280mm : ~160mm : 46mm
 * (iPad : phone : watch), which would render a watch ~100px tall on this canvas —
 * an unreadable smudge, and a lineup nobody can read proves nothing. The devices
 * are sized so every screen is legible instead, and each one is LABELLED, so the
 * image asserts "these five surfaces" and never "these relative sizes".
 *
 * ⚠️ The Pixel source keeps its status bar cropped (`cropTop`) — Pixel demo mode
 * does NOT hide the user's personal notification icons on this build, and they're
 * plainly readable at this size. The iOS/watchOS/Wear sources are simulator or
 * emulator captures with clean bars, so they're used whole.
 *
 * Brand palette, mark, gradients and font are IMPORTED from the existing
 * generators — there is no second copy of the brand here, so a re-brand recolours
 * this too.
 *
 *   node scripts/gen-multi-device.mjs              # brand green
 *   node scripts/gen-multi-device.mjs "#bd93f9"    # re-brand
 */
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePalette } from './gen-logo.mjs'
import {
  gradients,
  markG,
  b64,
  esc,
  renderPng,
  pngSize,
  FONT,
  assertPublishable,
} from './gen-store-composites.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'store-assets')
const OUT = join(ROOT, 'store-assets', 'final')

/**
 * The lineup, left to right. `weight` is this device's height as a fraction of the
 * tallest one — chosen for LEGIBILITY, not physical scale (see the docblock).
 * `cropTop` is source px removed from the top before framing.
 *
 * Order is largest-to-smallest so the eye lands on the iPad's sidebar first (the
 * screen no other surface has) and then reads down the family.
 */
const DEVICES = [
  // ⚠️ The iPad hero is cropped to its top 62%. Uncropped, the bottom third of
  // that capture is empty black page between the prompt chips and the composer —
  // fine on a store screenshot where it reads as breathing room, but at lineup
  // scale it renders as a device that appears to be OFF below the fold, which
  // reads as a broken mock rather than a spacious layout.
  { id: 'ipad', label: 'iPad', src: 'ios/raw/c12-ipad-hero.png', weight: 1, crop: { y: 0, h: 1706 } },
  { id: 'iphone', label: 'iPhone', src: 'ios/raw/c8-chat-hero-authed.png', weight: 0.78 },
  // ⚠️ status bar off: personal notification icons (see docblock).
  { id: 'pixel', label: 'Android', src: 'android/raw/c2-home-clean.png', weight: 0.78, cropTop: 116 },
  // ⚠️ The watchOS capture's bottom 56px is the top sliver of the "Ask tiny" button,
  // which the watch's own scroll cuts in half. At store-screenshot size that reads
  // as a button continuing below the fold; shrunk into a lineup it reads as a
  // half-drawn green bar. Cropped to end just under the last line of the answer.
  { id: 'watch', label: 'Apple Watch', src: 'ios/raw/c22-watch-chat.png', weight: 0.34, crop: { y: 0, h: 440 } },
  { id: 'wear', label: 'Wear OS', src: 'android/raw/c23-wear-chat.png', weight: 0.34 },
]

/**
 * Rough advance width of a string, in px, for the Helvetica-ish stack above.
 *
 * There is no text metric available here — rsvg-convert renders, it doesn't
 * measure — so both the caption fit and the label-collision check need an
 * estimate. 0.56em/char for bold and 0.52 for semibold are measured against the
 * rendered output of this very script (the first render overflowed the 16:9
 * caption off the right edge, which is what forced this function to exist). The
 * estimate is deliberately generous: over-estimating shrinks text slightly, while
 * under-estimating puts words off the canvas.
 */
const estWidth = (s, size, bold = true) => s.length * size * (bold ? 0.56 : 0.52)

const CAPTION = 'One AI. One memory. Every surface.'

/**
 * Canvas geometry per output. `rows` groups device ids into rows.
 *
 * ⚠️ The two canvases need DIFFERENT row structures, and this is the whole reason
 * `rows` is configurable rather than "all five in a line". Five devices across
 * 1080px of a 4:5 card put the iPad at ~380px wide — every screen an illegible
 * smudge — while leaving a third of the canvas empty above them, because the
 * binding constraint on a tall canvas is WIDTH and the spare space is HEIGHT.
 * Wrapping the wrists onto a second row spends that height and roughly doubles
 * every device. The 16:9 canvas has the opposite shape and reads fine in one line.
 */
const CANVASES = [
  {
    name: 'multi-device-1600x900.png',
    W: 1600,
    H: 900,
    capLines: [CAPTION],
    capFrac: 0.058,
    bandFrac: 0.62,
    rows: [['ipad', 'iphone', 'pixel', 'watch', 'wear']],
  },
  {
    name: 'multi-device-1080x1350.png',
    W: 1080,
    H: 1350,
    capLines: ['One AI. One memory.', 'Every surface.'],
    capFrac: 0.062,
    bandFrac: 0.66,
    rows: [
      ['ipad', 'iphone', 'pixel'],
      ['watch', 'wear'],
    ],
  },
]

/**
 * Lay the devices out row by row and return the SVG.
 *
 * Sizing is solved rather than hardcoded: pick the unit height so every row fits
 * the available width AND the rows together fit the band height, whichever binds.
 * A hardcoded height renders fine at one canvas size and silently overflows at
 * the other — and an overflowing lineup is clipped by the canvas edge, which
 * looks like a cropped device rather than a bug.
 */
function lineupSvg(p, { W, H, capLines, capFrac, bandFrac, rows }) {
  const capMaxW = W - Math.round(W * 0.06) * 2
  // Shrink the caption until the WIDEST line fits inside the side margins. The
  // first render of the 16:9 canvas put "One AI. One memory. Every surface." at
  // 0.058W and the final "e." fell off the right edge — the PNG was exactly
  // 1600×900 and the script exited 0, so only looking at it caught this. Sizing
  // from a fit test rather than a constant means a re-worded caption can't
  // silently reintroduce it.
  let capSize = Math.round(W * capFrac)
  const widest = () => Math.max(...capLines.map((l) => estWidth(l, capSize)))
  while (capSize > 12 && widest() > capMaxW) capSize -= 1
  const capTop = Math.round(H * 0.055)
  const capBlock = capTop + capLines.length * capSize * 1.22
  const labelSize = Math.max(16, Math.round(W * 0.019))
  const markSize = Math.round(W * 0.045)
  const gap = Math.round(W * 0.022)

  // Vertical space the device row may occupy: below the caption, above the labels
  // and the brand mark.
  const bandTop = capBlock + Math.round(H * 0.05)
  const bandBottom = H - markSize * 1.9 - labelSize * 2.2
  const bandH = Math.min(bandBottom - bandTop, Math.round(H * bandFrac))

  const measure = (d) => {
    // Same source-side blocklist the composite and carousel generators enforce, imported rather
    // than copied — see the docblock on BLOCKED_SOURCES in gen-store-composites.mjs. None of the
    // five DEVICES srcs is currently blocked; this is here so that swapping one for a leaking raw
    // fails loudly instead of publishing a 1600×900 card of the user's real data.
    assertPublishable(d.src, `multi-device:${d.id}`)
    const path = join(RAW, d.src)
    const { w: srcW, h: srcH } = pngSize(path)
    // `cropTop` trims the status bar; `crop` {y,h} frames an arbitrary vertical
    // slice (the iPad's top 62%). cropTop is the degenerate case of the same
    // thing, so both collapse to one region here.
    const regY = d.crop?.y ?? d.cropTop ?? 0
    const regH = d.crop?.h ?? srcH - regY
    return { ...d, path, srcW, srcH, regY, regH, aspect: srcW / regH }
  }
  const byId = new Map(DEVICES.map((d) => [d.id, measure(d)]))
  const rowShots = rows.map((ids) =>
    ids.map((id) => {
      const s = byId.get(id)
      if (!s) throw new Error(`row references unknown device id "${id}"`)
      return s
    })
  )
  // Every device must appear exactly once across the rows — a typo in one canvas'
  // `rows` would otherwise silently DROP a device family, which is the one defect
  // this whole asset exists to avoid (the image's claim is "every surface").
  const placed = rows.flat()
  if (placed.length !== DEVICES.length || new Set(placed).size !== DEVICES.length) {
    throw new Error(`rows place ${placed.length} devices, expected all ${DEVICES.length} exactly once`)
  }

  // Row heights split the band by each row's tallest weight, so a row of wrists
  // gets less vertical space than a row containing the iPad.
  const rowWeights = rowShots.map((r) => Math.max(...r.map((s) => s.weight)))
  const rowGapY = labelSize * 3.1 // room for the label under each row
  const weightSum = rowWeights.reduce((a, b) => a + b, 0)
  const availH = bandH - rowGapY * (rows.length - 1)
  const maxRowW = W - Math.round(W * 0.08) * 2

  // Solve for the unit height U (weight 1.0) once, GLOBALLY: per-row solving would
  // scale each row to fill its own width, so a 2-device row would render its
  // watches larger than the 3-device row's phones — the lineup has to share one
  // scale or it stops reading as one family.
  const U = Math.min(
    availH / weightSum,
    ...rowShots.map((r) => {
      const widthPerU = r.reduce((sum, s) => sum + s.weight * s.aspect, 0)
      return (maxRowW - gap * (r.length - 1)) / widthPerU
    })
  )

  // A label wider than its device would run into its neighbour's — "Apple Watch"
  // and "Wear OS" nearly touched in the first render, because a 46mm watch is far
  // narrower than its own name. Break any such label onto two lines rather than
  // shrinking every label (a uniformly tiny label row is unreadable at feed size).
  const wrapLabel = (label, w) =>
    estWidth(label, labelSize, false) <= w + gap * 0.8 || !label.includes(' ')
      ? [label]
      : label.split(' ')

  // Centre the block of rows in the band. Without this the rows hug the caption
  // and leave the dead space at the BOTTOM — which is exactly the defect the row
  // wrapping exists to remove, just relocated.
  const usedH = rowWeights.reduce((sum, w) => sum + Math.round(w * U), 0) + rowGapY * (rows.length - 1)
  const parts = []
  let baseline = bandTop + Math.max(0, (bandH - usedH) / 2)
  rowShots.forEach((row, ri) => {
    const laid = row.map((s) => {
      const h = Math.round(s.weight * U)
      return { ...s, h, w: Math.round(h * s.aspect) }
    })
    baseline += Math.round(rowWeights[ri] * U) // this row's devices sit ON this line
    const rowW = laid.reduce((sum, s) => sum + s.w, 0) + gap * (laid.length - 1)
    let x = Math.round((W - rowW) / 2)
    for (const s of laid) {
      const y = baseline - s.h
      const radius = Math.max(6, Math.round(s.w * 0.06))
      const scale = s.w / s.srcW
      // Draw the image full-size and offset so the crop region's top edge lands at
      // the frame top; the clip hides the rest. Same trick as compositeSvg — the
      // raw files are never edited.
      const imgY = y - s.regY * scale
      const labelLines = wrapLabel(s.label, s.w)
      parts.push(`  <clipPath id="clip-${s.id}"><rect x="${x}" y="${y}" width="${s.w}" height="${s.h}" rx="${radius}"/></clipPath>
  <g clip-path="url(#clip-${s.id})">
    <image xlink:href="data:image/png;base64,${b64(s.path)}" x="${x}" y="${imgY}" width="${s.w}" height="${s.srcH * scale}" preserveAspectRatio="none"/>
  </g>
  <rect x="${x}" y="${y}" width="${s.w}" height="${s.h}" rx="${radius}" fill="none" stroke="${p.accent}" stroke-opacity="0.34" stroke-width="2.5"/>
${labelLines
  .map(
    (l, i) =>
      `  <text x="${x + s.w / 2}" y="${baseline + labelSize * (1.7 + i * 1.15)}" text-anchor="middle" font-family="${FONT}" font-size="${labelSize}" font-weight="600" fill="${p.accent}" fill-opacity="0.9">${esc(l)}</text>`
  )
  .join('\n')}`)
      x += s.w + gap
    }
    baseline += rowGapY
  })

  const capText = capLines
    .map(
      (l, i) =>
        `  <text x="${W / 2}" y="${capTop + capSize + i * capSize * 1.22}" text-anchor="middle" font-family="${FONT}" font-size="${capSize}" font-weight="700" fill="#f4f4f4">${esc(l)}</text>`
    )
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- GENERATED by scripts/gen-multi-device.mjs — regenerate, don't hand-edit. -->
${gradients(p, 'md').replace(/__[XYWHR]+__/g, '0')}
  <rect width="${W}" height="${H}" fill="${p.bg}"/>
  <ellipse cx="${W / 2}" cy="${H * 0.2}" rx="${W * 0.9}" ry="${H * 0.5}" fill="url(#md-wash)"/>
${capText}
${parts.join('\n')}
${markG(p, 'md', W / 2, H - Math.round(markSize * 0.95), markSize)}
</svg>
`
}

const main = () => {
  const accent = process.argv.find((a) => a.startsWith('#')) || '#00FF88'
  const p = derivePalette(accent)
  mkdirSync(OUT, { recursive: true })

  for (const c of CANVASES) {
    const out = join(OUT, c.name)
    renderPng(lineupSvg(p, c), out, c.W)
    // Assert against the CANVAS spec, not against what we just asked for — a
    // renderer that silently rounds would otherwise pass unnoticed.
    const got = pngSize(out)
    if (got.w !== c.W || got.h !== c.H) {
      throw new Error(`${c.name} is ${got.w}×${got.h}, want ${c.W}×${c.H}`)
    }
    console.log(`✓ ${c.name}  ${got.w}×${got.h}  (${DEVICES.length} devices)`)
  }
  console.log('⚠️ READ the pngs — dimensions being right says nothing about the layout.')
}

main()
