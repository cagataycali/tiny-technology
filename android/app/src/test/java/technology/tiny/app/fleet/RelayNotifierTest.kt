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

    @Test fun `unknown tags default to the quiet activity channel`() {
        val route = RelayNotifier.classify("tiny-notification", "/") as RelayNotifier.Route.Banner
        assertEquals(RelayNotifier.CHANNEL_ACTIVITY, route.channel)
        assertNull(route.tinySlug)
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
