package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

    /**
     * The board's DC offset in counts, MEASURED — mean 8479 over 9.216s of its
     * own /audio, drifting 8303→8663 across one-second windows.
     *
     * Named rather than inlined because it appeared as a bare `886` in two tests
     * and in a test's own TITLE, and stayed there for a month after the
     * firmware's `GAIN_DB` moved the real offset ~10× — the tests kept passing
     * while asserting silence about an offset the board no longer has. One
     * constant is one place to re-measure. See [LiveTranscribe.decode].
     */
    private val MEASURED_DC = 8_479

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
    fun `removes the microphone's DC offset — the board sits ~8500 counts high`() {
        // A constant offset with no signal must decode to silence. Left in, it is
        // a QUARTER OF FULL SCALE and it eats the headroom the makeup gain needs.
        val out = FloatArray(64)
        val bytes = ByteArray(128)
        for (i in 0 until 64) {                 // 8479 counts, the measured offset
            bytes[i * 2] = (MEASURED_DC and 0xFF).toByte()
            bytes[i * 2 + 1] = ((MEASURED_DC shr 8) and 0xFF).toByte()
        }
        val n = LiveTranscribe.decode(bytes, 128, out)
        assertEquals(64, n)
        assertEquals("a pure DC offset should decode to silence", 0f, LiveTranscribe.rms(out, n), 1e-6f)
    }

    @Test
    fun `the offset is a quarter of full scale, so removal is not cosmetic`() {
        // The reason the figure matters: at ~8500 counts the constant alone is a
        // quarter of the sample range, so it is not a small bias to tidy up.
        // 886 — what this file measured before the firmware's GAIN_DB moved — was
        // 2.7%, and a correction sized for that leaves the real offset in.
        assertTrue(
            "the measured offset is no longer a quarter of full scale — re-measure the board",
            MEASURED_DC / 32768f > 0.2f,
        )
        // Whatever it is, decode() must not care: no fixed correction, running mean.
        val out = FloatArray(64)
        for (dc in intArrayOf(812, 8_479, 11_496)) {   // the firmware's own sweep
            val b = ByteArray(128)
            for (i in 0 until 64) {
                b[i * 2] = (dc and 0xFF).toByte()
                b[i * 2 + 1] = ((dc shr 8) and 0xFF).toByte()
            }
            val n = LiveTranscribe.decode(b, 128, out)
            assertEquals("a fixed correction was sized for one gain setting", 0f, LiveTranscribe.rms(out, n), 1e-6f)
        }
    }

    @Test
    fun `DC removal is what makes level measurable at all`() {
        // The trap iOS documented, re-measured on 9.216s of the board's own /audio
        // through Android's 4096-byte chunks: with the offset left in, a chunk's
        // RMS is dominated by the constant (0.269 of offset against 0.071 of real
        // signal), so chunk RMS spans only 0.254-0.279 instead of 0.050-0.092 —
        // nine tenths of the dynamic range gone, and a quiet chunk measures
        // almost exactly what a spoken one does. That is how an energy gate built
        // on top of this can look sensible and be completely inert.
        val out = FloatArray(64)
        fun rmsOf(signal: Int): Float {
            val b = ByteArray(128)
            for (i in 0 until 64) {
                val v = MEASURED_DC + if (i % 2 == 0) signal else -signal
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

    // ---- audio kept ON THIS PHONE, so a live row can be played ----------------
    //
    // 🔴 The defect these close: `c13b87ac` shipped a nicla_voice_transcripts
    // description telling every agent that a necklace-live row's audio "is playable
    // on the row in the tiny app" and to "say 'open the tiny app to listen', never
    // 'there is no audio'". True on iOS (SegmentAudio + storeHeard(audioFile:)),
    // and FALSE on Android, where finish() filed text only — so every agent sent an
    // Android user to a screen to listen to something the phone never kept.

    @Test
    fun `a WAV header, because MediaPlayer cannot play bare samples`() {
        // Not decoration: MediaPlayer sniffs the container and refuses a `.pcm`,
        // which would be a Play button that does nothing on a row that really does
        // own its audio. The fields are asserted at their BYTE OFFSETS — a header
        // of the right length with a field in the wrong place plays as noise or not
        // at all, and no test of its size can see that.
        val h = LiveTranscribe.wavHeader(32_000)
        assertEquals(44, h.size)
        assertEquals("RIFF", String(h, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(h, 8, 4, Charsets.US_ASCII))
        assertEquals("fmt ", String(h, 12, 4, Charsets.US_ASCII))
        assertEquals("data", String(h, 36, 4, Charsets.US_ASCII))
        fun le32(at: Int) = java.nio.ByteBuffer.wrap(h, at, 4)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN).int
        fun le16(at: Int) = java.nio.ByteBuffer.wrap(h, at, 2)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN).short.toInt()
        // RIFF size counts everything AFTER this field, so it is data + 36, not
        // data + 44: getting it wrong truncates the last 8 bytes of playback in
        // strict players and is inaudible in lenient ones.
        assertEquals(32_000 + 36, le32(4))
        assertEquals(16, le32(16))                            // PCM fmt chunk
        assertEquals(1, le16(20))                             // uncompressed
        assertEquals(1, le16(22))                             // mono
        assertEquals(LiveTranscribe.SAMPLE_RATE, le32(24))
        assertEquals(LiveTranscribe.SAMPLE_RATE * 2, le32(28))  // byte rate
        assertEquals(2, le16(32))                             // block align
        assertEquals(16, le16(34))                            // bits per sample
        assertEquals(32_000, le32(40))                        // data size
    }

    @Test
    fun `the header declares the board's OWN rate, not a plausible one`() {
        // 16kHz is what tiny_stream.py serves and what LiveScribe tells the
        // recognizer. A header claiming 44.1kHz plays the same samples ~2.8× fast:
        // a chipmunk recording that every log line reports as fine.
        assertEquals(16_000, LiveTranscribe.SAMPLE_RATE)
        val rate = java.nio.ByteBuffer.wrap(LiveTranscribe.wavHeader(0), 24, 4)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN).int
        assertEquals(16_000, rate)
    }

    @Test
    fun `the budget is measured through THIS phone's arithmetic`() {
        // ⚠️ A STALE/COPIED FIGURE IS THE BUG HERE. iOS budgets 96MB of 45s AAC
        // segments at ~197KB each — 6.2 hours. Android has no AAC encoder on this
        // path and writes PCM16LE, so a segment costs ~10× as much and the same
        // 96MB would mean something completely different. This asserts the DERIVED
        // cost and the honest hour-count, so "syncing" the constant to iOS's reds.
        assertEquals(60 * 16_000 * 2, LiveTranscribe.segmentAudioBytes())
        assertEquals(1_920_000, LiveTranscribe.segmentAudioBytes())
        val segments = LiveTranscribe.LIVE_AUDIO_BUDGET / LiveTranscribe.segmentAudioBytes()
        assertEquals(34, segments)
        // ~34 minutes, NOT the 6.2 hours iOS's number buys.
        val minutes = segments * LiveTranscribe.SEGMENT_MS / 60_000
        assertEquals(34L, minutes)
    }

    @Test
    fun `segmentAudioBytes tracks SEGMENT_MS, not a hardcoded minute`() {
        // The derivation is the point: a rotation window that moves without the cost
        // figure moving is the stale-measurement defect one rail over.
        assertEquals(
            (LiveTranscribe.SEGMENT_MS / 1000).toInt() * LiveTranscribe.SAMPLE_RATE * 2,
            LiveTranscribe.segmentAudioBytes(),
        )
    }

    @Test
    fun `the budget evicts the OLDEST audio, keeping the recent past playable`() {
        // ⚠️ ORDERING IS THIS FUNCTION'S JOB, not its caller's. iOS's version
        // documents "rows: newest first" and silently inverts for anyone who passes
        // them the other way — evicting everything recent and keeping the oldest,
        // which is the same as no budget for the only audio anyone replays. So the
        // input here is deliberately in the WRONG order.
        val files = listOf(
            Triple("new.wav", 1_000L, 40),
            Triple("old.wav", 900_000L, 40),
            Triple("middle.wav", 400_000L, 40),
        )
        // 80 bytes of budget holds two of the three: the newest two are kept and the
        // oldest goes, whatever order the caller happened to hand them over in.
        assertEquals(listOf("old.wav"), LiveTranscribe.audioEvictions(files, 80))
        // One file's worth of budget keeps ONLY the newest, and the two it drops come
        // back newest-first — proof the walk really is age-ordered rather than the
        // caller's order happening to agree once.
        assertEquals(listOf("middle.wav", "old.wav"), LiveTranscribe.audioEvictions(files, 40))
        // Nothing over budget is nothing evicted.
        assertEquals(emptyList<String>(), LiveTranscribe.audioEvictions(files, 120))
    }

    @Test
    fun `a pending file is never evicted by the budget — it may be open right now`() {
        // `live-<uuid>.wav` is written while the necklace is still talking and only
        // renamed when its row lands. Deleting one mid-write leaves the stream
        // writing to an unlinked inode: the audio vanishes and every log reads ok.
        val files = listOf(
            Triple("live-abc.wav", 0L, 1_000_000),
            Triple("row-1.wav", 5_000L, 40),
        )
        assertEquals(emptyList<String>(), LiveTranscribe.audioEvictions(files, 100))
        assertTrue(LiveTranscribe.isPendingAudio("live-abc.wav"))
        assertFalse(LiveTranscribe.isPendingAudio("row-1.wav"))
    }

    @Test
    fun `an orphan is a PENDING file old enough that nothing can be writing it`() {
        // The age gate is correctness, not caution — see MIN_ORPHAN_AGE_MS. And only
        // pending names are swept: a claimed `<serverId>.wav` is a row's audio and
        // belongs to the budget, so sweeping by age alone would delete the very rows
        // the tool description promises are playable.
        val files = listOf(
            "live-fresh.wav" to 1_000L,
            "live-orphan.wav" to LiveTranscribe.MIN_ORPHAN_AGE_MS,
            "row-1.wav" to 99_999_999L,
        )
        assertEquals(listOf("live-orphan.wav"), LiveTranscribe.orphanAudio(files))
    }

    @Test
    fun `the orphan gate outlasts a whole segment`() {
        // A file younger than one rotation may still be being written to. Anything
        // shorter than SEGMENT_MS here would delete live audio.
        assertTrue(LiveTranscribe.MIN_ORPHAN_AGE_MS > LiveTranscribe.SEGMENT_MS)
    }

    @Test
    fun `the two sweeps PARTITION the directory — neither can delete the other's`() {
        // Together they must cover every file and overlap on none: a name in neither
        // is audio nothing will ever bound, and a name in both is a file two rules
        // disagree about.
        val seen = listOf(
            Triple("live-open.wav", 0L, 500),
            Triple("live-orphan.wav", 700_000L, 500),
            Triple("row-a.wav", 10_000L, 500),
            Triple("row-b.wav", 20_000L, 500),
        )
        val orphans = LiveTranscribe.orphanAudio(seen.map { it.first to it.second })
        val evicted = LiveTranscribe.audioEvictions(seen, 500)
        assertEquals(listOf("live-orphan.wav"), orphans)
        assertEquals(listOf("row-b.wav"), evicted)
        assertTrue(orphans.intersect(evicted.toSet()).isEmpty())
    }

    @Test
    fun `the live label is the string the SERVER and the tool both name`() {
        // It is the only thing that tells a reader a row came from the necklace's own
        // microphone rather than from a take. The tool description quotes it, so a
        // typo here silently attributes a room's ambient minute to the hardware.
        assertEquals("necklace-live", LiveTranscribe.LIVE_LABEL)
    }

    // ---- the caption switch, mid-stream --------------------------------------

    @Test
    fun `THE DEFECT — switching captions off STOPS the recognizer`() {
        // 🔴 The whole cycle. The switch was read once, when the stream started,
        // so "off" stopped the overlay and the recognizer kept reading the
        // necklace's microphone — filing, on close(), speech heard after the user
        // asked it to stop. The card's icon says "stop reading the necklace's
        // audio"; this is the assertion that makes that true.
        assertEquals(
            LiveTranscribe.Scribe.STOP,
            LiveTranscribe.scribeAction(wanted = false, open = true),
        )
    }

    @Test
    fun `switching captions back on starts a recognizer mid-stream`() {
        // The other half, and it was equally broken: a stream that began with
        // captions off had a null scribe, and nothing ever built one, so the
        // switch was inert for the rest of the session.
        assertEquals(
            LiveTranscribe.Scribe.START,
            LiveTranscribe.scribeAction(wanted = true, open = false),
        )
    }

    @Test
    fun `the steady states do not churn the recognizer`() {
        // ⚠️ The reason this is a four-state rule and not two booleans: START and
        // STOP must fire on the TRANSITION only. A rule that returned START
        // whenever captions were on would rebuild the recognizer 30× a second —
        // every chunk losing the utterance in progress, which is exactly how
        // this reads on screen as "transcribes nothing at all".
        assertEquals(
            LiveTranscribe.Scribe.FEED,
            LiveTranscribe.scribeAction(wanted = true, open = true),
        )
        assertEquals(
            LiveTranscribe.Scribe.IDLE,
            LiveTranscribe.scribeAction(wanted = false, open = false),
        )
    }

    // ---- the join: a filename is the only pointer this phone has --------------

    @Test
    fun `a claimed file is named after the SERVER's row id`() {
        // ⚠️ The whole join. iOS keeps index.json; this app deliberately has no local
        // index (the server IS the list), so the NAME is the only place a pointer can
        // live. `audioFor` reads this same function, so a drift here breaks BOTH ends
        // at once rather than leaving a Play button pointing at nothing.
        assertEquals("tr_abc123.wav", LiveTranscribe.claimedAudioName("tr_abc123"))
        assertEquals("the id is not decorated, prefixed or lowercased",
            "AbC-9.wav", LiveTranscribe.claimedAudioName("AbC-9"))
    }

    @Test
    fun `a claimed name is never the pending name it replaces`() {
        // A rename to the file's OWN name is the silent version of "no join": the audio
        // sits on disk, addressable by nothing, and is swept as an orphan ten minutes
        // later while every log line reads ok.
        val claimed = LiveTranscribe.claimedAudioName("tr_1")
        assertNotNull(claimed)
        assertFalse(
            "a claimed file must stop looking pending, or the orphan sweep eats it",
            LiveTranscribe.isPendingAudio(claimed!!),
        )
    }

    @Test
    fun `no row id means no audio may be kept`() {
        // The transcript POST fell through to the event ring, which files no row. There
        // is nothing to address the file by, so null means DELETE — not "keep it and
        // hope". Blank and whitespace are the same case: optString returns "" for a
        // missing key, and a server that ever sent " " must not name a file " .wav".
        assertNull(LiveTranscribe.claimedAudioName(null))
        assertNull(LiveTranscribe.claimedAudioName(""))
        assertNull(LiveTranscribe.claimedAudioName("   "))
    }

    @Test
    fun `the id is trimmed, so a padded id and a clean one address ONE file`() {
        assertEquals("tr_7.wav", LiveTranscribe.claimedAudioName("  tr_7 "))
    }

    // ---- the launch sweep: both doors, or the directory grows forever ---------

    @Test
    fun `the launch sweep enforces the budget AND collects orphans`() {
        val mb = 1024 * 1024
        val files = listOf(
            // claimed, and 3MB over a 2MB budget between them
            Triple("tr_old.wav", 90_000L, 2 * mb),
            Triple("tr_new.wav", 1_000L, 2 * mb),
            // pending: one being written right now, one left by a crash
            Triple("live-open.wav", 5_000L, mb),
            Triple("live-crashed.wav", LiveTranscribe.MIN_ORPHAN_AGE_MS + 1, mb),
        )
        val doomed = LiveTranscribe.audioSweep(files, 2 * mb)

        // ⚠️ A mutant that computed the budget and threw the result away survived a
        // whole battery, because the only pin on it was a grep for the call. Both
        // halves are asserted through ONE call here, by outcome.
        assertTrue("the oldest claimed audio goes when the budget is exceeded",
            doomed.contains("tr_old.wav"))
        assertTrue("the crash orphan is collected", doomed.contains("live-crashed.wav"))
        assertFalse("the recent past stays playable", doomed.contains("tr_new.wav"))
        assertFalse("never the segment being written this second",
            doomed.contains("live-open.wav"))
    }

    @Test
    fun `every file in the directory is seen by exactly one door`() {
        // The property NEITHER rule can state alone: nothing escapes both (a pending
        // file nothing claims), and nothing is owned by both.
        val files = listOf(
            Triple("tr_a.wav", 10_000L, 1_000),
            Triple("live-b.wav", LiveTranscribe.MIN_ORPHAN_AGE_MS + 1, 1_000),
        )
        val orphans = LiveTranscribe.orphanAudio(files.map { it.first to it.second })
        val evicted = LiveTranscribe.audioEvictions(files, 0)
        assertEquals(listOf("live-b.wav"), orphans)
        assertEquals(listOf("tr_a.wav"), evicted)
        assertTrue("no file is both", orphans.intersect(evicted.toSet()).isEmpty())
        assertEquals(
            "and none is neither",
            files.map { it.first }.toSet(),
            (orphans + evicted).toSet(),
        )
    }

    @Test
    fun `an empty directory sweeps to nothing`() {
        assertEquals(emptyList<String>(), LiveTranscribe.audioSweep(emptyList(), 1))
    }

    @Test
    fun `stopping is not discarding — every state is reachable and distinct`() {
        // STOP is a separate state from IDLE precisely because it has work to do:
        // file the segment, THEN tear down. Collapsing them loses the words, and
        // a toggle is not a delete (iOS's toggleTranscribe calls finishSegment()).
        val all = listOf(true, false).flatMap { w ->
            listOf(true, false).map { o -> LiveTranscribe.scribeAction(w, o) }
        }
        assertEquals(4, all.toSet().size)
        assertEquals(LiveTranscribe.Scribe.entries.toSet(), all.toSet())
    }
}
