package technology.tiny.app.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The up-front price-badge visibility gate — mirrors web Chat.tsx:2386 and iOS
 * Views.swift:1607 exactly: `priceMicro != null && !(isPrivate && !isAuthorized)`.
 */
class PriceBadgeTest {

    @Test fun `free tiny (null price) never shows the badge`() {
        assertFalse(shouldShowPriceBadge(null, isPrivate = false, isAuthorized = false))
        assertFalse(shouldShowPriceBadge(null, isPrivate = true, isAuthorized = true))
    }

    @Test fun `paid public tiny shows the badge`() {
        assertTrue(shouldShowPriceBadge(10_000L, isPrivate = false, isAuthorized = false))
        assertTrue(shouldShowPriceBadge(10_000L, isPrivate = false, isAuthorized = true))
    }

    @Test fun `paid private tiny hides the badge while the device is NOT vouched`() {
        // A non-vouched visitor gets the lock panel instead of the composer — a
        // badge they can't act on would dead-end (the divergence this closes).
        assertFalse(shouldShowPriceBadge(10_000L, isPrivate = true, isAuthorized = false))
    }

    @Test fun `paid private tiny shows the badge once vouched (owner or unlocked visitor)`() {
        assertTrue(shouldShowPriceBadge(10_000L, isPrivate = true, isAuthorized = true))
    }
}
