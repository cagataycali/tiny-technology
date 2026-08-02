package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules that make the necklace's own microphone transcribe to WORDS instead
 * of to nothing — iOS `7d81ac87` + `f0c524dd` ported.
 *
 * Every one of these fails silently in production: the stream still plays, the
 * card still says "live", and the transcript is empty or quietly doubled. iOS
 * found all of them by measuring real captures of the board rather than by
 * reasoning, so these tests encode the MEASUREMENTS, not the intentions.
 */
class LiveTranscribeTest {

    // ---- decode + DC removal -------------------------------------------------

    @Test
    fun `decodes little-endian PCM16, not big-endian`() {
        // 0x0100 LE = 256. Read the other way it is 1 — a 256× level error that
        // makes every gain decision below wrong, and does not crash.
        val out = FloatArray(4)
        val n = LiveTranscribe.decode(byteArrayOf(0x00, 0x01, 0x00, 0x01), 4, out)
        assertEquals(2, n)
        // Both samples are identical, so DC removal zeroes them — the level, not
        // the sign, is what this proves; see the next test for the signed path.
        assertEquals(0f, out[0], 1e-6f)
    }

    @Test
    fun `keeps the sign bit — a negative sample is not read as a huge positive`() {
        // 0xFFFF LE = -1. Read unsigned it is 65535, i.e. +2.0 after scaling:
        // every negative half-cycle of speech would invert.
        val out = FloatArray(8)
        // -1, -1, +32767, +32767 → mean is positive; the first two must stay below it.
        val bytes = byteArrayOf(
            0xFF.toByte(), 0xFF.toByte(),
            0xFF.toByte(), 0x7F.toByte(),
        )
        val n = LiveTranscribe.decode(bytes, 4, out)
        assertEquals(2, n)
        assertTrue("the negative sample did not stay below the mean", out[0] < out[1])
    }

    @Test
    fun `removes the microphone's DC offset — the board sits ~500-800 counts high`() {
        // A constant offset with no signal must decode to silence. Left in, it is
        // 40% of the board's measured "quiet" spectrum and it eats the headroom
        // the makeup gain needs.
        val out = FloatArray(64)
        val bytes = ByteArray(128)
        for (i in 0 until 64) {                 // 886 counts, the measured offset
            bytes[i * 2] = (886 and 0xFF).toByte()
            bytes[i * 2 + 1] = ((886 shr 8) and 0xFF).toByte()
        }
        val n = LiveTranscribe.decode(bytes, 128, out)
        assertEquals(64, n)
        assertEquals("a pure DC offset should decode to silence", 0f, LiveTranscribe.rms(out, n), 1e-6f)
    }

    @Test
    fun `DC removal is what makes level measurable at all`() {
        // The trap iOS documented: with the offset left in, a chunk's RMS is
        // dominated by the constant (0.024 vs 0.0004 of real signal), so a quiet
        // chunk and a spoken one measure the SAME — which is how an energy gate
        // built on top of this can look sensible and be completely inert.
        val out = FloatArray(64)
        fun rmsOf(signal: Int): Float {
            val b = ByteArray(128)
            for (i in 0 until 64) {
                val v = 886 + if (i % 2 == 0) signal else -signal
                b[i * 2] = (v and 0xFF).toByte()
                b[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
            }
            return LiveTranscribe.rms(out, LiveTranscribe.decode(b, 128, out))
        }
        val quiet = rmsOf(2)
        val speech = rmsOf(300)
        assertTrue("speech must measure louder than silence once DC is gone", speech > quiet * 10)
    }

    @Test
    fun `a short read is honoured — no reading past what arrived`() {
        // The stream hands back partial chunks constantly; decoding the whole
        // buffer would feed the recognizer the previous chunk's tail on repeat.
        val out = FloatArray(8)
        assertEquals(1, LiveTranscribe.decode(ByteArray(16), 2, out))
        assertEquals(0, LiveTranscribe.decode(ByteArray(16), 1, out))  // half a sample
        assertEquals(0, LiveTranscribe.decode(ByteArray(16), 0, out))
    }

    // ---- makeup gain ---------------------------------------------------------

    @Test
    fun `the board's native level is lifted about ten times`() {
        // -40 dBFS ≈ 0.01 RMS, which transcribed to NOTHING before this existed;
        // the target is about -21 dBFS.
        val g = LiveTranscribe.gainFor(0.01f, 1f)
        assertTrue("expected roughly 9x, got $g", g > 6f && g < 12f)
    }

    @Test
    fun `a stream already loud enough passes through untouched`() {
        // Never attenuate: this must be a no-op inside the -15…-30 dBFS window a
        // recognizer reads cleanly, or it damages audio that was already fine.
        assertEquals(1f, LiveTranscribe.gainFor(0.2f, 1f), 1e-6f)
    }

    @Test
    fun `gain is bounded — a near-silent chunk cannot ask for thousands`() {
        assertEquals(LiveTranscribe.GAIN_MAX, LiveTranscribe.gainFor(0.002f, 1f), 1e-6f)
        assertTrue(LiveTranscribe.GAIN_MAX <= 20f)
    }

    @Test
    fun `below the noise gate the previous gain is KEPT, not reset`() {
        // A pause between sentences is not a reason to re-learn the room. Resetting
        // here is what makes the level pump audibly between words.
        assertEquals(7f, LiveTranscribe.gainFor(LiveTranscribe.NOISE_GATE / 2f, 7f), 1e-6f)
    }

    @Test
    fun `the peak-hold tracks speech, not room noise`() {
        // The whole reason this is a peak-hold and not an RMS-chasing AGC: after a
        // loud word, quiet chunks must NOT immediately win the estimate, or the
        // gain hands the quiet room a huge multiplier and flattens the contrast.
        var hold = 0f
        hold = LiveTranscribe.nextPeakHold(hold, 0.2f)       // a word
        assertEquals(0.2f, hold, 1e-6f)
        repeat(5) { hold = LiveTranscribe.nextPeakHold(hold, 0.001f) }  // quiet
        assertTrue("the estimate collapsed to room noise: $hold", hold > 0.15f)
    }

    @Test
    fun `the peak-hold does decay, so it follows someone walking away`() {
        var hold = 0.5f
        repeat(200) { hold = LiveTranscribe.nextPeakHold(hold, 0f) }
        assertTrue("a stuck peak-hold pins the gain at 1x forever: $hold", hold < 0.02f)
        assertTrue(LiveTranscribe.PEAK_DECAY < 1f)
    }

    @Test
    fun `this chunk is clamped against its own peak BEFORE it is written`() {
        // Reacting after clipping is observed is too late: the damaged samples have
        // already been handed to the recognizer, and distorted speech makes it emit
        // sliding two-word guesses instead of sentences.
        val safe = LiveTranscribe.safeGain(10f, 0.5f)
        assertTrue("10x on a 0.5 peak would clip: $safe", safe * 0.5f <= 0.96f)
    }

    @Test
    fun `a silent chunk's clamp does not divide by zero`() {
        assertEquals(4f, LiveTranscribe.safeGain(4f, 0f), 1e-6f)
    }

    // ---- when to rebuild the recognizer session ------------------------------

    @Test
    fun `a live session is never restarted`() {
        assertFalse(LiveTranscribe.shouldRestart(ended = false, deliveredUtterance = true, sinceStartMs = 99_999))
    }

    @Test
    fun `a session that reported an utterance is replaced IMMEDIATELY`() {
        // It quit after one sentence while the speaker is still going. ONE session
        // reports ONE utterance — 125s of speech fed to a single session
        // transcribed to nothing at all.
        assertTrue(LiveTranscribe.shouldRestart(ended = true, deliveredUtterance = true, sinceStartMs = 0))
    }

    @Test
    fun `a session that heard nothing waits out the rate limit`() {
        // Rebuilding one per chunk of silence measured 316 restarts in 125s and
        // destroyed recognition outright.
        assertFalse(LiveTranscribe.shouldRestart(ended = true, deliveredUtterance = false, sinceStartMs = 100))
        assertTrue(LiveTranscribe.shouldRestart(ended = true, deliveredUtterance = false,
            sinceStartMs = LiveTranscribe.MIN_RESTART_MS))
    }

    @Test
    fun `only a session that heard nothing is owed the preroll replay`() {
        // Replaying audio a session already reported manufactures the duplicate the
        // stitcher then has to guess at; NOT replaying audio it never reported
        // loses those syllables permanently — they exist only in the ring.
        assertTrue(LiveTranscribe.owedReplay(deliveredUtterance = false))
        assertFalse(LiveTranscribe.owedReplay(deliveredUtterance = true))
    }

    @Test
    fun `the preroll ring is about two seconds of 16kHz mono`() {
        val seconds = LiveTranscribe.PREROLL_SAMPLES / 16_000f
        assertTrue("$seconds s of preroll", seconds >= 1.5f && seconds <= 3f)
    }

    // ---- stitching -----------------------------------------------------------

    @Test
    fun `normalizing ignores the punctuation the recognizer re-invents`() {
        // The same audio comes back re-punctuated and re-capitalized between
        // sessions, so an exact comparison finds no overlap and lets every
        // duplicate through.
        assertEquals(
            LiveTranscribe.normalizedWords("Hello, world!"),
            LiveTranscribe.normalizedWords("hello world"),
        )
    }

    @Test
    fun `a seam is found across differing punctuation`() {
        val seam = LiveTranscribe.bestSeam("the necklace is listening", "Necklace is listening, and it works")
        assertEquals(3, seam?.overlap)
        assertEquals(0, seam?.junk)
    }

    @Test
    fun `a dying session's trailing junk does not defeat the trim`() {
        // THE bug that turned five spoken sentences into 450 characters of sliding
        // fragments: requiring an exact suffix match let one wrong guessed word
        // score a real four-word overlap as zero.
        val seam = LiveTranscribe.bestSeam(
            "should be transcribed on device the",       // "the" is a dying guess
            "should be transcribed on device correctly",
        )
        assertTrue("no seam found — the junk word defeated the trim", seam != null)
        assertEquals(1, seam?.junk)
    }

    @Test
    fun `a one-word overlap is NOT a seam — common words coincide constantly`() {
        assertNull(LiveTranscribe.bestSeam("we went to the", "the dog barked loudly"))
    }

    @Test
    fun `banking trims the replayed overlap instead of storing it twice`() {
        val banked = LiveTranscribe.bank(listOf("the necklace is listening"), "is listening and it works")
        assertEquals("the necklace is listening and it works", banked.joinToString(" "))
    }

    @Test
    fun `an exact duplicate is dropped`() {
        assertEquals(listOf("hello there"), LiveTranscribe.bank(listOf("hello there"), "hello there"))
    }

    @Test
    fun `a duplicate two utterances back is still caught`() {
        // A burst of restarts replays overlapping windows of one sentence, so the
        // duplicate is often not adjacent — comparison is against the WHOLE segment.
        val banked = listOf("the necklace is listening", "and it works well")
        assertEquals(banked, LiveTranscribe.bank(banked, "necklace is listening"))
    }

    @Test
    fun `a longer re-transcription REPLACES the shorter reading`() {
        // Same audio heard twice: keep the more complete one rather than appending.
        val banked = LiveTranscribe.bank(listOf("the necklace is"), "the necklace is listening closely")
        assertEquals(listOf("the necklace is listening closely"), banked)
    }

    @Test
    fun `unrelated speech is appended, not merged`() {
        val banked = LiveTranscribe.bank(listOf("hello there"), "completely different words")
        assertEquals(2, banked.size)
    }

    @Test
    fun `empty and blank utterances never enter the bank`() {
        assertEquals(listOf("hello"), LiveTranscribe.bank(listOf("hello"), "   "))
        assertEquals(emptyList<String>(), LiveTranscribe.bank(emptyList(), ""))
    }

    @Test
    fun `segment text puts the live utterance after the banked ones`() {
        assertEquals("one two three", LiveTranscribe.segmentText(listOf("one", "two"), "three"))
        assertEquals("one two", LiveTranscribe.segmentText(listOf("one", "two"), "  "))
    }

    // ---- filing a segment ----------------------------------------------------

    @Test
    fun `a silent segment is never filed`() {
        // An open necklace in a quiet room would otherwise file an empty row every
        // minute, forever.
        assertFalse(LiveTranscribe.worthStoring(""))
        assertFalse(LiveTranscribe.worthStoring("   "))
        assertFalse(LiveTranscribe.worthStoring("uh"))
    }

    @Test
    fun `a real sentence is filed`() {
        assertTrue(LiveTranscribe.worthStoring("the necklace is listening"))
    }

    @Test
    fun `a segment's duration is measured and floored at one second`() {
        assertEquals(1, LiveTranscribe.segmentSeconds(0))
        assertEquals(1, LiveTranscribe.segmentSeconds(400))
        assertEquals(12, LiveTranscribe.segmentSeconds(11_600))   // rounded, not truncated
        assertEquals(60, LiveTranscribe.segmentSeconds(60_000))
    }

    @Test
    fun `a segment rotates about once a minute`() {
        // One session's usable lifetime must not cap a long stream, and a segment
        // that never rotates is one transcript row growing without bound.
        assertTrue(LiveTranscribe.SEGMENT_MS in 20_000..180_000)
    }
}
