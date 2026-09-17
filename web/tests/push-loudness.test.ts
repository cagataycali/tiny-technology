// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  AMBIENT_TAG_PREFIXES,
  iOSInterruptionLevel,
  pushLoudness,
  webNotificationLoudness,
} from '@/lib/push/loudness'
import { workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 🔔 Every push tag the system can emit takes a SIDE on loudness.
 *
 * The defect this suite exists for: Android's `RelayNotifier.classify`
 * enumerated the LOUD tags (`tiny-job-`, `device-result-`, `batch-`) and dropped
 * everything else on the low-importance activity channel. So each new push kind
 * was born silent there — and two already were. `task-result-` (the delivery
 * half of fire-and-forget `use_device`, the whole point of the feature) arrived
 * as a soundless chip while the same feature's late reply got a heads-up banner.
 * `money-refunded` fell through too, the tag whose own worker comment says
 * "Silence here reads as loss."
 *
 * ⚠️ AND THE MIRROR, ON IOS: `Notify.post` set `.sound = .default` for every
 * caller, which is not the absence of a decision but the loud end pinned for
 * every case — so `tiny-visit-`, a nicety the worker throttles precisely because
 * it repeats, interrupted an iPhone as hard as a refund. Both phones now answer
 * from `AMBIENT_TAG_PREFIXES` below; the twin blocks at the bottom hold all
 * three implementations to it.
 *
 * ⚠️ AND THE THIRD SURFACE, THE WEB: `sw.js` hardcoded `vibrate` + `renotify`
 * at both of its `showNotification` sites. `renotify` is the sharp one — a
 * `tiny-visit-<slug>` tag is stable per tiny, so each visit REPLACES the last
 * notification and renotify re-alerts on every replacement. All four
 * implementations (TS, Kotlin, Swift, sw.js) now answer from one rule.
 *
 * ⚠️ PINNING THE TAGS I HAPPENED TO THINK OF WOULD PASS FOREVER WHILE THE LIST
 * ROTTED — the same trap `voice/playback.ts` documents about refusal strings, and
 * the reason that suite scrapes the worker instead of listing five spellings. So
 * this EXTRACTS every `tag:` literal from the worker and `lib/chat/tools`, and
 * requires each to be either in the ambient set or loud. A twelfth tag added
 * upstream fails here instead of quietly picking a side.
 */
warnIfWorkerAbsent('push-loudness')

/** Directories that can emit a push tag: the worker (its own routes) and the
 *  web tool layer (spawn.ts posts to /push/send with its own tag). */
const TAG_SOURCES = ['worker/src', 'lib/chat/tools']

type ExtractedTag = { tag: string; file: string }

/**
 * Every `tag:` literal that belongs to a PUSH, with the interpolation stripped
 * back to its stable prefix (`` `task-result-${p.ticket}` `` → `task-result-`).
 *
 * ⚠️ `payments.ts` uses `tag:` for STRUCTURED LOG LINES (`reconcile-sweep`,
 * `settle-unknown-skip`, …) — thirteen of them, none a notification. They are
 * discriminated by shape, not by a filename exclusion: a push payload carries
 * `title:` and `body:` alongside its tag, a log line carries neither. Excluding
 * `payments.ts` by name would have gone stale the moment a payment route sent a
 * push, which is exactly what `money-events.ts` does one file over.
 */
function extractPushTags(): ExtractedTag[] {
  const out: ExtractedTag[] = []
  for (const dir of TAG_SOURCES) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const path = join(dir, f)
      const src = readFileSync(path, 'utf8')
      const re = /tag:\s*(`[^`]*`|"[^"]*"|'[^']*')/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const window = src.slice(Math.max(0, m.index - 500), m.index + 500)
        if (!/title:/.test(window) || !/body:/.test(window)) continue // a log line
        const literal = m[1].slice(1, -1)
        // `dm-${sender.id}` → `dm-`; a plain literal stays whole.
        const prefix = literal.replace(/\$\{[^}]*\}.*$/, '')
        out.push({ tag: prefix, file: path })
      }
    }
  }
  return out
}

describe.skipIf(!present)('push tag loudness (extracted from source)', () => {
  const tags = extractPushTags()

  it('finds the push tags — a scraper that reads nothing passes forever', () => {
    // The "did I actually read this" assertion: an empty extraction would make
    // every per-tag check below vacuous.
    expect(tags.length).toBeGreaterThanOrEqual(10)
    const names = new Set(tags.map((t) => t.tag))
    // Spot-check the two ends of the census so a regex that matches only the
    // simple form (or only the interpolated one) can't slip through.
    expect(names).toContain('money-refunded') // plain string literal
    expect(names).toContain('task-result-') // interpolated template
    expect(names).toContain('tiny-visit-')
    // ⚠️ From lib/chat/tools, NOT the worker — the census reads two directories
    // and a spot-check drawn only from the first cannot tell that the second was
    // ever opened. `batch-` (spawn.ts, the web tool layer posting to /push/send)
    // is the only tag that proves the second source was read.
    expect(names).toContain('batch-')
    expect(new Set(tags.map((t) => t.file.split('/')[0])).size).toBeGreaterThan(1)
  })

  it('excludes the structured LOG tags that share the `tag:` key', () => {
    // payments.ts has 13 of these. If the discriminator breaks, they arrive here
    // as "push kinds" and the suite starts demanding a loudness for a log line.
    const names = tags.map((t) => t.tag)
    for (const log of ['reconcile-sweep', 'settle-unknown-skip', 'spend-reverse-refused']) {
      expect(names).not.toContain(log)
    }
  })

  it('every emitted tag is either ambient-by-name or loud — never silent by default', () => {
    for (const { tag, file } of tags) {
      const loudness = pushLoudness(tag)
      if (loudness === 'ambient') {
        // Being quiet is allowed, but only by explicit listing.
        expect(AMBIENT_TAG_PREFIXES.some((p) => tag.startsWith(p)), `${tag} (${file})`).toBe(true)
      } else {
        expect(loudness, `${tag} (${file}) must interrupt`).toBe('heads_up')
      }
    }
  })

  it('exactly one push kind is ambient, and it is the throttled nicety', () => {
    const ambient = tags.filter((t) => pushLoudness(t.tag) === 'ambient').map((t) => t.tag)
    expect(Array.from(new Set(ambient))).toEqual(['tiny-visit-'])
    // Ten-plus loud kinds against one quiet one is the arithmetic that decides
    // the polarity: enumerate the short closed set, default to the rest.
    const loud = tags.filter((t) => pushLoudness(t.tag) === 'heads_up')
    expect(loud.length).toBeGreaterThan(ambient.length)
  })

  it('the tags this loop ships are loud, by name', () => {
    // Named individually because these are the two that were actually broken —
    // a generic "everything is loud" pass would go green on a rule that
    // accidentally re-silenced them.
    expect(pushLoudness('task-result-task_2b7f3e0f_t123')).toBe('heads_up')
    expect(pushLoudness('device-result-env42')).toBe('heads_up')
    expect(pushLoudness('money-refunded')).toBe('heads_up')
    expect(pushLoudness('tiny-job-42')).toBe('heads_up')
    expect(pushLoudness('batch-batch_abc12345')).toBe('heads_up')
    expect(pushLoudness('tiny-visit-luna')).toBe('ambient')
  })

  it('an unknown or absent tag is loud, not silent', () => {
    // The polarity, stated directly: the default arm of the rule.
    expect(pushLoudness('tiny-notification')).toBe('heads_up') // buildNotifyEnvelope's own default
    expect(pushLoudness('some-kind-invented-in-2027')).toBe('heads_up')
    expect(pushLoudness('')).toBe('heads_up')
    expect(pushLoudness(null)).toBe('heads_up')
    expect(pushLoudness(undefined)).toBe('heads_up')
  })

  it('a prefix match is anchored at the START — a tag ending in a nicety still interrupts', () => {
    // `startsWith`, not `includes`: "device-result-tiny-visit-x" is a device
    // result, not a visit.
    expect(pushLoudness('device-result-tiny-visit-x')).toBe('heads_up')
    expect(pushLoudness('x-tiny-visit-luna')).toBe('heads_up')
  })
})

/**
 * ── The native twins ────────────────────────────────────────────────────────
 *
 * Both phones implement this rule, and each got it wrong in the OPPOSITE
 * direction — which is precisely why the iOS↔Android parity suite could never
 * see either half. Android enumerated the loud tags and let everything new fall
 * to its silent channel (so `task-result-` arrived soundless). iOS had no
 * ladder at all and set `.sound = .default` on every caller — not neutrality
 * but the loud end pinned for every case, so `tiny-visit-` interrupted as hard
 * as a refund. A parity check compares the phones to each other; both were
 * "correct" while both were wrong. Compare each to the RULE instead.
 *
 * These assertions hold each native constant to the TS one. The behaviours are
 * proven natively (RelayNotifierTest on the JVM, RelayNotifyTests /
 * FleetTraceLoudnessTests via XCTest).
 */
const nativeFile = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('the Kotlin twin carries the same closed ambient set', () => {
  const kotlin = nativeFile('android/app/src/main/java/technology/tiny/app/fleet/RelayNotifier.kt')

  it('lists the same prefixes as lib/push/loudness.ts', () => {
    const m = kotlin.match(/AMBIENT_TAG_PREFIXES\s*=\s*listOf\(([^)]*)\)/)
    expect(m, 'AMBIENT_TAG_PREFIXES not found in RelayNotifier.kt').toBeTruthy()
    const listed = (m![1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1))
    expect(listed).toEqual([...AMBIENT_TAG_PREFIXES])
  })

  it('routes the quiet channel ONLY through that set', () => {
    // The structural half of the rule: if CHANNEL_ACTIVITY ever appears in
    // classify's default arm again, the polarity has flipped back.
    const classify = kotlin.slice(kotlin.indexOf('fun classify('), kotlin.indexOf('fun redeemQuery'))
    expect(classify).toContain('AMBIENT_TAG_PREFIXES.any')
    expect(classify.slice(classify.indexOf('else ->'))).not.toContain('CHANNEL_ACTIVITY')
  })
})

describe('the Swift twin carries the same closed ambient set', () => {
  const swift = nativeFile('ios/Tiny/Sources/Notifications.swift')
  const session = nativeFile('ios/Tiny/Sources/Session.swift')

  it('lists the same prefixes as lib/push/loudness.ts', () => {
    const m = swift.match(/ambientTagPrefixes\s*=\s*\[([^\]]*)\]/)
    expect(m, 'ambientTagPrefixes not found in Notifications.swift').toBeTruthy()
    const listed = (m![1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1))
    expect(listed).toEqual([...AMBIENT_TAG_PREFIXES])
  })

  it('iOS has a ladder at all — the half that was missing', () => {
    // ⚠️ `.sound = .default` used to be unconditional. The assertion is that
    // BOTH properties now depend on the decision: `.passive` alone still plays
    // an attached sound, so a level-only fix is quiet in every respect except
    // the one a person actually notices.
    //
    // The expected strings are DERIVED from iOSInterruptionLevel rather than
    // typed, so the TS mapping cannot drift from the Swift one while both look
    // individually fine — the same reason AMBIENT_TAG_PREFIXES is compared
    // rather than re-listed.
    const quiet = iOSInterruptionLevel('tiny-visit-luna')
    const loud = iOSInterruptionLevel('task-result-x')
    expect(quiet).toEqual({ level: 'passive', sound: false })
    expect(loud).toEqual({ level: 'active', sound: true })

    const post = swift.slice(swift.indexOf('static func post('), swift.indexOf('static func redeemQuery'))
    expect(post).toContain(`content.interruptionLevel = ambient ? .${quiet.level} : .${loud.level}`)
    expect(post).toContain(`content.sound = ambient ? ${quiet.sound ? '.default' : 'nil'} : .default`)
    // …and nothing sets the sound unconditionally any more.
    expect(post).not.toMatch(/content\.sound = \.default\s*$/m)
  })

  it('anchors the prefix match, like both other implementations', () => {
    const fn = swift.slice(swift.indexOf('static func isAmbient('))
    expect(fn.slice(0, 200)).toContain('hasPrefix')
    expect(fn.slice(0, 200)).not.toContain('contains($0)')
  })

  it('the relay banner derives loudness from the TAG, never a hardcoded level', () => {
    // This is the call site that carries every worker push kind; hardcoding it
    // either way re-breaks the thing the shared rule exists for.
    const handler = session.slice(session.indexOf('func handleNotifyEnvelope'))
    const banner = handler.slice(handler.indexOf('case .banner'), handler.indexOf('/// "say'))
    expect(banner).toContain('ambient: Notify.isAmbient(tag: tag)')
  })

  it('the three fleet traces post ambient — what Android already claimed they did', () => {
    // ⚠️ Android's notifyFleetTrace docstring described these as "Silent by
    // design — a record, not an interruption" and cited iOS as the model. iOS
    // chimed for all three. The defect was visible only by reading what the
    // OTHER phone said about this one.
    for (const trace of ['Device re-enrolled', 'Web agent reached your phone', 'Recorded for your tiny']) {
      const at = session.indexOf(trace)
      expect(at, `${trace} not found in Session.swift`).toBeGreaterThan(-1)
      expect(session.slice(at, at + 400), `${trace} posts loud`).toContain('ambient: true')
    }
  })

  it('the alarm the agent schedules stays loud — the one sound that IS the point', () => {
    // DeviceTools.scheduleAlert is a user-requested alarm ("wake me in 20
    // minutes"). It has its own `.sound = .default` and must keep it: a silent
    // alarm is the failure mode, so this is not a site to sweep up.
    const tools = nativeFile('ios/Tiny/Sources/DeviceTools.swift')
    const fn = tools.slice(tools.indexOf('func scheduleAlert('))
    expect(fn.slice(0, 800)).toContain('content.sound = .default')
  })
})

/** The `notificationLoudness` body in sw.js, without the surrounding file. */
const swLadder = (sw: string) =>
  sw.slice(sw.indexOf('function notificationLoudness('), sw.indexOf("addEventListener('push'"))

/**
 * The ternary as ONE shape: guard, then the ambient arm, then the default arm.
 * Capturing them in ORDER is what makes an arm swap fail — see the comment at
 * the assertion. The guard is required to be the anchored prefix test, so an
 * unanchored `includes` cannot match either.
 */
const TERNARY_RE =
  /AMBIENT_TAG_PREFIXES\.some\(\(p\) => t\.startsWith\(p\)\)\s*\?\s*(\{[^}]*\})\s*:\s*(\{[^}]*\})/

describe('the service-worker twin carries the same closed ambient set', () => {
  const sw = nativeFile('public/sw.js')

  it('reads the file at all, and lists the same prefixes as lib/push/loudness.ts', () => {
    // A service worker cannot import the shared rule (no bundler), so the set is
    // mirrored — and mirrored constants drift unless something compares them.
    expect(sw.length).toBeGreaterThan(4_000) // the "did I read this" floor
    const m = sw.match(/AMBIENT_TAG_PREFIXES\s*=\s*\[([^\]]*)\]/)
    expect(m, 'AMBIENT_TAG_PREFIXES not found in public/sw.js').toBeTruthy()
    const listed = (m![1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1))
    expect(listed).toEqual([...AMBIENT_TAG_PREFIXES])
  })

  it('derives both arms from webNotificationLoudness, so the TS rule cannot drift', () => {
    // Expected values DERIVED, not typed — same discipline as the Swift block.
    // ⚠️ The narrowing below is load-bearing, not ceremony: the return type is
    // an EXCLUSIVE union, so `quiet.silent` does not typecheck until the arm is
    // proven. That is the spec's mutual exclusion enforced by the compiler — the
    // reason a caller cannot accidentally spread both keys into one options bag.
    const quiet = webNotificationLoudness('tiny-visit-luna')
    const loud = webNotificationLoudness('task-result-x')
    expect(quiet).toEqual({ silent: true, renotify: false })
    expect(loud).toEqual({ vibrate: [100, 50, 100], renotify: true })
    if (!('silent' in quiet)) throw new Error('the ambient arm must be the silent one')
    if (!('vibrate' in loud)) throw new Error('the loud arm must be the vibrating one')

    // ⚠️ BIND EACH ARM TO ITS CONDITION, don't just assert both literals exist.
    // The first version of this test used two `toContain` calls, and SWAPPING
    // the arms passed it — both strings were still present. That would ship the
    // worst possible inversion (a visit buzzes, a refund goes silent) through a
    // green suite: presence is not polarity, which is the whole subject of this
    // file. So the ternary is matched as ONE shape, arms captured in order.
    const arms = TERNARY_RE.exec(swLadder(sw))
    expect(arms, 'the notificationLoudness ternary did not match its expected shape').toBeTruthy()
    const [, ambientArm, defaultArm] = arms!
    expect(ambientArm).toBe(`{ silent: ${quiet.silent}, renotify: ${quiet.renotify} }`)
    expect(defaultArm).toBe(`{ vibrate: [${loud.vibrate.join(', ')}], renotify: ${loud.renotify} }`)
  })

  it('⚠️ never emits silent AND vibrate together — that TypeError shows NOTHING', () => {
    // Notifications spec, "create a notification" step 2: silent:true with
    // vibrate present throws. showNotification is awaited inside waitUntil, so
    // the throw means no notification at all — the naive version of this fix
    // (add `silent` beside the existing `vibrate`) turns "too loud" into "never
    // arrives". Assert the two arms are EXCLUSIVE, on the rule and on the twin.
    for (const tag of ['tiny-visit-luna', 'task-result-x', 'money-refunded', '']) {
      const opts = webNotificationLoudness(tag) as Record<string, unknown>
      expect('silent' in opts && 'vibrate' in opts, `${tag} emits both`).toBe(false)
    }
    // In sw.js the exclusivity is structural: neither ternary arm holds both.
    const fn = sw.slice(sw.indexOf('function notificationLoudness('), sw.indexOf("addEventListener('push'"))
    for (const arm of fn.split('?').slice(1).join('?').split(':')) {
      expect(/silent/.test(arm) && /vibrate:/.test(arm), `an arm sets both: ${arm.trim()}`).toBe(false)
    }
  })

  it('BOTH showNotification call sites spread the ladder — neither hardcodes loudness', () => {
    // The push handler and the page-postMessage handler. Fixing one and leaving
    // the other is how a surface ends up half-laddered, which is worse than
    // none: identical tags then arrive at two different loudnesses.
    const sites = sw.split('showNotification(').slice(1)
    expect(sites.length).toBe(2)
    for (const site of sites) {
      const opts = site.slice(0, site.indexOf('})'))
      expect(opts).toContain('...notificationLoudness(tag)')
      // The old hardcoded pair must be gone from the options bags.
      expect(opts).not.toContain('vibrate: [100, 50, 100]')
      expect(opts).not.toContain('renotify: true')
    }
  })

  it('renotify is never paired with an empty tag — spec step 3 is the same trap', () => {
    // `renotify: true` with tag '' also throws. Both sites fall back to a
    // non-empty literal, so the loud arm can never reach it.
    const sites = sw.split('showNotification(').slice(1)
    expect(sites.length).toBe(2)
    for (const site of sites) {
      expect(site.slice(0, site.indexOf('})'))).toContain('tag,')
    }
    expect(sw).toContain("data.tag || 'tiny-notification'")
    expect(sw).toMatch(/msg\.tag \|\| `tiny-\$\{Date\.now\(\)\}`/)
    // And the quiet arm sets renotify:false, so it cannot throw regardless.
    expect(webNotificationLoudness('tiny-visit-luna').renotify).toBe(false)
  })

  it('the ambient kind really is the one the web punished hardest', () => {
    // Not a restatement of the rule: the POINT of the web half. A stable
    // per-tiny tag + renotify means every replacement re-alerts, so the one
    // kind that repeats by design was the one that re-buzzed by design.
    expect(pushLoudness('tiny-visit-luna')).toBe('ambient')
    expect(webNotificationLoudness('tiny-visit-luna').renotify).toBe(false)
    // The worker's own throttle is the evidence it repeats — if that push stops
    // being throttled, this pairing deserves a fresh look.
    if (present) {
      const visit = readFileSync(join('worker/src', 'visit.ts'), 'utf8')
      expect(visit).toContain('tag: `tiny-visit-${slug}`')
      expect(visit).toContain('PUSH_THROTTLE_SECONDS')
    }
  })
})
