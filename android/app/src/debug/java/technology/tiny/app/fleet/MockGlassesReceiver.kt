/**
 * 🕶️🧪 Mock-glasses harness — DEBUG BUILDS ONLY (the mwdat-mockdevice
 * artifact is debugImplementation; this whole source set is absent from
 * release). Drives Meta's MockDeviceKit from adb so the ENTIRE Android
 * glasses pipeline — link gating, the 🕶 toolbar icon, the live HUD,
 * meta_take_photo, tap-event context — can be exercised end-to-end on a
 * device with no physical glasses:
 *
 *   adb shell am broadcast -a technology.tiny.app.MOCK_GLASSES --es cmd enable
 *   adb shell am broadcast -a technology.tiny.app.MOCK_GLASSES --es cmd tap
 *   cmds: enable | tap | tapAndHold | don | doff | fold | unfold | off | disable
 *
 * The receiver demands the sender hold DUMP (the adb shell does; third-party
 * apps do not), so a debug build sideloaded somewhere odd still can't have
 * its glasses puppeteered by another app.
 *
 * ⚠️ `enable` must run BEFORE the real SDK path is exercised in that process
 * (fresh app start → broadcast → then open glasses UI): the mock kit hooks
 * the SDK at initialize time.
 */
package technology.tiny.app.fleet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockDeviceKitConfig
import com.meta.wearable.dat.mockdevice.api.MockGlasses
import com.meta.wearable.dat.mockdevice.api.camera.CameraFacing

class MockGlassesReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "MockGlasses"
        @Volatile private var glasses: MockGlasses? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val cmd = intent.getStringExtra("cmd") ?: return
        val app = context.applicationContext
        runCatching {
            when (cmd) {
                "enable" -> {
                    val kit = MockDeviceKit.getInstance(app)
                    if (!kit.isEnabled) {
                        kit.enable(
                            MockDeviceKitConfig(
                                initiallyRegistered = true,
                                initialPermissionsGranted = true,
                            ),
                        )
                    }
                    // The bridge's usual init gate — the mock registration only
                    // shows through the SDK once it's initialized.
                    WearablesBridge.ensureInitialized(app)
                    val g = kit.pairGlasses(GlassesModel.RAYBAN_META).getOrNull() ?: glasses
                    glasses = g
                    g?.apply {
                        powerOn()
                        unfold()
                        don() // worn — the state a real capture needs
                        // A pushed clip beats the phone camera: deterministic,
                        // and the mock's live-camera capture path fails on some
                        // devices ("Failed to start camera capture for BACK",
                        // Pixel 10). run-as cp a feed.mp4 into files/ first.
                        val feed = java.io.File(app.filesDir, "feed.mp4")
                        if (feed.exists()) {
                            services.camera.setCameraFeed(android.net.Uri.fromFile(feed))
                        } else {
                            services.camera.setCameraFeed(CameraFacing.BACK)
                        }
                        // Pin what meta_take_photo "captures" — an E2E chat
                        // round-trip can then assert the exact pixels landed.
                        val photo = java.io.File(app.filesDir, "photo.jpg")
                        if (photo.exists()) {
                            services.camera.setCapturedImage(android.net.Uri.fromFile(photo))
                        }
                    }
                    Log.i(TAG, "mock glasses enabled+paired: ${g != null}")
                }
                "tap" -> glasses?.services?.captouch?.tap().also { Log.i(TAG, "tap sent") }
                // Permission flips mid-stream — the revocation edge case.
                "revoke-camera" -> MockDeviceKit.getInstance(app).permissions.set(
                    com.meta.wearable.dat.core.types.Permission.CAMERA,
                    com.meta.wearable.dat.core.types.PermissionStatus.Denied,
                ).also { Log.i(TAG, "camera permission revoked") }
                "grant-camera" -> MockDeviceKit.getInstance(app).permissions.set(
                    com.meta.wearable.dat.core.types.Permission.CAMERA,
                    com.meta.wearable.dat.core.types.PermissionStatus.Granted,
                ).also { Log.i(TAG, "camera permission granted") }
                "tapAndHold" -> glasses?.services?.captouch?.tapAndHold()
                "don" -> glasses?.don()
                "doff" -> glasses?.doff()
                "fold" -> glasses?.fold()
                "unfold" -> glasses?.unfold()
                "off" -> glasses?.powerOff()
                "disable" -> {
                    glasses = null
                    MockDeviceKit.getInstance(app).disable()
                }
                else -> Log.w(TAG, "unknown cmd: $cmd")
            }
        }.onFailure { Log.e(TAG, "cmd $cmd failed", it) }
    }
}
