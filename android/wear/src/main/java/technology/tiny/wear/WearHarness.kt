package technology.tiny.wear

import org.json.JSONArray
import technology.tiny.app.wear.WatchTurn

/**
 * WearHarness — debug-only wrist-state seeding, so a Wear screenshot can show the
 * app IN USE. The Android half of the iOS `--session-harness` flag
 * (TinyWatch/Sources/TinyWatchApp.swift).
 *
 * Why it has to exist: the whole wrist UI is gated on `vm.token == null ->
 * Unlinked()` (MainActivity), and that token arrives ONLY as a Data Layer push
 * from a PAIRED phone (PhoneLinkService). A Wear *emulator* has no pairing, so
 * without a seed path the emulator can only ever render "Open tiny on your phone
 * to link this watch" — and Play will not list Wear OS support without at least
 * one Wear screenshot. Same problem, same shape of answer as the watchOS side.
 *
 * Both values ride an Intent extra on the launch, never disk:
 *
 *   adb shell am start -n technology.tiny.wear/.MainActivity \
 *     --es tiny_harness_token '<jwt>' --es tiny_harness_turns '[{"q":…,"a":…}]'
 *
 * The seeded turns go through [WearStore.saveTurns], i.e. the same file
 * `loadTurns()` reads on VM construction — the captured screen is the app's real
 * render path over real persistence, not a preview composable.
 *
 * ## ⚠️ This harness WRITES, and that is what [mayOverwrite] is for
 *
 * Its three phone-side siblings ([technology.tiny.app.ui.GraphHarness],
 * `FleetHarness`, `MemoryHarness`) substitute a dataset **in memory** and leave
 * storage untouched — refusing to seed can cost nothing but a plain screen. This
 * one cannot work that way: the whole gate it defeats is read by
 * [WearViewModel]'s constructor straight out of [WearStore], so the seed has to
 * land in the store BEFORE the VM exists. It therefore does two destructive
 * writes: it replaces the session token in the encrypted prefs (the Keychain
 * analog) and `writeText`s over the transcript file.
 *
 * 🔑 **A harness that substitutes what a screen READS by writing over the real
 * thing needs a guard its read-only siblings don't.** On the emulator both writes
 * hit a blank slate. Aim the same `am start` at a REAL, phone-linked watch running
 * a debug build — which is exactly what the capture recipe sideloads, and one
 * mistyped `--serial` away — and it silently unlinks that watch (the placeholder
 * token replaces a live session, so the wrist has to be re-linked from the phone)
 * and deletes the real conversation on it. Neither is recoverable, and neither
 * prints anything: the seeder's own output says "✓ seeded".
 *
 * So the writes are gated on [mayOverwrite]: the harness may only ever clobber
 * wrist state it owns, or a wrist that has none.
 *
 * Pure on purpose (no Context, no Intent): the parse rules are JVM-unit-tested in
 * WearHarnessTest, and the Activity does nothing but hand over the two strings
 * and the current stored state. Every function takes `debug` explicitly rather
 * than reading BuildConfig, so a test can pin that a release build seeds NOTHING.
 */
object WearHarness {

    /** Launch-extra keys. Prefixed `tiny_harness_` so they read as a harness at a
     *  glance in an `am start` line and can't collide with TinyLaunch's face-tap
     *  extras. */
    const val EXTRA_TOKEN = "tiny_harness_token"
    const val EXTRA_TURNS = "tiny_harness_turns"

    /**
     * Whether the harness is allowed to overwrite the wrist's stored session +
     * transcript at all.
     *
     * True only when the state about to be destroyed is state the harness owns:
     *
     *  - `!hasToken` — an unlinked wrist (a fresh emulator) has no session to
     *    unlink and no reachable transcript to lose: the UI behind the gate can't
     *    be opened without a token, so nothing of the user's is on screen;
     *  - `harnessSeeded` — this wrist's state was put there by a previous harness
     *    run, so re-seeding it just replaces demo content with demo content. This
     *    is what makes a capture re-runnable, which matters: a wrist shot is
     *    almost never right the first time.
     *
     * False for a wrist a PHONE linked. That is the case the guard exists for: the
     * capture recipe sideloads a *debug* watch APK, so a mistyped `--serial` (or a
     * real watch left attached beside the emulator) aims the seeder at a live
     * wrist, where the placeholder token replaces the real session — unlinking the
     * watch until the phone re-pushes — and `saveTurns` deletes the real
     * conversation on it. Both are silent; the seeder still prints "✓ seeded".
     * 🔑 **A debug-only write is still a write to whatever device it lands on** —
     * "debug build" bounds who CAN run it, not what it destroys when they do.
     *
     * [WearViewModel.onLinked] clears the flag when a phone pushes a real token, so
     * a wrist that stops being demo state stops being overwritable — the flag
     * tracks the CURRENT state's provenance, not "a harness ran here once".
     */
    fun mayOverwrite(debug: Boolean, hasToken: Boolean, harnessSeeded: Boolean): Boolean {
        if (!debug) return false
        return !hasToken || harnessSeeded
    }

    /**
     * The session token to seed, or null to leave [WearStore.token] alone.
     *
     * Null in a release build no matter what the extra says — this is the whole
     * safety property: an APK on a stranger's watch cannot be handed a session by
     * an intent. Blank/whitespace is also null, because `--es key ''` is how a
     * script passes an unset variable, and adopting "" as a token would push the
     * UI past the gate into a chat that 401s on every send.
     */
    fun token(debug: Boolean, raw: String?): String? {
        if (!debug) return null
        return raw?.trim()?.takeIf { it.isNotEmpty() }
    }

    /**
     * Turns to seed the transcript with, or null to leave the stored transcript
     * alone (so a token-only launch keeps whatever was already there).
     *
     * `done` is forced TRUE for every seeded turn rather than read from the JSON.
     * That's a deliberate divergence from the iOS seeder, where the transcript is
     * a file decoded by Codable and a *missing* `done` fails the decode — which
     * `try?` swallows into an EMPTY chat, i.e. a silent wrong screenshot. Here a
     * turn with no `done` is simply a finished turn, because a seeded turn is by
     * definition not mid-stream: nothing is streaming it. A turn that arrived
     * unfinished would render as a spinner forever (WearStore.loadTurns sanitizes
     * on load, but only to "(interrupted)"), and neither of those is a shippable
     * store asset.
     *
     * Malformed JSON, a non-array, and an empty array all return null instead of
     * clearing the transcript: "I couldn't read what you sent" must not present as
     * "you asked for an empty chat".
     */
    fun turns(debug: Boolean, json: String?): List<WatchTurn>? {
        if (!debug) return null
        val raw = json?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return null
        val turns = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                val q = o.optString("q").trim()
                val a = o.optString("a").trim()
                // A turn with neither side is nothing to render — drop it rather
                // than emit an empty bubble pair.
                if (q.isEmpty() && a.isEmpty()) return@let null
                WatchTurn(
                    id = o.optString("id").takeIf { it.isNotEmpty() } ?: "harness-$i",
                    q = q,
                    a = a,
                    done = true,
                )
            }
        }
        return turns.ifEmpty { null }
    }
}
