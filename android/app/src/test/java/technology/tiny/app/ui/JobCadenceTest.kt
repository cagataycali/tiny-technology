package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ⏰ The rule that reads a run — [JobCadence], ported from the web's
 * `lib/chat/job-cadence.ts` (iOS ported the same rules as `JobCadence`).
 *
 * The defect it replaces was one row contradicting itself: `ran Jan 1, 09:00 ·
 * fired 0×`, about a reminder that never happened, and the false half is the one
 * a person acts on. The cause was `fireCount > 0 || !enabled` — treating a
 * cleared `enabled` flag as evidence of a run, when the scheduler clears it both
 * after a fire AND when it gives up on a stale one-shot.
 *
 * These are the rules, tested where they are decidable — pure, no Compose, no
 * `System.currentTimeMillis()`. The panel formats a date; this says what the date
 * MEANS, and getting it wrong is not a cosmetic bug: it tells somebody their
 * reminder happened.
 */
class JobCadenceTest {

    // A fixed "now" so every boundary below is hand-verifiable.
    private val now = 1_704_099_600L // 2024-01-01T09:00:00Z
    private val hour = 3_600L

    private fun state(runAt: Long?, fired: Int = 0, enabled: Boolean = true, at: Long = now) =
        JobCadence.oneShotState(runAt, fired, enabled, at)

    // ── fire_count is the only record of a run ────────────────────────────────

    @Test fun `a recorded fire is the one thing read as a run`() {
        assertEquals(JobCadence.OneShot.RAN, state(now - hour, fired = 1))
    }

    @Test fun `a run outranks every flag, including a still-enabled row`() {
        // The scheduler's post-fire disable is a SEPARATE statement inside a
        // swallowing try/catch, so `enabled = 1, fire_count = 1` is a state that
        // can genuinely exist — and it means the job ran.
        assertEquals(JobCadence.OneShot.RAN, state(now - hour, fired = 1, enabled = true))
        assertEquals(JobCadence.OneShot.RAN, state(now - hour, fired = 1, enabled = false))
        // …and a future run_at with a fire behind it is still a run, not pending:
        // the recorded fire is checked before the clock is consulted at all.
        assertEquals(JobCadence.OneShot.RAN, state(now + hour, fired = 1))
        // ⚠️ …and it outranks an UNREADABLE run_at too, which is the assertion that
        // actually pins the ORDER of the first two branches. Every case above has a
        // usable `run_at`, so hoisting the `usableSec` guard above the fire check
        // leaves them all green while a job that demonstrably ran reads as UNKNOWN.
        // Invisible in today's output — `cadence()` prints "?" without a timestamp,
        // and RAN/UNKNOWN happen to share TinyGray — so the wrong answer only
        // surfaces the day DONE and MUTED stop being the same colour. Pinned
        // because the rule is the contract four languages implement, not because
        // one screen currently hides the difference.
        assertEquals(JobCadence.OneShot.RAN, state(null, fired = 2, enabled = false))
    }

    @Test fun `THE DEFECT — disabled with zero fires is MISSED, not ran`() {
        // 🔴 The whole cycle in one assertion. This is the skip-stale row: the
        // scheduler abandoned it, `fire_count` was never touched, and the old
        // `!enabled` guess reported it as done.
        assertEquals(JobCadence.OneShot.MISSED, state(now - hour, fired = 0, enabled = false))
    }

    // ── the catch-up window ───────────────────────────────────────────────────

    @Test fun `a job due beyond the catch-up window is already certain to be dropped`() {
        // Still enabled, so the flag says nothing — but the very next tick takes
        // the skip-stale branch, so there is no honest way to call this pending.
        assertEquals(
            JobCadence.OneShot.MISSED,
            state(now - JobCadence.CATCH_UP_SECONDS - 1, enabled = true),
        )
    }

    @Test fun `inside the window a passed time is DUE — in flight, not broken`() {
        assertEquals(JobCadence.OneShot.DUE, state(now - hour))
        // The cron ticks every minute; a second overdue is a job about to run.
        assertEquals(JobCadence.OneShot.DUE, state(now - 1))
    }

    @Test fun `the window boundary is the scheduler's own comparison, strictly greater`() {
        // ⚠️ Exactly at 24h is still DUE — `now - due > CATCH_UP` in scheduler.ts,
        // not `>=`. An off-by-one here declares a job dead one tick before the
        // worker would have run it.
        assertEquals(JobCadence.OneShot.DUE, state(now - JobCadence.CATCH_UP_SECONDS))
        assertEquals(JobCadence.OneShot.MISSED, state(now - JobCadence.CATCH_UP_SECONDS - 1))
    }

    @Test fun `the catch-up window is 24 hours`() {
        // Pinned as a number because it is the same number in four languages
        // (worker, web, iOS, here) and nothing but a test makes them agree.
        assertEquals(24 * 60 * 60L, JobCadence.CATCH_UP_SECONDS)
    }

    // ── pending, and the 1970 guard ───────────────────────────────────────────

    @Test fun `a time still ahead is PENDING`() {
        assertEquals(JobCadence.OneShot.PENDING, state(now + hour))
        assertEquals(JobCadence.OneShot.PENDING, state(now + 1))
    }

    @Test fun `a time that IS now has passed — DUE, not pending`() {
        // `due > nowSec` is strict, so the fire second itself counts as arrived.
        assertEquals(JobCadence.OneShot.DUE, state(now))
    }

    @Test fun `an unusable run_at is UNKNOWN, never a job dated to 1970`() {
        // The worker validates `runAt` only as finite, and a proxied payload can
        // carry 0. Without the guard, 0 is a valid instant 54 years in the past —
        // which classifies as long-MISSED and reads as an abandoned reminder the
        // user never created.
        assertEquals(JobCadence.OneShot.UNKNOWN, state(null))
        assertEquals(JobCadence.OneShot.UNKNOWN, state(0L))
        assertEquals(JobCadence.OneShot.UNKNOWN, state(-5L))
    }

    @Test fun `usableSec is that guard, stated once`() {
        assertEquals(1L, JobCadence.usableSec(1L))
        assertNull(JobCadence.usableSec(0L))
        assertNull(JobCadence.usableSec(-1L))
        assertNull(JobCadence.usableSec(null))
    }

    // ── the words ─────────────────────────────────────────────────────────────

    @Test fun `the abandoned state is worded as an outcome, not as a flag`() {
        // "didn't run" is true for BOTH halves of MISSED (already dropped, and
        // certain to be dropped) and cannot be mistaken for a schedule. "disabled"
        // or "off" would describe the bookkeeping and leave the user to infer the
        // one fact that matters.
        assertEquals("didn't run", JobCadence.prefix(JobCadence.OneShot.MISSED))
    }

    @Test fun `a due job is not labelled with a future tense`() {
        // "once at 09:00" when 09:00 has passed reads as a job still coming, and
        // makes an in-flight run look overdue forever.
        assertEquals("due", JobCadence.prefix(JobCadence.OneShot.DUE))
        assertEquals("once at", JobCadence.prefix(JobCadence.OneShot.PENDING))
    }

    @Test fun `ran is the word for a recorded run, and unknown has no word at all`() {
        assertEquals("ran", JobCadence.prefix(JobCadence.OneShot.RAN))
        // Null, not "?" — the caller owns the fallback, so this cannot invent a
        // second vocabulary for "nothing to say".
        assertNull(JobCadence.prefix(JobCadence.OneShot.UNKNOWN))
    }

    // ── last_fired_at: the field the scheduler overwrites when it gives up ────

    @Test fun `"last" requires a fire behind it`() {
        assertEquals("last", JobCadence.lastFiredWord(1, JobCadence.OneShot.RAN))
    }

    @Test fun `an abandoned job's timestamp is named for what it really is`() {
        // 🔴 skip-stale writes `last_fired_at = now` on a job that never fired, so
        // "last Jan 1, 09:00" beside "fired 0×" named a time the job provably did
        // not run at. It IS worth showing — under its real name.
        assertEquals("switched off", JobCadence.lastFiredWord(0, JobCadence.OneShot.MISSED))
    }

    @Test fun `a never-fired job with nothing true to say says nothing`() {
        // A recurring job that skipped a stale slot also gets `last_fired_at`
        // bumped with no fire, and arrives here at fired == 0 / UNKNOWN. The row's
        // own "fired 0×" already covers it, so adding a stamp would only invite
        // the same misreading in a new place.
        assertNull(JobCadence.lastFiredWord(0, JobCadence.OneShot.UNKNOWN))
        assertNull(JobCadence.lastFiredWord(0, JobCadence.OneShot.PENDING))
        assertNull(JobCadence.lastFiredWord(0, JobCadence.OneShot.DUE))
    }

    // ── tone ──────────────────────────────────────────────────────────────────

    @Test fun `a missed job is warned about, and only live states read as live`() {
        // ⚠️ Android's detail line was ONE gray join, so "didn't run" arrived in
        // exactly the colour of "every 5 min" — the row's only warning was a word
        // the eye slides over. iOS had the mirror-image bug (green
        // unconditionally, so "didn't run" was painted as success).
        assertEquals(JobCadence.Tone.WARN, JobCadence.tone(null, JobCadence.OneShot.MISSED, false))
        assertEquals(JobCadence.Tone.LIVE, JobCadence.tone(null, JobCadence.OneShot.PENDING, true))
        assertEquals(JobCadence.Tone.LIVE, JobCadence.tone(null, JobCadence.OneShot.DUE, true))
        assertEquals(JobCadence.Tone.DONE, JobCadence.tone(null, JobCadence.OneShot.RAN, false))
        assertEquals(JobCadence.Tone.MUTED, JobCadence.tone(null, JobCadence.OneShot.UNKNOWN, true))
    }

    @Test fun `a recurring job is judged by its switch, not by a one-shot state`() {
        // `every 5 min` has no run_at, so its OneShot is always UNKNOWN — reading
        // the state here would mute every live recurring row in the list.
        assertEquals(JobCadence.Tone.LIVE, JobCadence.tone("*/5m", JobCadence.OneShot.UNKNOWN, true))
        assertEquals(JobCadence.Tone.MUTED, JobCadence.tone("*/5m", JobCadence.OneShot.UNKNOWN, false))
    }

    @Test fun `an empty schedule string is not a schedule`() {
        // The payload carries "" for a one-shot (optString's default), and
        // `JobRow.schedule` nulls it — but the rule must not depend on that,
        // because "" would otherwise take the recurring branch and tone every
        // one-shot by its enabled flag: exactly the flag this cycle stopped
        // reading as a run.
        assertEquals(JobCadence.Tone.WARN, JobCadence.tone("", JobCadence.OneShot.MISSED, false))
    }
}
