#!/usr/bin/env node
/**
 * gen-store-composites.mjs — captioned, framed store/social composites from the
 * raw device captures in store-assets/{ios,android}/raw.
 *
 * Why this exists rather than shipping raws:
 *  - Apple/Play listings convert far better with a caption above the shot, and
 *    Apple crops overlay text in the outer bands on some placements.
 *  - Instagram crops to 4:5, so a raw 1080×2410 phone shot is destroyed there
 *    (see store-assets/social/instagram.md). It needs an inset composite.
 *  - The Pixel's status bar still shows the user's PERSONAL notification icons
 *    (demo mode doesn't hide them on this build), so Android shots must have
 *    the status bar cropped off — this script does it, per-shot, by height.
 *
 * Brand palette + mark come from gen-logo.mjs / gen-store-graphics.mjs. There is
 * no second copy of the brand here; a re-brand recolors these too.
 *
 *   node scripts/gen-store-composites.mjs                # all shots, brand green
 *   node scripts/gen-store-composites.mjs --only=hero    # one shot id
 *   node scripts/gen-store-composites.mjs "#bd93f9"      # re-brand
 *
 * Emits, per shot, into store-assets/final/:
 *   apple-<n>-<id>.png     1320×2868  (6.9" iPhone — Apple's required size)
 *   play-<n>-<id>.png      1080×2160  (Play phone — 2:1, Play's MAXIMUM ratio;
 *                                     see the note at the render call)
 *   ig-<id>.png            1080×1350  (Instagram 4:5)
 *   ipad-<n>-<id>.png      2064×2752  (13" iPad — Apple REQUIRES its own set
 *                                      when the app supports iPad, and it does)
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { derivePalette } from './gen-logo.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'store-assets')
const OUT = join(ROOT, 'store-assets', 'final')
export const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif'

/**
 * Raws that must never be composited into ANY published asset, with the reason.
 *
 * ## Why this lives here rather than in the script that needed it
 *
 * c37 found the c28 real-graph leak in its FIFTH home — an Instagram carousel slide built from a
 * pre-harness raw — and gated it inside `gen-social-carousels.mjs`. That fix reached ONE of the
 * three scripts that read the raw capture dirs, which is the same mistake c37 was diagnosing: a
 * defect filed against the asset class where it was noticed. `gen-store-composites.mjs` (this
 * file) sources `android/raw/c2-memory-graph.png` at shot `memory-graph` and had no gate at all,
 * and `gen-multi-device.mjs` had none either.
 *
 * (⚠️ Do not write those two dirs as one `**` glob in this docblock: the `*` followed by `/`
 * closes the block comment and the whole file stops parsing. `node --check` catches it in a
 * second; a reviewer reading the prose does not.)
 *
 * So the list is exported from the module all three already import, and each enforces it. One
 * list, one place to add to, and a new generator that imports `assertPublishable` inherits it.
 *
 * ## Why source-side and not output-side
 *
 * The leaking slide was undetectable downstream: right dimensions, right palette, right caption,
 * and an md5 that matched its own copy. Two identical copies of a leaking file are perfectly in
 * sync. The only place the difference is knowable is the INPUT.
 *
 * Deleting a line here does not make a raw safe. Re-capture under a harness instead — and note a
 * clean twin usually already exists (`c28-memory-graph.png` did, for two whole cycles, while the
 * carousel shipped the leaking one).
 *
 * ## Every entry carries a `kind`, and it decides throw-vs-skip
 *
 * c38 gave the three generators different behaviour for a blocked source — the carousel and the
 * multi-device card throw, the composite loop skips one output and exits non-zero — and put that
 * choice in the CONSUMER. c40 found that is the wrong axis. What behaviour is correct depends on
 * WHY the raw is blocked, not on which script noticed:
 *
 *   `wrong`   — a clean twin exists and the shot list should have named it. An authoring mistake.
 *               Produce nothing; the run is asking for something that has a correct answer.
 *   `pending` — the shot list is right and the RAW isn't ready (needs a harness recapture). Skip
 *               the affected output, keep the rest, exit non-zero. A gate that stops the safe
 *               work is a gate people delete.
 *
 * Keyed per-generator, `pending` + carousel = the whole carousel unrunnable, which is exactly the
 * failure c38 fixed in the composite loop and then reintroduced one script over. It only looked
 * fine because no carousel slide happened to name the one `pending` entry there was.
 *
 * ⚠️ `gen-multi-device.mjs` still refuses BOTH kinds outright, and that is not an oversight: its
 * output claims "One AI. One memory. Every surface." and it enforces that all five device panels
 * are placed. Skipping a panel would make the card assert something false, so there is no safe
 * partial result to keep.
 */
export const BLOCKED_SOURCES = {
  'ios/raw/c10-memory-graph.png': {
    kind: 'wrong',
    why:
      "pre-harness capture: renders the account's real fact graph (FINANCIAL FLAG, SHIPMENT OF " +
      'RECORD, a named third party, ~40 private repo names). Use ios/raw/c28-memory-graph.png.',
  },
  'ios/raw/c11-messages.png': {
    kind: 'wrong',
    why: 'real private DM previews and real names — never safe for a published asset, at any crop.',
  },
  // ⚠️⚠️ c54, and the entry deliberately NOT added here is the lesson.
  //
  // The memory LIST raws (`ios/raw/c10-memory.png`, `ios/raw/c12-ipad-memory.png`,
  // `android/raw/c2-memory.png`) render `MemoryPanel` — "☁️ Server learnings (learn tool)",
  // Panels.swift:1410 — which fetches `/api/learnings?limit=200` on the plain shipping path with NO
  // harness gate. So they show the signed-in account's REAL learnings, and the graph's
  // `--memory-graph-harness` does not touch them (it substitutes only `MemoryGraphView`'s dataset).
  //
  // They are still NOT blocked, because c38 already READ them and the content cleared: the two
  // legible facts name `cagataycali/scout-the-rover` and `cagataycali/strands-robots`, both
  // verified PUBLIC repos (re-verified with `gh repo view` in c54, still public, as is the HF
  // dataset `cagataydev/scout-earthrover-ecot`). Nothing dated, no third party, no private repo.
  // 🔑 **"Renders real data" is not the same finding as "leaks".** Blocking these would have been a
  // safety theatre commit that deleted a valid asset set on a premise nobody re-checked — c54's
  // first draft did exactly that, and the check that caught it was going back to c38's own
  // evidence rather than trusting a fresh reading of the same pixels.
  //
  // What WAS missing is that c38's clearance was a human read of one capture with nothing
  // re-checking it, while the graph beat got an oracle that survives a re-encode. The account's
  // learnings can change at any time — the next `learn` call can put anything on this screen, and
  // no check would notice. That gap is now closed for the VIDEOS (a `forbid` beat in
  // check-video-graph-beat.py, since a video's frames are re-decoded on every `--check`).
  //
  // ✅ c56 built the missing piece: `MemoryHarness` (iOS Panels.swift) seeds BOTH of that sheet's
  // ungated sources — the /api/learnings fetch AND the on-device `Continuity.memories` section
  // above it, which a network-only harness would have left live. These three raws are still NOT
  // blocked and still not RE-CAPTURED: a recapture under `--memory-list-harness` is what would
  // make them durably clean, and until someone does it they remain exactly what they were — read
  // once, found clean, backed by no oracle. 🔑 **Building the harness does not re-capture the
  // assets**; recording the capability is not recording the capture.
  'ios/raw/c12-ipad-memory-graph.png': {
    kind: 'wrong',
    why: 'pre-harness iPad capture of the real fact graph. Use ios/raw/c30-ipad-memory-graph.png.',
  },
  'android/raw/c2-memory-graph.png': {
    kind: 'pending',
    why:
      'Android pre-harness capture of the real fact graph; the c29 harness recapture is still ' +
      'pending an awake Pixel (see store-assets/UPLOAD.md). This is why play-02-memory-graph.png ' +
      "is an entry in that runbook's BLOCKED table.",
  },
  'android/raw/c3-wallet-top.png': {
    kind: 'wrong',
    why:
      "shows the user's real USDC balance AND a real wallet address. Only the MONETIZE crop of " +
      'android/raw/c3-wallet.png is publishable, and only from the bottom card.',
  },
  // ⚠️ c40. This raw is the `fleet` screen and the fleet LIST is its entire content — six rows of
  // the user's real device hostnames (`cagataycali-iphone`, `cagataycali-pixel (this phone)`,
  // `cagatay-mac`, `cagataycali-ipad`, `cagatay-cagatay`, `thor`) with their online/last-seen
  // state and a `revoke` button each. Unlike the wallet page there is no publishable region to
  // crop to: every crop of this screen worth captioning IS the hostname list.
  //
  // It was already known — `store-assets/copy/google-play.md` has listed "`play-05-devices` — the
  // user's whole device fleet by hostname" since the c28 audit. What c40 found is that the note
  // was prose in a doc and nothing enforced it, so:
  //   - `play-05-devices.png` was sitting in the Play UPLOAD TREE, and `--check` called the tree
  //     clean ("20 up to date, 0 drifted", one unrelated asset flagged);
  //   - the same raw also feeds TWO Instagram slides, `ig-p1-5-devices` and `ig-p4-3-node`, which
  //     no cycle had ever listed. Third time this loop has filed a leak against the asset class
  //     where it was noticed (c37: store sets vs carousel; c38: carousel vs the other two
  //     generators; now: a store shot vs the social slides sharing its source).
  'android/raw/c4-devices.png': {
    kind: 'pending',
    why:
      "renders the user's real device fleet by hostname, with a revoke button per row; the whole " +
      'screen is that list, so no crop is safe. Needs a Pixel recapture under a fleet harness ' +
      '(seeded hostnames) — see store-assets/copy/google-play.md.',
  },
}

/**
 * Throw unless `src` (a path relative to `store-assets/`) is safe to publish.
 *
 * ⚠️ Call this BEFORE `existsSync`. A blocked raw that is also absent must report the BLOCK —
 * "missing raw" reads as an instruction to go and re-create the file, which for these files means
 * re-capturing the leak.
 *
 * ⚠️ Refuses BOTH kinds. Use this where there is no safe partial result (see the `kind` docblock
 * above); where skipping one output is meaningful, use `blockedReason()` and honour `.kind`.
 */
export function assertPublishable(src, where) {
  const b = blockedReason(src)
  if (!b) return
  throw new Error(
    `BLOCKED SOURCE in ${where}: ${src}\n  [${b.kind}] ${b.why}\n` +
      '  Store and social assets are PUBLISHED. Re-capture under a harness; do not delete the entry.'
  )
}

/**
 * The same lookup, non-fatal: returns `{kind, why}`, or null if `src` is publishable.
 *
 * ## Why a non-fatal shape exists
 *
 * Throwing is wrong when a blocked source means the RAW isn't ready yet. `android/raw/`
 * `c2-memory-graph.png` is exactly that: the shot list is correct, the Android harness recapture
 * is correct, and the only missing thing is an awake Pixel. c38 made this concrete — wiring the
 * throw into the SHOTS loop made `node scripts/gen-store-composites.mjs` abort at shot 2 of 7,
 * which does not merely fail to help, it takes away the ability to regenerate the five clean
 * shots after it (a re-brand could not run at all). A safety gate that stops the safe work is a
 * gate people delete.
 *
 * So for a `pending` source the loop skips the affected outputs, keeps the rest, and the run still
 * exits non-zero. Skipping leaves any previously-generated leaking PNG on disk; that is deliberate
 * and covered by `sync-store-screenshots.mjs`'s independent `BLOCKED` list plus UPLOAD.md.
 * Silently regenerating it is the failure this prevents, not its existence.
 *
 * A `wrong` source still throws even here — there is a clean twin to name, so nothing about the
 * run is salvageable and continuing would just bake the authoring mistake into six other files.
 */
export function blockedReason(src) {
  return BLOCKED_SOURCES[src] ?? null
}

/**
 * The gate for a generator that can skip ONE output and keep going.
 *
 * Returns the reason string to record, or null to proceed. Throws on a `wrong` source, because
 * "skip it" is not a sane response to "you named the leaking twin of a file you have".
 */
export function blockedPendingReason(src, where) {
  const b = blockedReason(src)
  if (!b) return null
  if (b.kind !== 'pending') assertPublishable(src, where)
  return b.why
}

/**
 * Every OUTPUT filename this module's shot lists would build from a BLOCKED raw, as
 * `[name, why]` — i.e. the assets that must never reach an upload.
 *
 * ## Why this is derived and not a list
 *
 * `sync-store-screenshots.mjs` kept its own hand-written `BLOCKED` array of output filenames, and
 * that is two copies of one truth with no transform between them — the shape this loop has now
 * paid for four times. c40 found the consequence: `android/raw/c4-devices.png` had been documented
 * as leaking the user's device hostnames since the c28 audit, and `play-05-devices.png` was
 * nonetheless sitting in the Play upload tree with `--check` reporting "20 up to date, 0 drifted".
 * Nobody had transcribed the source-side fact into the output-side list.
 *
 * Deriving it means adding one `BLOCKED_SOURCES` entry now names every affected output by itself,
 * across both platforms and the IG cut, in the same order the generator builds them. The
 * filename expressions below are the SAME ones the loops use — when one changes, both change.
 *
 * ⚠️ This answers "would a regeneration produce a leak", not "is what's on disk safe". A file
 * already written from a blocked raw stays on disk, which is exactly why the upload gate consumes
 * this by checking `existsSync` per name.
 */
export function blockedOutputs() {
  const out = []
  const add = (name, src) => {
    const b = blockedReason(src)
    if (b) out.push([`${name}.png`, b.why])
  }
  SHOTS.forEach((shot, i) => {
    const idx = String(i + 1).padStart(2, '0')
    add(`apple-${idx}-${shot.id}`, shot.ios || shot.android)
    if (shot.android) add(`play-${idx}-${shot.id}`, shot.android)
    if (shot.ig) add(`ig-${shot.id}`, shot.ios || shot.android)
  })
  IPAD_SHOTS.forEach((shot, i) => {
    add(`ipad-${String(i + 1).padStart(2, '0')}-${shot.id}`, shot.ipad)
  })
  for (const [, w] of Object.entries(WRIST_SHOTS)) add(w.out.split('/').pop().replace(/\.png$/, ''), w.raw)
  return out
}

/**
 * The two wrist shots, which this module does NOT build — and which nothing else did either.
 *
 * ## Why they are declared here anyway
 *
 * `watch-01-chat.png` and `wear-01-chat.png` are hand-copied into the upload trees straight from
 * their raws (md5-identical, no crop, no frame). That made them invisible to every gate at once, and
 * c43 PROBED it rather than reasoning about it: adding both raws to `BLOCKED_SOURCES` above changed
 * `blockedOutputs()` not at all and `sync --check` printed nothing about either file — the only
 * matching line was the reassuring `wearScreenshots left alone`. Four exemptions had stacked up:
 *
 *   1. no generator emits them, so they are absent from `final/` and from the sync MAP;
 *   2. `sync-store-screenshots.mjs` skips `watch-`/`wear-` prefixes in its ORPHAN scan by name;
 *   3. `wearScreenshots/` is not among the directories that scan walks at all;
 *   4. `blockedOutputs()` only ever walked `SHOTS`/`IPAD_SHOTS`, so a blocked wrist raw named no
 *      output — the c40 defect exactly, one directory over: the derivation existed and did not
 *      COVER these two.
 *
 * Both are content-clean today (read at full size in c43: seeded transcripts, no handle, no private
 * data). That is the reason to wire them now rather than later — the gate is being added while the
 * answer is "clean", so it can never be mistaken for a reaction to a leak.
 *
 * ⚠️ These are DECLARATIONS, not a build step. `raw` is the file a capture writes and `out` is the
 * tree path an upload reads; the pair is what lets the blocked list and the sync's own integrity
 * check reach a file this module never writes. If a wrist shot ever gains a real composite step,
 * point `out` at `final/` and add it to the sync MAP — do not delete the entry.
 */
export const WRIST_SHOTS = {
  watch: {
    raw: 'ios/raw/c22-watch-chat.png',
    out: 'fastlane/screenshots/en-US/watch-01-chat.png',
    dims: [416, 496],
    label: 'watchOS (Apple requires a set per device family)',
  },
  wear: {
    raw: 'android/raw/c23-wear-chat.png',
    out: 'android/fastlane/metadata/android/en-US/images/wearScreenshots/wear-01-chat.png',
    dims: [768, 768],
    label: "Wear OS (Play won't show the Wear tab without one)",
  },
}

/**
 * The shot list. `caption` is the store caption (keep it under ~40 chars — it
 * renders at one or two lines); `statusBarPx` is how much to crop off the top
 * of the source (Android only: the personal notification icons live there).
 *
 * Order mirrors the sets in store-assets/copy/*.md — the number prefix in the
 * output filename IS the upload order, since both consoles sort by filename.
 */
const SHOTS = [
  {
    id: 'hero',
    caption: 'Create your own AI\nby chatting',
    ios: 'ios/raw/c8-chat-hero-authed.png',
    android: 'android/raw/c2-home-clean.png',
    statusBarPx: 116,
    ig: true,
  },
  // ⚠️ PRIVACY DEFECT until c28 — the worst one found in this loop. Both the old
  // iOS and the old Android raws rendered the SIGNED-IN USER'S OWN fact graph, and
  // the node captions are perfectly legible at 1320×2868: a named third party, a
  // "FINANCIAL FLAG" fact, "SHIPMENT OF RECORD", "LEDGER READ", WhatsApp
  // references and a wall of private repo names. Slot 2 shows in App Store search
  // results, so this was the single most-viewed asset in the set.
  //
  // Unlike the chat shots there is nothing to seed — the graph is a network fetch —
  // so the fix is the DEBUG-only `--memory-graph-harness` in MemoryGraph.load(),
  // which substitutes a chosen 12-live + 3-closed baking-persona dataset (built
  // through the production parseNode/parseEdge, so it can only express what the
  // real API could return) and leaves everything else real: the same GraphSim
  // layout, the same liveFill recency ramp, and a footer counting these very
  // arrays ("15 facts · 17 links" is the harness dataset, not a drawn string).
  //
  // ⚠️ The android raw is STILL the leaking one. It needs a Pixel recapture with
  // the same treatment and must not be uploaded to Play until then — see the
  // blocker note in store-assets/copy/google-play.md.
  {
    id: 'memory-graph',
    caption: 'Watch its memory grow',
    ios: 'ios/raw/c28-memory-graph.png',
    android: 'android/raw/c2-memory-graph.png',
    statusBarPx: 116,
    ig: true,
    // Same reason as `voice`: the 4:5 card's default top-slice framed the empty
    // upper half of the canvas and cut the lowest node off at the card's edge.
    // The subject is the node cloud plus the "N facts · M links" footer, and both
    // live in the bottom two thirds. Measured, not eyeballed: green node pixels
    // span y≈1100–1990 and the legend row sits at y≈2740 in the 2868-tall raw.
    igCrop: { x: 0, y: 1000, w: 1320, h: 1868 },
  },
  {
    id: 'universe',
    caption: 'Meet AIs other\npeople built',
    ios: 'ios/raw/c9-universe.png',
    android: 'android/raw/c3-universe.png',
    statusBarPx: 116,
  },
  // ⚠️ This shot had a REAL DEFECT until c27: with no `ios` source, `appleSrc`
  // silently fell back to the Android capture, so slot 4 of the **Apple 6.9" set**
  // was a Pixel screenshot — Google search bar, Android navbar pill, Compose
  // overflow menu, all inside an iPhone-sized canvas. The fallback is deliberate
  // and fine where the two UIs are near-identical, but it fails SILENTLY, so any
  // shot lacking `ios:` is an Android shot in an Apple set until someone looks.
  // (Apple rejects screenshots showing another platform's UI; this one was
  // unmistakable.) `c27-voice-call.png` is a real iPhone 17 Pro Max capture.
  {
    id: 'voice',
    caption: 'Call it like a person',
    ios: 'ios/raw/c27-voice-call.png',
    android: 'android/raw/c5-voice-call.png',
    statusBarPx: 116,
    ig: true,
    // The IG card frames the BOTTOM of this screen, not the top. The in-call strip
    // ("In call with tiny — recorded; type or talk" + meter + End) is what "Call it
    // like a person" is pointing at, and it lives directly above the composer — the
    // default top-slice inset cut the phone off before reaching it.
    igCrop: { x: 0, y: 1250, w: 1320, h: 1618 },
  },
  // ⚠️ c31: this was the SAME defect c26 fixed on iPad — "fix the CAPTURE, not the
  // caption" — and it had survived on the phone set (and in `ig-devices`, which is
  // the card that gets POSTED first) because only the iPad twin was ever revisited.
  // The old raw `c10-map.png` was an idle basemap under "Your phone becomes a node":
  // no position dot, no pins, no HUD, `locate me` unlit — the caption's entire
  // subject missing, with Apple Maps attribution as the only real content on screen.
  // Review reads that as not depicting the app in use.
  //
  // Tracking is reachable ONLY by tapping "locate me" (permission must fire on the
  // tap, never on open) and the simulator CLI can't send a tap, so the idle raw
  // wasn't a choice anyone made — it was the only state reachable. Hence the DEBUG
  // `--map-tracking-harness` (MapScreen.swift). The new raw shows the claim instead
  // of asserting it: accent pulse at the fix, the pill lit `tracking`, and the HUD
  // printing the literal `### Location` block the tiny is handed.
  {
    id: 'devices',
    caption: 'Your phone becomes\na node',
    ios: 'ios/raw/c31-map-tracking.png',
    android: 'android/raw/c4-devices.png',
    statusBarPx: 116,
    ig: true,
    // This shot has TWO subjects and they sit at opposite ends: the lit `tracking`
    // pill (y 384–542) and the HUD block (to y ~2820). A 4:5 crop at full width is
    // only 1650px tall and cannot span that 2480px range, so a "frame the bottom"
    // crop silently dropped the pill — half the evidence that the feature is ON.
    // A `crop` is scaled to FIT (not clipped) inside the card, so a tall rect keeps
    // both. Verified by measuring accent pixels in the output, not by eye.
    igCrop: { x: 0, y: 340, w: 1320, h: 2480 },
  },
  // ⚠️ Same silent-fallback defect as `voice`, found in the SAME audit (c27): no
  // `ios:` key, so the Apple 6.9" slot 6 was `c4-chat-streaming.png` — a Pixel
  // shot with a Google search bar, an Android navbar and an @-handle header. Both
  // are fixed; when adding a shot, an `ios:` key is not optional documentation.
  //
  // The subject here is the CHIP ROW (`msg.tools` → gearshape capsules,
  // Views.swift:3677), which is why the iOS raw is a SEEDED transcript rather
  // than a live send: the chips only exist if the turn really called those tools,
  // and driving a real call means billing the user's model key for whatever the
  // model happens to pick that minute. `seed-ios-chat.mjs tools` writes a chosen
  // transcript naming two tools iOS genuinely runs (`schedule_alert` via
  // DeviceTools, `remember` via ChatStreamDecoder) — a seeded chip can name
  // anything, so it has to be checked against source, not against the caption.
  {
    id: 'tools',
    caption: 'It actually does things',
    ios: 'ios/raw/c27-tools.png',
    android: 'android/raw/c4-chat-streaming.png',
    statusBarPx: 116,
  },
  {
    id: 'memory',
    caption: 'Teach it once.\nIt remembers.',
    ios: 'ios/raw/c10-memory.png',
    android: 'android/raw/c2-memory.png',
    statusBarPx: 116,
  },
]

// ⚠️ Deliberately NOT in SHOTS:
//  - c11-messages.png       real private DM previews + real names
//  - c3-wallet*.png         real balance, and a real wallet address in -top
//    (a "it can earn" shot needs the user's blur/approval decision first)

/**
 * The iPad 13" set — a SEPARATE list, not a size variant of SHOTS.
 *
 * Apple requires its own screenshot set for iPad when the app supports iPad (it
 * does), and a scaled-down iPhone shot is both against the spirit of that and a
 * worse ad: the iPad build has a persistent sidebar (Split.swift) that the phone
 * doesn't have at all. So the order LEADS with the sidebar — the one screen that
 * only exists here — instead of mirroring the phone set's hero-first order.
 *
 * Sources are already 2064×2752 with a clean simulator status bar, so cropTop=0
 * throughout (no personal notification icons to remove, unlike the Pixel).
 */
/**
 * The iPad form-sheet rect in 2064×2752 source px: x 452–1611, y 716–2016,
 * plus 8px of bleed so the sheet's own rounded corners aren't shaved by the clip.
 *
 * ⚠️ Measured by walking the LONGEST CONTIGUOUS non-black run down the sheet's
 * centre column. A whole-image `rowfrac > threshold` bbox — the obvious approach —
 * gave y 716–2695 instead, because the chat COMPOSER BAR sits below the sheet and
 * is also non-black, so the bbox spanned the gap between them and the "crop"
 * included ~700px of empty page. That version rendered without error and at exactly
 * the right canvas size; only cropping the raw and LOOKING at it showed the sheet
 * occupying the top two-thirds with black underneath. A bbox over a disconnected
 * set of bright regions is not the region you're looking for.
 */
const SHEET = { x: 444, y: 708, w: 1175, h: 1316 }

const IPAD_SHOTS = [
  {
    id: 'sidebar',
    caption: 'Every surface, one tap away',
    ipad: 'ios/raw/c12-ipad-sidebar.png',
  },
  // ⚠️ This shot's history is the loop's best example of "fix the CAPTURE, not the
  // caption". The original raw (`c13-ipad-map.png`) was an idle map: zero pins, no
  // position dot, no HUD — nothing on screen but a dark city and two buttons. Its
  // caption had already been walked back once, from "A live map of your fleet" to
  // "Your AI knows where you are", because a fleet claim over an empty map is both
  // false and the kind of thing App Review rejects as not depicting the app in use.
  // But the weakened caption still oversold it: an idle basemap doesn't show the AI
  // knowing anything.
  //
  // The fix is the map's TRACKING state, which is real and needs no invented data:
  // `xcrun simctl location <udid> set 37.7793,-122.4193` + `simctl privacy grant
  // location` (so no permission dialog covers the shot), then tap locate-me. That
  // lights the accent pulse dot at the fix, flips the pill to "tracking" in brand
  // green, and — the actual reason this shot now earns its slot — raises the HUD
  // showing the LITERAL `### Location` markdown block the tiny is handed
  // (`Geo.contextBlock`, byte-parity across all three clients). The screenshot's
  // claim and the app's behaviour are then the same thing, legibly.
  //
  // ⚠️ "be seen" is deliberately NOT tapped. It POSTs the user's real coordinates
  // to /api/location as a public presence pin — publishing the user's location to
  // get a screenshot. The pill reads its off state here, which is also the honest
  // default.
  {
    id: 'map',
    caption: 'It knows where you are — and shows you exactly what it sees',
    ipad: 'ios/raw/c26-ipad-map-tracking.png',
  },
  // Memory / Universe / Graph present on iPad as a CENTRED FORM SHEET, measured at
  // x 452–1611, y 716–2695 — 56% of the width and 40% of the screen area. Framing
  // the whole screen would sell 60% empty black, so these three crop to the sheet
  // (plus a small bleed so the sheet's own rounded corners aren't shaved).
  // ⚠️ c30: the iPad raw was the THIRD twin of the c28 leak, and the one that had
  // never been read. `c12-ipad-memory-graph.png` drew the signed-in user's own
  // 105-fact graph, and on a 2064-wide upload the captions are far MORE legible
  // than on the phone: `2026-07-26 FINANCIAL FLAG…`, `LEDGER READ`, `WhatsApp`, a
  // named third party, and ~40 private repo names. The iPad set is REQUIRED by
  // Apple, so this shot was mandatory-and-leaking. Fixing the phone twin in c28
  // said nothing about it — same caption, same generator block, different capture.
  {
    id: 'memory-graph',
    caption: 'Watch its memory grow',
    ipad: 'ios/raw/c30-ipad-memory-graph.png',
    crop: SHEET,
  },
  {
    id: 'universe',
    caption: 'Meet AIs other people built',
    ipad: 'ios/raw/c13-ipad-universe.png',
    crop: SHEET,
  },
  {
    id: 'hero',
    caption: 'Create your own AI by chatting',
    ipad: 'ios/raw/c12-ipad-hero.png',
  },
  {
    id: 'memory',
    caption: 'Teach it once. It remembers.',
    ipad: 'ios/raw/c12-ipad-memory.png',
    crop: SHEET,
  },
]

// ⚠️ `ipad-01-sidebar` and `ipad-04-universe` both show real builders' handles
// AND profile photos (@hashtagemy, @mertozbas, …). Same open consent question as
// the Universe beat in the app preview video — see store-assets/final/VIDEOS.md.
// They are IN the set because the phone set already ships the same content with
// the same flag; the decision is one decision, not two.

export const gradients = (p, id) => `  <defs>
    <radialGradient id="${id}-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="${p.accent}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}-core" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="${p.highlight}"/>
      <stop offset="45%" stop-color="${p.accent}"/>
      <stop offset="100%" stop-color="${p.shade}"/>
    </radialGradient>
    <radialGradient id="${id}-wash" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}-clip">
      <rect x="__X__" y="__Y__" width="__W__" height="__H__" rx="__R__"/>
    </clipPath>
  </defs>`

export const markG = (p, id, cx, cy, size) => {
  const s = size / 120
  return `  <g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${s})">
    <circle cx="60" cy="60" r="34" fill="url(#${id}-glow)"/>
    <circle cx="60" cy="18" r="4" fill="${p.accent}"/>
    <circle cx="102" cy="60" r="3" fill="${p.accent}" opacity="0.8"/>
    <circle cx="60" cy="102" r="3.4" fill="${p.lightDot}"/>
    <circle cx="24" cy="44" r="2.6" fill="${p.accent}" opacity="0.7"/>
    <circle cx="96" cy="88" r="2.6" fill="${p.accent}" opacity="0.7"/>
    <circle cx="60" cy="60" r="15" fill="url(#${id}-core)"/>
  </g>`
}

export const b64 = (path) => readFileSync(path).toString('base64')

/** Escape the few chars that break SVG text. */
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Rendered text width, ESTIMATED — there is no measurement available here (rsvg
 * rasterizes, it doesn't report metrics), so this is the only way to know a
 * caption fits before it's already clipped. 0.56em/char for bold Helvetica-ish
 * text; it errs WIDE, which shrinks a borderline caption rather than clipping it.
 * gen-multi-device.mjs holds the same heuristic for the same font — keep them equal.
 */
export const estWidth = (s, size, bold = true) => s.length * size * (bold ? 0.56 : 0.52)

/**
 * One framed composite: caption band on top, the device shot below it, clipped
 * to rounded corners and cropped by `cropTop` source px (the status bar).
 *
 * `mode: 'inset'` (Instagram) shows only the TOP of the shot — a 4:5 canvas
 * can't hold a 19.5:9 phone screen, and the top is where the hero content is.
 *
 * `crop: {x,y,w,h}` (source px) frames an arbitrary region instead of the whole
 * screen. It exists for the iPad, where Memory/Universe/Graph present as centred
 * FORM SHEETS occupying only ~40% of a 2064×2752 screen — framing the full screen
 * there sells 60% empty black. `cropTop` is the degenerate top-only case and is
 * kept because the Android shots use nothing else.
 */
export function compositeSvg(p, id, { W, H, src, srcW, srcH, cropTop, crop, caption, mode, captionSize, padScale, bandScale }) {
  const pad = Math.round(W * 0.06 * (padScale ?? 1))
  const lines = caption.split('\n')
  // ⚠️ SHRINK-TO-FIT, and it is not optional. rsvg RENDERS text, it never measures
  // it, so a caption wider than the canvas is centred and then clipped at BOTH
  // edges — the script exits 0 and `pngSize` matches the spec exactly. A 58-char
  // iPad caption at the fixed 72px lost its first word and its last word that way,
  // and only reading the render showed it. The estimate is the same 0.56em-per-char
  // heuristic gen-multi-device.mjs uses (same font, same weight); it errs wide,
  // which is the safe direction. Keep `estWidth` and that script's copy in step.
  let capSize = captionSize || Math.round(W * 0.062)
  const capMaxW = W - pad * 2
  const widest = () => Math.max(...lines.map((l) => estWidth(l, capSize)))
  while (capSize > 12 && widest() > capMaxW) capSize -= 1
  const capTop = Math.round(H * (mode === 'inset' ? 0.085 : 0.055) * (bandScale ?? 1))
  const capBlock = capTop + lines.length * capSize * 1.22 + Math.round(H * 0.02)

  // The visible source region. A `crop` rect subsumes cropTop; without one the
  // region is the whole source minus the status bar.
  const reg = crop || { x: 0, y: cropTop, w: srcW, h: srcH - cropTop }
  const visW = reg.w
  const visH = reg.h
  // Reserve a bottom band for the brand mark, then SCALE TO FIT the remaining
  // box — scaling to width alone overflowed a 19.5:9 shot past the canvas by
  // ~70px, which clipped the frame's bottom edge and let the mark land on top
  // of the screenshot. Store mode fits the whole screen; inset mode (4:5) fills
  // the band and lets the clip take the bottom, since 4:5 can't hold 19.5:9.
  const bottomBand = Math.round(H * 0.075 * (bandScale ?? 1))
  const availH = H - capBlock - bottomBand
  const maxW = W - pad * 2
  // Inset (4:5) can only ever show the TOP slice of a 19.5:9 screen, so the
  // frame is deliberately NARROWER than the canvas: a full-width inset showed
  // only ~45% of the screen and guillotined the tagline mid-sentence. At 0.72
  // width it reaches ~62%, so the hero's orb + wordmark + tagline + chips all
  // land inside the slice.
  // ⚠️ The 0.72 only applies to a WHOLE-SCREEN inset, where the clip is doing the
  // cropping and a narrower frame is what buys more visible screen. Once a `crop`
  // rect names the region, the clip has nothing left to hide — so fit it like store
  // mode (scale to whichever of width/height binds) and it lands COMPLETE. Using
  // the 0.72 path with a crop clipped the region a second time: ig-voice cut the
  // phone off above the in-call strip, i.e. the entire subject of the caption "Call
  // it like a person" was missing from the card, which still rendered at a perfect
  // 1080×1350.
  const scale =
    mode === 'inset' && !crop ? (maxW * 0.72) / visW : Math.min(maxW / visW, availH / visH)
  const shotW = Math.round(visW * scale)
  const shotH = Math.round(Math.min(visH * scale, availH))
  const shotX = Math.round((W - shotW) / 2) // centre whatever the fit produced
  const shotY = capBlock
  const radius = Math.round(W * 0.035)

  // The <image> is drawn at full scaled size and offset so that the crop region's
  // top-left lands at the frame's top-left; the clipPath is what actually hides
  // the overflow. Cropping via the clip (not by editing pixels) keeps the source
  // files untouched.
  const imgW = srcW * scale
  const imgH = srcH * scale
  const imgX = shotX - reg.x * scale
  const imgY = shotY - reg.y * scale

  const defs = gradients(p, id)
    .replace('__X__', shotX)
    .replace('__Y__', shotY)
    .replace('__W__', shotW)
    .replace('__H__', shotH)
    .replace('__R__', radius)

  const capText = lines
    .map(
      (l, i) =>
        `  <text x="${W / 2}" y="${capTop + capSize + i * capSize * 1.22}" text-anchor="middle" font-family="${FONT}" font-size="${capSize}" font-weight="700" fill="#f4f4f4">${esc(l)}</text>`
    )
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- GENERATED by scripts/gen-store-composites.mjs — regenerate, don't hand-edit.
       Caption sits in the top band (Apple crops overlay text near the edges);
       the shot is clipped to rounded corners and the source status bar is
       cropped away (it carries the user's personal notification icons). -->
${defs}
  <rect width="${W}" height="${H}" fill="${p.bg}"/>
  <ellipse cx="${W / 2}" cy="${H * 0.22}" rx="${W * 0.9}" ry="${H * 0.4}" fill="url(#${id}-wash)"/>
${capText}
  <g clip-path="url(#${id}-clip)">
    <image xlink:href="data:image/png;base64,${src}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMin slice"/>
  </g>
  <rect x="${shotX}" y="${shotY}" width="${shotW}" height="${shotH}" rx="${radius}" fill="none" stroke="${p.accent}" stroke-opacity="0.28" stroke-width="3"/>
${markG(p, id, W / 2, H - Math.round(H * 0.028), Math.round(W * 0.062))}
</svg>
`
}

export const renderPng = (svgText, outPng, width) => {
  const tmp = mkdtempSync(join(tmpdir(), 'tiny-comp-'))
  try {
    const svgPath = join(tmp, 'in.svg')
    writeFileSync(svgPath, svgText)
    execFileSync('rsvg-convert', ['-w', String(width), '-o', outPng, svgPath], {
      maxBuffer: 1024 * 1024 * 256,
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** PNG IHDR read — no image lib needed, and it fails loudly on a non-PNG. */
export function pngSize(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${path}`)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const main = () => {
  const args = process.argv.slice(2)
  const accent = args.find((a) => a.startsWith('#')) || '#00FF88'
  const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]
  const p = derivePalette(accent)
  mkdirSync(OUT, { recursive: true })

  // ⚠️ --only FILTERS, it does not renumber. The index comes from the shot's
  // position in the FULL list, because the number prefix in the filename is the
  // upload order both consoles sort by. Deriving it from a loop counter over the
  // filtered list wrote `ipad-01-hero.png` for --only=hero — a second, wrongly
  // ordered copy of what is really ipad-05, sitting next to the correct file and
  // stealing slot 1 from the sidebar shot.
  const pick = (list) => (only ? list.filter((s) => s.id === only) : list)
  const shots = pick(SHOTS)
  const ipadShots = pick(IPAD_SHOTS)
  if (!shots.length && !ipadShots.length) throw new Error(`no shot matches --only=${only}`)

  // Outputs refused because their source raw is in BLOCKED_SOURCES. Collected rather than thrown
  // so the clean shots still regenerate; reported and exited non-zero at the bottom of main().
  const skipped = []

  for (const shot of shots) {
    const n = SHOTS.indexOf(shot) + 1
    const idx = String(n).padStart(2, '0')

    // Apple 6.9" — iOS source when we have one, else the Android capture
    // (the apps are visually near-identical; noted per shot in the copy docs).
    const appleSrc = shot.ios || shot.android
    // ⚠️ Non-fatal, unlike the carousel's gate: see blockedReason()'s docblock. A blocked raw
    // here means the recapture is pending, not that the shot list is wrong, so this skips ONE
    // output and lets the other six regenerate — then main() exits non-zero at the end.
    const appleBlock = blockedPendingReason(appleSrc, `apple-${idx}-${shot.id}`)
    if (appleBlock) skipped.push([`apple-${idx}-${shot.id}`, appleSrc, appleBlock])
    const applePath = join(RAW, appleSrc)
    if (!appleBlock && !existsSync(applePath)) throw new Error(`missing raw: ${appleSrc}`)
    const aSize = pngSize(applePath)
    // Only crop a status bar off ANDROID sources; the iOS sim shots already
    // have a clean overridden status bar (9:41, full battery, no notifications).
    const aCrop = shot.ios ? 0 : shot.statusBarPx
    if (!appleBlock) renderPng(
      compositeSvg(p, `a${n}`, {
        W: 1320,
        H: 2868,
        src: b64(applePath),
        srcW: aSize.w,
        srcH: aSize.h,
        cropTop: aCrop,
        caption: shot.caption,
      }),
      join(OUT, `apple-${idx}-${shot.id}.png`),
      1320
    )

    const playBlock = shot.android
      ? blockedPendingReason(shot.android, `play-${idx}-${shot.id}`)
      : null
    if (playBlock) skipped.push([`play-${idx}-${shot.id}`, shot.android, playBlock])
    if (shot.android && !playBlock) {
      const pPath = join(RAW, shot.android)
      if (!existsSync(pPath)) throw new Error(`missing raw: ${shot.android}`)
      const pSize = pngSize(pPath)
      // ⚠️ 1080×2160, NOT the Pixel's native 1080×2410. Play caps a phone
      // screenshot's aspect ratio at 2:1 and 2410/1080 = 2.231:1, so the native-size
      // canvas is REJECTED at upload — a whole set that looks perfect locally. 2160
      // is exactly 2:1 at this width. The shot inside is scale-to-fit, so the phone
      // screen is unchanged; only the surrounding canvas is shorter.
      renderPng(
        compositeSvg(p, `p${n}`, {
          W: 1080,
          H: 2160,
          src: b64(pPath),
          srcW: pSize.w,
          srcH: pSize.h,
          cropTop: shot.statusBarPx,
          caption: shot.caption,
        }),
        join(OUT, `play-${idx}-${shot.id}.png`),
        1080
      )
    }

    const igSrcMaybe = shot.ios || shot.android
    const igBlock = shot.ig ? blockedPendingReason(igSrcMaybe, `ig-${shot.id}`) : null
    if (igBlock) skipped.push([`ig-${shot.id}`, igSrcMaybe, igBlock])
    if (shot.ig && !igBlock) {
      const igSrc = igSrcMaybe
      const igPath = join(RAW, igSrc)
      const iSize = pngSize(igPath)
      renderPng(
        compositeSvg(p, `i${n}`, {
          W: 1080,
          H: 1350,
          src: b64(igPath),
          srcW: iSize.w,
          srcH: iSize.h,
          // ⚠️ `igCrop` exists because the default inset shows the TOP of the screen,
          // which is the wrong half for any shot whose subject sits at the BOTTOM.
          // Pass it when the caption is about something down there (see `voice`).
          crop: shot.igCrop,
          cropTop: shot.ios ? 0 : shot.statusBarPx,
          caption: shot.caption,
          mode: 'inset',
          captionSize: 72,
        }),
        join(OUT, `ig-${shot.id}.png`),
        1080
      )
    }
    // ⚠️ Name what was refused on the shot's OWN line. A bare `✓ 02 memory-graph` above a
    // summary at the bottom reads as "shot 2 is fine" — and shot 2 is precisely the one whose
    // Play cut renders the user's real fact graph. The per-item line is what people scan.
    const refusedHere = [appleBlock && 'apple', playBlock && 'play', igBlock && 'ig'].filter(Boolean)
    console.log(
      refusedHere.length
        ? `✓ ${idx} ${shot.id}  (🔴 refused: ${refusedHere.join(', ')})`
        : `✓ ${idx} ${shot.id}`
    )
  }

  // iPad 13" — a 4:3 canvas holding a 4:3 shot, so unlike the phone sets the
  // source very nearly fills it. Three things therefore differ from the phone
  // math, all passed in rather than derived from W (W*0.062 = a 128px caption
  // at 2064 wide, which would eat a third of the canvas):
  //   - captionSize is set absolutely (72px, ~2.6% of height)
  //   - padScale shrinks the side padding, since there's no aspect slack to spare
  //   - bandScale tightens the caption/brand bands for the same reason
  // Why the bands matter here and not on the phone: a 19.5:9 shot in a 19.5:9-ish
  // canvas is height-limited, so trimming a band buys nothing. A 4:3 shot in a
  // 4:3 canvas is limited by whatever the bands leave over, so the first version
  // (phone band values) rendered the iPad at 82% of canvas width with dead space
  // down both sides — correct, verified dimensions, and a weak-looking ad.
  for (const shot of ipadShots) {
    const m = IPAD_SHOTS.indexOf(shot) + 1 // full-list position, not a loop counter
    const idx = String(m).padStart(2, '0')
    const ipadBlock = blockedPendingReason(shot.ipad, `ipad-${idx}-${shot.id}`)
    if (ipadBlock) {
      skipped.push([`ipad-${idx}-${shot.id}`, shot.ipad, ipadBlock])
      continue
    }
    const path = join(RAW, shot.ipad)
    if (!existsSync(path)) throw new Error(`missing raw: ${shot.ipad}`)
    const size = pngSize(path)
    renderPng(
      compositeSvg(p, `t${m}`, {
        W: 2064,
        H: 2752,
        src: b64(path),
        srcW: size.w,
        srcH: size.h,
        cropTop: 0, // simulator status bar is already clean
        crop: shot.crop,
        caption: shot.caption,
        captionSize: 72,
        padScale: 0.3,
        bandScale: 0.62,
      }),
      join(OUT, `ipad-${idx}-${shot.id}.png`),
      2064
    )
    console.log(`✓ ipad ${idx} ${shot.id}`)
  }

  console.log(`\naccent ${accent} → ${OUT}`)

  // ⚠️ Non-zero exit, not a warning. A warning printed above 20 `✓` lines is invisible, and the
  // thing at stake is whether a PNG of the user's real memory graph reaches a store console.
  if (skipped.length) {
    console.error(`\n🔴 REFUSED ${skipped.length} output(s) — their source raw is BLOCKED:`)
    for (const [out, src, why] of skipped) console.error(`  ${out}  ←  ${src}\n      ${why}`)
    console.error(
      '\nThe rest of the set regenerated normally. These outputs were NOT rewritten, so any\n' +
        'previously-generated copy is still on disk and still unsafe — see the BLOCKED table in\n' +
        'store-assets/UPLOAD.md and `node scripts/sync-store-screenshots.mjs --check`.'
    )
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
