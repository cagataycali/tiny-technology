package technology.tiny.app.fleet

/**
 * 🎧 One necklace-live segment's audio on disk, so its row can be PLAYED
 * (iOS `SegmentAudio`, `c13b87ac`).
 *
 * ⚠️ THIS IS NOT BLOCKED BY THE PLATFORM CONSTRAINT [PhoneRecorder]'s header
 * describes. That constraint is about the phone's OWN microphone, whose samples are
 * captured inside Google's recognition-service process. The necklace's audio arrives
 * over the network and passes through [LiveScribe.feed] in this app's own memory —
 * these are the very bytes written down the recognizer's pipe, so keeping a copy
 * costs one extra write of something already in hand.
 *
 * ⚠️ WHY THIS IS A FILE OF ITS OWN, not a private class inside [LiveScribe] where it
 * started. Every rule below fails SILENTLY, and none of them could be reached from a
 * test while nested inside a driver built out of `SpeechRecognizer`, `Handler` and
 * `ParcelFileDescriptor`. A mutation battery proved that the hard way: a header
 * claiming zero samples, a poisoned write thrown through the transcript, and a
 * 44-byte empty file kept as a playable row ALL survived, because the only pins that
 * can see into a class like that are greps, and a grep cannot watch bytes land.
 * Nothing here touches Android — it is `java.io` and an integer — so the class lives
 * where a JVM test can drive it. See `SegmentAudioTest`.
 *
 * Same shape as the file half of a take, and for the same reason: a write that throws
 * POISONS the container, so the stream is dropped on the first failure and the
 * TRANSCRIPT half of the segment still survives. [bytes] is what tells [finish]
 * whether there is anything worth keeping — a file that exists with no audio in it is
 * an unplayable row with a Play button.
 *
 * @param stream ⚠️ THE TEST SEAM, and the reason it is worth one parameter. The rule
 *   that matters most here — a write that fails must cost the audio and NOT the words
 *   — is unreachable otherwise: a `FileOutputStream` this class opened itself cannot
 *   be made to fail on demand from a test, and that rule survived a mutant that
 *   removed the `runCatching` entirely. Production never passes it; [pending] is the
 *   constructor the app uses.
 */
internal class SegmentAudio(
    val file: java.io.File,
    stream: java.io.OutputStream? = null,
) {

    /**
     * `live-<uuid>.wav` while pending — and the name is the whole join.
     *
     * This phone has no local `index.json` (the server IS the list), so unlike iOS
     * nothing on disk maps a file to a row. The NAME carries the pointer instead:
     * pending here, renamed to [LiveTranscribe.claimedAudioName] by
     * [PhoneRecorder.claimAudio] when the row comes back.
     */
    val name: String get() = file.name

    private var out: java.io.OutputStream? = stream
        ?: runCatching { java.io.BufferedOutputStream(java.io.FileOutputStream(file)) }.getOrNull()

    /** Sample bytes written so far, excluding the header. */
    var bytes = 0
        private set

    /** True while a write could still succeed — false once poisoned or closed. */
    val open: Boolean get() = out != null

    init {
        // Placeholder: the real sizes aren't known until the segment closes, so the
        // header is REWRITTEN in finish(). A 44-byte gap now keeps the samples at the
        // offset the finished header will declare. Failing here poisons the container
        // exactly as a failed sample write does — a file whose samples start at offset
        // 0 would be noise in front of every recording.
        val o = out
        if (o != null) runCatching { o.write(ByteArray(HEADER_BYTES)) }.onFailure { out = null }
    }

    /**
     * Append conditioned PCM. NEVER throws: the words are worth more than the audio.
     *
     * A failure here (a full disk, a revoked directory) poisons the container for good
     * rather than being retried per chunk — a half-written file with a plausible header
     * is worse than no file, and the caller is mid-stream with a transcript to file.
     */
    fun write(pcm: ByteArray, length: Int) {
        val o = out ?: return
        runCatching { o.write(pcm, 0, length); bytes += length }
            .onFailure { out = null }   // poisoned — keep the words, drop the audio
    }

    /**
     * Close EXPLICITLY and return whether the file is worth keeping.
     *
     * Not left to a finalizer: the header carries the sizes, so bytes read before it is
     * rewritten are unplayable everywhere while every log line reads ok — the same
     * defect as an AAC file with no moov atom.
     *
     * A segment with no samples is DELETED and refused, not kept: 44 bytes of header is
     * a valid WAV of silence, so keeping it would put a Play button on a row whose audio
     * is nothing at all. Refusing is also what stops an empty room's minute being stored
     * every minute forever.
     *
     * Idempotent — a second call finds no stream and re-reports the same verdict.
     */
    fun finish(): Boolean {
        val o = out
        out = null
        runCatching { o?.flush(); o?.close() }
        if (bytes <= 0) { runCatching { file.delete() }; return false }
        return runCatching {
            java.io.RandomAccessFile(file, "rw").use { raf ->
                raf.seek(0)
                raf.write(LiveTranscribe.wavHeader(bytes))
            }
        }.isSuccess.also { if (!it) runCatching { file.delete() } }
    }

    /**
     * [finish], as the value a row wants: the file's name, or null if there is no
     * audio worth pointing at.
     *
     * One call rather than a boolean the caller pairs back up with a name, because the
     * pairing is the whole promise the `nicla_voice_transcripts` tool makes — every
     * agent is told a necklace-live row's audio is playable in the app. A caller that
     * closes the file and then files `null` anyway is the exact shape of the bug this
     * cycle exists to fix, and it should not be expressible in two independent lines.
     */
    fun finishAndName(): String? = if (finish()) name else null

    /**
     * Throw the audio away — the segment's words weren't worth storing either.
     *
     * Deliberately NOT left to the retention sweeps: no row will ever reference this
     * file, so [LiveTranscribe.audioEvictions] can't see it (it is still pending) and
     * only the ten-minute orphan gate would ever collect it. A minute of an empty room
     * should not sit on someone's disk for ten.
     */
    fun discard() {
        out?.let { o -> out = null; runCatching { o.close() } }
        runCatching { file.delete() }
    }

    companion object {
        /** The RIFF/WAV header's length — see [LiveTranscribe.wavHeader]. */
        const val HEADER_BYTES = 44

        /**
         * A fresh pending segment in `dir` — the constructor the app uses.
         *
         * The prefix is [LiveTranscribe.PENDING_AUDIO_PREFIX] and not a literal: both
         * retention sweeps partition the directory on exactly that string, so a typo
         * here would make live audio permanent.
         */
        fun pending(dir: java.io.File): SegmentAudio = SegmentAudio(
            java.io.File(dir, "${LiveTranscribe.PENDING_AUDIO_PREFIX}${java.util.UUID.randomUUID()}.wav"),
        )
    }
}
