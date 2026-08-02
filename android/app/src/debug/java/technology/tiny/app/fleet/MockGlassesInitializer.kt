/**
 * 🧪 Enables Meta's MockDeviceKit at PROCESS BIRTH — a ContentProvider's
 * onCreate runs before Application.onCreate and therefore before anything
 * can call Wearables.initialize(), which is the ordering the mock transport
 * needs (enabling after initialize leaves sessions aimed at real hardware
 * that isn't there; observed as a 25s STARTED timeout on the Pixel).
 *
 * Debug builds only (source set + debugImplementation artifact). Armed by a
 * marker file the adb shell can place on a debuggable build:
 *
 *   adb shell run-as technology.tiny.app touch files/mock_glasses
 *   adb shell run-as technology.tiny.app rm files/mock_glasses   # disarm
 *
 * Pairing/donning stays in MockGlassesReceiver — this only flips the kit on.
 */
package technology.tiny.app.fleet

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.util.Log
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.MockDeviceKitConfig
import java.io.File

class MockGlassesInitializer : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context ?: return true
        if (File(ctx.filesDir, "mock_glasses").exists()) {
            runCatching {
                MockDeviceKit.getInstance(ctx).enable(
                    MockDeviceKitConfig(initiallyRegistered = true, initialPermissionsGranted = true),
                )
                Log.i("MockGlasses", "mock kit enabled at process birth")
            }.onFailure { Log.e("MockGlasses", "early enable failed", it) }
        }
        return true
    }

    override fun query(u: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
    override fun getType(u: Uri): String? = null
    override fun insert(u: Uri, v: ContentValues?): Uri? = null
    override fun delete(u: Uri, s: String?, a: Array<String>?): Int = 0
    override fun update(u: Uri, v: ContentValues?, s: String?, a: Array<String>?): Int = 0
}
