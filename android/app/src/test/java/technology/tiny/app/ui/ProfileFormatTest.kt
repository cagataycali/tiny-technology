package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

/**
 * Pure English count label behind the profile section headers + follower meta
 * (web Profile.tsx / iOS Panels.swift parity: "1 public tiny", "3 forged tools",
 * "0 followers"). The singular/plural must be exact — the sheet header reads
 * "N public tiny/s" verbatim.
 */
class ProfileFormatTest {

    @Test fun `zero and plural take the s`() {
        assertEquals("0 followers", pluralCount(0, "follower"))
        assertEquals("2 followers", pluralCount(2, "follower"))
        assertEquals("0 public tinys", pluralCount(0, "public tiny"))
        assertEquals("3 forged tools", pluralCount(3, "forged tool"))
    }

    @Test fun `exactly one is singular`() {
        assertEquals("1 follower", pluralCount(1, "follower"))
        assertEquals("1 public tiny", pluralCount(1, "public tiny"))
        assertEquals("1 forged tool", pluralCount(1, "forged tool"))
    }

    /**
     * Tool-install price CHIP label. A one-time install is a CHARGE, not a
     * per-message rate, so it formats through the canonical usd() (min-2 up to
     * 6 fraction digits → "$0.50"/"$1.00") — matching the server install paywall
     * and web (ProfileToolCard.tsx) + iOS (Panels.swift priceLabel), which both
     * route the install charge through usd(). Free tools (0/negative) render "".
     */
    @Test fun `free tool has no price label`() {
        assertEquals("", priceLabel(0L))
        assertEquals("", priceLabel(-5L))
    }

    @Test fun `priced tool uses min-2 currency formatting`() {
        assertEquals("$0.50", priceLabel(500_000L))      // half a dollar — min-2, NOT "$0.5"
        assertEquals("$1.00", priceLabel(1_000_000L))    // whole dollar — min-2, NOT "$1"
        assertEquals("$0.001", priceLabel(1_000L))       // platform-fee floor (3dp kept)
        assertEquals("$0.0001", priceLabel(100L))        // sub-cent (4dp kept)
        assertEquals("$2.25", priceLabel(2_250_000L))
    }

    /**
     * A NONZERO price below the min-2 significant range still renders its true
     * value via usd()'s up-to-6dp precision — it does NOT collapse to "$0.00".
     * priceMicro=1 is $0.000001; usd() keeps all 6 places. This is the whole
     * point of routing the CHARGE through usd() instead of the strip-zeros badge
     * formatter: an install charge must never under-report as free. Web + iOS
     * usd() agree (both show the sub-cent value, never "$0").
     */
    @Test fun `a sub-cent nonzero charge shows its true value, never dollar-zero`() {
        assertEquals("$0.000001", priceLabel(1L))   // $0.000001 — full 6dp, not "$0"
        assertEquals("$0.000049", priceLabel(49L))
    }

    /**
     * The decimal separator is ALWAYS a dot, even on a comma-decimal device
     * locale (de/fr/tr). usd() pins Locale.US, so a German phone still renders
     * "$0.50", never "$0,50". Web (toLocaleString en-US) + iOS (NumberFormatter
     * en_US) hold the same locale-independence contract.
     */
    @Test fun `decimal separator is a dot regardless of device locale`() {
        val prior = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY) // comma is the decimal separator here
            assertEquals("$0.50", priceLabel(500_000L))
            assertEquals("$2.25", priceLabel(2_250_000L))
            assertEquals("$0.0001", priceLabel(100L))
        } finally {
            Locale.setDefault(prior)
        }
    }
}
