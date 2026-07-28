package technology.tiny.wear

import android.content.ComponentName
import android.content.Context
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester

/**
 * The two glanceable wrist surfaces — the fleet [FleetTileService] and the
 * [FleetComplicationService] — both render the cached [WearStore] snapshot and so
 * must be re-rendered TOGETHER whenever that snapshot changes (a phone push lands,
 * or a watch-side chat records a new exchange). Centralising the "nudge both"
 * call in one place keeps the tile and the complication from drifting: every
 * writer of the snapshot calls [refresh], and neither surface can be forgotten.
 *
 * Both updaters throw where tiles/complications aren't supported (a non-Wear
 * host), so each is wrapped in runCatching — a refresh is best-effort.
 */
object WristSurfaces {
    fun refresh(context: Context) {
        runCatching { TileService.getUpdater(context).requestUpdate(FleetTileService::class.java) }
        runCatching {
            ComplicationDataSourceUpdateRequester
                .create(context, ComponentName(context, FleetComplicationService::class.java))
                .requestUpdateAll()
        }
    }
}
