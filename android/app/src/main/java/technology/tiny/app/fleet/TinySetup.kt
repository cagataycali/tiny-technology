package technology.tiny.app.fleet

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

/**
 * BLE provisioning for tiny hardware beacons (Nicla necklace) — Android port
 * of iOS TinySetup.swift, speaking the firmware protocol in strands-nicla
 * firmware/tiny_ble.py and firmware/voice/tiny_voice.ino:
 *
 *   connect → discover → subscribe to the config characteristic → write
 *   newline-terminated JSON in ≤20-byte chunks (one chunk per onWrite ack) →
 *   the device notifies {"ok":true,"complete":bool} and hard-resets onto WiFi.
 *
 * The caller LINKS first ([link]) and only then enrolls a device record and
 * [send]s the config. Order matters, and two bugs taught us why — both were
 * found on iOS and both were live here too:
 *
 *   - Enrolling before the link minted a registry row on every failed attempt.
 *     That's where the orphaned "registered, seen 2 min ago, out of range"
 *     devices came from — and `/api/devices` returns the token exactly once, so
 *     an orphan can never be provisioned, only revoked.
 *   - ArduinoBLE notifies subscribers on a CENTRAL write as well as a local one
 *     (`BLELocalCharacteristic::writeValue(device,…)` delegates to the notifying
 *     overload), so the board echoes every chunk we write back at us before it
 *     answers. This file used to treat the FIRST notify as the verdict, so a
 *     truncated echo of our own payload failed to parse and the sheet said
 *     "device rejected the configuration" with a healthy board on the desk.
 *     Only a notify carrying "ok" is a verdict; see [callback].
 *
 * Every phase is watchdogged: `connectGatt` to a board that has wandered out of
 * range can sit in STATE_CONNECTING indefinitely without ever reporting a
 * failure, which is the "Connecting…" hang.
 *
 * The account bearer JWT is deliberately NOT sent (the caller must not put it
 * in the config). The firmware retired it — tiny_upload authenticates media
 * with the device token, which is scoped to this one board and revocable from
 * the Devices panel; shipping an account-wide credential into a wearable's
 * flash was authority it never needed.
 *
 * All callbacks arrive on Binder threads; state goes out through StateFlows so
 * Compose reads stay cheap (same pattern as [Bluetooth]).
 */
@SuppressLint("MissingPermission") // callers gate on BLUETOOTH_CONNECT first
object TinyProvisioner {
    private val SERVICE_UUID = UUID.fromString("74696e79-5f62-6c65-5f70-726f76697331")
    private val CONFIG_UUID = UUID.fromString("74696e79-5f63-6667-5f77-726974653031")
    private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private const val CHUNK = 20 // ATT default MTU minus header — always safe

    /**
     * Config payload ceilings, per board — they are NOT the same, and one sheet
     * provisions both. The Vision (tiny_ble.py) sets a 1024-byte GATT buffer;
     * the Voice keeps a 256-byte static buffer (`TV_CFG_MAX` in tiny_voice.ino)
     * because that board has no heap to spare. Sending 900 bytes to a Voice
     * would be refused on the board after crossing the air, so bound it
     * correctly here instead. Both leave headroom for the newline terminator.
     */
    const val CONFIG_LIMIT_VISION = 900
    const val CONFIG_LIMIT_VOICE = 240

    /** idle | connecting | handshaking | linked | writing | waiting | done | incomplete | failed:<why> */
    private val _phase = MutableStateFlow("idle")
    val phase: StateFlow<String> = _phase

    /** Extra context for the current phase (which keys the board still wants). */
    private val _detail = MutableStateFlow<String?>(null)
    val detail: StateFlow<String?> = _detail

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var gatt: BluetoothGatt? = null
    private var configChar: BluetoothGattCharacteristic? = null
    private var payload = ByteArray(0)
    private var offset = 0
    private var linkGate: CompletableDeferred<Boolean>? = null

    /**
     * Bumped by every arm()/disarm() — a stale watchdog sees a changed value and
     * returns instead of failing a phase that already moved on.
     */
    @Volatile private var generation = 0

    fun reset() {
        disarm()
        settleLink(false)
        runCatching { gatt?.close() }
        gatt = null
        configChar = null
        _phase.value = "idle"
        _detail.value = null
    }

    /**
     * Connect, discover and subscribe, WITHOUT touching the registry. Returns
     * false with `phase == "failed:<why>"` so the caller can abandon the attempt
     * before minting a device token that would otherwise be orphaned.
     */
    suspend fun link(context: Context, address: String): Boolean {
        // Already linked (e.g. retrying after an enrollment hiccup) — reuse it.
        if (configChar != null && gatt != null && _phase.value == "linked") return true
        val mgr = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = mgr?.adapter
        if (adapter == null || !adapter.isEnabled) {
            _phase.value = "failed:Bluetooth is off — turn it on to set up your tiny."
            return false
        }
        reset()
        val device = runCatching { adapter.getRemoteDevice(address) }.getOrNull()
        if (device == null) { _phase.value = "failed:beacon not reachable"; return false }
        val gate = CompletableDeferred<Boolean>()
        linkGate = gate
        _phase.value = "connecting"
        arm(25_000, "Couldn't reach the device. Bring it closer, make sure it's powered, then rescan Nearby.")
        gatt = device.connectGatt(context, false, callback, android.bluetooth.BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) {
            fail("Couldn't open a Bluetooth link to the device.")
            return false
        }
        return gate.await()
    }

    /**
     * Push `config` (firmware ALLOWED_KEYS subset) over the link [link] opened.
     * `limit` is the board's own buffer — see [CONFIG_LIMIT_VISION].
     */
    fun send(config: JSONObject, limit: Int = CONFIG_LIMIT_VISION) {
        val g = gatt
        val ch = configChar
        if (g == null || ch == null) {
            fail("Lost the link before the configuration could be sent — try again.")
            return
        }
        val json = (config.toString() + "\n").toByteArray()
        if (json.size > limit) {
            // Refuse here rather than after crossing the air: the board would
            // truncate or reject it, and the sheet would blame the radio.
            fail("Configuration is too large for the device (${json.size} bytes).")
            return
        }
        payload = json
        offset = 0
        _phase.value = "writing"
        arm(20_000, "The device never confirmed the configuration. Bring it closer and try again.")
        writeNext(g, ch)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when {
                newState == BluetoothProfile.STATE_CONNECTED -> {
                    _phase.value = "handshaking"
                    arm(15_000, "The device connected but never answered. Power-cycle it and try again.")
                    g.discoverServices()
                }
                newState == BluetoothProfile.STATE_DISCONNECTED &&
                    _phase.value !in listOf("done", "incomplete", "idle") &&
                    !_phase.value.startsWith("failed") -> {
                    // The firmware resets ~1s after acking, so a disconnect once
                    // we're done is the success path — excluded above.
                    fail("The device disconnected before setup finished — try again.")
                    runCatching { g.close() }
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val ch = g.getService(SERVICE_UUID)?.getCharacteristic(CONFIG_UUID)
            if (ch == null) { fail("That isn't a tiny device (setup service missing)."); g.disconnect(); return }
            configChar = ch
            g.setCharacteristicNotification(ch, true)
            val cccd = ch.getDescriptor(CCCD_UUID)
            if (cccd != null) {
                @Suppress("DEPRECATION")
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                g.writeDescriptor(cccd) // the link is ready in onDescriptorWrite
            } else {
                ready()
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            ready()
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Sending the configuration failed."); g.disconnect(); return }
            if (offset < payload.size) writeNext(g, ch) else _phase.value = "waiting"
        }

        @Deprecated("pre-33 callback — delegates to the ByteArray overload")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            onCharacteristicChanged(g, ch, ch.value ?: ByteArray(0))
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
            // Only the post-write notify is a verdict. A notify that arrives
            // while we're still linking (or after we're done) is not ours.
            if (_phase.value != "writing" && _phase.value != "waiting") return
            // ECHO GUARD. ArduinoBLE notifies on a CENTRAL write too, so the
            // board echoes every chunk we send before it ever answers. Measured
            // on wire, a 4-chunk write produced:
            //   {"device_id": "phyte / st-0001", "token": " / … / {"ok":true,…}
            // Acting on the first notify fed our own truncated payload to the
            // parser, which then reported "device rejected the configuration"
            // with a perfectly healthy board on the desk. A verdict is the only
            // thing carrying "ok", so wait for that and drop anything else
            // instead of trusting arrival order. The 20s watchdog still covers a
            // verdict that never comes, so this cannot hang.
            val v = verdictOf(value) ?: return
            disarm()
            v.detail?.let { _detail.value = it }
            _phase.value = v.phase
            g.disconnect()
        }
    }

    /** What a verdict notify means: the phase to enter, plus any board detail. */
    internal data class Verdict(val phase: String, val detail: String?)

    /**
     * Decide whether `value` is the board's VERDICT or just an echo of our own
     * write, and what it says. Null means "not a verdict — drop it".
     *
     * Pure and internal so a JVM test can feed it the exact bytes measured on
     * wire, echoes included; the callback above only routes the answer.
     */
    internal fun verdictOf(value: ByteArray): Verdict? {
        val reply = runCatching { JSONObject(String(value)) }.getOrNull()
        // "ok" is what makes a notify a verdict. An echoed chunk either fails to
        // parse (a fragment isn't JSON) or parses without it — both drop here.
        if (reply == null || !reply.has("ok")) return null
        val missing = reply.optJSONArray("missing")
        val detail = if (missing != null && missing.length() > 0) {
            "Still missing: " +
                (0 until missing.length()).joinToString(", ") { missing.optString(it) } + "."
        } else {
            null
        }
        val phase = when {
            !reply.optBoolean("ok") -> {
                val why = reply.optString("error").takeIf { it.isNotEmpty() }?.let { " ($it)" } ?: ""
                "failed:The device rejected the configuration$why."
            }
            reply.optBoolean("complete") -> "done"
            else -> "incomplete"
        }
        return Verdict(phase, detail)
    }

    /** One ≤20-byte chunk per write ack — the firmware reassembles on newline. */
    @Suppress("DEPRECATION") // pre-33 write API — min SDK is below 33
    private fun writeNext(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
        val end = minOf(offset + CHUNK, payload.size)
        val chunk = payload.copyOfRange(offset, end)
        offset = end
        ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        ch.value = chunk
        if (!g.writeCharacteristic(ch)) {
            fail("Sending the configuration failed.")
            g.disconnect()
        }
    }

    // ── Watchdog + link-gate plumbing ─────────────────────────────────────

    private fun ready() {
        disarm()
        _phase.value = "linked"
        settleLink(true)
    }

    private fun fail(why: String) {
        disarm()
        _phase.value = "failed:$why"
        settleLink(false)
    }

    /** A phase deadline: fires `why` unless [disarm] (or a later arm) beats it. */
    private fun arm(millis: Long, why: String) {
        generation += 1
        val g = generation
        scope.launch {
            delay(millis)
            if (generation != g) return@launch
            fail(why)
        }
    }

    private fun disarm() { generation += 1 }

    private fun settleLink(ok: Boolean) {
        val gate = linkGate ?: return
        linkGate = null
        gate.complete(ok)
    }
}
