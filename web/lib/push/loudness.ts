/**
 * 🔔 How loudly a push should arrive — the rule, in one place, with a POLARITY.
 *
 * The worker mirrors every push to native devices as a `{type:"notify"}` relay
 * envelope (push.ts `relayPushToDevices`), tagged with the worker's own push tag.
 * That tag is the ONLY routing input the clients get, and each client decides
 * what to do with it. Web (`sw.js`) vibrates every notification. Android has a
 * loudness ladder — two channels, `tiny_alerts` (IMPORTANCE_HIGH, heads-up) and
 * `tiny_activity` (IMPORTANCE_LOW, a silent chip in the shade) — and its
 * `classify` enumerated the LOUD tags and defaulted everything else to the
 * SILENT one:
 *
 *     dm- → poll · tiny-job- → HIGH · device-result- → HIGH · batch- → HIGH
 *     else → CHANNEL_ACTIVITY          ← the default, and it is quiet
 *
 * ⚠️ THAT DEFAULT IS THE WRONG WAY ROUND, and the proof is `task-result-`.
 * `buildTaskResultPush` (relay.ts) is the delivery half of fire-and-forget
 * `use_device` — the whole point of the feature: fire a task at the Mac, walk
 * away, get told when it lands. Its tag matched no arm, so on Android it arrived
 * as a silent chip, while the SAME feature's late-reply push
 * (`device-result-`) got a heads-up banner. Nobody wrote that difference; it
 * fell out of a list that grew one arm per remembered tag while the default
 * absorbed every new kind in silence.
 *
 * `money-refunded` fell through the same hole, and its own worker comment says
 * why that is worse than a missed banner: "The one that MUST be sent… Silence
 * here reads as loss."
 *
 * ⚠️ A DISPATCH LIST HAS A POLARITY: enumerate the small, closed, KNOWN set and
 * let the default carry the rest. Of the eleven push tags the worker and web can
 * emit, exactly ONE is ambient (`tiny-visit-` — the worker already throttles it
 * to one per 5 min per tiny, because it is a nicety). Ten are things a person
 * asked for or needs to know about. So the ambient list is the closed one, and
 * the default must be LOUD — which also means a push kind added next year is
 * born audible on every surface, instead of born silent on one.
 *
 * ⚠️ AND A QUIET DEFAULT IS INVISIBLE TO A PARITY TEST. Parity compares the
 * phones to each other; both were "correct" because iOS had no ladder to be
 * wrong about. `tests/relay-notify.test.ts` even asserted the quiet default
 * BY LINE — `toContain('else -> Route.Banner(CHANNEL_ACTIVITY')` — under a
 * comment reading "Defaulting to silent is exactly how the iOS hole existed".
 * The test named the right principle and pinned the code that broke it: it was
 * checking the envelope still reached the user AT ALL (the iOS bug, where it
 * vanished), and read "arrives silently" as "arrives". Two tests had to be
 * rewritten to fix three lines.
 *
 * ⚠️⚠️ THE SAME DEFECT WITH THE POLARITY REVERSED, on iOS: having NO ladder is
 * not neutral, it is the loud end pinned for everything. `Notify.post` set
 * `.sound = .default` on all nine of its callers, so `tiny-visit-` — a nicety
 * the worker throttles precisely because it repeats — interrupted an iPhone
 * exactly as hard as a refund. Worse, three of those callers are fleet traces
 * that Android's own `notifyFleetTrace` docstring describes as mirroring iOS:
 * "Silent by design (activity channel is LOW) — a record, not an
 * interruption." That was a description of behaviour iOS never had. `iOSInterruptionLevel`
 * below closes it with `interruptionLevel` (iOS 15+, no entitlement — unlike
 * `.timeSensitive`, which needs one this app does not carry).
 *
 * The general shape: **a surface with no ladder has not opted out of the
 * question, it has answered it for every case at once** — and which end it is
 * pinned to decides whether the bug reads as "never arrives" or "never stops
 * arriving". Both phones now answer from this one file.
 *
 * Pure and shared, like `voice/playback.ts`: the rule is checkable without a
 * device, and the Kotlin/Swift twins have one definition to be twins OF.
 */

/**
 * Tag prefixes that are genuinely ambient — background colour about someone
 * else's activity, not an answer the person is waiting on.
 *
 * ⚠️ THE CLOSED SET, and it is closed because it is short. Adding a prefix here
 * makes a push kind silent on Android forever, so the bar is the one
 * `tiny-visit-` clears: the event is a nicety, it can repeat often, and missing
 * one costs the person nothing. `tests/push-loudness.test.ts` extracts every
 * `tag:` literal the worker and `lib/chat/tools` can emit and asserts each is
 * either listed here or loud — so a twelfth tag added upstream fails a suite
 * instead of quietly picking a side.
 */
export const AMBIENT_TAG_PREFIXES = ["tiny-visit-"] as const;

/** How a push should arrive. `heads_up` interrupts (Android IMPORTANCE_HIGH,
 *  and what web/iOS already do for everything); `ambient` is a silent chip. */
export type PushLoudness = "heads_up" | "ambient";

/**
 * How loudly should a push with this tag arrive?
 *
 * ⚠️ DEFAULTS LOUD, on purpose — see the file docstring. An unrecognised tag is
 * a push kind this client was never taught, and the honest assumption about
 * something a person's own account generated is that they want to know. A wrong
 * heads-up is a mild annoyance the user can silence per-channel in system
 * settings; a wrong silence is the feature appearing not to work at all, with
 * nothing on screen to complain about.
 *
 * Note this decides LOUDNESS only, never whether to show anything: every notify
 * envelope with something to say gets a banner on both natives. The DM tag is
 * routed away from bannering entirely (to the unread poll) before loudness is
 * ever consulted, so it does not appear here.
 */
export function pushLoudness(tag: string | null | undefined): PushLoudness {
  const t = String(tag || "");
  return AMBIENT_TAG_PREFIXES.some((p) => t.startsWith(p)) ? "ambient" : "heads_up";
}

/**
 * The iOS half of the ladder: `UNNotificationInterruptionLevel` (iOS 15+; the
 * app targets 18.0) plus whether to attach a sound.
 *
 * `.active` is the normal one — banner + sound, what every notification did
 * before. `.passive` still appears in the shade and on the lock screen but
 * never lights the screen or makes a noise: the exact counterpart of Android's
 * `IMPORTANCE_LOW` activity channel, and the only pair of levels that needs no
 * entitlement (`.timeSensitive`/`.critical` both do).
 *
 * ⚠️ Sound is dropped for `ambient` as well as the level. `.passive` alone
 * still plays the sound when one is set, so a `.passive` notification with
 * `.sound = .default` is quiet in every respect except the one the user
 * actually notices — a half-fix that would test green against the level and
 * still ding. Android gets both properties from the channel; iOS has to set
 * them separately, which is why they are returned together here.
 */
export function iOSInterruptionLevel(tag: string | null | undefined): {
  level: "active" | "passive";
  sound: boolean;
} {
  return pushLoudness(tag) === "ambient"
    ? { level: "passive", sound: false }
    : { level: "active", sound: true };
}

/**
 * The web half: the loudness fields of a `showNotification()` options bag.
 *
 * The third surface, and the third variant of the same missing decision. `sw.js`
 * hardcoded `vibrate: [100, 50, 100]` and `renotify: true` at BOTH of its
 * `showNotification` call sites, for every tag — so `tiny-visit-` buzzed a phone
 * exactly as hard as `money-refunded`.
 *
 * ⚠️ AND `renotify` IS THE KNOB THAT MATTERS MOST HERE, because of what the tag
 * is: `tiny-visit-<slug>` is stable per tiny, so every visit REPLACES the
 * previous notification, and `renotify: true` means each replacement re-alerts.
 * The worker throttles that push to one per 5 min per tiny precisely because it
 * repeats; the web then took the repetition and made it the loudest thing about
 * it. Of the three surfaces this is the one that was wrong *specifically* at the
 * ambient kind, rather than uniformly.
 *
 * ⚠️⚠️ `silent` AND `vibrate` ARE MUTUALLY EXCLUSIVE AT THE SPEC LEVEL, and the
 * failure is total: "create a notification" step 2 throws a `TypeError` when
 * `silent` is true and `vibrate` exists, and both call sites sit inside
 * `e.waitUntil(...)`, so a throw means NOTHING IS SHOWN AT ALL. The obvious
 * shape of this fix — add `silent` next to the `vibrate` that is already there —
 * therefore converts "too loud" into "never arrives", which is this same defect
 * one polarity over. They are returned as an EXCLUSIVE PAIR so a caller cannot
 * spread both. (Step 3 throws for `renotify` with an empty tag, too; `renotify`
 * is false on the quiet arm and the loud arm's tag falls back to a non-empty
 * literal, so neither arm can reach it.)
 *
 * ⚠️ `silent` is not Baseline — Firefox does not implement it. Unsupported
 * dictionary members are dropped rather than throwing, so where it is ignored
 * the notification arrives at the device's OWN default: quieter than today
 * regardless, because the forced vibration pattern is gone, and never louder.
 * The degradation is monotone, which is why this is worth shipping on a
 * property one engine will ignore half of.
 */
export function webNotificationLoudness(tag: string | null | undefined):
  | { silent: true; renotify: false }
  | { vibrate: number[]; renotify: true } {
  return pushLoudness(tag) === "ambient"
    ? { silent: true, renotify: false }
    : { vibrate: [100, 50, 100], renotify: true };
}
