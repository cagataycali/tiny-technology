package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import technology.tiny.app.tools.AlertWorker

/**
 * The tag→route contract between the worker's push tags (push.ts: dm-<sender>,
 * tiny-job-<id>, tiny-visit-<slug>) and the native notification surfaces. A
 * misroute here either double-banners DMs (bypassing DmNotifier's snapshot) or
 * turns ambient visit pings into heads-up alerts.
 */
class RelayNotifierTest {

    // -- classify --

    @Test fun `dm tags poke the DM poll instead of bannering`() {
        assertEquals(RelayNotifier.Route.DmPoke, RelayNotifier.classify("dm-u123", "/tiny?dm=ada"))
    }

    @Test fun `a dm-shaped url routes to the poll even with an unknown tag`() {
        assertEquals(RelayNotifier.Route.DmPoke, RelayNotifier.classify("custom", "/tiny?dm=ada"))
    }

    @Test fun `job tags banner on the high-importance alerts channel`() {
        val route = RelayNotifier.classify("tiny-job-42", "/deploy-bot") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, route.channel)
        assertEquals("deploy-bot", route.tinySlug)
    }

    @Test fun `device-result tags banner on the alerts channel — the user fired this work and is waiting`() {
        val route = RelayNotifier.classify("device-result-env42", "/?q=fetch") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, route.channel)
        assertNull(route.tinySlug) // "/" home url — banner opens the app
        assertEquals("fetch", route.redeemQ) // tap → trusted ask?q= auto-send
    }

    @Test fun `batch tags banner on the alerts channel with the redeem turn`() {
        val route = RelayNotifier.classify("batch-batch_abc12345", "/?q=redeem%20it") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, route.channel)
        assertEquals("redeem it", route.redeemQ)
    }

    // -- redeemQuery: pure string parsing (JVM tests — no android.net.Uri) --

    @Test fun `redeemQuery decodes the q param and ignores everything else`() {
        assertEquals(
            "My device finished — fetch it with use_device action:'result'",
            RelayNotifier.redeemQuery("/?q=My%20device%20finished%20%E2%80%94%20fetch%20it%20with%20use_device%20action%3A'result'"),
        )
        assertEquals("x", RelayNotifier.redeemQuery("/tiny?from=push&q=x"))
        assertNull(RelayNotifier.redeemQuery("/tiny?from=push"))
        assertNull(RelayNotifier.redeemQuery("/"))
        assertNull(RelayNotifier.redeemQuery("/?q="))
    }

    @Test fun `visit tags banner on the quiet activity channel`() {
        val route = RelayNotifier.classify("tiny-visit-mytiny", "/mytiny") as RelayNotifier.Route.Banner
        assertEquals(RelayNotifier.CHANNEL_ACTIVITY, route.channel)
        assertEquals("mytiny", route.tinySlug)
    }

    /**
     * ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and that is the whole finding.
     * It read "unknown tags default to the quiet activity channel" and passed,
     * because `classify` enumerated the loud tags and let the default absorb
     * everything else in silence. So every push kind added upstream was born
     * silent on Android — see the four below, each of which fell through.
     */
    @Test fun `an unknown tag defaults LOUD — a kind nobody taught this client still interrupts`() {
        val route = RelayNotifier.classify("tiny-notification", "/") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, route.channel)
        assertNull(route.tinySlug)
    }

    @Test fun `a finished background task banners — the delivery half of fire-and-forget use_device`() {
        // relay.ts buildTaskResultPush: `task-result-<ticket>`. The user fired a
        // task at their Mac and walked away; this push IS the feature. It matched
        // no arm of the old list, so it arrived as a soundless chip while the same
        // feature's late reply (device-result-) got a heads-up banner.
        val route = RelayNotifier.classify("task-result-task_2b7f3e0f_t123", "/?q=fetch%20it")
            as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, route.channel)
        assertEquals("fetch it", route.redeemQ)
    }

    @Test fun `money movements banner — silence about a refund reads as loss`() {
        // money-events.ts on pay_refunded: "The one that MUST be sent. A failed
        // withdrawal already debited the balance and then refunded it; a user who
        // saw the debit and nothing else has watched money disappear."
        for (tag in listOf("money-refunded", "money-earned", "money-received", "money-withdrawn")) {
            val route = RelayNotifier.classify(tag, "/wallet") as RelayNotifier.Route.Banner
            assertEquals("$tag must interrupt", AlertWorker.CHANNEL, route.channel)
        }
    }

    @Test fun `the ambient match is anchored at the START of the tag`() {
        // startsWith, not contains: a tag that merely CONTAINS the nicety is not
        // one. Without this, `contains` passes every other test in this file —
        // it only diverges on a tag with the prefix buried inside, which nothing
        // else here constructs.
        val buried = RelayNotifier.classify("device-result-tiny-visit-x", "/") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, buried.channel)
        val suffixed = RelayNotifier.classify("x-tiny-visit-luna", "/") as RelayNotifier.Route.Banner
        assertEquals(AlertWorker.CHANNEL, suffixed.channel)
    }

    @Test fun `the ambient set is exactly the one tag that is genuinely ambient`() {
        // The closed set is what gets enumerated (lib/push/loudness.ts parity).
        // If this list grows, a push kind went silent — make that a decision
        // somebody wrote down, not a side effect of a default.
        assertEquals(listOf("tiny-visit-"), RelayNotifier.AMBIENT_TAG_PREFIXES)
    }

    @Test fun `same tag yields the same notification id so re-pushes replace`() {
        val a = RelayNotifier.classify("tiny-job-42", "/x") as RelayNotifier.Route.Banner
        val b = RelayNotifier.classify("tiny-job-42", "/y") as RelayNotifier.Route.Banner
        assertEquals(a.notifId, b.notifId)
    }

    // -- tinySlug --

    @Test fun `plain tiny path is a slug, query stripped`() {
        assertEquals("mytiny", RelayNotifier.tinySlug("/mytiny"))
        assertEquals("mytiny", RelayNotifier.tinySlug("/mytiny?from=push"))
    }

    @Test fun `profile home and nested paths are not slugs`() {
        assertNull(RelayNotifier.tinySlug("/@ada")) // visit-by-known-user url
        assertNull(RelayNotifier.tinySlug("/"))
        assertNull(RelayNotifier.tinySlug("/a/b"))
    }
}
