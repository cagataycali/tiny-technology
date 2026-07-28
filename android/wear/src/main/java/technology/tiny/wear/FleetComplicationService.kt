package technology.tiny.wear

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import technology.tiny.app.wear.WatchCore
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationRequest

/**
 * Fleet-presence complication — the smallest wrist glance: online/total on the
 * watch face itself, no tile swipe, no app open. Complements [FleetTileService]
 * (richer, one swipe away). Reads the same cached snapshot [WearStore] persists
 * from the phone's `/tiny/snapshot` push, so it renders cold; the phone-side
 * PhoneLinkService requests a refresh when a new snapshot lands.
 *
 * Supports SHORT_TEXT ("2/5", the fleet glance), RANGED_VALUE (online out of
 * total, for arc/progress slots), and LONG_TEXT (the last exchange, for the
 * roomy face slots — "question → answer").
 */
class FleetComplicationService : ComplicationDataSourceService() {

    override fun getPreviewData(type: ComplicationType): ComplicationData? = when (type) {
        ComplicationType.SHORT_TEXT -> shortText(online = 2, total = 5, tapIntent = false)
        ComplicationType.RANGED_VALUE -> rangedValue(online = 2, total = 5, tapIntent = false)
        ComplicationType.LONG_TEXT ->
            longText("what's the weather?", "Sunny, 24°C in Berlin.", 2, 5, tapIntent = false)
        else -> null
    }

    override fun onComplicationRequest(
        request: ComplicationRequest,
        listener: ComplicationRequestListener,
    ) {
        val store = WearStore(this)
        val linked = store.token != null
        val snap = store.snapshot
        val online = snap?.online ?: 0
        val total = snap?.total ?: 0

        val data = when (request.complicationType) {
            ComplicationType.SHORT_TEXT ->
                if (!linked) unlinkedShortText() else shortText(online, total, tapIntent = true)
            ComplicationType.RANGED_VALUE ->
                if (!linked) null else rangedValue(online, total, tapIntent = true)
            ComplicationType.LONG_TEXT ->
                if (!linked) null else longText(snap?.lastQ, snap?.lastA, online, total, tapIntent = true)
            else -> null
        }
        listener.onComplicationData(data)
    }

    private fun shortText(online: Int, total: Int, tapIntent: Boolean): ComplicationData =
        ShortTextComplicationData.Builder(
            text = plain("$online/$total"),
            contentDescription = plain("Fleet: $online of $total devices online"),
        )
            .setTitle(plain("fleet"))
            .setMonochromaticImage(sproutIcon())
            .apply { if (tapIntent) setTapAction(TinyLaunch.pendingIntent(this@FleetComplicationService)) }
            .build()

    private fun rangedValue(online: Int, total: Int, tapIntent: Boolean): ComplicationData =
        RangedValueComplicationData.Builder(
            value = online.toFloat(),
            min = 0f,
            max = total.coerceAtLeast(1).toFloat(),
            contentDescription = plain("Fleet: $online of $total devices online"),
        )
            .setText(plain("$online/$total"))
            .setMonochromaticImage(sproutIcon())
            .apply { if (tapIntent) setTapAction(TinyLaunch.pendingIntent(this@FleetComplicationService)) }
            .build()

    private fun longText(
        lastQ: String?,
        lastA: String?,
        online: Int,
        total: Int,
        tapIntent: Boolean,
    ): ComplicationData =
        LongTextComplicationData.Builder(
            text = plain(WatchCore.lastExchangeText(lastQ, lastA, online, total)),
            contentDescription = plain("tiny's last exchange — tap to ask"),
        )
            .setTitle(plain("tiny"))
            .setMonochromaticImage(sproutIcon())
            // The roomy last-exchange slot taps through headless: it PREFERS asking
            // tiny's fresh follow-up (iOS W7 surfaces the chip as a face Button) and
            // falls back to a briefing when there's none (iOS BriefingIntent). Either
            // answer lands right back here via rememberExchange → WristSurfaces.refresh.
            .apply { if (tapIntent) setTapAction(lastExchangeTap()) }
            .build()

    /** Pick the LONG_TEXT tap-action: a fresh stored follow-up wins, else a briefing
     *  (choice owned by the tested WearFollowup.faceTap so tap target and intent agree). */
    private fun lastExchangeTap(): android.app.PendingIntent {
        val stored = WearStore(this).topFollowup
        return when (WearFollowup.faceTap(stored?.first, stored?.second, System.currentTimeMillis())) {
            WearFollowup.FaceTap.FOLLOWUP -> TinyLaunch.followupPendingIntent(this)
            WearFollowup.FaceTap.BRIEFING -> TinyLaunch.briefingPendingIntent(this)
        }
    }

    private fun unlinkedShortText(): ComplicationData =
        ShortTextComplicationData.Builder(
            text = plain("—"),
            contentDescription = plain("Open tiny on your phone to link this watch"),
        )
            .setTitle(plain("tiny"))
            .setMonochromaticImage(sproutIcon())
            .setTapAction(TinyLaunch.pendingIntent(this))
            .build()

    private fun sproutIcon(): MonochromaticImage =
        MonochromaticImage.Builder(
            android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_launcher_foreground),
        ).build()

    private fun plain(text: String): ComplicationText =
        PlainComplicationText.Builder(text).build()
}
