package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

    // ── WHICH microphone heard it ─────────────────────────────────────────────
    //
    // c66 routed this rail through the glasses; nothing said so. A take made
    // through a headset on the user's face and a take made through the phone in
    // their pocket produced byte-identical replies, and the tool's own text told
    // the agent the phone "records through its own mic" either way. The words
    // arrive in both cases — only the ROOM differs, and nothing else in the reply
    // can reveal it.

    @Test fun `the reply says WHICH microphone heard the take`() {
        val r = PhoneRecorder.reply(ok("buy milk").copy(micRoute = "bluetooth"))
        assertEquals("bluetooth", r.optString("micRoute"))
    }

    @Test fun `the phone's own mic is reported just as explicitly`() {
        // Not an absence. "phone" is a POSITIVE answer — the agent may say the
        // phone heard it — and it must be distinguishable from "nobody knows".
        val r = PhoneRecorder.reply(ok("buy milk").copy(micRoute = "phone"))
        assertEquals("phone", r.optString("micRoute"))
    }

    @Test fun `a take that never opened a mic reports NO route, rather than guessing`() {
        // The failure constructors leave it null: no recognizer, no permission, mic
        // busy. A defaulted "phone" there would claim the built-in mic heard the
        // silence of a take that never ran — and the tool would pass that on.
        assertFalse(
            "an unknown route must be absent, not defaulted",
            PhoneRecorder.reply(ok("buy milk")).has("micRoute"),
        )
        val failed = PhoneRecorder.reply(
            PhoneRecorder.Take(false, "", "tr-1", 0, "microphone permission is not granted on this phone"),
        )
        assertFalse(failed.has("micRoute"))
    }

    @Test fun `the route words are meta_listen's words, exactly`() {
        // The agent compares this field across rails by string equality, so the
        // SPELLING is the contract: WearablesListener posts "bluetooth"/"phone"
        // and iOS's MicRoute.current() returns the same two. "bt" or "headset"
        // would be a different fact to any reader — and would look correct in
        // every file that produced it.
        assertEquals("bluetooth", PhoneRecorder.route(viaBluetooth = true))
        assertEquals("phone", PhoneRecorder.route(viaBluetooth = false))
    }

    @Test fun `the route follows the LINK, not the rail that raised it`() {
        // `route()` is asked about BtMic's state, not about this rail's own
        // "did I call acquire" flag — a take that rode a link the HUD had already
        // raised hears the headset just as much as one that raised it itself.
        BtMic.clearHolders()
        assertEquals("phone", PhoneRecorder.route(BtMic.active))
        BtMic.noteHolder("hud-transcript") // another rail's link
        assertEquals("bluetooth", PhoneRecorder.route(BtMic.active))
        BtMic.clearHolders()
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

    // ── A take that ends when the SPEAKER does, not when a guess runs out ───
    //
    // `seconds` became a FLOOR for the wake path: someone who says the wake word
    // and then talks for thirty seconds used to keep the first ten, with nothing
    // in the stored row saying it had been cut. These pin the whole stop rule,
    // which is why it is pure and takes its clock as a parameter — a microphone
    // is not available here and never will be.

    /** t=0 start, a 10s floor, extension allowed to the 120s ceiling. */
    private fun extend(
        nowMs: Long,
        lastGrowthMs: Long = 0L,
        stop: Boolean = false,
        floorS: Int = 10,
        capS: Int = PhoneRecorder.MAX_SECONDS,
    ) = PhoneRecorder.shouldExtend(nowMs, floorS * 1000L, capS * 1000L, lastGrowthMs, stop)

    @Test fun `the take runs its full window before extension is even a question`() {
        // Inside the floor, growth is irrelevant: a take asked for 10s gets 10s
        // whether or not anyone spoke. Held at 9.9s, the last tick that matters.
        assertTrue(extend(0))
        assertTrue("a silent take was cut short of what it asked for", extend(9_900))
    }

    @Test fun `words still arriving carry the take past its deadline`() {
        // 🔴 THE GAP. At the 10s deadline with a word 0.5s ago, the old loop
        // stopped and the rest of the sentence was never recorded.
        assertTrue(extend(10_000, lastGrowthMs = 9_500))
        assertTrue("a take stopped mid-sentence", extend(40_000, lastGrowthMs = 39_000))
    }

    @Test fun `silence past the deadline ends the take`() {
        // The other half: without this it is an open microphone. 3s of no NEW
        // words is the speaker being done, so the take must not linger.
        assertFalse(extend(14_000, lastGrowthMs = 10_000))
        // And the boundary itself is closed — exactly the grace is already over.
        assertFalse(extend(13_000, lastGrowthMs = 10_000))
        assertTrue("the grace ended a beat too early", extend(12_900, lastGrowthMs = 10_000))
    }

    @Test fun `the hard cap outranks words that never stop`() {
        // ⚠️ A noisy room produces words forever. A take that never ends never
        // uploads, never transcribes and never gives the mic back — worse than a
        // truncated one. So growth 0.1s ago still loses at the ceiling.
        assertFalse(
            "an extending take outlived the ceiling",
            extend(120_000, lastGrowthMs = 119_900),
        )
        assertFalse(extend(600_000, lastGrowthMs = 599_900))
    }

    @Test fun `the user's Stop beats every other rule`() {
        // Checked FIRST, so it wins even inside the floor, where the take is
        // otherwise unconditionally allowed to continue.
        assertFalse("Stop was ignored inside the requested window", extend(1_000, stop = true))
        assertFalse(extend(10_500, lastGrowthMs = 10_400, stop = true))
    }

    @Test fun `a take that never extends stops exactly at its window`() {
        // The default path (relay, manual, memo): floor == cap, so the take ends
        // at its deadline no matter how much is being said. This is the contract
        // nicla_voice_record depends on — it polls for `seconds + 25`.
        assertTrue(extend(9_900, lastGrowthMs = 9_800, floorS = 10, capS = 10))
        assertFalse(
            "a take nobody opted in for ran past its window",
            extend(10_000, lastGrowthMs = 9_900, floorS = 10, capS = 10),
        )
    }

    // ── The opt-in gate, which is a function precisely so it can be pinned ──

    @Test fun `only an opted-in take may outrun what it asked for`() {
        // ⚠️ iOS's own harness lesson, ported with the code: with this decision
        // inline in record(), a mutation that let EVERY take extend passed the
        // whole suite. The gate was unreachable from a test, so it was unprotected
        // — and it is the gate that keeps the relay's budget honest.
        assertEquals(10, PhoneRecorder.hardCapSeconds(10, extendWhileSpeaking = false))
        assertEquals(120, PhoneRecorder.hardCapSeconds(10, extendWhileSpeaking = true))
    }

    @Test fun `extension is OFF by default — the budgeted callers are untouched`() {
        // nicla_voice_record polls the relay for only `seconds + 25`. A take that
        // extended to two minutes would answer an agent that had already given up:
        // the transcript stored, the caller told it timed out. Only the wake path,
        // with nobody waiting, opts in — and it does so explicitly.
        assertEquals(30, PhoneRecorder.hardCapSeconds(30, false))
    }

    @Test fun `an extended take can never outlast one that asked for the maximum`() {
        // The ceiling is the SAME number in both directions, so "extend" can only
        // ever reach a length some caller could have requested outright.
        assertEquals(
            PhoneRecorder.hardCapSeconds(PhoneRecorder.MAX_SECONDS, false),
            PhoneRecorder.hardCapSeconds(5, true),
        )
        assertEquals(PhoneRecorder.MAX_SECONDS, PhoneRecorder.hardCapSeconds(5, true))
    }

    @Test fun `the grace crosses a pause between sentences without holding the mic`() {
        // Measured around 1s in normal speech, so anything under ~2s would cut
        // people off mid-thought; anything approaching the floor itself would
        // make every take an extended one.
        assertTrue("too short to cross a breath", PhoneRecorder.SILENCE_GRACE_MS >= 2_000L)
        assertTrue("the mic sits open after the room goes quiet", PhoneRecorder.SILENCE_GRACE_MS <= 5_000L)
        // And it must be far coarser than the tick that samples it, or growth
        // would be judged on a single slice of recognizer latency.
        assertTrue(PhoneRecorder.SILENCE_GRACE_MS > PhoneRecorder.STOP_TICK_MS * 5)
    }

    @Test fun `an extended take still reports the length it really ran`() {
        // The window passed to actualSeconds is the HARD CAP now, not what was
        // asked for: clamped to `secs`, every 40-second wake take would be filed,
        // replied and stored as 10 — the same lie a fixed 10s take used to tell.
        val cap = PhoneRecorder.hardCapSeconds(10, extendWhileSpeaking = true)
        assertEquals(40, PhoneRecorder.actualSeconds(40_000, cap))
        // …while the un-extended take is still bounded by its own window.
        assertEquals(10, PhoneRecorder.actualSeconds(40_000, PhoneRecorder.hardCapSeconds(10, false)))
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

    // ── The words: what a take has heard so far ──────────────────────────────

    @Test fun `the take's words are published, not kept inside the recognizer`() {
        // 🔴 THE GAP this closes: `partial` was a local `var` inside `listen()` and
        // never escaped, so both Record buttons drew ten bars over no text. A meter
        // proves the mic hears SOMETHING; only words prove it hears YOU. Reading the
        // flow at all is the pin — the type is what makes a UI able to collect it.
        val words: kotlinx.coroutines.flow.StateFlow<String> = PhoneRecorder.partial
        assertNotNull("the take's words are unreachable from any screen", words.value)
    }

    @Test fun `no take running means no words on screen`() {
        // ⚠️ Nothing may sit here between takes. The published text is what a card
        // renders as "the mic is hearing this right now", so a leftover sentence
        // would be the previous take's words presented as live ones — and after a
        // FAILED take (mic busy, permission denied) it would look like a recording
        // in progress that no button can stop.
        assertFalse("a take is running in a unit test", PhoneRecorder.isRecording.value)
        assertEquals("words left behind with no take running", "", PhoneRecorder.partial.value)
        // The meter's own resting state, for the same reason and beside it.
        assertEquals(0f, PhoneRecorder.level.value, 0.001f)
    }

    @Test fun `a refused take leaves no words behind`() {
        // ⚠️ record() has three early returns BEFORE the mic is claimed (no
        // recognizer, no permission, mic busy) and they bypass the `finally` that
        // clears this. They must be harmless — which they are only because the
        // clear ALSO happens where the claim succeeds. Held with the mic taken by
        // someone else, which is the reachable one of the three in a JVM test.
        assertTrue(MicClaim.claim("voice"))
        try {
            assertEquals("a refusal left words on screen", "", PhoneRecorder.partial.value)
            assertFalse(PhoneRecorder.isRecording.value)
        } finally {
            MicClaim.release("voice")
        }
    }

    // ── The fallback rail's budget ────────────────────────────────────────────
    //
    // The rail that files NO row, so anything the worker truncates is gone with no
    // id to fetch the rest with. These are the only tests in the app that assert
    // against a cap living in someone else's repo, so they say WHERE it lives:
    // worker `devices.ts` DeviceEventCall slices a client's detail to 240 BEFORE
    // prepending the device name, which is why 240 binds and `emitEvent`'s 300 —
    // the number the route advertises, and the number iOS budgets against — is
    // never reached.

    /** What the worker keeps of a client's detail, transcribed from devices.ts. */
    private fun railKeeps(detail: String) = detail.take(PhoneRecorder.NOTE_DETAIL_MAX)

    @Test fun `the note line survives the ring at the worst label the agent can send`() {
        // 200 chars is not a synthetic input: it is exactly what PhoneRecorder.label
        // permits, and `reason` is free text written by an agent.
        val d = PhoneRecorder.noteDetail(PhoneRecorder.label("r".repeat(500)), "x".repeat(4000))
        assertEquals(
            "the worker cuts ${d.length - PhoneRecorder.NOTE_DETAIL_MAX} chars off the tail, " +
                "and this rail files no row to fetch them from",
            d, railKeeps(d),
        )
    }

    @Test fun `the speech is what the budget is spent on, not the label`() {
        val d = PhoneRecorder.noteDetail("r".repeat(500), "the roof guy comes tuesday at nine")
        assertTrue(
            "the words were pushed out by a label the agent already knows: $d",
            d.contains("the roof guy comes tuesday at nine"),
        )
        assertFalse(
            "the label ran past its own bound",
            d.contains("r".repeat(PhoneRecorder.NOTE_LABEL_MAX + 1)),
        )
    }

    @Test fun `a long take SPENDS the room the budget found, not a fixed 180`() {
        // ⚠️ THIS IS THE HALF A ">= 180" ASSERTION CANNOT SEE, and a mutant proved
        // it: with the label bounded at 40, `text.take(180)` never OVERFLOWS the
        // ring — it just silently leaves 13–49 chars of the budget unspent, every
        // time, on every label this app actually generates. So the assertion has to
        // be that the room is USED, not merely that 180 survived. Measured:
        //   memo → 229 chars of speech fit, manual → 227, web agent → 224,
        //   wake: hey tiny → 219, necklace-live → 220.
        for (label in listOf("memo", "manual", "web agent", "wake: hey tiny", "necklace-live")) {
            val d = PhoneRecorder.noteDetail(label, "x".repeat(4000))
            assertEquals("$label overshot the ring", d, railKeeps(d))
            val words = d.count { it == 'x' }
            assertTrue(
                "$label left ${PhoneRecorder.NOTE_DETAIL_MAX - d.length} chars of the " +
                    "budget unspent — the words were cut at $words, not at what fits",
                d.length == PhoneRecorder.NOTE_DETAIL_MAX,
            )
            assertTrue("$label carries fewer words than the old take(180) did", words > 180)
        }
    }

    @Test fun `the emoji is counted in the units the worker slices in`() {
        // 🎙️ is U+1F399 U+FE0F — ONE grapheme, THREE utf-16 units. Kotlin's `take`
        // and the worker's String.slice are both utf-16, so a budget computed here
        // agrees with the cut there by construction. iOS budgets in graphemes and
        // is 2 chars over its own cap for this exact reason.
        assertEquals("🎙️ is no longer 3 utf-16 units — re-measure the shell", 3, "🎙️".length)
        val d = PhoneRecorder.noteDetail("memo", "é".repeat(4000))
        assertEquals("a multi-byte take overshot the ring", d, railKeeps(d))
    }

    @Test fun `a short take passes through unaltered`() {
        // No padding, no truncation, and the shape the agent's prompt already reads.
        assertEquals("🎙️ memo: “hello”", PhoneRecorder.noteDetail("memo", "hello"))
    }

    @Test fun `no label, however long, can take the speech below its floor`() {
        // ⚠️ THE PROPERTY THE DEAD `maxOf` FLOOR ONLY LOOKED LIKE IT PROVIDED. Two
        // mutants — deleting the floor, and setting it to 0 — both left every test
        // green, because with the label bounded FIRST the room can never fall to 40
        // from any input. So the guarantee is structural, and this asserts it
        // against the bound rather than against a guard nothing reaches: iOS needs a
        // real floor because its line reserves an unbounded audio URL; this line has
        // no URL, so the label bound alone fixes the arithmetic.
        for (label in listOf("", "memo", "r".repeat(40), "r".repeat(200), "r".repeat(5000))) {
            val d = PhoneRecorder.noteDetail(label, "x".repeat(4000))
            assertTrue(
                "a ${label.length}-char label squeezed the speech to ${d.count { it == 'x' }}",
                d.count { it == 'x' } >= PhoneRecorder.MIN_NOTE_PREVIEW,
            )
            assertEquals("a ${label.length}-char label overshot the ring", d, railKeeps(d))
        }
        // And the number that bound buys is worth stating: 193 chars of speech at the
        // very worst label, against the 180 the old fixed slice gave at the best one.
        // 192 chars of speech at the very worst label, against the 180 the old fixed
        // slice gave at the BEST one. ⚠️ 192, not 193: 🎙️ is THREE utf-16 units (a
        // surrogate pair plus U+FE0F), and counting it as two is how this constant was
        // first written — caught here, which is the point of measuring in a test.
        assertEquals("the label bound moved — re-measure what it costs the speech", 192, PhoneRecorder.MIN_NOTE_PREVIEW)
        assertTrue("the worst case now carries less than the old fixed 180", PhoneRecorder.MIN_NOTE_PREVIEW > 180)
    }

    @Test fun `the budget defends the cap that BINDS, not the one advertised`() {
        // ⚠️ THE FINDING, pinned as arithmetic so it cannot be "corrected" back to
        // 300 by reading events.ts alone. The chain is route(300) →
        // DeviceEventCall(`name: ` + detail.slice(0,240)) → emitEvent(300).
        assertEquals("the binding cap moved — re-measure the whole chain", 240, PhoneRecorder.NOTE_DETAIL_MAX)
        // Why step 3 can never bind: the longest thing it can ever see.
        assertTrue(
            "40-char name + separator + 240 now exceeds emitEvent's 300",
            40 + 2 + PhoneRecorder.NOTE_DETAIL_MAX <= 300,
        )
    }
}
