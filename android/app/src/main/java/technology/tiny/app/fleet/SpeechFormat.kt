/**
 * ✒️ SpeechFormat — every recognition request in this app asks for punctuation.
 *
 * `RecognizerIntent` returns UNPUNCTUATED text by default, exactly like iOS's
 * `SFSpeechRecognitionRequest.addsPunctuation`. On a screen that is a cosmetic
 * detail. Everywhere text leaves this phone it is not: each of the rails below is
 * read by the AGENT — as a chat message, a tool result, or a transcript row in
 * its context — and a run-on with no sentence boundaries is something the model
 * has to guess at.
 *
 * `DmMedia.kt` already wrote the reason down for voice notes:
 *
 *   "A voice note is a sentence someone said, read as text by the recipient AND
 *    the agent — without punctuation it arrives as one unreadable run-on."
 *
 * A tool result is the same thing with no human in the loop to forgive it.
 *
 * ⚠️ THIS IS A ONE-LINE FUNCTION BECAUSE A HAND-KEPT LIST IS WHAT MISSES A RAIL.
 * iOS shipped this on four of its seven speech requests and missed three
 * (`e8b6df23`), and two of the three were the two rails of ONE tool —
 * `meta_listen` returned punctuated prose or a run-on depending on whether the
 * user happened to have a HUD card open. The same split is available here
 * (`WearablesListenerBridge.freeFormIntent` is shared with `GlassesLive`
 * precisely so it cannot happen), and `tests/android-speech-punctuation.test.ts`
 * DERIVES its roster by grepping for `ACTION_RECOGNIZE_SPEECH` rather than
 * listing sites, so a new recognition path cannot join the app unregistered.
 *
 * ⚠️ QUALITY, NOT LATENCY. Every caller here is either answering an agent that is
 * already waiting on a mailbox poll, or dictating a message that is about to make
 * a network round-trip. The formatting pass is not what the user is waiting for.
 * `FORMATTING_OPTIMIZE_LATENCY` exists for live captioning; nothing here is that.
 *
 * ⚠️ NO `SDK_INT` GUARD, AND THAT IS DELIBERATE — not an oversight to "fix".
 * `EXTRA_ENABLE_FORMATTING` arrived in API 33 (verified against the SDK's own
 * `api-versions.xml`, not assumed) while this app's `minSdk` is 29. But the
 * symbol is a compile-time-inlined `String` constant, so there is no class or
 * method to fail to resolve on an older phone, and `Intent` extras are a bag that
 * a recognizer ignores when it doesn't know the key. A version check would buy
 * nothing and would make the sentence read worse on an Android 12 phone that was
 * going to ignore the extra anyway. Same reason `EXTRA_PREFER_OFFLINE` is set
 * unconditionally alongside it.
 */
package technology.tiny.app.fleet

import android.content.Intent
import android.speech.RecognizerIntent

/**
 * Ask the recognizer for punctuated, capitalised text.
 *
 * Returns the same [Intent] so it chains with the `putExtra` calls it sits
 * among, in either the builder or the `apply {}` style — both are in use.
 */
fun Intent.askForPunctuation(): Intent = putExtra(
    RecognizerIntent.EXTRA_ENABLE_FORMATTING,
    RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY,
)
