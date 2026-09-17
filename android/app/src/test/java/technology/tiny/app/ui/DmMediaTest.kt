package technology.tiny.app.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 📎 DM media rules on the JVM — the half of DmMedia.kt that has no camera in it.
 *
 * The codecs need a device; these do not, and these are the parts that decide
 * whether a DM can be sent at all. Every number and sentence here is also pinned
 * against the TypeScript and Swift copies from node
 * (tests/android-dm-media.test.ts) — that catches DRIFT, while this file catches
 * a rule that is WRONG in all three languages at once.
 */
class DmMediaTest {

    // ── the allowlist decides the kind, and nothing else does ────────────────

    @Test fun `kind comes from the content type`() {
        assertEquals("image", dmAttachmentKind("image/jpeg"))
        assertEquals("image", dmAttachmentKind("image/gif"))
        assertEquals("video", dmAttachmentKind("video/mp4"))
        assertEquals("audio", dmAttachmentKind("audio/wav"))
    }

    @Test fun `an unlisted type has no kind`() {
        // The store won't serve these, so the composer must not stage them and the
        // renderer must not guess at them.
        assertNull(dmAttachmentKind("video/quicktime"))
        assertNull(dmAttachmentKind("image/heic"))
        assertNull(dmAttachmentKind("application/pdf"))
        assertNull(dmAttachmentKind(""))
    }

    @Test fun `the type is matched case-insensitively and trimmed`() {
        // A server that echoes "IMAGE/JPEG" or " image/jpeg" must not turn a photo
        // into an "other" that renders as a bare link.
        assertEquals("image", dmAttachmentKind("IMAGE/JPEG"))
        assertEquals("image", dmAttachmentKind(" image/png "))
    }

    @Test fun `🔴 a decoded attachment ignores the kind on the wire`() {
        // The defence: a caller that labels an mp4 as an image would otherwise get
        // its bytes handed to an image decoder — and, on the read path, to a vision
        // model as a picture.
        val a = dmAttachment(
            JSONObject()
                .put("kind", "image")           // ← the lie
                .put("url", "/media/x.mp4")
                .put("contentType", "video/mp4"),
            0,
        )
        assertEquals("video", a?.kind)
    }

    @Test fun `an unknown type decodes as other rather than vanishing`() {
        // A bubble that shows nothing tells the reader the message was empty.
        val a = dmAttachment(
            JSONObject().put("url", "/media/x.bin").put("contentType", "application/x-thing"),
            0,
        )
        assertEquals("other", a?.kind)
    }

    @Test fun `an attachment with no url is dropped`() {
        assertNull(dmAttachment(JSONObject().put("contentType", "image/jpeg"), 0))
        assertNull(dmAttachment(JSONObject(), 0))
    }

    @Test fun `ids are unique even when the same file is attached twice`() {
        // Two identical keys in a lazy list is a rendering bug, and attaching the
        // same photo twice is legitimate.
        val arr = JSONArray()
            .put(JSONObject().put("url", "/media/a.jpg").put("contentType", "image/jpeg"))
            .put(JSONObject().put("url", "/media/a.jpg").put("contentType", "image/jpeg"))
        val list = dmAttachments(arr)
        assertEquals(2, list.size)
        assertEquals(2, list.map { it.id }.toSet().size)
    }

    @Test fun `a bad row costs its own slot, not the message`() {
        val arr = JSONArray()
            .put(JSONObject().put("url", "/media/a.jpg").put("contentType", "image/jpeg"))
            .put(JSONObject().put("contentType", "image/jpeg")) // no url
            .put(JSONObject().put("url", "/media/b.mp4").put("contentType", "video/mp4"))
        val list = dmAttachments(arr)
        assertEquals(listOf("image", "video"), list.map { it.kind })
    }

    @Test fun `no attachments decodes to an empty list, not a crash`() {
        assertEquals(emptyList<DmAttachment>(), dmAttachments(null))
        assertEquals(emptyList<DmAttachment>(), dmAttachments(JSONArray()))
    }

    // ── the send body ───────────────────────────────────────────────────────

    @Test fun `a text-only DM sends the shape it always sent`() {
        // Not an empty array: every text-only client has posted exactly this for as
        // long as /api/messages has existed.
        val body = dmSendBody("ada", "hi", emptyList())
        assertEquals("ada", body.optString("to"))
        assertEquals("hi", body.optString("message"))
        assertTrue(body.opt("attachments") == null)
    }

    @Test fun `an attachment ships kind, url, type and the size that was measured`() {
        val a = DmAttachment(
            kind = "image", url = "/media/a.jpg", contentType = "image/jpeg",
            bytes = 1234, width = 800, height = 600,
        )
        val arr = dmSendBody("ada", "", listOf(a)).optJSONArray("attachments")
        assertNotNull(arr)
        val one = arr!!.optJSONObject(0)
        assertEquals("image", one.optString("kind"))
        assertEquals("/media/a.jpg", one.optString("url"))
        assertEquals("image/jpeg", one.optString("contentType"))
        assertEquals(1234, one.optInt("bytes"))
        assertEquals(800, one.optInt("width"))
    }

    @Test fun `a caption-less attachment sends an empty message, not a placeholder`() {
        // The server allows it (decideDmPayload) and the recipient's thread shows
        // the photo alone — inventing "📷" here would put a caption in the DB that
        // the sender never typed.
        val body = dmSendBody("ada", "", listOf(DmAttachment(kind = "image", url = "/media/a.jpg", contentType = "image/jpeg")))
        assertEquals("", body.optString("message"))
        assertEquals(1, body.optJSONArray("attachments")?.length())
    }

    @Test fun `an empty transcript is left off rather than sent blank`() {
        val a = DmAttachment(kind = "audio", url = "/media/a.wav", contentType = "audio/wav", transcript = "")
        val one = dmSendBody("ada", "", listOf(a)).optJSONArray("attachments")!!.optJSONObject(0)
        assertTrue(one.opt("transcript") == null)
    }

    // ── refusals: the sentence IS the feature ───────────────────────────────

    @Test fun `under the cap is not a refusal`() {
        assertNull(dmSizeRefusal(0))
        assertNull(dmSizeRefusal(DM_UPLOAD_MAX_BYTES))
    }

    @Test fun `🔴 one byte over names both numbers and the state`() {
        val why = dmSizeRefusal(DM_UPLOAD_MAX_BYTES + 1, "That photo")
        assertNotNull(why)
        assertTrue(why!!.startsWith("That photo is "))
        assertTrue(why.contains("over the 2.5MB limit"))
        // "nothing was sent" is the load-bearing half: without it the reader has to
        // guess whether a half-message went out.
        assertTrue(why.endsWith("nothing was sent."))
    }

    @Test fun `sizes are formatted with a dot, whatever the phone's locale`() {
        // A device set to de-DE formats 2.6 as "2,6" — and the server reported the
        // limit as 2.6MB, so the two would disagree in the same sentence.
        val previous = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.GERMANY)
            assertEquals("2.5MB", dmMB(DM_UPLOAD_MAX_BYTES))
        } finally {
            java.util.Locale.setDefault(previous)
        }
    }

    @Test fun `the room rule refuses the whole pick and shows the arithmetic`() {
        assertNull(dmAttachmentRoom(0, 4))
        assertNull(dmAttachmentRoom(3, 1))
        val why = dmAttachmentRoom(3, 2)
        assertNotNull(why)
        // Both of the user's numbers, so they can see why 5 didn't fit in 4.
        assertTrue(why!!.contains("carry 4 attachments"))
        assertTrue(why.contains("you have 3 and picked 2"))
    }

    @Test fun `a clip is refused on duration, before the transcode`() {
        assertNull(dmClipRefusal(DM_CLIP_MAX_SECONDS.toDouble()))
        val why = dmClipRefusal(94.4)
        assertNotNull(why)
        assertTrue(why!!.contains("That clip is 94s"))
        assertTrue(why.contains("up to 30s"))
        // The only remedy that actually works, named.
        assertTrue(why.contains("Trim it"))
    }

    @Test fun `an unmeasurable duration is not a refusal`() {
        // A NaN from a file that wouldn't report its length must not become "That
        // clip is NaNs" — the caller refuses that case with its own sentence.
        assertNull(dmClipRefusal(Double.NaN))
    }

    // ── the send gate ───────────────────────────────────────────────────────

    @Test fun `nothing staged blocks nothing`() {
        assertNull(dmBlockingReason(emptyList()))
        assertNull(dmBlockingReason(listOf(DmUploadState.READY, DmUploadState.READY)))
    }

    @Test fun `🔴 an in-flight upload blocks the send`() {
        // The whole reason this exists: the DM would arrive without the photo, and
        // it cannot be unsent.
        assertEquals(
            "Still uploading — one moment.",
            dmBlockingReason(listOf(DmUploadState.READY, DmUploadState.UPLOADING)),
        )
    }

    @Test fun `a failed upload blocks the send and offers both ways out`() {
        val why = dmBlockingReason(listOf(DmUploadState.READY, DmUploadState.FAILED))
        assertNotNull(why)
        assertTrue(why!!.contains("Retry it or remove it"))
        assertTrue(why.contains("nothing was sent"))
    }

    @Test fun `uploading wins over failed — the transient reason first`() {
        // With one of each, "still uploading" is the one that will resolve on its
        // own; telling the user to retry something that hasn't finished is noise.
        assertEquals(
            "Still uploading — one moment.",
            dmBlockingReason(listOf(DmUploadState.FAILED, DmUploadState.UPLOADING)),
        )
    }

    // ── durations ───────────────────────────────────────────────────────────

    @Test fun `durations read as a clock`() {
        assertEquals("0:07", dmDuration(7_000))
        assertEquals("1:42", dmDuration(102_000))
        assertEquals("0:01", dmDuration(600))   // rounds up off zero
    }

    @Test fun `a missing duration shows nothing, not zero`() {
        // "0:00" reads as a broken file; an absent label reads as "not stated".
        assertEquals("", dmDuration(null))
        assertEquals("", dmDuration(0))
    }

    // ── transcripts ─────────────────────────────────────────────────────────

    @Test fun `a short transcript is untouched`() {
        assertEquals("hello there", dmClipTranscript("hello there"))
    }

    @Test fun `🔴 clipping a long transcript never splits a surrogate pair`() {
        // The exact defect tests/dm-length-parity.test.ts documents for the DM body:
        // Kotlin's String.take counts UTF-16 units, so it can cut an emoji in half
        // and leave a lone high surrogate — mojibake in D1 and in the recipient's
        // thread. This must clip on code points instead.
        // One BMP character in front, so the unit-counting cut lands BETWEEN the two
        // halves of an emoji — the same string dm-length-parity uses for the body.
        val long = "x" + "👋".repeat(DM_MAX_TRANSCRIPT_CHARS + 50)
        val out = dmClipTranscript(long)
        assertEquals(DM_MAX_TRANSCRIPT_CHARS, out.codePointCount(0, out.length))
        assertEquals("x" + "👋".repeat(DM_MAX_TRANSCRIPT_CHARS - 1), out)
        // And the naive version really is wrong, so this pins a defect rather than a
        // preference: it keeps half the characters AND ends mid-pair.
        val naive = long.take(DM_MAX_TRANSCRIPT_CHARS)
        assertTrue(naive.last().isHighSurrogate())
        assertTrue(naive.codePointCount(0, naive.length) < DM_MAX_TRANSCRIPT_CHARS)
    }

    // ── 🔊 WAV: the bytes the other clients play ─────────────────────────────

    @Test fun `the header is a 44-byte RIFF WAVE, mono, 16-bit, 16kHz`() {
        val h = dmWavHeader(1000)
        assertEquals(44, h.size)
        assertEquals("RIFF", String(h, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(h, 8, 4, Charsets.US_ASCII))
        assertEquals("fmt ", String(h, 12, 4, Charsets.US_ASCII))
        assertEquals("data", String(h, 36, 4, Charsets.US_ASCII))
        fun le16(off: Int) = (h[off].toInt() and 0xff) or ((h[off + 1].toInt() and 0xff) shl 8)
        fun le32(off: Int) = le16(off) or (le16(off + 2) shl 16)
        assertEquals(36 + 1000, le32(4))          // RIFF size = file - 8
        assertEquals(16, le32(16))                // fmt chunk size
        assertEquals(1, le16(20))                 // PCM, uncompressed
        assertEquals(1, le16(22))                 // mono
        assertEquals(DM_VOICE_SAMPLE_RATE, le32(24))
        assertEquals(DM_VOICE_SAMPLE_RATE * 2, le32(28)) // byte rate
        assertEquals(2, le16(32))                 // block align
        assertEquals(16, le16(34))                // bits per sample
        assertEquals(1000, le32(40))              // data size
    }

    @Test fun `a WAV reports its own length back`() {
        // One second of 16kHz mono PCM16 = 32000 bytes.
        val wav = dmWavHeader(32_000) + ByteArray(32_000)
        assertEquals(1_000, dmWavDurationMs(wav))
    }

    @Test fun `a truncated WAV reports zero rather than throwing`() {
        assertEquals(0, dmWavDurationMs(ByteArray(10)))
    }

    @Test fun `🔴 a full-length voice note still fits the upload cap`() {
        // This is where DM_VOICE_MAX_MS comes from — if the cap or the sample rate
        // ever moves, a 60-second note becomes unsendable AFTER it was recorded.
        val bytes = 44 + dmVoicePcmCap()
        assertTrue("60s of PCM is $bytes bytes", bytes <= DM_UPLOAD_MAX_BYTES)
        assertNull(dmSizeRefusal(bytes, "That voice note"))
    }

    @Test fun `the byte clock and the cap agree`() {
        assertEquals(DM_VOICE_MAX_MS, dmPcmMs(dmVoicePcmCap().toLong()))
        assertEquals(1_000L, dmPcmMs(32_000L))
        assertEquals(0L, dmPcmMs(0L))
    }

    // ── 🎥 the clip bitrate budget ───────────────────────────────────────────

    @Test fun `🔴 the requested bitrate keeps a full-length clip under the cap`() {
        // Arithmetic, not a preset: budget bytes → bits, minus the audio track,
        // divided by the duration. Checked at both ends of the allowed range.
        for (seconds in listOf(1, 5, 15, DM_CLIP_MAX_SECONDS)) {
            val ms = seconds * 1000L
            val bps = dmClipVideoBitrate(ms)
            val predicted = ((bps + 64_000L) * seconds / 8)
            assertTrue(
                "${seconds}s at ${bps}bps ≈ $predicted bytes",
                predicted <= DM_UPLOAD_MAX_BYTES,
            )
        }
    }

    @Test fun `the second pass asks for less than the first`() {
        val first = dmClipVideoBitrate(30_000)
        val second = dmClipVideoBitrate(30_000, tighten = 0.6)
        assertTrue("$second should be below $first", second < first)
    }

    @Test fun `the bitrate is clamped, so no clip is encoded into mush`() {
        // A very long clip's fair share would fall below what 540p H.264 needs to
        // be watchable — better to hit the floor, measure the result and refuse
        // with real bytes than to send something unwatchable.
        assertEquals(120_000, dmClipVideoBitrate(600_000))
        assertEquals(2_500_000, dmClipVideoBitrate(500))
    }

    // ── preview boxes ───────────────────────────────────────────────────────

    @Test fun `a photo's box comes from its stored aspect ratio`() {
        // Reserving the right height is what stops the thread reflowing under the
        // reader's thumb as photos decode.
        assertEquals(220, dmPreviewHeight(1000, 1000, maxWidth = 220))
        assertEquals(165, dmPreviewHeight(1600, 1200, maxWidth = 220))
    }

    @Test fun `an unmeasured photo gets a sane box instead of a zero-height one`() {
        assertEquals(165, dmPreviewHeight(null, null, maxWidth = 220))
        assertEquals(165, dmPreviewHeight(0, 0, maxWidth = 220))
    }

    @Test fun `a panorama and a skyscraper both stay inside their bounds`() {
        assertTrue(dmPreviewHeight(4000, 200, maxWidth = 220) >= 80)
        assertTrue(dmPreviewHeight(200, 4000, maxWidth = 220) <= 308)
    }
}
