package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 📸 The glasses-still CAP — the one Android image rail that didn't have one.
 *
 * ⚠️⚠️ MEASURED (javap, mwdat-camera 0.8.0): `StreamConfiguration.videoQuality`
 * is read only by `StreamImpl.start` and `StreamImpl.createVideoFormat` — the
 * VIDEO rail — and `StreamImpl.capturePhoto` reads none of it. The `LOW` this
 * app opens its stream with therefore does NOT shrink the photo; a still comes
 * back at sensor size (12MP on Ray-Ban Meta) and the cap has to be ours.
 *
 * Uncapped, that still went out base64'd inside a JSON body at the worker's
 * `/media/upload`, which gates at 6MB DECODED and answers 400 `data must be
 * valid base64 ≤6MB` — a sentence `photoPayload` hands the user verbatim as the
 * reason their photo failed. iOS caps first ("Cap the long side like
 * Screenshot"), so it never sees that.
 *
 * `Bitmap` can't be constructed in a plain JVM test, so the seam under test is
 * the scaling math [WearablesBridge.scaledTo].
 */
class GlassesPhotoEncodeTest {

    @Test fun `a sensor-size glasses still is capped to the long side`() {
        // Ray-Ban Meta portrait still: 3024×4032.
        val (w, h) = WearablesBridge.scaledTo(3024, 4032, WearablesBridge.PHOTO_MAX_SIDE)!!
        assertEquals(1600, h)
        assertEquals(1200, w)
    }

    @Test fun `the aspect ratio survives the cap`() {
        for ((w, h) in listOf(4032 to 3024, 3024 to 4032, 4000 to 3000, 12_000 to 9_000)) {
            val (sw, sh) = WearablesBridge.scaledTo(w, h, WearablesBridge.PHOTO_MAX_SIDE)!!
            assertEquals(maxOf(sw, sh).toLong(), WearablesBridge.PHOTO_MAX_SIDE.toLong())
            // Within a pixel of the original ratio — .toInt() truncates.
            assertTrue(
                "$w×$h became $sw×$sh",
                Math.abs(w.toDouble() / h - sw.toDouble() / sh) < 0.01,
            )
        }
    }

    @Test fun `a photo already inside the cap is left untouched`() {
        // Null, not a same-size pair: createScaledBitmap on an in-budget photo
        // would resample it for nothing.
        assertNull(WearablesBridge.scaledTo(640, 360, WearablesBridge.PHOTO_MAX_SIDE))
        assertNull(WearablesBridge.scaledTo(1600, 1200, WearablesBridge.PHOTO_MAX_SIDE))
        assertNull(WearablesBridge.scaledTo(900, 1600, WearablesBridge.PHOTO_MAX_SIDE))
    }

    @Test fun `one pixel over the cap does scale`() {
        assertEquals(1600, WearablesBridge.scaledTo(1601, 1200, 1600)!!.first)
    }

    @Test fun `an extreme frame never scales a side to zero pixels`() {
        // A 0-pixel dimension is a createScaledBitmap crash, and this rail's
        // failures are read out loud to the user asking for a photo.
        val (w, h) = WearablesBridge.scaledTo(20_000, 3, 1600)!!
        assertEquals(1600, w)
        assertTrue("short side collapsed to $h", h >= 1)
    }

    @Test fun `the capped photo fits the worker's upload gate with room to spare`() {
        // MEDIA_MAX_BYTES in chatgpt-plugin-tinyai/src/media.ts is 6MB decoded.
        // A 1600-long-side JPEG at q80 lands in the low hundreds of KB; the
        // pin is the ceiling that makes that true — 1600×1600 pixels can't
        // exceed 6MB even at a pessimistic 1 byte per pixel, whereas the
        // uncapped 12MP frame this replaced could not make that promise.
        val worstCasePixels = WearablesBridge.PHOTO_MAX_SIDE.toLong() * WearablesBridge.PHOTO_MAX_SIDE
        assertTrue(
            "a capped still could still overrun /media/upload",
            worstCasePixels < 6L * 1024 * 1024,
        )
        assertTrue(4032L * 3024 > 6L * 1024 * 1024)
    }

    @Test fun `the quality is the one the model is fed everywhere else`() {
        // Screenshot.kt encodes at 80 and iOS at quality 0.8 — the same photo
        // reaching the same model shouldn't be sharper on one phone.
        assertEquals(80, WearablesBridge.PHOTO_QUALITY)
    }
}
