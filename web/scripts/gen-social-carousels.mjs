#!/usr/bin/env node
/**
 * gen-social-carousels.mjs — the Instagram carousel slides for the two
 * storyboarded posts in store-assets/social/instagram.md.
 *
 * Why a separate script from gen-store-composites.mjs: a store screenshot and a
 * carousel slide are different objects. A store slide's caption describes a
 * FEATURE ("Watch its memory grow"); a carousel slide is one beat of an ARGUMENT
 * and half the slides carry no screenshot at all. Same brand, same geometry —
 * both are imported, not re-declared — but the shot list and the ordering logic
 * belong to the post, not to the store.
 *
 *   node scripts/gen-social-carousels.mjs                 # both posts
 *   node scripts/gen-social-carousels.mjs --only=post1
 *   node scripts/gen-social-carousels.mjs "#bd93f9"       # re-brand
 *
 * Emits into store-assets/final/:
 *   ig-p1-N-<id>.png   1080×1350   post 1, "What is a tiny?" (7 slides)
 *   ig-p4-N-<id>.png   1080×1350   post 4, "your phone is not a client" (5)
 *
 * The number in the filename IS the swipe order.
 */
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePalette } from './gen-logo.mjs'
import { socialCardSvg } from './gen-store-graphics.mjs'
import {
  compositeSvg,
  renderPng,
  pngSize,
  blockedReason,
  blockedPendingReason,
} from './gen-store-composites.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'store-assets')
const OUT = join(ROOT, 'store-assets', 'final')
const W = 1080
const H = 1350

/**
 * The source-side leak gate now lives in `gen-store-composites.mjs` and is imported above.
 *
 * It started here, in c37, because this script is where the fifth home of the real-graph leak was
 * found: `ig-p1-3-memory.png` shipped as a perfectly valid 1080×1350 brand slide generated from
 * `c10-memory-graph.png` (a pre-harness capture of the user's REAL graph) and nothing downstream
 * could tell — right dimensions, right palette, right caption, and an md5 that matched its own
 * copy. The only place the difference is knowable is the INPUT.
 *
 * c38 moved the list to the shared module, because a per-script copy of it repeats the exact
 * mistake c37 diagnosed: `gen-store-composites.mjs` was sourcing `android/raw/c2-memory-graph.png`
 * with no gate at all the whole time this one was gated. One list, three enforcers.
 */

/**
 * Crop regions in SOURCE pixels, for the slides where the interesting thing is
 * a card partway down the screen rather than the top of the app.
 *
 * ⚠️ MONETIZE is not an arbitrary framing choice — it's the privacy scrub.
 * `android/raw/c3-wallet.png` is excluded from every store set because the page
 * shows the user's real USDC balance and (in `-top`) a real wallet address. The
 * "Monetize your tinys" card at the BOTTOM of that same page shows neither: only
 * public tiny slugs, their public prices, and public x402/ERC-8004 URLs. So the
 * carousel's "it can earn" beat comes from this rect and nowhere else — do not
 * widen it upward, and do not swap in the whole screen.
 */
const MONETIZE = { x: 36, y: 1185, w: 1008, h: 900 }
/**
 * The in-call bar, plus enough of the reply above it to show a call happening
 * inside a NORMAL chat — which a top-of-screen inset can't show at all, since the
 * bar sits just above the composer.
 *
 * The top edge is set to a BULLET BOUNDARY (the "weather" tool line), not to a
 * round number: a crop that starts mid-sentence reads as a botched export rather
 * than as a scrolled conversation, and at this height the whole thing is scaled
 * by availH, so the top edge is the only thing choosing what's visible.
 */
const IN_CALL = { x: 0, y: 945, w: 1080, h: 1070 }
/** The fleet list: device rows with online/last-seen dots. */
const FLEET = { x: 24, y: 1290, w: 1032, h: 1000 }

const TYPE = 'type' // no screenshot; socialCardSvg does the whole slide

const POSTS = {
  post1: {
    prefix: 'ig-p1',
    slides: [
      {
        id: 'what',
        kind: TYPE,
        kicker: 'WHAT IS A TINY',
        lines: [
          { t: 'An AI you make', size: 96 },
          { t: 'by talking to it.', size: 96, accent: true },
        ],
        footer: 'swipe for the whole idea →',
      },
      {
        id: 'no-config',
        src: 'ios/raw/c8-chat-hero-authed.png',
        caption: 'No config.\nNo prompt files.',
        mode: 'inset',
      },
      {
        // ⚠️ c28's HARNESS raw, never `c10-memory-graph.png`. c10 is a pre-fix capture that
        // renders the signed-in account's REAL graph, and this slide shipped it: at 1080×1350,
        // legibly, `2026-07-26 FINANCIAL FLAG…`, `SHIPMENT OF RECORD (confi…`, a named third
        // party (`Arron Bailiss is …`), `DIAGNOSTIC REC…` and ~40 private repo names — an
        // Instagram post of the user's private memory. The fifth home of the c28 defect: the
        // store PNGs, the required iPad set, the Android set and all four video encodes were
        // each fixed in turn, and the carousel was never re-read because it had been filed as
        // a "store screenshot" problem every time. c28 substitutes the 15-fact baking demo
        // dataset via `--memory-graph-harness`, so its footer reads `15 facts · 17 links`.
        //
        // The imported BLOCKED_SOURCES gate fails the build if a leaking raw is named here again.
        id: 'memory',
        src: 'ios/raw/c28-memory-graph.png',
        caption: 'Read every fact\nit holds.',
        mode: 'inset',
      },
      {
        id: 'voice',
        src: 'android/raw/c5-voice-call.png',
        caption: 'Call it. Interrupt it\nmid-sentence.',
        crop: IN_CALL,
      },
      {
        id: 'devices',
        src: 'android/raw/c4-devices.png',
        caption: 'Phone, tablet, watch —\nall one AI.',
        crop: FLEET,
      },
      {
        id: 'earn',
        src: 'android/raw/c3-wallet.png',
        caption: 'It can earn. Your price,\nyour veto.',
        crop: MONETIZE,
      },
      {
        id: 'cta',
        kind: TYPE,
        kicker: 'WHAT IT COSTS',
        lines: [
          { t: 'Free to create.', size: 92 },
          { t: 'Free to keep.', size: 92, accent: true },
          { t: 'No subscription just to exist.', size: 50 },
        ],
        footer: 'iOS + Android · link in bio',
      },
    ],
  },
  post4: {
    prefix: 'ig-p4',
    slides: [
      {
        id: 'cant-touch',
        kind: TYPE,
        kicker: 'ONE AI, MANY BODIES',
        lines: [
          { t: "Most AI can't touch", size: 88 },
          { t: 'anything you own.', size: 88, accent: true },
          { t: 'Yours can.', size: 60 },
        ],
        footer: 'swipe →',
      },
      {
        id: 'hardware',
        kind: TYPE,
        kicker: 'ON YOUR PHONE',
        // A list, not prose — one capability per line, each one a real shipped
        // tool (torch/haptics/sensors/BLE/brightness/clipboard/speech/image gen).
        lines: [
          { t: 'torch · haptics · sensors', size: 62 },
          { t: 'bluetooth · brightness', size: 62 },
          { t: 'clipboard · speech', size: 62 },
          { t: 'on-device image generation', size: 62, accent: true },
        ],
        footer: 'no round trip to anyone’s server',
      },
      {
        id: 'node',
        src: 'android/raw/c4-devices.png',
        caption: 'Every device enrols\nas a node.',
        crop: FLEET,
      },
      // ⚠️ The storyboard's caption here was "A live map of what's online right
      // now" — and this capture has ZERO device pins on it (an empty San
      // Francisco with only the locate-me / be-seen controls). Same false-claim
      // trap that the iPad set hit: the map screen is real, a fleet of pins on it
      // is not, and IG has no App Review to stop it. The honest beat this capture
      // DOES prove is that location is a switch you flip.
      {
        id: 'be-seen',
        src: 'ios/raw/c10-map.png',
        caption: '“Be seen.” Location is\none tap, and opt-in.',
        mode: 'inset',
      },
      {
        id: 'cta',
        kind: TYPE,
        kicker: 'THE POINT',
        lines: [
          { t: 'Your phone isn’t a', size: 84 },
          { t: 'window into an AI.', size: 84 },
          { t: 'It’s part of one.', size: 84, accent: true },
        ],
        footer: 'free to create · free to keep',
      },
    ],
  },
}

const b64 = (path) => readFileSync(path).toString('base64')

/**
 * Every carousel SLIDE filename that would be built from a BLOCKED raw, as `[name, why]`.
 *
 * The counterpart to `blockedOutputs()` in the shared module, and it has to be separate because
 * the slide lists live here. c40's finding was precisely that the social slides were invisible to
 * the upload gate: `android/raw/c4-devices.png` feeds `ig-p1-5-devices` and `ig-p4-3-node`, and no
 * cycle had ever listed either — the leak kept being filed against whichever asset class noticed
 * it (c37: the store sets vs this carousel; c38: this carousel vs the other two generators).
 *
 * ⚠️ The `n` counter must mirror main()'s, TYPE slides included — they take a number too. Deriving
 * the name from the same expression main() uses is what keeps that true.
 */
export function blockedSlides() {
  const out = []
  for (const post of Object.values(POSTS)) {
    let n = 0
    for (const s of post.slides) {
      n += 1
      if (!s.src) continue
      const b = blockedReason(s.src)
      if (b) out.push([`${post.prefix}-${n}-${s.id}.png`, b.why])
    }
  }
  return out
}

const main = () => {
  const args = process.argv.slice(2)
  const accent = args.find((a) => a.startsWith('#')) || '#00FF88'
  const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]
  const p = derivePalette(accent)
  mkdirSync(OUT, { recursive: true })

  // Slides refused because their source raw is BLOCKED with kind `pending`. Collected rather than
  // thrown so the clean slides still regenerate; reported and exited non-zero at the bottom.
  const skipped = []

  const names = only ? [only] : Object.keys(POSTS)
  for (const name of names) {
    const post = POSTS[name]
    if (!post) throw new Error(`no post named ${name} (have: ${Object.keys(POSTS).join(', ')})`)
    let n = 0
    for (const s of post.slides) {
      n += 1
      const out = join(OUT, `${post.prefix}-${n}-${s.id}.png`)
      if (s.kind === TYPE) {
        renderPng(socialCardSvg(p, `${post.prefix}${n}`, s), out, W)
      } else {
        // ⚠️ Before `existsSync`, on purpose: a blocked raw that is also missing must report
        // the BLOCK, not "missing raw". "Missing" invites someone to go and re-create the file.
        //
        // ⚠️ c40: this was `assertPublishable`, which refuses BOTH kinds — and that turned out to
        // be the c38 defect reintroduced one script over. When `android/raw/c4-devices.png` became
        // blocked (kind `pending`: it needs a Pixel recapture, the slide list is correct), a hard
        // throw made post1 abort at slide 5 of 7 and post4 at slide 3 of 5, so the eight CLEAN
        // slides in those posts could no longer be regenerated at all — a re-brand would have had
        // nothing to run. `pending` skips the slide and exits non-zero; `wrong` still throws,
        // because naming the leaking twin of a file you have is an authoring mistake with a
        // correct answer, not a capture that hasn't happened yet.
        const block = blockedPendingReason(s.src, `slide ${post.prefix}-${n}-${s.id}`)
        if (block) {
          skipped.push([`${post.prefix}-${n}-${s.id}`, s.src, block])
          console.log(`✗ ${post.prefix}-${n}-${s.id}  (🔴 refused: source is BLOCKED)`)
          continue
        }
        const path = join(RAW, s.src)
        if (!existsSync(path)) throw new Error(`missing raw: ${s.src}`)
        const size = pngSize(path)
        // A `crop` region is framed with the DEFAULT (scale-to-fit) mode, not
        // inset: inset scales to width alone and lets the clip take the bottom,
        // which is right for a 19.5:9 screen on a 4:5 canvas but would guillotine
        // a card that's already nearly square.
        renderPng(
          compositeSvg(p, `${post.prefix}${n}`, {
            W,
            H,
            src: b64(path),
            srcW: size.w,
            srcH: size.h,
            cropTop: 0,
            crop: s.crop,
            caption: s.caption,
            mode: s.mode,
            captionSize: 66,
          }),
          out,
          W
        )
      }
      const got = pngSize(out)
      if (got.w !== W || got.h !== H) throw new Error(`${out} is ${got.w}×${got.h}, want ${W}×${H}`)
      console.log(`✓ ${post.prefix}-${n}-${s.id}`)
    }
  }
  console.log(`\naccent ${accent} → ${OUT}`)

  if (skipped.length) {
    console.error(`\n🔴 REFUSED ${skipped.length} slide(s) — their source raw is BLOCKED:`)
    for (const [slide, src, why] of skipped) console.error(`  ${slide}  ←  ${src}\n      ${why}`)
    console.error(
      '\n  Any previously-generated copy of these slides is STILL ON DISK and still leaking —\n' +
        '  skipping means "do not rebuild", never "it is safe now". Delete the PNG or re-capture.'
    )
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
