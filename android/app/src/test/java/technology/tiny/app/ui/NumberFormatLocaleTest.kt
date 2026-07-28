package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

/**
 * Locale-independence of the numeric formatters that render into user-facing text
 * shared with web/iOS: render_ui's trimNum (table/chart cells) and MemoryUniverse's
 * compact (headline counts). The bug this pins: Kotlin's `"%.1f".format(v)` extension
 * uses Locale.getDefault(), so a de/fr/tr device would render a COMMA decimal ("1,25",
 * "1,9M") where web (toFixed) and iOS (String(format:)) always emit a DOT ("1.25",
 * "1.9M") — a byte-divergence in what the user sees vs the other two clients. The fix
 * pins Locale.US on every String.format; these tests run the assertions under a swapped
 * default locale to prove the output no longer tracks the device.
 *
 * Same locale-decimal class as ProfileFormatTest / WalletCore usd/priceLabel.
 */
class NumberFormatLocaleTest {

    private inline fun <T> underLocale(locale: Locale, block: () -> T): T {
        val prev = Locale.getDefault()
        return try {
            Locale.setDefault(locale)
            block()
        } finally {
            Locale.setDefault(prev)
        }
    }

    // ── render_ui trimNum: integers print bare, fractionals get a DOT decimal ──

    @Test fun `trimNum renders whole numbers without a decimal`() {
        assertEquals("42", trimNum(42.0))
        assertEquals("0", trimNum(0.0))
        assertEquals("-7", trimNum(-7.0))
    }

    @Test fun `trimNum uses a dot decimal even on a comma-decimal device`() {
        underLocale(Locale.GERMANY) {
            assertEquals("1.25", trimNum(1.25))
            assertEquals("3.10", trimNum(3.1))
        }
        underLocale(Locale.FRANCE) {
            assertEquals("0.50", trimNum(0.5))
        }
    }

    // ── MemoryUniverse compact: headline count abbreviation, dot decimal ──

    @Test fun `compact abbreviates thousands and millions`() {
        assertEquals("0", compact(0))
        assertEquals("999", compact(999))
        assertEquals("45K", compact(45_300))
        assertEquals("120K", compact(120_000))     // K tier always rounds to whole K
        assertEquals("300.0M", compact(300_000_000)) // M tier keeps "%.1f" (web/iOS twin)
    }

    @Test fun `compact uses a dot decimal even on a comma-decimal device`() {
        underLocale(Locale.GERMANY) {
            assertEquals("1.9M", compact(1_880_100))
            assertEquals("2.5M", compact(2_500_000))
        }
        underLocale(Locale.forLanguageTag("tr-TR")) {
            assertEquals("1.9M", compact(1_880_100))
        }
    }
}
