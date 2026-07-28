package technology.tiny.app.ui

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * True when the system animator scale is 0 — the "remove animations"
 * accessibility setting. Compose's animation APIs don't gate on it, so every
 * decorative animation (streaming dots, composer breathe, chip entrances)
 * checks this and renders its resting state instead (iOS gates the same
 * class of motion on Reduce Motion).
 */
@Composable
fun rememberAnimationsOff(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(
            context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f,
        ) == 0f
    }
}
