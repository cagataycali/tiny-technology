/**
 * 🎧 BtMic — route speech recognition through a connected Bluetooth
 * headset's microphone (the Meta glasses, when they're worn).
 *
 * iOS gets this with one option: `.allowBluetooth` on the audio session
 * makes the glasses the phone's mic (WearablesLive.swift:137 calls it the
 * load-bearing option). Android does NOT route automatically for speech
 * recognition: SpeechRecognizer captures in Google's recognition-service
 * process with the VOICE_RECOGNITION source, which stays on the built-in
 * mic unless the SCO audio link is raised device-wide. Without this, every
 * meta_listen and HUD transcript reads the PHONE's mic and calling the
 * result "what the glasses heard" would be a lie about which microphone
 * heard it.
 *
 * The legacy startBluetoothSco() API is deprecated on 31+ but remains the
 * one knob that affects ANOTHER process's capture route — the modern
 * setCommunicationDevice() only scopes to the calling app's own use cases.
 * Best-effort by design: no BT mic around → acquire() returns false and the
 * caller proceeds on the phone mic, exactly like today.
 */
package technology.tiny.app.fleet

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

object BtMic {
    @Volatile private var claimed = false

    /** The SCO link is currently ours — i.e. recognition hears the headset. */
    val active: Boolean get() = claimed

    /** A SCO/BLE-headset mic is present and connected. */
    fun available(context: Context): Boolean {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return if (Build.VERSION.SDK_INT >= 31) {
            am.availableCommunicationDevices.any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            }
        } else {
            @Suppress("DEPRECATION")
            am.isBluetoothScoAvailableOffCall
        }
    }

    /**
     * Raise the SCO link so recognition hears the headset. Returns false
     * (and changes nothing) when no BT mic is around. The link takes
     * ~0.5-1s to come up — callers should give it a beat before recording.
     */
    fun acquire(context: Context): Boolean {
        if (claimed) return true
        if (!available(context)) return false
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return runCatching {
            @Suppress("DEPRECATION")
            am.startBluetoothSco()
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = true
            claimed = true
            true
        }.getOrDefault(false)
    }

    /** Drop the link. Safe to call unconditionally; no-op unless acquired. */
    fun release(context: Context) {
        if (!claimed) return
        claimed = false
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        runCatching {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
        }
    }
}
