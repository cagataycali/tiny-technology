package technology.tiny.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.Colors
import androidx.wear.protolayout.material.CompactChip
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Fleet-presence tile — tiny at a glance on the wrist, WITHOUT opening the app
 * (the Wear analog of the iOS home-screen widget / the phone's Glance widget).
 * Reads the snapshot [WearStore] caches from the phone's `/tiny/snapshot` push
 * so it renders cold; tapping the tile opens the watch app to ask.
 *
 * A tile is a static, system-rendered layout (ProtoLayout) — no Compose, no live
 * process — so it must read persisted state, never in-memory VM state. That's why
 * cycle 130 first taught WearStore to cache the snapshot.
 */
class FleetTileService : TileService() {

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val store = WearStore(this)
        val linked = store.token != null
        val snap = store.snapshot
        val accent = tileAccent(store.accentHex)

        val layout = if (!linked) {
            unlinkedLayout(accent)
        } else {
            fleetLayout(accent, snap, deviceParameters = requestParams.deviceConfiguration)
        }

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES_VERSION)
            // Presence goes stale server-side after ~60s; refresh every 5 min to
            // match the phone's fleet-poll cadence without burning the battery.
            .setFreshnessIntervalMillis(5 * 60 * 1000L)
            .setTileTimeline(
                TimelineBuilders.Timeline.Builder()
                    .addTimelineEntry(
                        TimelineBuilders.TimelineEntry.Builder()
                            .setLayout(
                                LayoutElementBuilders.Layout.Builder().setRoot(layout).build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()
        return Futures.immediateFuture(tile)
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(
            ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build(),
        )

    private fun fleetLayout(
        accent: Int,
        snap: WatchSnapshot?,
        deviceParameters: androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters,
    ): LayoutElementBuilders.LayoutElement {
        val online = snap?.online ?: 0
        val total = snap?.total ?: 0
        val unread = snap?.unread ?: 0
        // Presence line shared with the chat header (WatchCore) — unread rides the
        // tile's own sub-line below, so pass 0 here.
        val presence = if (snap == null) "…" else technology.tiny.app.wear.WatchCore.presenceLine(online, total)
        // Sub-line surfaces tiny's last answer when the fleet's quiet (WatchCore
        // owns the priority so the tile and its unit tests agree).
        val sub = technology.tiny.app.wear.WatchCore.tileSubline(
            hasSnapshot = snap != null,
            unread = unread,
            lastA = snap?.lastA,
        )

        return PrimaryLayout.Builder(deviceParameters)
            .setContent(
                LayoutElementBuilders.Column.Builder()
                    .setWidth(expand())
                    // The glanceable body taps through HEADLESS — a fresh follow-up
                    // if there is one, else a briefing (same WearFollowup.faceTap
                    // choice the complication uses). The "Ask tiny" chip below stays
                    // dictation, so the tile offers both without a swipe.
                    .setModifiers(
                        ModifiersBuilders.Modifiers.Builder()
                            .setClickable(headlessClickable())
                            .build(),
                    )
                    .addContent(
                        Text.Builder(this, presence)
                            .setTypography(Typography.TYPOGRAPHY_TITLE3)
                            .setColor(argb(accent))
                            .build(),
                    )
                    .addContent(
                        Text.Builder(this, sub)
                            .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                            .setColor(argb(Colors.DEFAULT.onSurface))
                            .build(),
                    )
                    .build(),
            )
            .setPrimaryChipContent(
                CompactChip.Builder(this, "Ask tiny", launchClickable(), deviceParameters)
                    .setChipColors(
                        androidx.wear.protolayout.material.ChipColors.primaryChipColors(
                            Colors(accent, Colors.DEFAULT.onPrimary, Colors.DEFAULT.surface, Colors.DEFAULT.onSurface),
                        ),
                    )
                    .build(),
            )
            .build()
    }

    private fun unlinkedLayout(
        accent: Int,
    ): LayoutElementBuilders.LayoutElement =
        LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(launchClickable())
                    .build(),
            )
            .addContent(
                Text.Builder(this, "🌱 Open tiny on your phone")
                    .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                    .setColor(argb(accent))
                    .setMaxLines(3)
                    .build(),
            )
            .build()

    /** Tap → open the watch chat (dictate a question). */
    private fun launchClickable(): ModifiersBuilders.Clickable =
        ModifiersBuilders.Clickable.Builder()
            .setId("open")
            .setOnClick(launchAction(extra = null))
            .build()

    /** Tap → open the app AND run a headless ask (follow-up if fresh, else briefing).
     *  Mirrors the LONG_TEXT complication's dynamic tap so the two glanceable
     *  surfaces agree; MainActivity.handleFaceTap reads the extra. */
    private fun headlessClickable(): ModifiersBuilders.Clickable {
        val stored = WearStore(this).topFollowup
        val extra = when (WearFollowup.faceTap(stored?.first, stored?.second, System.currentTimeMillis())) {
            WearFollowup.FaceTap.FOLLOWUP -> TinyLaunch.EXTRA_FOLLOWUP
            WearFollowup.FaceTap.BRIEFING -> TinyLaunch.EXTRA_BRIEFING
        }
        return ModifiersBuilders.Clickable.Builder()
            .setId(extra)
            .setOnClick(launchAction(extra))
            .build()
    }

    /** A LaunchAction opening MainActivity, optionally carrying a boolean [extra]
     *  (the ProtoLayout analog of Intent.putExtra — MainActivity reads it as a
     *  boolean extra keyed by the same name). */
    private fun launchAction(extra: String?): ActionBuilders.LaunchAction {
        val activity = ActionBuilders.AndroidActivity.Builder()
            .setPackageName(packageName)
            .setClassName(MainActivity::class.java.name)
        if (extra != null) {
            activity.addKeyToExtraMapping(
                extra,
                ActionBuilders.AndroidBooleanExtra.Builder().setValue(true).build(),
            )
        }
        return ActionBuilders.LaunchAction.Builder().setAndroidActivity(activity.build()).build()
    }

    companion object {
        // Static tile — no image/font resources beyond the system set.
        private const val RESOURCES_VERSION = "1"
    }
}

/** Per-tiny accent as an ARGB Int (green fallback) — delegates to the shared
 *  WatchCore.accentArgb so the tile, complication, and app agree on the color. */
internal fun tileAccent(hex: String?): Int =
    technology.tiny.app.wear.WatchCore.accentArgb(hex)
