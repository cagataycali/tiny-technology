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
 * ⚠️ A measurement can go STALE without any code changing. The DC figures in
 * [decode] were right when written and were ~10× low a month later, because the
 * firmware's gain moved underneath them — see the knob argument there. When a
 * number here disagrees with the board, the board is right.
 *
 * ⚠️ The numbers are the BOARD's, not Android's recognizer's. The conditioning
 * (DC removal, makeup gain) is a property of the microphone hardware and holds
 * across phones; what is genuinely different here is how audio reaches a
 * recognizer at all — see [TinyLive.lanAudio], which pipes PCM to
 * `SpeechRecognizer` via `EXTRA_AUDIO_SOURCE` rather than appending buffers.
 */
internal object LiveTranscribe {

    // ---- the caption switch, mid-stream --------------------------------------

    /**
     * What the audio loop must do with its recognizer this chunk, given the
     * caption switch — the ONE decision that makes the switch mean anything.
     *
     * 🔴 The switch used to be read exactly once, when the stream started
     * ([TinyLive.lanAudio] built its `LiveScribe` or didn't). So turning captions
     * OFF stopped only the overlay: the recognizer kept reading the necklace's
     * microphone and `close()` still filed everything it heard, including speech
     * from after the user asked it to stop. The card's own icon says "stop
     * reading the necklace's audio" and its comment argues that a continuously
     * read microphone in someone's home must be switchable off without ending
     * the video — this is the code that has to be true for that to be honest.
     * Turning it back ON did nothing at all, since the null scribe stayed null.
     *
     * The states are named rather than returned as a pair of booleans because
     * the interesting ones are the TRANSITIONS, and a caller that reads two
     * flags can implement three of the four and look complete.
     */
    enum class Scribe {
        /** Off, and nothing open — the ordinary "captions off" chunk. */
        IDLE,

        /** On with a session open — feed it. */
        FEED,

        /** Turned on since the last chunk: open a recognizer now. */
        START,

        /**
         * Turned off with a session open: file what was heard, then tear down.
         *
         * STOP, not DISCARD. The words already spoken are the user's — the same
         * rule as stopping a take, and iOS's `toggleTranscribe` calls
         * `finishSegment()` for it. A switch is not a delete.
         */
        STOP,
    }

    fun scribeAction(wanted: Boolean, open: Boolean): Scribe = when {
        wanted && open -> Scribe.FEED
        wanted -> Scribe.START
        open -> Scribe.STOP
        else -> Scribe.IDLE
    }

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
     * The board's PDM path sits ~8500 counts above zero and DRIFTS, so a fixed
     * correction is wrong within seconds; the running mean of each chunk tracks
     * it. Left in, the offset is a fat sub-20Hz tone under everything —
     * inaudible, but it is a QUARTER OF FULL SCALE and it eats the headroom the
     * gain needs.
     *
     * ⚠️ That figure is not a property of the microphone, it is a property of a
     * KNOB: the firmware's `GAIN_DB` digitally multiplies the decimated sample,
     * and strands-nicla `firmware/tiny_audio.py`'s own sweep records dc 812 at
     * gain_db=24, dc 8,334 at 44 and dc 11,496 at the 48 it now ships. The
     * ~500-800 this comment used to claim was the offset at a gain setting the
     * firmware abandoned. So the number moves when that knob moves — which is
     * precisely why the running mean is here, and why nothing downstream may
     * hardcode a correction.
     *
     * DC removal is also a PREREQUISITE for measuring level at all, not a
     * nicety. Measured over 9.216s of the board's own /audio through THIS
     * function's arithmetic, in the 4096-byte chunks [TinyLive.lanAudio] reads:
     * mean 8479 counts, drifting 8303→8663 across one-second windows. With the
     * offset left in, a chunk's RMS is dominated by the constant — 0.269 of
     * offset against 0.071 of real signal — so chunk RMS spans only 0.254-0.279
     * (a 10% swing) instead of 0.050-0.092 (85%). Nine tenths of the dynamic
     * range is gone, and every chunk reads nearly the same level whether anyone
     * is speaking or not; that collapse is why an energy gate built on top of it
     * was INERT rather than merely unhelpful.
     *
     * ⚠️ Those spans are narrower than the ones iOS documents (0.249-0.286 vs
     * 0.045-0.105) on the SAME capture, and neither is wrong: the span is
     * measured per chunk, and iOS conditions whatever URLSession hands it while
     * Android always reads 2048 samples. A longer window averages more. Do not
     * "sync" these two figures — re-measure at the chunk size in use.
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

    // ── Segment audio kept on THIS phone (iOS SegmentAudio/audioEvictions parity) ──

    /**
     * The label every live segment is filed under.
     *
     * ⚠️ Same string the SERVER stores (`storeHeard(…, LIVE_LABEL, …)`), the same one
     * the `nicla_voice_transcripts` tool names in its description, and the same one
     * iOS files. It is the only thing that tells a reader — agent or human — that a
     * row came from the necklace's own microphone rather than from a take, so a typo
     * here silently attributes a room's ambient minute to hardware nobody pointed at
     * it. A shared constant, never a literal at the call site.
     */
    const val LIVE_LABEL = "necklace-live"

    /**
     * Byte budget for AUTOMATIC audio — 64MB.
     *
     * ⚠️ MEASURED THROUGH THIS PHONE'S ARITHMETIC, NOT COPIED FROM iOS. iOS stores
     * 45s AAC segments at ~197KB and budgets 96MB. Android writes RIFF/WAV PCM16LE
     * (see [wavHeader]) because it holds raw samples and has no AAC encoder on this
     * path — so a segment costs `SEGMENT_MS/1000 × 16000 × 2` bytes = **1.92MB per
     * 60s segment**, ~10× an AAC one. 64MB is therefore 34 segments ≈ 34 minutes
     * of kept audio, NOT the 6.2 hours iOS's figure buys. Raising this trades
     * someone's disk for older audio; it must never be "synced" to iOS's number,
     * which would be 51 minutes of silently different meaning.
     */
    const val LIVE_AUDIO_BUDGET = 64 * 1024 * 1024

    /** Bytes one whole segment of kept audio costs — the figure above, derived. */
    fun segmentAudioBytes(): Int = (SEGMENT_MS / 1000).toInt() * SAMPLE_RATE * 2

    /** The board's format, and the one thing every consumer here agrees on. */
    const val SAMPLE_RATE = 16_000

    /**
     * ⚠️ WHY THERE IS NO `isAutomaticAudio(label)` HERE, THOUGH iOS HAS ONE, AND WHY
     * THAT IS NOT A MISSING PORT.
     *
     * iOS keeps every kind of audio in one directory beside `index.json`, so its
     * budget rule has to ask a row's LABEL whether it is exempt — a hand-made take
     * must never be pushed off the disk by a room full of ambient minutes. On this
     * phone that question has no false answer: a take owns no audio at all (see
     * [PhoneRecorder]'s header — `SpeechRecognizer` captures inside another process),
     * so `live-audio/` contains live segments and nothing else, and a ported
     * `label == LIVE_LABEL` guard would read as load-bearing while no input could
     * ever fail it. A vacuous guard is worse than no guard: it invites the next
     * reader to trust a protection that isn't there.
     *
     * The distinction this directory really does have is by NAME, and the two sweeps
     * below partition it on exactly that — so neither can delete what the other owns,
     * and neither can touch a file still being written:
     *  - `live-<uuid>.wav` — PENDING. Written while the necklace is still talking;
     *    renamed to `<serverId>.wav` the moment its row lands, deleted if it doesn't
     *    (`PhoneRecorder.claimAudio`). One surviving past the age gate is therefore a
     *    crash/force-quit orphan by construction, which is what makes [orphanAudio]
     *    correct with no row list at all.
     *  - `<serverId>.wav` — CLAIMED by a server row. [audioEvictions]'s business.
     */
    const val PENDING_AUDIO_PREFIX = "live-"

    /** A file still waiting for its row — see [PENDING_AUDIO_PREFIX]. */
    fun isPendingAudio(name: String): Boolean = name.startsWith(PENDING_AUDIO_PREFIX)

    /**
     * Which audio files to delete to stay inside `budget`, oldest first
     * (iOS `audioEvictions`).
     *
     * The TEXT of an evicted row is never touched — nor even consulted. What the
     * necklace heard is small, durable, and the thing the agent reads: losing the
     * recording is a tradeoff, losing the words with it would not be. Since the row
     * lives on the server and the file names itself after the row, dropping a file
     * needs no write anywhere else, which is the whole reason this phone can enforce
     * the budget at launch while iOS can only do it when it loads its index.
     *
     * ⚠️ ORDERS ITS OWN INPUT. iOS's version documents "rows: newest first" and is
     * silently wrong for any caller that passes them the other way round — it would
     * keep the OLDEST audio and evict everything recent, which is the same bug as no
     * budget for the only thing anyone wants to replay. Age is in the input, so the
     * ordering is decided here.
     *
     * PENDING files are skipped: one may be open right now, and [orphanAudio] is what
     * collects the rest. A pending file is at most one segment ([segmentAudioBytes]),
     * so the slack this leaves in the budget is bounded and small.
     *
     * @param files `(name, ageMs, bytes)` in the audio dir.
     * @return names whose file should be deleted.
     */
    fun audioEvictions(files: List<Triple<String, Long, Int>>, budget: Int): List<String> {
        var used = 0
        val evict = mutableListOf<String>()
        for ((name, _, bytes) in files.filterNot { isPendingAudio(it.first) }
            .sortedBy { it.second }) {
            // A 0-byte file needs no special case: `used` only ever advances when it
            // FITS, so `used <= budget` holds and `used + 0 <= budget` is always true.
            if (used + bytes <= budget) used += bytes else evict.add(name)
        }
        return evict
    }

    /**
     * Minimum age before a pending file may be swept, in ms.
     *
     * ⚠️ NOT caution — required for correctness. A segment's file is opened while the
     * necklace is still talking and only renamed when the segment CLOSES, so a sweep
     * with no age gate would delete the segment currently being written (the stream
     * would keep writing to an unlinked inode and the audio would vanish with every
     * log line still reading ok). A segment is at most [SEGMENT_MS], so minutes of
     * slack costs one extra launch before an orphan is collected.
     */
    const val MIN_ORPHAN_AGE_MS = 600_000L

    /**
     * Pending files old enough that nothing can still be writing them.
     *
     * [audioEvictions] bounds only the files a row can address. A crash, a force-quit
     * or a low-memory kill mid-segment leaves one nothing will ever rename — invisible
     * to the budget above (which skips pending names on purpose), so the budget could
     * be perfectly enforced while the directory grew without limit. This is the other
     * door.
     *
     * @param files `(name, ageMs)` in the audio dir.
     */
    fun orphanAudio(files: List<Pair<String, Long>>): List<String> =
        files.filter { (name, age) -> isPendingAudio(name) && age >= MIN_ORPHAN_AGE_MS }
            .map { it.first }

    /**
     * The name a pending file takes once the SERVER has filed its row, or null when
     * there is no row to address it by — in which case the caller must keep nothing.
     *
     * ⚠️ THE JOIN, as a pure function, and that is deliberate. Both halves of it used
     * to live inside [PhoneRecorder]'s `claimAudio`/`fileTranscript` — a `private
     * suspend fun` taking a `TinyApp` and posting JSON — where nothing could test
     * either. A mutation battery walked straight through both: renaming the file to
     * its own name (so the join silently never happens and the audio is swept as an
     * orphan) and discarding the server's id (so every recording is deleted the moment
     * its row lands) BOTH survived, because the only pin one can write about code
     * shaped like that is a grep for the line that was mutated.
     *
     * A blank id is not an error to swallow: the transcript POST fell through to the
     * event ring, which files no row, so the audio would be addressable by nothing.
     * Null means DELETE, and [PhoneRecorder.claimAudio] is where that happens.
     *
     * @param serverId the id the WORKER filed the row under — never a local UUID,
     *   which nothing server-side has ever seen.
     */
    fun claimedAudioName(serverId: String?): String? =
        serverId?.trim()?.takeIf { it.isNotEmpty() }?.let { "$it.wav" }

    /**
     * Everything the launch sweep should delete, given one stat of the audio dir.
     *
     * Pure so that BOTH halves are provable together: the two rules partition the
     * directory by name, and the property that matters is the one neither can state
     * alone — that no file escapes both doors. A mutant that computed the byte budget
     * and threw the result away survived a whole battery while `audioEvictions` was
     * called from a line only a grep could check.
     *
     * @param files `(name, ageMs, bytes)` in the audio dir, statted ONCE.
     */
    fun audioSweep(files: List<Triple<String, Long, Int>>, budget: Int): List<String> =
        orphanAudio(files.map { it.first to it.second }) + audioEvictions(files, budget)

    /**
     * A 44-byte RIFF/WAV header for `dataBytes` of PCM16LE mono at [SAMPLE_RATE].
     *
     * ⚠️ WHY A HEADER AT ALL, when the samples alone are the audio: `MediaPlayer`
     * cannot play a bare `.pcm` — it sniffs the container and fails, which would be
     * a Play button that does nothing on a row that really does own its audio. The
     * header is written LAST (the sizes aren't known until the segment closes), the
     * same ordering lesson as iOS's missing moov atom: bytes read before the index
     * is written are unplayable everywhere while every log line says ok.
     */
    fun wavHeader(dataBytes: Int): ByteArray {
        val byteRate = SAMPLE_RATE * 2
        val h = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray(Charsets.US_ASCII))
        h.putInt(36 + dataBytes)          // everything after this field
        h.put("WAVE".toByteArray(Charsets.US_ASCII))
        h.put("fmt ".toByteArray(Charsets.US_ASCII))
        h.putInt(16)                      // PCM fmt chunk size
        h.putShort(1)                     // PCM, uncompressed
        h.putShort(1)                     // mono
        h.putInt(SAMPLE_RATE)
        h.putInt(byteRate)                // bytes/second
        h.putShort(2)                     // block align
        h.putShort(16)                    // bits per sample
        h.put("data".toByteArray(Charsets.US_ASCII))
        h.putInt(dataBytes)
        return h.array()
    }
}
