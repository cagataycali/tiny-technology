package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Activity HUD `ago()` — the relative-age formatter shown on each event row
 * (⚡ Activity sheet). Pure, `now`-injectable logic that must render IDENTICALLY
 * to web ActivityHUD.ago() and iOS EventGlyph.ago(), the twin this mirrors:
 *   - buckets seconds → s / m / h / d (integer-floored, no rounding)
 *   - a non-positive/garbage `created` floors to "1s", never a bogus huge value
 * Android's signature is ago(created: seconds, nowMs: millis) — `created` is
 * seconds-since-epoch off /api/events, `nowMs` is System.currentTimeMillis().
 * This is the function's first-ever coverage (it shipped untested; iOS pins it).
 */
class ActivityAgoTest {

    // nowMs = 1e9 ms → nowMs/1000 = 1_000_000 s, the same anchor iOS uses.
    private val nowMs = 1_000_000_000L

    @Test fun `buckets seconds into s m h d — iOS EventGlyph parity`() {
        assertEquals("5s", ago(created = 1_000_000L - 5, nowMs = nowMs))
        assertEquals("2m", ago(created = 1_000_000L - 120, nowMs = nowMs))
        assertEquals("2h", ago(created = 1_000_000L - 7200, nowMs = nowMs))
        assertEquals("2d", ago(created = 1_000_000L - 172_800, nowMs = nowMs))
    }

    @Test fun `unit boundaries roll over at 60s 3600s 86400s`() {
        assertEquals("59s", ago(created = 1_000_000L - 59, nowMs = nowMs))
        assertEquals("1m", ago(created = 1_000_000L - 60, nowMs = nowMs))
        assertEquals("59m", ago(created = 1_000_000L - 3599, nowMs = nowMs))
        assertEquals("1h", ago(created = 1_000_000L - 3600, nowMs = nowMs))
        assertEquals("23h", ago(created = 1_000_000L - 82_800, nowMs = nowMs))
        assertEquals("1d", ago(created = 1_000_000L - 86_400, nowMs = nowMs))
    }

    @Test fun `division floors — never rounds up to the next bucket`() {
        // 119s is 1m59s → "1m", not "2m"; 7199s is 1h59m → "1h".
        assertEquals("1m", ago(created = 1_000_000L - 119, nowMs = nowMs))
        assertEquals("1h", ago(created = 1_000_000L - 7199, nowMs = nowMs))
        assertEquals("1d", ago(created = 1_000_000L - 172_799, nowMs = nowMs))
    }

    @Test fun `a non-positive or future created floors to 1s — never a bogus value`() {
        // created <= 0 (missing/garbage timestamp) → the "1s" guard, matching
        // web's `n > 0 ? … : 1` and iOS's `created > 0` branch.
        assertEquals("1s", ago(created = 0L, nowMs = nowMs))
        assertEquals("1s", ago(created = -5L, nowMs = nowMs))
        // A future/equal timestamp would compute <= 0 seconds; maxOf(1, …) floors it.
        assertEquals("1s", ago(created = 1_000_000L, nowMs = nowMs))
        assertEquals("1s", ago(created = 1_000_005L, nowMs = nowMs))
    }

    // ── iconFor: event-kind → glyph, matched by PREFIX. Byte-twin of iOS
    // EventGlyph.icon(for:) (pinned by EventGlyphTests, TinyTests.swift:566-584)
    // and web iconFor (lib/chat/event-icons.ts). Shipped untested on Android;
    // this mirrors the iOS suite exactly. The load-bearing case is tiny_visit —
    // it MUST be keyed in full because the row is keyed off "tiny", so a bare
    // "visit" prefix would never reach it and 👀 would silently fall to ⚡.

    @Test fun `iconFor matches by prefix — job and telegram cover their sub-kinds`() {
        // `job` covers job_result/job_error; `telegram` covers all telegram_*.
        assertEquals("⏰", iconFor("job_result"))
        assertEquals("⏰", iconFor("job_error"))
        assertEquals("✈️", iconFor("telegram_out"))
        assertEquals("✈️", iconFor("telegram_button"))
        assertEquals("🤝", iconFor("follow"))
        assertEquals("💬", iconFor("dm"))
    }

    @Test fun `iconFor resolves tiny_visit to eyes — the full-key branch`() {
        // If someone "cleaned up" this key to a bare "visit", the kind starts
        // with "tiny" so it would never match → 👀 unreachable behind ⚡. This
        // test is the guard against that regression (iOS tinyVisitResolvesToEyes).
        assertEquals("👀", iconFor("tiny_visit"))
    }

    @Test fun `iconFor resolves device_result to the laptop`() {
        // 💻 A use_device task whose reply landed after the 45s wait (worker
        // relay.ts buildLateReplyEvent). The event ring is the only surface a
        // late completion reaches, so no glyph = the finished work reads as
        // generic ⚡ noise. iOS lateDeviceResultResolvesToLaptop.
        assertEquals("💻", iconFor("device_result"))
    }

    @Test fun `iconFor degrades an unknown or empty kind to the bolt`() {
        assertEquals("⚡", iconFor("wat"))
        assertEquals("⚡", iconFor(""))
    }

    // ⚠️ THE GAP THESE TWO PIN (mirrors tests/event-icons.test.ts and iOS
    // everyEmittedKindHasAGlyph). ⚡ is the right answer for a kind a newer worker
    // invented and the wrong answer for one we ship — and on screen they are the
    // same pixels, so nothing failed while `pay_alarm` ("🚨 x402 reconciliation
    // needs a human", swept every minute by the worker) rendered exactly like a
    // corrupt event. The fallback is deliberate and unchanged; the ROSTER
    // (EMITTED_KINDS) is what turns a missing glyph into a red test.

    @Test fun `every kind the worker emits has a real glyph, not the fallback`() {
        for (kind in EMITTED_KINDS) {
            assertEquals("$kind falls through to the bolt — add a KIND_ICONS entry", false, iconFor(kind) == "⚡")
        }
    }

    /**
     * 💵 The four money kinds each say something different — "you were paid" vs
     * "your payout landed" vs "your payout bounced and came back". The ring is
     * often the only place the user learns any of them, since the worker's payment
     * paths notified through no rail at all until money-events.ts. A shared glyph
     * would collapse a refund into an earning at a glance.
     */
    @Test fun `each money kind has its own glyph and is on the roster`() {
        val money = listOf("pay_earned", "pay_received", "pay_withdrawn", "pay_refunded")
        val glyphs = money.map { iconFor(it) }
        assertEquals("money kinds share a glyph: $glyphs", money.size, glyphs.toSet().size)
        for (kind in money) {
            assertEquals("$kind missing from the roster", true, EMITTED_KINDS.contains(kind))
        }
    }

    /**
     * ⛔ A job that will NEVER run must not wear the glyph of a job that did.
     *
     * `job` is a KIND_ICONS key and a real prefix of `job_missed`, so a matcher
     * that walks the map in declaration order hands the ⏰ of a completed run to
     * the one event meaning "this never happened and never will". Same shape as
     * the menu bar's checkmark-on-a-failure: the more specific key only wins
     * because iconFor sorts by key length, and that sort is what this pins.
     */
    @Test fun `job_missed keeps its own glyph and does not inherit the job prefix`() {
        assertEquals(true, EMITTED_KINDS.contains("job_missed"))
        assertEquals("⛔", iconFor("job_missed"))
        assertEquals("job_missed inherited the glyph of a job that ran", false,
            iconFor("job_missed") == iconFor("job_result"))
        // The ordinary job kinds still collapse onto the shared clock.
        assertEquals(iconFor("job_error"), iconFor("job_result"))
    }

    @Test fun `pay_alarm is the siren and nothing else is`() {
        // Distinctness is the requirement, not the emoji: a reconciliation page
        // sharing a glyph with page views is a page nobody reads.
        assertEquals("🚨", iconFor("pay_alarm"))
        for (kind in EMITTED_KINDS.filter { it != "pay_alarm" }) {
            assertEquals("$kind also renders the siren", false, iconFor(kind) == "🚨")
        }
    }
}
