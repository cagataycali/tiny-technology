package technology.tiny.app.tools

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure ImageReader row-stride geometry (behind ScreenshotService.bitmapFrom).
 * The GPU pads each captured row to an alignment boundary, so the backing
 * bitmap must be built at the PADDED width and cropped back to the screen
 * width — get this off by one and every Android screenshot shears diagonally
 * (each row offset by the pad). Bitmap/Image are on-device only, so the risky
 * arithmetic is extracted and tested here. iOS has no analogue (ReplayKit
 * hands back a ready CVPixelBuffer).
 */
class ScreenshotServiceTest {

    // RGBA_8888 → 4 bytes/pixel, the only format ScreenshotService requests.
    private val rgba = 4

    @Test fun `no padding returns the exact screen width`() {
        // rowStride == pixelStride * width → nothing to crop.
        assertEquals(1080, ScreenshotService.paddedBufferWidth(1080, rgba, 1080 * rgba))
    }

    @Test fun `padded rows widen the buffer by padding div pixelStride`() {
        // Common case: 1080px screen, row padded from 4320 to 4352 bytes (+32).
        // Extra columns = 32 / 4 = 8 → buffer is 1088 wide, then cropped to 1080.
        assertEquals(1088, ScreenshotService.paddedBufferWidth(1080, rgba, 4352))
    }

    @Test fun `a larger pad adds proportionally more columns`() {
        // 720px screen padded from 2880 to 3072 bytes (+192) → 192/4 = 48 cols.
        assertEquals(768, ScreenshotService.paddedBufferWidth(720, rgba, 3072))
    }

    @Test fun `defends against a zero pixelStride instead of dividing by zero`() {
        // Should never happen for RGBA_8888, but a bad plane must not crash the
        // capture — fall back to the screen width.
        assertEquals(1080, ScreenshotService.paddedBufferWidth(1080, 0, 9999))
    }

    @Test fun `an under-reported rowStride degrades to the screen width`() {
        // Defensive: a negative pad (rowStride < pixelStride*width) can't widen
        // the buffer — clamp to width rather than shrink it.
        assertEquals(1080, ScreenshotService.paddedBufferWidth(1080, rgba, 1080 * rgba - 16))
    }
}
