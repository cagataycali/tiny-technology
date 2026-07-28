#!/usr/bin/env node
/**
 * sync-store-screenshots.mjs — copy the generated composites into the two fastlane
 * trees, and FAIL LOUDLY when they're out of date.
 *
 * ## Why this exists
 *
 * `store-assets/final/` is generated; `fastlane/screenshots/en-US/` (Apple) and
 * `android/fastlane/metadata/android/en-US/images/` (Play) are what an upload lane
 * actually reads. Until now the second step was the sentence "then re-copy into the
 * two trees" in UPLOAD.md — a manual step whose failure is completely invisible,
 * because a stale PNG is still a valid PNG of the right size in the right place.
 *
 * That failure already happened, and it was the worst possible file. c28/c30 fixed a
 * privacy leak in the memory-graph shots (they rendered the signed-in user's own fact
 * graph: a named third party, a `FINANCIAL FLAG` fact, ~40 private repo names).
 * Regenerating updated `final/ipad-03-memory-graph.png` — and left the **leaking**
 * copy sitting in `fastlane/screenshots/en-US/`, which is the copy that would have
 * been uploaded. An md5 census caught it; nothing else would have.
 *
 * So the sync is code now, and `--check` is the assertion. A screenshot pipeline whose
 * last mile is a human remembering to `cp` will ship a stale asset eventually, and the
 * stale one is disproportionately likely to be the one that was just fixed for cause.
 *
 * ## Usage
 *
 *   node scripts/sync-store-screenshots.mjs           # copy what differs, report it
 *   node scripts/sync-store-screenshots.mjs --check   # exit 1 if anything differs
 *
 * `--check` is the CI/pre-upload form: it writes nothing and names every drifted file.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
// ⚠️ Imported, not transcribed. See the BLOCKED docblock below — a hand-copied version of these
// two lists is what let a known-leaking Play shot sit in the upload tree.
import { blockedOutputs, WRIST_SHOTS } from './gen-store-composites.mjs'
import { blockedSlides } from './gen-social-carousels.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const FINAL = join(ROOT, 'store-assets/final')

/**
 * Which finals belong in which tree, and under what name.
 *
 * Apple's `deliver` reads one flat directory per locale and infers the device from
 * the image DIMENSIONS, not the filename — so iPhone (1320×2868) and iPad
 * (2064×2752) shots coexist in `en-US/` and keep their `apple-`/`ipad-` prefixes.
 * The prefix is for humans; the pixels are what routes them.
 *
 * Play's `supply` is the opposite: the DIRECTORY names the form factor
 * (phoneScreenshots / tenInchScreenshots / wearScreenshots), so the same file can
 * only ever mean one thing.
 *
 * ⚠️ Deliberately NOT synced: anything not in a store set. `ig-*` and `social-*` and
 * the videos are social/marketing assets. Copying "everything" into a metadata tree is
 * how an asset gets uploaded to a slot nobody inspected.
 *
 * ⚠️ c48 — this docblock used to add `play-feature-graphic-*` to that not-synced list, "because it
 * lives in a different Play slot entirely". A different slot is a reason to give it a DIFFERENT
 * DESTINATION, never a reason to have no owner: `images/featureGraphic.png` was already sitting in
 * the tree, hand-copied at `5371a983`, matching `final/` today **by luck**. It was outside `MAP` (so
 * no md5 comparison), and `images/` itself was outside the orphan scan (which listed only
 * `phoneScreenshots`/`wearScreenshots`) — so the file was exempt from every check this script
 * performs, and a re-run of `gen-store-graphics.mjs` would have left the tree on the old art
 * silently. That is the c30 leak's exact shape, and c43's "exempt from one check becomes absent from
 * every check" one level up: there the exemption was per-FILE, here a whole DIRECTORY was unscanned.
 * Both root-slot images are now owned entries, and `PLAY_IMAGES` is scanned for orphans.
 */
const APPLE_DIR = 'fastlane/screenshots/en-US'
const PLAY_IMAGES = 'android/fastlane/metadata/android/en-US/images'
const PLAY_PHONE = `${PLAY_IMAGES}/phoneScreenshots`
const PLAY_WEAR = `${PLAY_IMAGES}/wearScreenshots`

const MAP = [
  // Apple iPhone 6.9"
  ...['01-hero', '02-memory-graph', '03-universe', '04-voice', '05-devices', '06-tools', '07-memory']
    .map((s) => [`apple-${s}.png`, `${APPLE_DIR}/apple-${s}.png`]),
  // Apple iPad 13" — REQUIRED set if the app is iPad-compatible, and the set whose
  // memory-graph shot was the stale leak that motivated this script.
  ...['01-sidebar', '02-map', '03-memory-graph', '04-universe', '05-hero', '06-memory']
    .map((s) => [`ipad-${s}.png`, `${APPLE_DIR}/ipad-${s}.png`]),
  // Play phone
  ...['01-hero', '02-memory-graph', '03-universe', '04-voice', '05-devices', '06-tools', '07-memory']
    .map((s) => [`play-${s}.png`, `${PLAY_PHONE}/play-${s}.png`]),
  // Play's two root-slot graphics. Not screenshots, but `supply` reads them from this tree by
  // these exact names, so they need owners here for the same reason every shot does. The hi-res
  // icon is REQUIRED for a listing and did not exist anywhere until c48.
  ['play-feature-graphic-1024x500.png', `${PLAY_IMAGES}/featureGraphic.png`],
  ['play-icon-512.png', `${PLAY_IMAGES}/icon.png`],
]

/**
 * Assets KNOWN to be unsafe to publish, with the reason. `--check` fails while any
 * of these exists, because drift and safety are independent and this script only
 * ever measured drift.
 *
 * Why not a scan: "does this PNG show private data" is a content question no md5 can
 * answer, and the c30 lesson was that a green consistency check reads as clearance.
 * Two identical copies of a leaking file are perfectly in sync.
 *
 * ⚠️ c40: this used to be a HAND-WRITTEN array of output filenames, and that was two copies of
 * one truth — a source-side `BLOCKED_SOURCES` map in the generators, and this list of the outputs
 * built from it, with nothing joining them. The consequence was live: `android/raw/c4-devices.png`
 * had been documented as showing the user's whole device fleet by hostname since the c28 audit, and
 * `play-05-devices.png` was still sitting in the Play upload tree while this very check reported
 * "20 up to date, 0 drifted" and flagged one unrelated asset. Nobody had transcribed the fact.
 *
 * So the list is now DERIVED from the generators' own shot lists. Adding one `BLOCKED_SOURCES`
 * entry blocks every output built from it — both store platforms, the IG cut, and the carousel
 * slides — without a second edit anyone can forget.
 *
 * To clear an entry: RE-CAPTURE the raw and re-read its pixels, then remove it from
 * `BLOCKED_SOURCES`. Never edit a list to get green.
 *
 * ⚠️ c42: the list was right and it was being applied to the WRONG DIRECTORY. Every use below
 * looked only in `store-assets/final/` — but `final/` is the generated staging area, and the files
 * an upload lane actually reads are the COPIES in the two fastlane trees. Two consequences, both
 * probed and reproduced before this fix:
 *
 *   1. Deleting the leaking `final/play-05-devices.png` — which is what "re-capture and regenerate"
 *      reads like, and what a `git clean` of a generated directory does anyway — dropped it from
 *      `DO NOT UPLOAD` entirely. `--check` still exited 1, but for `MISSING SOURCE` (a drift
 *      complaint that says "run gen-store-composites.mjs"), while the identical leaking PNG sat
 *      untouched in `phoneScreenshots/` where `supply` would read it.
 *   2. A plain sync would COPY a known-unsafe asset INTO the upload tree and report it as work
 *      done — `→ ABSENT → synced …/play-05-devices.png` — three lines above its own
 *      `🔴 DO NOT UPLOAD` for the same file. The gate warned and the same run did the thing.
 *
 * So blocked-ness is now checked at every LOCATION a blocked output can exist (see
 * `blockedLocations()`), and the copy loop REFUSES a blocked asset instead of writing it.
 */
const BLOCKED = [...blockedOutputs(), ...blockedSlides()]
const BLOCKED_NAMES = new Set(BLOCKED.map(([name]) => name))

/**
 * Every video encode, with the geometry its checker needs. `--check` re-runs
 * `store-assets/scripts/check-video-graph-beat.py` over all of them so a video's verdict is
 * always recomputed from the delivered bytes: an asset can be re-encoded from a stale raw at
 * any time, and the only thing that would notice is a check that keeps looking.
 *
 * ⚠️⚠️ **This list was called `CLEARED_VIDEOS` for 21 cycles, and c54 found that the NAME was
 * itself the defect.** The evidence it carried was real and remains true — c33 re-recorded the
 * two iPad encodes with `--session-harness --graph-dataset-harness` and matched 23/23 graph
 * frames against a committed footer reference; c37 did the same for the iPhone raw, 18/18. Both
 * measurements are still reproducible today. But every one of them was **about the memory GRAPH
 * sheet**, and the cut visits two account-data sheets. Three to eight seconds of all four
 * encodes is the memory LIST — the signed-in account's real learnings, at full legibility, with
 * a private repo name in the first line.
 *
 * 🔑 **A list named for a conclusion outlives the evidence that earned it.** "CLEARED" is a
 * claim about a FILE; what c33/c37 established was a fact about a BEAT. Naming the list after
 * the conclusion is what let a partial verification read as a whole-file clearance for 21
 * cycles — and it is why the honest fix is not to move four entries into `BLOCKED` (which is
 * hand-maintained, and would leave the next video to inherit the same word). The list says
 * only which videos get CHECKED; the checker says what they are.
 *
 * Where clearance is recorded instead: the checker's own per-beat verdict, printed on every
 * run and reaching the exit status. All four encodes currently FAIL it on the `memory` beat.
 * They stay listed here rather than moving to `BLOCKED` precisely so the failure is recomputed
 * from pixels each time rather than asserted by a human who read a docblock.
 */
const CHECKED_VIDEOS = [
  ['apple-app-preview-ipad-1200x1600.mp4', 'ipad'],
  ['ipad-preview-1920x1080.mp4', 'wide'],
  // The Reel shares the App Store cut's 886-wide scale chain on purpose — see the `reel`
  // geometry note in the checker. A wrong geometry here does not fail loudly; it makes the
  // checker crop the wrong rects and stop finding the beat.
  ['apple-app-preview-iphone-886x1920.mp4', 'iphone'],
  ['social-reel-1080x1920.mp4', 'reel'],
]

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')
const check = process.argv.includes('--check')

let drifted = 0
let missing = 0
let copied = 0
let same = 0

/**
 * Every path a blocked output could be sitting at, as `[name, absPath, whereLabel]`.
 *
 * `final/` is the staging copy; the fastlane paths are the ones an upload reads. Deriving the
 * destinations from `MAP` rather than listing them keeps this honest when a shot moves trees — the
 * c40 lesson applied one level down: the blocked NAMES were derived and the LOCATIONS were not.
 *
 * ⚠️ Not every blocked output has a MAP entry, and that is correct: `ig-*` slides are social assets
 * that no store tree owns. They are still reported from `final/`, which is where a human attaches
 * them from.
 */
function blockedLocations(name) {
  const at = [[join(FINAL, name), `store-assets/final/${name}`]]
  for (const [srcName, destRel] of MAP) {
    if (srcName === name) at.push([join(ROOT, destRel), destRel])
  }
  // ⚠️ The wrist shots are hand-copied from their raws into the trees and pass through `MAP` not at
  // all, so a MAP-only derivation cannot see them (c43). Declared in `WRIST_SHOTS` for exactly this.
  for (const w of Object.values(WRIST_SHOTS)) {
    if (w.out.split('/').pop() === name) at.push([join(ROOT, w.out), w.out])
  }
  return at
}

for (const [srcName, destRel] of MAP) {
  const src = join(FINAL, srcName)
  const dest = join(ROOT, destRel)
  // ⚠️ Refuse BEFORE the drift comparison, and refuse whether or not `--check` was passed. A plain
  // sync used to copy a blocked asset into the upload tree and print `→ ABSENT → synced` for it,
  // three lines above its own DO-NOT-UPLOAD warning for the same file (c42). A gate that warns
  // while the same run performs the act it is warning about is not a gate.
  //
  // This does NOT count as drift: the trees legitimately differ from `final/` for this file until a
  // recapture lands, and calling that drift would tell people to fix it by syncing — the exact
  // thing being refused. The DO-NOT-UPLOAD pass below is what makes the run exit non-zero.
  //
  // ⚠️ Only speak when there is something to refuse. A first version keyed on the NAME alone and
  // printed a refusal for a blocked asset that existed in neither tree — pointing at a
  // "DO NOT UPLOAD below" that then did not print, because that pass is correctly keyed on
  // existence. A gate that cries wolf about a file nobody has is how people learn to skim its
  // output. The `continue` is unconditional either way: `BLOCKED_NAMES` is never synced.
  if (BLOCKED_NAMES.has(srcName)) {
    if (existsSync(src) || existsSync(dest)) {
      console.error(`  ⛔ REFUSED TO SYNC  ${destRel} — blocked source; see DO NOT UPLOAD below`)
    }
    continue
  }
  if (!existsSync(src)) {
    console.error(`  ✗ MISSING SOURCE  ${srcName} — run gen-store-composites.mjs`)
    missing++
    continue
  }
  const destExists = existsSync(dest)
  if (destExists && md5(src) === md5(dest)) {
    same++
    continue
  }
  drifted++
  const why = destExists ? 'STALE' : 'ABSENT'
  if (check) {
    console.error(`  ✗ ${why}  ${destRel}  (differs from final/${srcName})`)
  } else {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src))
    console.log(`  → ${why} → synced  ${destRel}`)
    copied++
  }
}

// Anything in a tree that ISN'T owned is an orphan: a file no generator owns, which is precisely
// the shape of the bug this script exists to prevent.
//
// ⚠️ c43: the wrist shots used to be exempted by FILENAME PREFIX, and that exemption was doing far
// more than it looked like. `watch-01-chat.png` and `wear-01-chat.png` are hand-copied from their
// raws (md5-identical, no crop) — so they are absent from `final/`, absent from `MAP`, skipped here
// by name, and `wearScreenshots/` was not even in the scanned directory list. Blocking BOTH wrist
// raws in `BLOCKED_SOURCES` was probed and changed nothing at all: `blockedOutputs()` returned the
// same two names and this script printed nothing about either file. Four exemptions, no owner.
//
// They are still exempt from the DRIFT comparison — correctly, since no `final/` copy exists to
// compare against — but they now have an owner (`WRIST_SHOTS`) and are verified against their RAW
// below instead. Exempt from one check must never mean absent from all of them.
const owned = new Set(MAP.map(([, d]) => d))
for (const w of Object.values(WRIST_SHOTS)) owned.add(w.out)
// ⚠️ c48: `PLAY_IMAGES` (the root slot holding featureGraphic.png / icon.png) was missing from this
// list, so the orphan pass never even read the directory. An unscanned DIRECTORY is a larger hole
// than an exempted file, and it looked complete because the two subdirectories under it were listed.
for (const dir of [APPLE_DIR, PLAY_IMAGES, PLAY_PHONE, PLAY_WEAR]) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) continue
  for (const f of readdirSync(abs, { withFileTypes: true })) {
    if (f.isDirectory()) continue // phoneScreenshots/ etc. are scanned as their own entries
    if (!f.name.endsWith('.png')) continue
    if (!owned.has(`${dir}/${f.name}`)) {
      console.error(`  ! ORPHAN  ${dir}/${f.name} — nothing declares or regenerates it`)
      drifted++
    }
  }
}

// The wrist shots' integrity check. They have no `final/` copy, so "does the tree match staging"
// cannot be asked of them; what CAN be asked is whether the tree copy still matches the raw a
// capture wrote, and whether it is still the size the store routes on. Apple's `deliver` picks the
// device family from the image DIMENSIONS, so a wrist PNG of the wrong size does not fail — it
// routes somewhere else, or gets rejected long after upload.
let wrist = 0
let wristOk = 0
for (const [key, w] of Object.entries(WRIST_SHOTS)) {
  const out = join(ROOT, w.out)
  const raw = join(ROOT, 'store-assets', w.raw)
  // ⚠️ A blocked wrist shot is NOT "verified against its raw", and saying so would be the worst
  // possible line to print next to a DO-NOT-UPLOAD for the same file: matching a leaking raw exactly
  // is what makes it unsafe, not what makes it safe. The DO-NOT-UPLOAD pass owns those two.
  if (BLOCKED_NAMES.has(w.out.split('/').pop())) continue
  if (!existsSync(out)) {
    console.error(`  ✗ MISSING WRIST SET  ${w.out} — ${w.label}; see UPLOAD.md "Both wrists are wired"`)
    wrist++
    continue
  }
  if (!existsSync(raw)) {
    console.error(`  ! UNVERIFIABLE  ${w.out} — its raw ${w.raw} is gone, so nothing can re-derive it`)
    wrist++
    continue
  }
  if (md5(out) !== md5(raw)) {
    console.error(
      `  ✗ WRIST DRIFT  ${w.out} differs from store-assets/${w.raw} — the tree copy is a plain` +
        ` copy of the raw, so a difference means one of them was edited by hand. Re-copy, or if the` +
        ` raw was recaptured, re-read its pixels first.`,
    )
    wrist++
    continue
  }
  const dims = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out], { encoding: 'utf8' })
  const got = [...(dims.stdout || '').matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]))
  if (got.length === 2 && (got[0] !== w.dims[0] || got[1] !== w.dims[1])) {
    console.error(
      `  ✗ WRIST GEOMETRY  ${w.out} is ${got.join('×')}, expected ${w.dims.join('×')} (${key}).` +
        ' Apple routes by dimensions, not filename — a wrong-sized wrist shot is not a failed upload.',
    )
    wrist++
    continue
  }
  wristOk++
}

// Safety gate, independent of drift. Reported even on a plain sync run so the
// warning is in front of whoever is about to open the console.
let blocked = 0
for (const [name, why] of BLOCKED) {
  // ⚠️ Every location, not just `final/`. Deleting the staging copy used to make the whole warning
  // vanish while the identical file stayed in the Play tree (c42) — and deleting a generated file
  // is the ordinary reaction to being told to re-capture it.
  const at = blockedLocations(name).filter(([abs]) => existsSync(abs))
  if (!at.length) continue
  for (const [, label] of at) console.error(`  🔴 DO NOT UPLOAD  ${label} — ${why}`)
  // Count the ASSET once however many copies exist: the summary line is about how many unsafe
  // things are on disk, and inflating it by copy count makes the number mean nothing.
  blocked++
  // Say it explicitly when the staging copy is gone but an upload-tree copy is not. Otherwise the
  // list reads like the file is merely still staged, when in fact it is in the directory `deliver`
  // and `supply` read — and regenerating `final/` will not remove it.
  //
  // ⚠️ Not for the wrist shots: they were NEVER in `final/`, so "not in final/ any more" is a false
  // history and "regenerating will not remove them" points at a regeneration that does not exist for
  // them. A hint that misdescribes the situation is worse than none — it is the one thing a hurried
  // reader will act on. Their own remedy is the capture recipe (c43).
  const isWrist = Object.values(WRIST_SHOTS).some((w) => w.out.split('/').pop() === name)
  if (isWrist) {
    console.error(
      `     ↑ ${name} is a WRIST shot: hand-copied from its raw, never in store-assets/final/, so no` +
        ' regeneration touches it. Delete the tree copy, then re-capture per UPLOAD.md.',
    )
  } else if (!existsSync(join(FINAL, name)) && at.length) {
    console.error(
      `     ↑ ${name} is NOT in store-assets/final/ any more, but the copies above are what an` +
        ' upload reads. Regenerating will not remove them — delete them, or land the recapture.',
    )
  }
}

// Re-verify every video from its delivered bytes. Only under --check: it decodes the whole
// encode per file, which is too slow for the sync people run casually, and the blocked-asset
// warnings above already cover the unsafe stills on every run.
//
// ⚠️ The checker's verdict is per BEAT and it prints which one failed — do not paraphrase it
// here. This message used to say "the graph beat no longer matches the clean reference", which
// was a guess about WHY the exit code was non-zero, and c54's actual failure is a different beat
// with no reference at all. A gate that narrates a cause it did not measure teaches people to
// fix the wrong thing; forward the tool's own output and let it speak.
let unsafeVideos = 0
if (check) {
  for (const [name, geometry] of CHECKED_VIDEOS) {
    const abs = join(FINAL, name)
    if (!existsSync(abs)) continue
    const r = spawnSync('python3', [
      join(ROOT, 'store-assets/scripts/check-video-graph-beat.py'), abs, '--geometry', geometry,
    ], { encoding: 'utf8' })
    if (r.status !== 0) {
      console.error(`  🔴 UNSAFE VIDEO  ${name} — NOT CLEARED, do not upload. The checker's verdict:\n${
        ((r.stdout || '') + (r.stderr || '')).split('\n').map((l) => `     ${l}`).join('\n')}`)
      unsafeVideos++
    }
  }
}

console.log(
  `\n${check ? 'checked' : 'synced'}: ${same} up to date, ${drifted} drifted${
    check ? '' : `, ${copied} copied`
  }${missing ? `, ${missing} missing sources` : ''}`,
)
if (existsSync(join(ROOT, PLAY_WEAR))) {
  // ⚠️ Was `(wearScreenshots left alone — …)`, which was true and read as clearance: it was the ONLY
  // line either wrist shot produced, and it appeared whether the file was verified, stale, or a
  // hand-edited leak. Say what was actually checked (c43).
  console.log(
    wrist
      ? `(wrist sets: ${wrist} problem(s) above — not synced from final/, verified against their raws)`
      : `(wrist sets: ${wristOk} verified against their raws + expected dimensions)`,
  )
}

if (check && (drifted || missing || blocked || unsafeVideos || wrist)) {
  if (drifted || missing) {
    console.error(
      '\nFAIL: an upload from this tree would ship assets that do not match store-assets/final.',
    )
  }
  if (unsafeVideos) {
    console.error(
      // ⚠️ "these encodes" is the WHOLE remaining set, and this line used to explain the hold as
      // if that set were fixed at four. c59 re-recorded the iPhone pair under the harness and it
      // cleared, so the sentence now describes only what is still held — the count above is read
      // from the run, and the reason is stated per video in the verdicts it points at.
      // 🔑 **A summary that explains WHY on behalf of a set will be wrong the moment the set
      // shrinks**; point at the per-item verdicts instead of restating them.
      `FAIL: ${unsafeVideos} video(s) are NOT CLEARED by their per-beat safety check — read each` +
        ' verdict above, it names the beat and the reason. 🔴 means unverified, which is not the' +
        ' same as proven dirty: an encode recorded before a beat had a harness has no clean' +
        ' reference it could be matched against, and the check will not pretend to clear it. The' +
        ' fix is a RE-RECORD with the harness flags, then a committed reference crop for that' +
        " geometry — not a flag flip: a harness makes the next capture checkable, it does not" +
        ' clean the last one. A video is never permanently safe either — a beat can be re-encoded' +
        ' from a stale raw, and a beat nobody had looked at yet can be discovered at any time (c54' +
        ' found the memory LIST sheet in all four encodes after 21 cycles of verifying only the' +
        ' graph).',
    )
  }
  if (wrist) {
    console.error(
      `FAIL: ${wrist} problem(s) with the wrist sets. Apple requires a screenshot set per device` +
        " family and Play won't show the Wear tab without one, so a missing wrist shot is a blocked" +
        ' submission, not a cosmetic gap.',
    )
  }
  if (blocked) {
    console.error(
      `FAIL: ${blocked} asset(s) are known-unsafe to publish. Consistency is not safety — a` +
        ' leaking file syncs perfectly. Re-capture, re-read the pixels, then remove the' +
        ' BLOCKED entry.',
    )
  }
  process.exit(1)
}
