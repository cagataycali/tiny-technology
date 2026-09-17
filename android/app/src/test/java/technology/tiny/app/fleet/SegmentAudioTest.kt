package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🎧 What a necklace-live segment's audio file must actually BE on disk.
 *
 * ⚠️ WHY THIS FILE EXISTS, and it is the most useful thing this cycle produced. The
 * `nicla_voice_transcripts` tool tells every agent that a necklace-live row's audio
 * "is playable on the row in the tiny app" and never to say there is no audio. The
 * Android half of that promise was written and pinned only by SOURCE GREPS, because
 * the writer was a private class nested inside a driver made of `SpeechRecognizer`
 * and `ParcelFileDescriptor`. A mutation battery then walked through four of the
 * pins untouched:
 *  - the segment closed its file and filed the row with `audioFile = null`
 *  - the finished header declared ZERO samples (the missing-moov defect)
 *  - a failed write rethrew and took the segment's TRANSCRIPT down with it
 *  - a zero-byte file was kept, drawing a Play button over 44 bytes of header
 *
 * Every one of those is a Play button that fails, or words lost to a full disk, and
 * every one of them reads fine in the source. A grep can see that `wavHeader(bytes)`
 * appears; only a test can see what the bytes on disk say. So the class moved out to
 * [SegmentAudio] and this drives it against real temp files.
 */
class SegmentAudioTest {

    private fun dir(): java.io.File =
        java.nio.file.Files.createTempDirectory("segaudio").toFile().also { it.deleteOnExit() }

    /** LE reader, so assertions are about the BYTES a player will read, not our own writer. */
    private fun le32(b: ByteArray, at: Int): Int =
        (b[at].toInt() and 0xff) or ((b[at + 1].toInt() and 0xff) shl 8) or
            ((b[at + 2].toInt() and 0xff) shl 16) or ((b[at + 3].toInt() and 0xff) shl 24)

    private fun le16(b: ByteArray, at: Int): Int =
        (b[at].toInt() and 0xff) or ((b[at + 1].toInt() and 0xff) shl 8)

    private fun ascii(b: ByteArray, at: Int, n: Int) = String(b, at, n, Charsets.US_ASCII)

    // ---- the promise: a file a player can actually open ----------------------

    @Test
    fun `a finished segment is a playable WAV whose header describes the samples it holds`() {
        val seg = SegmentAudio.pending(dir())
        val pcm = ByteArray(1_600) { (it % 251).toByte() }   // 50ms of 16k mono PCM16
        seg.write(pcm, pcm.size)
        seg.write(pcm, pcm.size)

        assertTrue("a segment with samples is worth keeping", seg.finish())

        val bytes = seg.file.readBytes()
        assertEquals("header + every sample written", 44 + 3_200, bytes.size)
        assertEquals("RIFF", ascii(bytes, 0, 4))
        assertEquals("WAVE", ascii(bytes, 8, 4))
        assertEquals("data", ascii(bytes, 36, 4))
        // ⚠️ THE MOOV-ATOM DEFECT, as a byte assertion: the sizes aren't known until the
        // segment closes, so a header written once at open declares 0 and the file is
        // unplayable everywhere while every log line reads ok.
        assertEquals("the data chunk declares the samples on disk", 3_200, le32(bytes, 40))
        assertEquals("RIFF size is everything after the field", 36 + 3_200, le32(bytes, 4))
        assertEquals("the board's rate, not a plausible one", 16_000, le32(bytes, 24))
        assertEquals("mono", 1, le16(bytes, 22))
        assertEquals("PCM16", 16, le16(bytes, 34))
    }

    @Test
    fun `the samples land AFTER the header, not over it`() {
        val seg = SegmentAudio.pending(dir())
        // A recognisable first sample: if the placeholder gap were missing, the rewrite
        // would land on top of the audio and every recording would open with noise.
        seg.write(byteArrayOf(0x11, 0x22, 0x33, 0x44), 4)
        assertTrue(seg.finish())

        val bytes = seg.file.readBytes()
        assertEquals(48, bytes.size)
        assertEquals(0x11, bytes[44].toInt() and 0xff)
        assertEquals(0x22, bytes[45].toInt() and 0xff)
        assertEquals(0x44, bytes[47].toInt() and 0xff)
    }

    @Test
    fun `only the length written is stored, not the whole buffer`() {
        val seg = SegmentAudio.pending(dir())
        // The driver hands over a reused buffer with a length — storing buffer.size
        // would append whatever the last chunk left in the tail as audio.
        seg.write(ByteArray(4_096), 100)
        assertTrue(seg.finish())
        assertEquals(100, seg.bytes)
        assertEquals(44 + 100, seg.file.length())
    }

    // ---- an empty segment is not a playable row ------------------------------

    @Test
    fun `a segment nobody spoke into is deleted, not kept as a Play button over silence`() {
        val seg = SegmentAudio.pending(dir())
        assertTrue("the placeholder header exists on disk", seg.file.isFile)

        assertFalse("44 bytes of header is not audio worth keeping", seg.finish())
        assertFalse("and it does not stay on the disk", seg.file.exists())
    }

    @Test
    fun `finishAndName gives the row a pointer only when there is audio to point at`() {
        val d = dir()
        val quiet = SegmentAudio.pending(d)
        assertNull("no samples, so no pointer", quiet.finishAndName())

        val heard = SegmentAudio.pending(d)
        heard.write(ByteArray(64), 64)
        assertEquals("the file it just finished", heard.name, heard.finishAndName())
    }

    // ---- the poisoned-stream contract: the WORDS survive ---------------------

    @Test
    fun `a write that throws costs the audio and never the caller`() {
        val seg = SegmentAudio(java.io.File(dir(), "live-poison.wav"), ThrowingStream(after = 44))
        seg.write(ByteArray(32), 32)      // must NOT throw — the caller is mid-stream
        assertFalse("poisoned by the failure", seg.open)
        assertEquals("nothing was counted", 0, seg.bytes)

        seg.write(ByteArray(32), 32)      // and never re-fails, 30×/second
        assertEquals(0, seg.bytes)
        assertFalse("no audio, so no pointer for the row", seg.finish())
    }

    @Test
    fun `samples written before a failure are not filed as a truncated recording`() {
        // 44 header + 100 bytes, then the disk fills. The bytes that DID land are real
        // audio, so the file is kept and its header must describe exactly them.
        val seg = SegmentAudio(java.io.File(dir(), "live-half.wav"), ThrowingStream(after = 144))
        seg.write(ByteArray(100) { 7 }, 100)
        assertEquals(100, seg.bytes)
        seg.write(ByteArray(100), 100)
        assertFalse(seg.open)
        assertEquals("the failed chunk is not counted", 100, seg.bytes)
    }

    @Test
    fun `a stream that cannot even take the header poisons the segment immediately`() {
        val seg = SegmentAudio(java.io.File(dir(), "live-dead.wav"), ThrowingStream(after = 0))
        assertFalse("no placeholder means no correct offsets, ever", seg.open)
        seg.write(ByteArray(16), 16)
        assertEquals(0, seg.bytes)
    }

    @Test
    fun `an unopenable directory leaves the words alone`() {
        // The real failure mode on a phone: filesDir gone or unwritable. The driver
        // still has a transcript to file, so nothing here may throw.
        val gone = java.io.File(dir(), "not-a-dir/live-x.wav")
        val seg = SegmentAudio(gone)
        assertFalse(seg.open)
        seg.write(ByteArray(8), 8)
        assertFalse(seg.finish())
    }

    // ---- a discarded segment leaves nothing behind --------------------------

    @Test
    fun `discard removes the file a segment not worth storing wrote`() {
        val seg = SegmentAudio.pending(dir())
        seg.write(ByteArray(2_000), 2_000)
        assertTrue(seg.file.isFile)

        seg.discard()
        // ⚠️ Nothing else would: it is still PENDING, so the byte budget skips it, and
        // only the 10-minute orphan gate would ever collect it.
        assertFalse("a minute of an empty room is not left on the disk", seg.file.exists())
        assertFalse(seg.open)
    }

    @Test
    fun `finish is idempotent — a second call re-reports, it does not resurrect`() {
        val seg = SegmentAudio.pending(dir())
        seg.write(ByteArray(80), 80)
        assertTrue(seg.finish())
        val first = seg.file.readBytes()
        assertTrue("still kept", seg.finish())
        assertArrayEqualsMsg("the file was not rewritten differently", first, seg.file.readBytes())
    }

    // ---- the name IS the join ------------------------------------------------

    @Test
    fun `a pending segment is named so both retention sweeps can see what it is`() {
        val seg = SegmentAudio.pending(dir())
        assertTrue(
            "pending names are what the sweeps partition on",
            LiveTranscribe.isPendingAudio(seg.name),
        )
        assertTrue(seg.name.endsWith(".wav"))
        assertEquals("the file and the name it reports are one thing", seg.file.name, seg.name)
    }

    @Test
    fun `two segments in one directory never collide`() {
        val d = dir()
        val a = SegmentAudio.pending(d)
        val b = SegmentAudio.pending(d)
        assertNotNull(a.name)
        assertFalse("a segment per rotation, and several per stream", a.name == b.name)
    }

    private fun assertArrayEqualsMsg(msg: String, a: ByteArray, b: ByteArray) =
        assertTrue(msg, a.contentEquals(b))

    /** A stream that accepts [after] bytes and then fails, like a disk filling up. */
    private class ThrowingStream(private val after: Int) : java.io.OutputStream() {
        private var written = 0
        override fun write(b: Int) {
            if (written >= after) throw java.io.IOException("no space left on device")
            written++
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            if (written + len > after) throw java.io.IOException("no space left on device")
            written += len
        }
    }
}
