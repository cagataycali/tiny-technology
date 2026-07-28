package technology.tiny.app.fleet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import technology.tiny.app.TinyApp

/**
 * Re-arms the always-on fleet node after a reboot. Only starts the service if
 * the user opted in (config.alwaysOn) and is still logged in — otherwise the
 * boot broadcast is a no-op.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = context.applicationContext as TinyApp
        if (app.config.alwaysOn && app.auth.isLoggedIn) {
            RelayService.start(context)
        }
    }
}
