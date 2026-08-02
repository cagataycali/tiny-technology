package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🎙️ What the phone tells the web agent about a take it was asked to make.
 *
 * The bug this closes was silence: FleetManager.handleEnvelope dropped a
 * {type:"record"} envelope at `type != "invoke"`, and because the relay poll
 * CLAIMS envelopes (CAS delivered=0→1) the request was consumed and destroyed,
 * never retried. nicla_voice_record waited out its whole window and then told the
 * user their phone "may still be recording". It never started.
 *
 * These pin the PURE half — the reply shape, the clamp, the label — because the
 * take itself needs a microphone and Google's recognition service. The wiring
 * (that FleetManager actually calls this, and that the phone advertises `record`)
 * is invisible from here and is pinned in tests/nicla-android-parity.test.ts.
 */
class PhoneRecorderTest {

    private fun ok(text: String, seconds: Int = 10) =
        PhoneRecorder.Take(true, text, "tr-1", seconds)

    // ── The reply the worker tool parses ──────────────────────────────────────

    @Test fun `a take reports what it heard, with its id`() {
        val r = PhoneRecorder.reply(ok("buy milk"))
        assertEquals("tr-1", r.optString("transcriptId"))
        assertTrue(r.optString("result"), r.optString("result").contains("buy milk"))
        assertTrue(r.optString("result").contains("10s"))
        assertFalse(r.has("error"))
    }

    @Test fun `silence is a SUCCESS, not a failure`() {
        // The mic worked and the room was quiet. Reporting that as an error sends
        // the user to check hardware that behaved perfectly — and the tool returns
        // `ok: false` on any `error` key, so this distinction is load-bearing.
        val r = PhoneRecorder.reply(ok("   "))
        assertFalse("silence must not be reported as an error", r.has("error"))
        assertTrue(r.optString("result"), r.optString("result").contains("silence"))
        assertEquals("tr-1", r.optString("transcriptId"))
    }

    @Test fun `NO audioUrl key — Android has no file to host`() {
        // The platform constraint, pinned as a contract. SpeechRecognizer captures
        // in Google's process, so this app never sees the samples; iOS gets an
        // audioUrl because one AVAudioEngine tap feeds recognition AND a file.
        // The tool reads `p.audioUrl` — absent degrades to audio_url: null, while
        // a fabricated or empty URL would render a player over nothing.
        val r = PhoneRecorder.reply(ok("hello"))
        assertFalse("an audioUrl here would be a lie about hosted audio", r.has("audioUrl"))
    }

    @Test fun `a failed take carries BOTH error and result`() {
        // `error` is what makes the tool return ok:false. `result` is the belt:
        // a reply with neither field falls through the tool's parse to its "did
        // not answer" timeout, blaming the network for a refusal this phone
        // already explained.
        val r = PhoneRecorder.reply(
            PhoneRecorder.Take(false, "", "tr-9", 0, "microphone permission is not granted on this phone"),
        )
        assertTrue(r.has("error"))
        assertTrue(r.has("result"))
        assertTrue(r.optString("error"), r.optString("error").contains("permission"))
        // No transcript id: nothing was filed, and handing back an id that
        // resolves to nothing would make nicla_voice_transcript a dead end.
        assertFalse(r.has("transcriptId"))
    }

    @Test fun `a long take is previewed, not dumped whole`() {
        // iOS's 600 chars. The full text lives in the transcript store and the
        // tool's own note tells the agent to fetch it by id.
        val r = PhoneRecorder.reply(ok("x".repeat(5_000)))
        assertTrue(r.optString("result").length < 700)
        assertEquals(600, Regex("x+").find(r.optString("result"))!!.value.length)
    }

    // ── The clamp: an envelope is not a trusted input ─────────────────────────

    @Test fun `seconds are clamped at BOTH ends`() {
        assertEquals(10, PhoneRecorder.clampSeconds(null))     // iOS's default
        assertEquals(10, PhoneRecorder.clampSeconds(10))
        assertEquals(120, PhoneRecorder.clampSeconds(120))
        // A relay payload reaches this phone from anything holding the internal
        // key. Unclamped, `seconds: 86400` holds the microphone for a day.
        assertEquals(120, PhoneRecorder.clampSeconds(86_400))
        // 0 is what optInt returns for a missing/garbage field — it must not mean
        // "record nothing", which would reply "heard nothing (silence)" and look
        // like a quiet room rather than a malformed request.
        assertEquals(5, PhoneRecorder.clampSeconds(0))
        assertEquals(5, PhoneRecorder.clampSeconds(-30))
    }

    @Test fun `the clamp matches the worker tool's own bounds`() {
        // Two clamps, one range: the tool clamps 5..120 before sending and this
        // clamps again on arrival. If they disagreed, a 120s request would come
        // back as a shorter take with no explanation of the difference.
        assertEquals(5, PhoneRecorder.MIN_SECONDS)
        assertEquals(120, PhoneRecorder.MAX_SECONDS)
    }

    // ── The label the USER later reads ────────────────────────────────────────

    @Test fun `a take with no reason is still labelled`() {
        // This is the line in the user's transcript list explaining why their
        // phone turned its microphone on. Empty is not an acceptable answer.
        assertEquals("web agent", PhoneRecorder.label(null))
        assertEquals("web agent", PhoneRecorder.label(""))
        assertEquals("web agent", PhoneRecorder.label("   "))
    }

    @Test fun `a given reason is kept, trimmed and bounded`() {
        assertEquals("what did I just say", PhoneRecorder.label("  what did I just say  "))
        assertEquals(200, PhoneRecorder.label("z".repeat(500)).length)
    }

    // ── One microphone ────────────────────────────────────────────────────────

    @Test fun `the mic is claimed by one owner at a time`() {
        assertTrue(MicClaim.claim("recorder"))
        // Voice chat asking now must lose — two capture sessions shred both
        // transcripts. iOS gets this free from the shared AVAudioSession.
        assertFalse(MicClaim.claim("voice"))
        assertEquals("recorder", MicClaim.heldBy)
        MicClaim.release("recorder")
        assertFalse(MicClaim.busy)
        assertTrue(MicClaim.claim("voice"))
        MicClaim.release("voice")
    }

    @Test fun `a late release cannot free someone else's claim`() {
        // The ordering that matters: a finished take's teardown arriving after a
        // new owner took the mic must NOT release it, or a third session gets in
        // on top of a live one.
        assertTrue(MicClaim.claim("recorder"))
        MicClaim.release("recorder")
        assertTrue(MicClaim.claim("voice"))
        MicClaim.release("recorder")            // the late, stale teardown
        assertEquals("voice — a stale release stole the claim", "voice", MicClaim.heldBy)
        MicClaim.release("voice")
    }

    // ── A take you can stop, that reports how long it really was ────────────

    @Test fun `a stopped take reports what it ran, not what it asked for`() {
        // The lie this closes: storing the REQUESTED window would label a
        // 4-second stopped-early take as 120 seconds in the reply the agent
        // reads, in the transcript store, and in the server's duration column.
        assertEquals(4, PhoneRecorder.actualSeconds(4_000, 120))
        assertEquals(37, PhoneRecorder.actualSeconds(37_400, 120))
    }

    @Test fun `a stop inside the first tick is not a zero-second take`() {
        // Floor of 1. A "0s" take reads as a failure in the list, when in fact
        // the mic worked and the user simply changed their mind immediately.
        assertEquals(1, PhoneRecorder.actualSeconds(0, 120))
        assertEquals(1, PhoneRecorder.actualSeconds(120, 120))
    }

    @Test fun `the measured length never exceeds the window`() {
        // The recognizer's settle delay runs PAST the deadline, so raw elapsed
        // time would report a 10s take as 11s — a take longer than the one that
        // was allowed, which the worker tool's own clamp would then reject.
        assertEquals(10, PhoneRecorder.actualSeconds(10_700, 10))
        assertEquals(120, PhoneRecorder.actualSeconds(999_999, 120))
    }

    @Test fun `the length is rounded, not truncated`() {
        // Truncation reports every take as up to a second short; a 5.6s take is
        // "6s" to the person who just spoke it.
        assertEquals(6, PhoneRecorder.actualSeconds(5_600, 120))
        assertEquals(5, PhoneRecorder.actualSeconds(5_400, 120))
    }

    @Test fun `a degenerate window still yields a legal length`() {
        // coerceIn throws when its range is inverted, and a 0 window would do
        // exactly that — a crash inside a take's teardown, where nothing is
        // watching, on a phone whose clock did something strange.
        assertEquals(1, PhoneRecorder.actualSeconds(9_000, 0))
        assertEquals(1, PhoneRecorder.actualSeconds(0, 0))
    }

    @Test fun `stopEarly is ignored when no take is running`() {
        // A stop with nothing to stop must not arm the flag: it would sit set
        // and kill the NEXT take on its first tick.
        PhoneRecorder.stopEarly()
        assertFalse("a stop with no take running started one", PhoneRecorder.isRecording.value)
    }

    @Test fun `the stop slice is fine enough for Stop to feel instant`() {
        // A take used to sleep straight to its deadline; the slice IS the stop
        // path. Anything approaching a second reads as an unresponsive button.
        assertTrue("stop granularity is too coarse", PhoneRecorder.STOP_TICK_MS <= 250)
        assertTrue("a zero/negative tick would spin the CPU", PhoneRecorder.STOP_TICK_MS > 0)
    }

    // ── The meter: proof the mic is really hearing something ────────────────

    @Test fun `silence and loud speech land at opposite ends of the meter`() {
        // Android documents no range for onRmsChanged; in practice it runs about
        // -2 to 10. A bar fed raw dB sits pinned at one end and proves nothing.
        assertEquals(0f, PhoneRecorder.meterLevel(-2f), 0.001f)
        assertEquals(1f, PhoneRecorder.meterLevel(10f), 0.001f)
        assertEquals(0.5f, PhoneRecorder.meterLevel(4f), 0.001f)
    }

    @Test fun `an out-of-range reading cannot push the meter off its scale`() {
        // The range is undocumented, so a phone reporting -50 or 200 is not a
        // bug to crash on — it is a bar drawn outside its own frame.
        assertEquals(0f, PhoneRecorder.meterLevel(-50f), 0.001f)
        assertEquals(1f, PhoneRecorder.meterLevel(200f), 0.001f)
    }

    @Test fun `the meter rises with the voice`() {
        // Monotonic, or the bar moves the wrong way as the user speaks up.
        val steps = listOf(-2f, 0f, 2f, 4f, 6f, 8f, 10f).map { PhoneRecorder.meterLevel(it) }
        assertEquals(steps.sorted(), steps)
        assertEquals("silence and speech must not read alike", 7, steps.toSet().size)
    }
}
