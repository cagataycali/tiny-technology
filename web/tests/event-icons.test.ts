// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { iconFor, EMITTED_KINDS, KIND_ICONS } from '../lib/chat/event-icons'
import { EVENT_ICONS } from '../lib/chat/prompt'

const source = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/**
 * Pins iconFor() against the event kinds the worker actually emits
 * (worker/src/*.ts). The regression this guards: the icon map
 * keyed `visit` but the only visit kind is `tiny_visit`, and
 * "tiny_visit".startsWith("visit") is false — so the reserved 👀 icon was dead
 * and every page-visit row fell through to the generic ⚡ fallback.
 */
describe('iconFor', () => {
  it('tiny_visit → 👀 (the regression: was ⚡ when keyed as "visit")', () => {
    expect(iconFor('tiny_visit')).toBe('👀')
  })

  it('prefix matches for the multi-suffix kinds', () => {
    expect(iconFor('job_result')).toBe('⏰')
    expect(iconFor('job_error')).toBe('⏰')
    expect(iconFor('telegram')).toBe('✈️')
    expect(iconFor('telegram_out')).toBe('✈️')
    expect(iconFor('telegram_button')).toBe('✈️')
  })

  it('exact-match kinds', () => {
    expect(iconFor('follow')).toBe('🤝')
    expect(iconFor('dm')).toBe('💬')
  })

  it('unknown kind → ⚡ fallback', () => {
    expect(iconFor('mystery')).toBe('⚡')
    expect(iconFor('')).toBe('⚡')
  })

  /**
   * ⚠️ THE GAP THIS PINS. ⚡ is the right answer for a kind a newer worker
   * invented and the wrong answer for one we ship — and the two render
   * IDENTICALLY, so nothing failed while `pay_alarm` ("🚨 x402 reconciliation
   * needs a human", swept every minute) drew the same glyph as a corrupt event
   * on all three human HUDs. The fallback is unchanged; the ROSTER is what makes
   * a missing glyph fail instead of ship.
   */
  it('EVERY kind the worker emits has a real glyph, not the unknown fallback', () => {
    for (const kind of EMITTED_KINDS) {
      expect(iconFor(kind), `${kind} falls through to ⚡ — add a KIND_ICONS entry`)
        .not.toBe('⚡')
    }
  })

  it('pay_alarm is 🚨 and nothing else is — the loudest event needs its own glyph', () => {
    // Distinctness is the requirement, not the emoji: a reconciliation page that
    // shares a glyph with page views is a page nobody reads.
    expect(iconFor('pay_alarm')).toBe('🚨')
    const others = EMITTED_KINDS.filter((k) => k !== 'pay_alarm').map(iconFor)
    expect(others, 'another kind also renders 🚨').not.toContain('🚨')
  })

  it('every key is a prefix of something real, or a declared reserve', () => {
    // The tiny_visit bug generalised: a key that matches no emitted kind is dead
    // code that reads as coverage. share/learn/push are documented reserves.
    const RESERVES = ['share', 'learn', 'push']
    for (const key of Object.keys(KIND_ICONS)) {
      if (RESERVES.includes(key)) continue
      expect(
        EMITTED_KINDS.some((k) => k.startsWith(key)),
        `KIND_ICONS key "${key}" matches no emitted kind — dead glyph (the tiny_visit bug)`,
      ).toBe(true)
    }
  })

  /**
   * 🎙️ THE DEVICE KINDS, READ FROM THE WORKER'S OWN ALLOWLIST rather than
   * hand-copied — because hand-copying is exactly what failed.
   *
   * The roster above is maintained by grepping `emitEvent(` in the worker, and
   * that grep cannot see a family whose emit sites are in the PHONES:
   * `DEVICE_EVENT_KINDS` (devices.ts) is the allowlist for POST /devices/event,
   * written by NiclaVoiceGateway (`nicla_wake`) and NiclaRecorder
   * (`device_note`) on iOS and their Kotlin twins — plus `nicla_transcript`,
   * which transcripts.ts emits on every stored take. All four were absent from
   * EMITTED_KINDS, so the roster test passed at full green while three of them
   * rendered ⚡ on every HUD and ℹ in the agent's prompt.
   *
   * This is the pay_alarm bug again, on the path that matters most: a transcript
   * is SPEECH THE USER SAID, arriving in the "mention anything relevant" block
   * wearing the glyph of a corrupt event. A guard whose input list is hand-kept
   * cannot catch a family nobody remembered to list — so this reads the worker's
   * constant and lets the ALLOWLIST be the roster's source of truth.
   */
  it('the worker\'s device-event allowlist is fully covered by the roster', () => {
    const m = source('worker/src/devices.ts')
      .match(/DEVICE_EVENT_KINDS = \[([^\]]+)\]/)
    expect(m, 'DEVICE_EVENT_KINDS moved — this test can no longer see the allowlist').not.toBeNull()
    const kinds = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
    expect(kinds.length, 'parsed no kinds — the regex stopped matching').toBeGreaterThanOrEqual(4)
    for (const kind of kinds) {
      expect(EMITTED_KINDS as readonly string[],
        `a device can emit "${kind}" but the icon roster never heard of it`).toContain(kind)
      expect(iconFor(kind), `${kind} renders the unknown-kind ⚡`).not.toBe('⚡')
      expect(EVENT_ICONS[kind], `${kind} has no prompt glyph — reaches the agent as ℹ`).toBeTruthy()
    }
  })

  /**
   * The voice kinds say three DIFFERENT things and must not collapse into one
   * glyph: "the necklace heard its name", "here is what was said", "the camera
   * saw motion". The agent's next sentence differs for each, and so does the
   * user's reason to look at the row.
   *
   * `device_note` is the one that was actively wrong rather than merely absent.
   * It is NiclaRecorder's fallback rail (NiclaRecorder.swift postToServer) for
   * when /api/devices/transcript does not answer, so it carries real transcript
   * text, and the `device` PREFIX key silently rendered it 💻, the glyph for
   * "your laptop finished a task". Not a missing glyph: a confidently wrong one.
   *
   * ⚠️ This rationale said the route "isn't deployed — which is the state
   * production is in", and that was stale. Probed 2026-08-02: the POST answers
   * 401 `unknown device`, the worker's device-auth SQL declining an unenrolled
   * probe, which cannot be reached unless the route is live. The ASSERTIONS below
   * are unaffected and are why this correction is a comment rather than a deleted
   * test: the rail still exists for a failed POST, and a rail that carries the
   * user's own words must never render as a finished laptop task. 🔑 A test whose
   * stated reason has expired keeps passing, and the next reader inherits the
   * expired reason as fact — which is how "production has no transcript store"
   * survived into three files.
   */
  it('each voice kind is distinguishable from the others and from a page view', () => {
    const kinds = ['nicla_wake', 'nicla_transcript', 'nicla_sentry', 'device_note']
    for (const k of kinds) {
      expect(iconFor(k), `${k} renders ⚡ on the HUD`).not.toBe('⚡')
      expect(iconFor(k), `${k} shares the page-view glyph`).not.toBe(iconFor('tiny_visit'))
      expect(EVENT_ICONS[k], `${k} shares the page-view glyph in the prompt`)
        .not.toBe(EVENT_ICONS['tiny_visit'])
    }
    expect(new Set(kinds.map(iconFor)).size, 'two voice kinds share a HUD glyph').toBe(4)
    // device_note carries transcript text on the undeployed-route fallback rail,
    // so it must not read as the laptop-task glyph it inherited from `device`.
    expect(iconFor('device_note'), 'device_note still inherits 💻 from the `device` prefix')
      .not.toBe(iconFor('device_result'))
  })

  /**
   * FOUR surfaces render this ring, and three of them keep their own copy of the
   * table. iOS Activity.swift had already picked 🗣️/🎙️/👁️ for the nicla kinds —
   * and its own `emittedKinds` mirror still omitted them, so the parity pin it
   * exists to enforce could never fire. A glyph on one client and ⚡ on the rest
   * is drift that ships.
   */
  it.each([
    ['ios/Tiny/Sources/Activity.swift'],
    ['android/app/src/main/java/technology/tiny/app/ui/Activity.kt'],
    ['lib/chat/prompt.ts'],
  ])('%s knows the voice kinds', (file) => {
    const src = source(file)
    for (const kind of ['nicla_wake', 'nicla_transcript', 'nicla_sentry', 'device_note']) {
      expect(src, `${file} has no entry for ${kind}`).toContain(kind)
    }
  })

  /**
   * ⚠️ THE STALE-FACT PIN, and the only reason it can exist is that the claim was
   * written as an assertion about PRODUCTION rather than about the code.
   *
   * "while /api/devices/transcript is undeployed (the current production state)"
   * appeared in `prompt.ts`, in this file's own rationale above, and twice in
   * `NiclaRecorder.swift` — four readers deep, all sourced from one comment nobody
   * re-probed. It answers 401 `unknown device` (the worker's device-auth SQL), so
   * the route is live and every one of those sentences was wrong.
   *
   * A comment cannot be tested for truth. What it CAN be tested for is the shape
   * that let this spread: a claim about what production is RUNNING, carried in a
   * file with no evidence in it. So the rule is per-FILE — mention the route and
   * whether it is deployed, and that file must also carry the probe.
   *
   * ⚠️ Two shapes I tried first, both wrong, both instructive:
   *   1. Ban the phrasing. It failed on the three files that FIXED the problem,
   *      because a correction has to quote the sentence it retires — and on this
   *      file, whose own regex literal matched itself. A source-scanning pin that
   *      forbids words cannot live in the tree it scans.
   *   2. Require the probe within ~500 chars of each hit. That fails a legitimate
   *      cross-reference: `postToServer`'s doc comment says "see the file header",
   *      700 lines from the evidence, which is the right way to write it.
   *   3. Match `Probed 2026-08-02` as contiguous text. It failed on the Swift
   *      header, where the date had WRAPPED onto the next line as `probed\n * 2026
   *      -08-02` — so the evidence was there and the pin said it wasn't. Any
   *      source-scanning regex that spans more than a couple of words has to allow
   *      for comment leaders (`*`, `//`, `#`) and newlines between them.
   *
   * 🔑 The bug is not that the fact expired. It is that four files stated it in a
   * form that could never expire visibly — so the invariant is evidence-per-file,
   * not wording.
   */
  it.each([
    ['lib/chat/prompt.ts'],
    ['ios/Tiny/Sources/NiclaRecorder.swift'],
    ['tests/event-icons.test.ts'],
  ])('%s carries the probe if it claims anything about the transcript route', (file) => {
    const src = source(file)
    // Blind-extractor guard: all three of these files discuss this route today.
    // A zero means the discussion moved and this pin is scanning for nothing —
    // which is precisely how the original comment survived four readings.
    expect(src, `${file} no longer mentions /api/devices/transcript — re-anchor this ` +
      `pin on wherever the claim moved rather than leaving it to pass vacuously`)
      .toContain('/api/devices/transcript')

    // Deployment vocabulary: a claim about STATE. "if that POST fails" is a
    // condition, makes no claim about production, and is deliberately not matched.
    const claims = src.match(/\b(un)?deployed\b|current production state/gi) || []
    if (!claims.length) return

    // `[\s*/#]*` between the word and the date: a wrapped comment puts a newline
    // and a leader in the middle of the evidence (see note 3 above).
    expect(src, `${file} says "${claims[0]}" about /api/devices/transcript and carries ` +
      `no probe date. An undated deployment claim is what went stale here: this exact ` +
      `sentence was false for as long as it existed and was copied into three other ` +
      `files as production fact. Write what you observed ("Probed YYYY-MM-DD: POST … ` +
      `answers 401 unknown device"), or point at the file that did.`)
      .toMatch(/[Pp]robed[\s*/#]*20\d\d-\d\d-\d\d|see the file header/)
  })

  /**
   * ⚠️⚠️ THE ROSTER IS THE GUARD'S INPUT, NOT THE ROW'S GLYPH — and that is why a
   * kind can be missing from two of the three rosters while every surface renders
   * it perfectly and every test passes.
   *
   * `device_task_result` (relay.ts RelayTaskResultCall — a daemon's use_tasks
   * completion, the delivery half of "trigger and forget on the Mac") joined the
   * WEB roster in 2ae89508 and neither phone's. Measured before this pin existed:
   * web 22 kinds, iOS 21, Android 21, the difference exactly that one kind. The
   * three KIND_ICONS tables were byte-identical the whole time.
   *
   * 🔑 Why nothing caught it, in the commit's own words: "the 💻 prefix key renders
   * it with zero new glyph code." True, and that is the trap. On web the roster is
   * consumed by `iconFor`'s callers AND the pins; on the phones it is consumed by
   * NOTHING but the pins — `emittedKinds`/`EMITTED_KINDS` appear only in
   * TinyTests.swift and ActivityAgoTest.kt. So on the two surfaces where the entry
   * is purely a guard, adding it looked like paperwork with no visible effect,
   * which is precisely when it gets skipped. The row kept drawing 💻; the guard
   * just stopped covering it.
   *
   * ⚠️ AND PHONE-TO-PHONE PARITY IS BLIND TO IT: iOS and Android were 21 and 21,
   * equal to each other and both wrong. Compare each surface to the ROSTER THAT
   * LEADS, never the followers to each other.
   *
   * ⚠️ DERIVED, NEVER HARDCODED. The sibling test above ("knows the voice kinds")
   * checks a hand-written list of four kind names, so it pins the drift of 2026-07
   * and can never see the next one — a guard whose input is transcribed by hand
   * inherits every omission it exists to catch. This reads EMITTED_KINDS and
   * requires the mirrors to carry every entry, so kind 23 fails here on the day it
   * lands rather than the day someone re-greps.
   */
  it.each([
    ['ios/Tiny/Sources/Activity.swift', /static let emittedKinds = \[([\s\S]*?)\n {4}\]/],
    ['android/app/src/main/java/technology/tiny/app/ui/Activity.kt', /internal val EMITTED_KINDS = listOf\(([\s\S]*?)\n\)/],
  ])('%s mirrors the FULL web roster, not a remembered subset', (file, re) => {
    const m = source(file).match(re as RegExp)
    expect(m, `${file}'s roster declaration moved — re-anchor this pin on wherever it ` +
      `went rather than leaving it to pass on an empty read`).not.toBeNull()

    // Comment leaders stripped first: every roster entry here is annotated, and a
    // kind NAMED in a comment must not count as a kind LISTED in the array — that
    // would make a prose mention satisfy the guard.
    const body = m![1].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // Array.from, not [...spread]: this file's tsconfig target makes spreading a
    // matchAll iterator a TS2802 (the older extractor above already trips it).
    const mirrored = Array.from(body.matchAll(/"([^"\n]+)"/g), (x) => x[1])

    // Did-I-read-this floor: a regex that stops matching yields [] and every
    // toContain below would… still fail, but on a confusing message. This says so.
    expect(mirrored.length, `parsed no kinds out of ${file} — the extractor is reading nothing`)
      .toBeGreaterThanOrEqual(20)

    for (const kind of EMITTED_KINDS) {
      expect(mirrored, `${file} never heard of "${kind}". Its glyph may well render ` +
        `(a PREFIX key covers most kinds for free) — the roster is not what draws the ` +
        `row, it is what makes a MISSING glyph fail instead of ship, and on this ` +
        `surface the pins are its only consumer.`).toContain(kind)
    }
  })

  /**
   * The mirrors must not drift the other way either: a kind listed on a phone but
   * not in EMITTED_KINDS is a claim the worker emits something it does not, and it
   * makes that surface's own "every kind has a glyph" loop assert about a ghost.
   */
  it.each([
    ['ios/Tiny/Sources/Activity.swift', /static let emittedKinds = \[([\s\S]*?)\n {4}\]/],
    ['android/app/src/main/java/technology/tiny/app/ui/Activity.kt', /internal val EMITTED_KINDS = listOf\(([\s\S]*?)\n\)/],
  ])('%s invents no kinds the worker cannot emit', (file, re) => {
    const body = source(file).match(re as RegExp)![1]
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const kind of Array.from(body.matchAll(/"([^"\n]+)"/g), (x) => x[1])) {
      expect(EMITTED_KINDS as readonly string[],
        `${file} lists "${kind}", which no emitter produces`).toContain(kind)
    }
  })

  it('malformed kind (non-string from worker payload) → ⚡, never throws', () => {
    // ActivityHUD passes e.kind straight from the worker event payload; a
    // missing/non-string kind must degrade to ⚡, not throw on .startsWith and
    // crash the HUD render.
    expect(iconFor(undefined as unknown as string)).toBe('⚡')
    expect(iconFor(null as unknown as string)).toBe('⚡')
    expect(iconFor(123 as unknown as string)).toBe('⚡')
    // A numeric kind that stringifies to a matching prefix still resolves
    expect(iconFor({} as unknown as string)).toBe('⚡')
  })
})
