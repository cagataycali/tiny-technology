package technology.tiny.app.fleet

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import technology.tiny.app.TinyApp

/**
 * Quick Settings tile — the Android analog of iOS's Control-Center TinyAskControl
 * (TinyWidgets.swift). One tap from the notification shade opens tiny with the mic
 * listening, exactly like iOS's OpenVoiceModeIntent (opensIntent tinyapp://voice).
 * The voice deep-link route is already wired end-to-end in MainActivity/ChatScreen
 * (starts VoiceMode on the permission-gated path), so the tile just fires it.
 *
 * The tile subtitle reflects sign-in: signed out → "sign in first" (the app opens
 * to the login screen anyway; the tile shouldn't imply it'll listen while logged
 * out). API 34+ requires the PendingIntent overload of startActivityAndCollapse;
 * the Intent overload is kept for API 29–33 (deprecated there, still correct).
 */
class AskTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val loggedIn = (applicationContext as? TinyApp)?.auth?.isLoggedIn == true
        tile.state = Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= 29) {
            tile.subtitle = if (loggedIn) "speak · pause · sent" else "sign in first"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("tinyapp://voice")).apply {
            setPackage(packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        // API 34+ mandates a PendingIntent; the Intent overload is deprecated there
        // but required on 29–33. Both collapse the shade and unlock to launch.
        if (Build.VERSION.SDK_INT >= 34) {
            val pi = PendingIntent.getActivity(
                this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            startActivityAndCollapse(pi)
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}
