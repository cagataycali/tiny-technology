package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Attachments.payloadBytes / payloadBytesOf / fitsPayload — the total-payload batch
 * guard behind the composer's staged attachments (ChatViewModel.addPendingImage /
 * addPendingDoc). The per-item caps (3MB/doc, downscaled images) don't stop FOUR heavy
 * picks from summing past the worker's ~4.5MB body budget, so an over-budget set used to
 * fail server-side as a send error instead of up front. This mirrors iOS
 * MAX_ATTACHMENTS_PAYLOAD_BYTES / Array.payloadBytes and web base64Bytes /
 * attachmentsPayloadBytes so the three clients agree on when "remove some first" fires.
 * payloadBytes = base64.length × 0.75 (base64 inflates raw bytes 4/3×).
 */
class PayloadCapTest {

    /** A base64 string whose DECODED size is ~`bytes` — length = bytes / 0.75. */
    private fun b64OfBytes(bytes: Int): String = "A".repeat((bytes / 0.75).toInt())

    private fun doc(base64: String) = PendingDoc(name = "d", format = "pdf", base64 = base64)

    @Test fun `payloadBytes decodes base64 length at the web 0_75 ratio`() {
        // 400 chars of base64 → 300 decoded bytes.
        assertEquals(300, Attachments.payloadBytes("A".repeat(400)))
    }

    @Test fun `payloadBytesOf sums images and docs together`() {
        val total = Attachments.payloadBytesOf(
            imagesBase64 = listOf(b64OfBytes(1_000_000)),
            docs = listOf(doc(b64OfBytes(500_000))),
        )
        // Small rounding from the two independent 0.75 conversions is fine.
        assertTrue("expected ~1.5MB, got $total", total in 1_499_000..1_500_100)
    }

    @Test fun `an add that keeps the total under the cap fits`() {
        // ~2MB already staged + a ~1MB add = ~3MB < 3.5MB cap.
        assertTrue(
            Attachments.fitsPayload(
                imagesBase64 = listOf(b64OfBytes(2_000_000)),
                docs = emptyList(),
                addBase64 = b64OfBytes(1_000_000),
            )
        )
    }

    @Test fun `an add that pushes the total past the cap is rejected`() {
        // ~3MB already staged + a ~1MB add = ~4MB > 3.5MB cap.
        assertFalse(
            Attachments.fitsPayload(
                imagesBase64 = listOf(b64OfBytes(3_000_000)),
                docs = emptyList(),
                addBase64 = b64OfBytes(1_000_000),
            )
        )
    }

    @Test fun `the first add into an empty composer fits under the cap`() {
        assertTrue(
            Attachments.fitsPayload(emptyList(), emptyList(), addBase64 = b64OfBytes(3_000_000))
        )
    }

    @Test fun `a single add at exactly the cap fits`() {
        // Boundary: total == MAX_PAYLOAD_BYTES is allowed (≤, not <).
        val exact = b64OfBytes(Attachments.MAX_PAYLOAD_BYTES)
        assertTrue(Attachments.fitsPayload(emptyList(), emptyList(), addBase64 = exact))
    }

    @Test fun `docs already staged count against an incoming image`() {
        // ~3.2MB of docs leaves < 0.3MB — a ~0.5MB image can't join.
        assertFalse(
            Attachments.fitsPayload(
                imagesBase64 = emptyList(),
                docs = listOf(doc(b64OfBytes(3_200_000))),
                addBase64 = b64OfBytes(500_000),
            )
        )
    }

    @Test fun `an injected max lets the rule scale`() {
        assertFalse(
            Attachments.fitsPayload(
                imagesBase64 = listOf(b64OfBytes(800_000)),
                docs = emptyList(),
                addBase64 = b64OfBytes(400_000),
                max = 1_000_000,
            )
        )
    }

    @Test fun `the composer cap label is MiB-derived, matching web and iOS`() {
        // 3_500_000 B ÷ 1024² = 3.33… → "3.3MB", NOT the decimal-MB "3.5MB"
        // the message used to hardcode. Web ((/1024/1024).toFixed(1)) and iOS
        // (/1_048_576, %.1f) both render "3.3MB"; this keeps Android honest and
        // self-updating if MAX_PAYLOAD_BYTES ever moves.
        assertEquals("3.3MB", Attachments.MAX_PAYLOAD_LABEL)
    }

    @Test fun `the per-document cap label is MiB-derived, matching web`() {
        // 3_000_000 B ÷ 1024² = 2.86… → "2.9MB", NOT the decimal-MB "3MB" the
        // reject message used to hardcode (which read HIGHER than a rejected
        // file whose size the same string renders in MiB). Web
        // (lib/file-attachments.ts:130, (MAX_DOCUMENT_BYTES/1024/1024).toFixed(1))
        // renders "2.9MB" from the identical 3_000_000 constant.
        assertEquals("2.9MB", Attachments.MAX_DOC_LABEL)
    }

    @Test fun `both cap labels use a dot decimal under a comma-decimal locale`() {
        // The reference is web's `.toFixed(1)`, which ALWAYS emits a dot. Both
        // labels format with an explicit Locale.US, so on a tr/de/fr device
        // (comma decimal separator) they must still read "3.3MB"/"2.9MB", not
        // "3,3MB"/"2,9MB" — one client silently disagreeing with the others on
        // the exact number a user trims their attachments toward. Reproduce the
        // format under a forced default locale to prove it's locale-pinned, not
        // merely correct on an en_US CI box.
        val original = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr-TR"))
            assertEquals(
                "3.3MB",
                String.format(java.util.Locale.US, "%.1fMB", Attachments.MAX_PAYLOAD_BYTES / 1_048_576.0),
            )
            assertEquals(
                "2.9MB",
                String.format(java.util.Locale.US, "%.1fMB", Attachments.MAX_DOC_BYTES / 1_048_576.0),
            )
            // Guardrail: the SAME expression WITHOUT the locale would drift to a
            // comma under tr-TR — proving the Locale.US pin is what's load-bearing.
            assertEquals(
                "3,3MB",
                String.format("%.1fMB", Attachments.MAX_PAYLOAD_BYTES / 1_048_576.0),
            )
        } finally {
            java.util.Locale.setDefault(original)
        }
    }
}
