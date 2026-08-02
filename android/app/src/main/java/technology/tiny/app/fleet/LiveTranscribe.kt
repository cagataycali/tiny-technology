package technology.tiny.app.fleet

/**
 * 🗣️ The pure half of transcribing the necklace's own microphone — Android port
 * of the audio-conditioning and utterance-stitching rules iOS arrived at in
 * `7d81ac87` and then CORRECTED in `f0c524dd`.
 *
 * The board has served its microphone as `GET /audio` (PCM16LE 16kHz mono) all
 * along, and [TinyLive.lanAudio] decoded it straight into an `AudioTrack` and
 * threw the words away — the necklace could be heard and never understood.
 *
 * Everything here is PURE and unit-tested, deliberately, because every one of
 * these rules fails SILENTLY: the stream still plays, the panel still says
 * "live", and the transcript is empty or subtly doubled. iOS measured all of
 * them against real captures of the board (8s and 125s of /audio at
 * 192.168.1.207:8080); the numbers in this file are those measurements, not
 * guesses, and they are the reason a plausible implementation transcribes
 * nothing at all.
 *
 * ⚠️ The numbers are the BOARD's, not Android's recognizer's. The conditioning
 * (DC removal, makeup gain) is a property of the microphone hardware and holds
 * across phones; what is genuinely different here is how audio reaches a
 * recognizer at all — see [TinyLive.lanAudio], which pipes PCM to
 * `SpeechRecognizer` via `EXTRA_AUDIO_SOURCE` rather than appending buffers.
 */
internal object LiveTranscribe {

    // ---- levels, all measured on the real board ------------------------------

    /**
     * Target RMS for makeup gain: about -21 dBFS.
     *
     * The board delivers roughly -40 to -48 dBFS. A sweep of the SAME capture
     * through the SAME decode path transcribes cleanly from -15 to -30 dBFS,
     * returns ONE word at -36, and returns nothing whatsoever at the native
     * level. So this is not polish — it is the difference between working and not.
     */
    const val TARGET_RMS = 0.09f

    /** Below this the peak estimate is room noise; leave the gain where it is. */
    const val NOISE_GATE = 0.0015f

    /** Never attenuate: a stream already loud enough must pass through at 1×. */
    const val GAIN_MIN = 1f

    /**
     * Ceiling of 12×, above the ~10× the board's own level needs.
     *
     * Unbounded, a near-silent chunk asks for thousands and the next word
     * arrives clipped into distortion.
     */
    const val GAIN_MAX = 12f

    /** Per-chunk peak may reach this after gain — headroom against clipping. */
    const val PEAK_CEILING = 0.95f

    /**
     * Peak-hold decay per chunk. 0.98 ≈ 10 seconds of memory: long enough to
     * hold through a pause inside a sentence, short enough to follow someone
     * walking away from the board.
     */
    const val PEAK_DECAY = 0.98f

    /**
     * Decode PCM16LE bytes to floats in `out`, removing the microphone's DC
     * offset in the same pass. Returns the number of samples written.
     *
     * The board's PDM path sits ~500-800 counts above zero and DRIFTS, so a
     * fixed correction is wrong within seconds; the running mean of each chunk
     * tracks it. Left in, the offset is a fat sub-20Hz tone under everything —
     * inaudible, but it was 40% of the "quiet" spectrum measured on the board,
     * and it eats the headroom the gain needs.
     *
     * It is also a PREREQUISITE for measuring level at all, not a nicety: with
     * the board's ~886-count offset left in, a chunk's RMS is dominated by the
     * constant (0.024 vs 0.0004 of actual signal), so every chunk reads the same
     * level whether anyone is speaking or not — which is exactly how an energy
     * gate built on top of it can look reasonable and be inert.
     */
    fun decode(bytes: ByteArray, count: Int, out: FloatArray): Int {
        val n = minOf(count / 2, out.size)
        if (n <= 0) return 0
        var sum = 0f
        for (i in 0 until n) {
            val lo = bytes[i * 2].toInt() and 0xFF
            val hi = bytes[i * 2 + 1].toInt()          // signed: keeps the sign bit
            val v = ((hi shl 8) or lo).toShort().toFloat() / 32768f
            out[i] = v
            sum += v
        }
        val mean = sum / n
        for (i in 0 until n) out[i] -= mean
        return n
    }

    /** RMS of the first `n` samples. */
    fun rms(buf: FloatArray, n: Int): Float {
        if (n <= 0) return 0f
        var sum = 0f
        for (i in 0 until n) sum += buf[i] * buf[i]
        return kotlin.math.sqrt(sum / n)
    }

    /** Largest absolute sample in the first `n`. */
    fun peak(buf: FloatArray, n: Int): Float {
        var p = 0f
        for (i in 0 until n) p = maxOf(p, kotlin.math.abs(buf[i]))
        return p
    }

    /**
     * The new decaying peak-hold, from the old one and this chunk's RMS.
     *
     * A peak-hold asks "how loud is the loudest thing I have heard lately?", so
     * room noise never becomes the peak and the estimate tracks actual speech.
     */
    fun nextPeakHold(previous: Float, chunkRms: Float): Float =
        maxOf(previous * PEAK_DECAY, chunkRms)

    /**
     * Makeup gain from the peak-hold — deliberately NOT an RMS-chasing AGC.
     *
     * iOS built the RMS version first and measured it failing: a per-chunk
     * normalizer asks "is THIS chunk at the target?", so it hands a quiet room a
     * huge gain and loud speech a small one, flattening the very speech/silence
     * contrast a recognizer relies on. On audio already at -25.7 dBFS it wound to
     * 26×, overshot by 12 dB and clipped 86% of one chunk's samples; distorted
     * speech made the recognizer emit sliding 2-3 word guesses instead of
     * sentences. A peak-hold gives the whole segment ONE slowly-moving
     * multiplier, preserving contrast and moving only the absolute level.
     *
     * Below the noise gate the previous gain is KEPT rather than reset: a pause
     * between sentences is not a reason to re-learn the level of the room.
     */
    fun gainFor(peakHold: Float, current: Float): Float =
        if (peakHold <= NOISE_GATE) current
        else (TARGET_RMS / peakHold).coerceIn(GAIN_MIN, GAIN_MAX)

    /**
     * The gain actually safe for THIS chunk, clamped against its own peak.
     *
     * Reacting after the fact — shrinking the gain once clipping is observed —
     * is too late, because the damaged samples have already been handed to the
     * recognizer.
     */
    fun safeGain(gain: Float, chunkPeak: Float): Float =
        if (chunkPeak > 0f) minOf(gain, PEAK_CEILING / chunkPeak) else gain

    // ---- stitching several recognizer sessions into one segment --------------

    /**
     * Words, lowercased and stripped of punctuation.
     *
     * The recognizer re-punctuates and re-capitalizes the same audio differently
     * between sessions, so an exact comparison finds no overlap at all and lets
     * every duplicate straight through.
     */
    fun normalizedWords(s: String): List<String> =
        s.split(' ', '\n', '\t')
            .map { it.lowercase().trim('.', ',', '!', '?', ';', ':', '"', '\'', '’', '“', '”', '-', '—') }
            .filter { it.isNotEmpty() }

    /** Where two consecutive utterances join: how much of `a`'s tail is junk, and the overlap. */
    data class Seam(val junk: Int, val overlap: Int)

    /**
     * Find the seam between two utterances, tolerating junk at the end of the
     * first.
     *
     * A dying session's final words are a PARTIAL guess at audio it never
     * finished hearing — "…is listening, and the" where the speaker said "…and
     * this sentence should be transcribed". Requiring an exact suffix match let
     * that one wrong word defeat the entire trim: a real four-word overlap scored
     * zero and the whole replayed window was banked verbatim, which is what
     * turned five spoken sentences into 450 characters of sliding two-to-three
     * word fragments.
     *
     * So: drop up to three trailing words from `a` and take the first alignment
     * that matches. Two words MINIMUM, because a single common word ("the",
     * "and") matches by coincidence constantly.
     */
    fun bestSeam(a: String, b: String): Seam? {
        val aw = normalizedWords(a)
        val bw = normalizedWords(b)
        for (junk in 0..3) {
            if (junk >= aw.count()) break
            val head = aw.subList(0, aw.size - junk)
            var n = minOf(head.size, bw.size)
            while (n >= 2) {
                if (head.subList(head.size - n, head.size) == bw.subList(0, n)) return Seam(junk, n)
                n--
            }
        }
        return null
    }

    /**
     * Add a finished utterance to the segment, trimming the overlap the preroll
     * replay creates. Returns the new bank.
     *
     * Replaying ~2s of audio means the next session legitimately re-transcribes
     * the tail of the previous utterance. Untrimmed, a stored segment read
     * "…transcribed on device The necklace is listening, and the sentence should
     * be transcribed on device" — the same sentence twice, which is WORSE than a
     * clipped one, because the agent reads it as two things being said.
     */
    fun bank(banked: List<String>, raw: String): List<String> {
        val t = raw.trim()
        if (t.isEmpty()) return banked
        val prev = banked.lastOrNull() ?: return banked + t
        if (prev == t) return banked
        // Compared against the WHOLE segment, not only the last utterance: a
        // burst of restarts replays overlapping windows of one sentence, so the
        // duplicate is often two or three utterances back.
        val segment = normalizedWords(banked.joinToString(" ")).joinToString(" ")
        val incoming = normalizedWords(t).joinToString(" ")
        if (incoming.isEmpty()) return banked
        if (segment.contains(incoming)) return banked
        // A re-transcription of the same audio: keep the longer reading, which is
        // the more complete one.
        if (incoming.contains(normalizedWords(prev).joinToString(" "))) {
            return banked.dropLast(1) + t
        }
        val seam = bestSeam(prev, t) ?: return banked + t
        var out = banked
        if (seam.junk > 0) {
            val kept = prev.split(' ').dropLast(seam.junk).joinToString(" ")
            out = if (kept.isEmpty()) out.dropLast(1) else out.dropLast(1) + kept
        }
        val rest = t.split(' ').drop(seam.overlap).joinToString(" ")
        return if (rest.isEmpty()) out else out + rest
    }

    /** Everything heard so far in a segment: banked utterances plus the live one. */
    fun segmentText(banked: List<String>, live: String): String {
        val l = live.trim()
        return (banked + if (l.isEmpty()) emptyList() else listOf(l)).joinToString(" ")
    }

    /**
     * Whether a dead session is owed a replay of the preroll.
     *
     * This depends on HOW it ended, and getting it wrong costs either words or
     * duplicates. A session that delivered a final result already reported
     * everything it heard, so replaying its audio re-transcribes accounted-for
     * speech and manufactures the duplicate the stitcher then has to guess at. An
     * error can strike mid-utterance with syllables never reported anywhere, and
     * those exist ONLY in the preroll ring.
     */
    fun owedReplay(deliveredUtterance: Boolean): Boolean = !deliveredUtterance

    /**
     * Whether to rebuild the recognizer session now.
     *
     * Restart urgency comes from the RECOGNIZER, not from audio energy. A session
     * that delivered an utterance quit while the speaker is very likely still
     * going, so its replacement is needed NOW. A session that ended having heard
     * nothing was listening to an empty room, and rebuilding one per chunk of
     * silence measured 316 restarts in 125s and destroyed recognition outright —
     * so that case waits out the rate limit.
     *
     * An energy gate was tried in this position on iOS and REMOVED: it cannot
     * tell "mid-sentence" from "the room is noisy", and on this stream it was
     * silently inert anyway, because the DC offset made every chunk measure the
     * same level (see [decode]).
     */
    fun shouldRestart(ended: Boolean, deliveredUtterance: Boolean, sinceStartMs: Long): Boolean {
        if (!ended) return false
        return deliveredUtterance || sinceStartMs >= MIN_RESTART_MS
    }

    /** Floor between restarts on a quiet stream — see [shouldRestart]. */
    const val MIN_RESTART_MS = 1_500L

    /** A segment is rotated at this age, so one session's lifetime can't cap a stream. */
    const val SEGMENT_MS = 60_000L

    /** Preroll ring: ~2s at 16kHz mono, replayed to a session that died mid-utterance. */
    const val PREROLL_SAMPLES = 32_000

    /** Shorter than this, a segment is noise the recognizer guessed at — don't store it. */
    const val MIN_SEGMENT_CHARS = 8

    /**
     * Whether a finished segment is worth filing.
     *
     * A silent segment is not a failure and must not become a transcript row: an
     * open necklace in a quiet room would otherwise file "" every minute forever.
     */
    fun worthStoring(text: String): Boolean = text.trim().length >= MIN_SEGMENT_CHARS

    /**
     * Seconds to report for a segment — MEASURED, floored at 1.
     *
     * Same rule [PhoneRecorder.actualSeconds] holds: a duration that reports the
     * window rather than the elapsed time is a number nobody can trust.
     */
    fun segmentSeconds(elapsedMs: Long): Int = maxOf(1, ((elapsedMs + 500) / 1000).toInt())
}
