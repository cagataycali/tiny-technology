/**
 * NiclaVoiceGateway — the phone stands in for a device that cannot reach the
 * internet. Android port of ios/Tiny/Sources/NiclaVoiceGateway.swift.
 *
 * The Nicla Vision necklace is a full node: WiFi, its own `tind_` token, it
 * heartbeats and polls the relay by itself. The Nicla Voice cannot. It is an
 * nRF52832 + NDP120 — BLE only, no WiFi radio at all — so nothing it hears can
 * leave the board without a gateway. That is this file: while the phone is
 * near the necklace it holds a BLE link and acts as the device's network stack.
 *
 * Two jobs, both on the device's behalf, not the phone's:
 *
 *   1. Presence. POST /api/devices/heartbeat with the VOICE's deviceId+token
 *      every 30s while connected, so /devices and the agent's tools see the
 *      necklace as online. The window is 60s server-side, so a dropped link
 *      goes 🔴 within a minute — which is the truth: with no phone in range
 *      the board is unreachable, however happily it is listening.
 *
 *   2. Wake events. The firmware notifies {"wake":n,"label":"alexa"} the
 *      instant the NDP120 matches. We forward it to the owner's event ring via
 *      POST /api/devices/event, authenticated with the DEVICE token — so the
 *      agent can answer "did my necklace hear anything?" without the phone
 *      having to be the one asked.
 *
 * Deliberately does NOT carry audio: the board has no audio characteristic
 * (64KB of RAM), so a wake is an EVENT, not a recording.
 */
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
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp

/** One wake the necklace reported, as the phone saw it. */
data class VoiceWake(val label: String, val count: Int, val atMs: Long)

/**
 * What the board says about itself (status characteristic, JSON with short
 * keys because the whole notify has to fit a 64-byte buffer).
 */
data class VoiceStatus(
    val ndpUp: Boolean = false, // "ndp" — all three .synpkg loads returned 1
    val micOn: Boolean = false, // "mic" — turnOnMicrophone() returned 0
    val wakes: Int = 0,         // "w"   — matches since boot
    val labels: Int = 0,        // "l"   — classes in the loaded net
    val uptimeS: Int = 0,       // "up"  — seconds since boot
) {
    /**
     * The distinction that matters for a wearable: advertising and *deaf*
     * looks exactly like advertising and listening from the outside. Without
     * this the only symptom of a failed model load is a necklace that never
     * fires.
     */
    val listening: Boolean get() = ndpUp && micOn
}

@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is granted during setup, before register()
object NiclaVoiceGateway {
    // Same GATT service as the provisioner; the Voice adds two notify chars.
    private val SERVICE_UUID = UUID.fromString("74696e79-5f62-6c65-5f70-726f76697331")
    private val WAKE_UUID = UUID.fromString("74696e79-5f77-616b-655f-65766e743031")
    private val STATUS_UUID = UUID.fromString("74696e79-5f73-7461-745f-72643031ffff")
    private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val WAKES_MAX = 20
    private const val BEAT_SECONDS = 30L
    internal val CAPABILITIES = listOf("mic", "wake", "imu", "ble")

    /** A Voice unit this phone has paired and speaks for. */
    data class VoiceUnit(val deviceId: String, val address: String, val name: String)

    private val _unit = MutableStateFlow<VoiceUnit?>(null)
    val unit: StateFlow<VoiceUnit?> = _unit

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    private val _status = MutableStateFlow<VoiceStatus?>(null)
    val status: StateFlow<VoiceStatus?> = _status

    /**
     * Newest first, bounded — a wearable can fire all day and this is a UI
     * tail, not a log. The durable copy is the server event ring.
     */
    private val _wakes = MutableStateFlow<List<VoiceWake>>(emptyList())
    val wakes: StateFlow<List<VoiceWake>> = _wakes

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var gatt: BluetoothGatt? = null
    private var beatJob: Job? = null
    private var app: TinyApp? = null
    /**
     * Set once we have ever been asked to run — guards against a stop() from
     * a stale lifecycle racing a fresh start().
     */
    private var wanted = false

    // ── Persistence: id/address/name in plain prefs, token in Keystore-backed
    //    encrypted prefs (iOS: UserDefaults + Keychain split, same reasoning —
    //    the token is a credential, the pairing metadata is not).

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("nicla_voice", Context.MODE_PRIVATE)

    private fun securePrefs(context: Context): SharedPreferences =
        EncryptedSharedPreferences.create(
            context,
            "nicla_voice_secure",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    private fun loadUnit(context: Context): VoiceUnit? {
        val p = prefs(context)
        val deviceId = p.getString("deviceId", null) ?: return null
        val address = p.getString("address", null) ?: return null
        return VoiceUnit(deviceId, address, p.getString("name", null) ?: "tiny voice")
    }

    private fun token(context: Context, deviceId: String): String? =
        securePrefs(context).getString("token_$deviceId", null)

    /**
     * The paired Voice's (deviceId, token) — or null when no necklace is paired.
     *
     * Exposed so a transcript can be ATTRIBUTED to the necklace that asked for
     * it (PhoneRecorder.fileTranscript, iOS NiclaRecorder.postToServer parity).
     * Deliberately narrower than exposing [token]: a caller can obtain the
     * credential pair for the unit this phone already speaks for, and cannot ask
     * for an arbitrary deviceId's token.
     */
    internal fun credentials(context: Context): Pair<String, String>? {
        val u = _unit.value ?: loadUnit(context) ?: return null
        return token(context, u.deviceId)?.let { u.deviceId to it }
    }

    // ── Registration ────────────────────────────────────────────────────────

    /**
     * Called from TinySetupDialog once the Voice has accepted its identity
     * over BLE, and from VoiceDevicePanel's adopt() for a board enrolled
     * ELSEWHERE (paired from a laptop, or from a phone since reinstalled).
     * That second caller exists because provisioning was the only way in, and
     * provisioning mints a new device row — so a Voice the owner could see in
     * their fleet was permanently ungatewayable by this phone.
     *
     * One Voice per phone for now: a second register REPLACES the first rather
     * than silently keeping a stale unit whose token no longer matches.
     */
    fun register(context: Context, deviceId: String, token: String, address: String, name: String = "tiny voice") {
        securePrefs(context).edit().putString("token_$deviceId", token).apply()
        prefs(context).edit()
            .putString("deviceId", deviceId)
            .putString("address", address)
            .putString("name", name)
            .apply()
        _unit.value = VoiceUnit(deviceId, address, name)
        start(context)
    }

    /**
     * Forget the unit locally. Does NOT revoke the device server-side — that
     * is the Devices panel's revoke button, and conflating the two would mean
     * closing a sheet silently killed a token.
     */
    fun forget(context: Context) {
        _unit.value?.let { securePrefs(context).edit().remove("token_${it.deviceId}").apply() }
        prefs(context).edit().clear().apply()
        stop()
        _unit.value = null
        _status.value = null
        _wakes.value = emptyList()
    }

    // ── Link lifecycle ──────────────────────────────────────────────────────

    /**
     * Bring the link up. Safe to call repeatedly (app launch, foreground,
     * after setup) — a no-op when there is no registered Voice, so a user
     * with no necklace never pays for this file.
     */
    fun start(context: Context) {
        val tinyApp = context.applicationContext as? TinyApp ?: return
        app = tinyApp
        if (_unit.value == null) _unit.value = loadUnit(tinyApp)
        val u = _unit.value ?: return
        wanted = true
        if (gatt != null) return // already connected or auto-reconnect armed
        val adapter: BluetoothAdapter? =
            (tinyApp.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null) return
        if (!adapter.isEnabled) {
            _lastError.value = "Bluetooth is off — the necklace can't reach your tiny without it."
            return
        }
        val device = runCatching { adapter.getRemoteDevice(u.address) }.getOrNull()
        if (device == null) {
            _lastError.value = "Bring the necklace nearby and open Nearby devices once."
            return
        }
        // autoConnect=true is Android's pending connection: the stack keeps
        // the intent alive and re-links whenever the peripheral reappears —
        // exactly the behaviour a wearable wants; walk back into range and
        // the link restores itself with no UI.
        gatt = runCatching {
            device.connectGatt(tinyApp, true, callback, android.bluetooth.BluetoothDevice.TRANSPORT_LE)
        }.getOrElse {
            _lastError.value = "Bluetooth permission denied — the necklace needs it to reach your tiny."
            null
        }
    }

    fun stop() {
        wanted = false
        beatJob?.cancel(); beatJob = null
        runCatching { gatt?.close() }
        gatt = null
        _connected.value = false
    }

    /** Ask for the status JSON now (the firmware also notifies it periodically). */
    fun refreshStatus() {
        val g = gatt ?: return
        val ch = g.getService(SERVICE_UUID)?.getCharacteristic(STATUS_UUID) ?: return
        @Suppress("DEPRECATION")
        runCatching { g.readCharacteristic(ch) }
    }

    // ── GATT plumbing ───────────────────────────────────────────────────────
    // GATT operations are strictly one-at-a-time: the two CCCD subscriptions
    // and the initial status read are SEQUENCED through the descriptor-write
    // callbacks, not fired together (a second write while one is pending is
    // silently dropped on most stacks).

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    scope.launch { _lastError.value = null }
                    g.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    // Out of range is the NORMAL state of a wearable, not an
                    // error worth showing — autoConnect re-arms by itself and
                    // presence goes stale on its own.
                    scope.launch {
                        _connected.value = false
                        beatJob?.cancel(); beatJob = null
                    }
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val svc = g.getService(SERVICE_UUID)
            if (svc == null) {
                scope.launch { _lastError.value = "That device isn't a tiny necklace." }
                return
            }
            val wake = svc.getCharacteristic(WAKE_UUID)
            if (wake == null) {
                scope.launch { _lastError.value = "That device isn't a tiny necklace." }
                return
            }
            subscribe(g, wake) // status char is next, from onDescriptorWrite
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            val svc = g.getService(SERVICE_UUID) ?: return
            when (descriptor.characteristic.uuid) {
                WAKE_UUID -> {
                    val st = svc.getCharacteristic(STATUS_UUID)
                    if (st != null) {
                        subscribe(g, st)
                    } else {
                        scope.launch { linkReady() }
                    }
                }
                STATUS_UUID -> {
                    @Suppress("DEPRECATION")
                    runCatching { g.readCharacteristic(descriptor.characteristic) }
                    // Only now is the link USEFUL. Marking connected at
                    // STATE_CONNECTED would start heartbeating for a device we
                    // might still fail to subscribe to, and presence would
                    // claim a wake path that isn't wired up.
                    scope.launch { linkReady() }
                }
            }
        }

        @Deprecated("pre-33 callback — delegates to the ByteArray overload")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            onCharacteristicChanged(g, ch, ch.value ?: ByteArray(0))
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
            when (ch.uuid) {
                WAKE_UUID -> scope.launch { handleWake(value) }
                STATUS_UUID -> scope.launch { handleStatus(value) }
            }
        }

        @Deprecated("pre-33 callback — delegates to the ByteArray overload")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && ch.uuid == STATUS_UUID) {
                @Suppress("DEPRECATION")
                val v = ch.value ?: ByteArray(0)
                scope.launch { handleStatus(v) }
            }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && ch.uuid == STATUS_UUID) {
                scope.launch { handleStatus(value) }
            }
        }

        private fun subscribe(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            g.setCharacteristicNotification(ch, true)
            val cccd = ch.getDescriptor(CCCD_UUID) ?: return
            @Suppress("DEPRECATION")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            g.writeDescriptor(cccd)
        }
    }

    private fun linkReady() {
        if (_connected.value) return
        _connected.value = true
        startBeating()
    }

    // ── Proxy presence ──────────────────────────────────────────────────────

    /**
     * Heartbeat as the DEVICE, for as long as we hold its link. Runs only
     * while connected: a heartbeat sent while the necklace is out of range
     * would report a reachable device that no tool call could actually reach.
     */
    private fun startBeating() {
        beatJob?.cancel()
        beatJob = scope.launch {
            while (isActive && _connected.value) {
                beat()
                delay(BEAT_SECONDS * 1000)
            }
        }
    }

    private suspend fun beat() {
        val a = app ?: return
        val u = _unit.value ?: return
        val tok = token(a, u.deviceId) ?: return
        val res = runCatching {
            a.api.postJson(
                "/api/devices/heartbeat",
                JSONObject()
                    .put("deviceId", u.deviceId)
                    .put("token", tok)
                    .put("capabilities", JSONArray(CAPABILITIES)),
            )
        }.getOrNull() ?: return
        // A rejected heartbeat means the owner revoked this device from the
        // Devices panel. Keep holding the BLE link (the board is still ours
        // physically) but say why — a silent stop looks like a bug.
        if (!res.optBoolean("ok", true)) {
            val why = res.optString("error").ifEmpty { "heartbeat rejected" }
            _lastError.value =
                if (why.contains("unknown device")) "This necklace was revoked — set it up again." else why
        }
    }

    // ── Wake fan-out ────────────────────────────────────────────────────────

    /** Firmware notify {"wake":n,"label":"alexa"} → UI tail + server event. */
    internal fun parseWake(value: ByteArray, nowMs: Long): VoiceWake? {
        val obj = runCatching { JSONObject(String(value)) }.getOrNull() ?: return null
        // The firmware strips the net's "NN0:" prefix already; default to
        // "wake" rather than "?" so a label-less match is still legible.
        val label = obj.optString("label").trim().ifEmpty { "wake" }
        return VoiceWake(label, obj.optInt("wake"), nowMs)
    }

    /** The event line the agent later reads (iOS forward() parity, verbatim). */
    internal fun wakeDetail(wake: VoiceWake): String = "heard “${wake.label}” (#${wake.count})"

    private fun handleWake(value: ByteArray) {
        val wake = parseWake(value, System.currentTimeMillis()) ?: return
        _wakes.value = (listOf(wake) + _wakes.value).take(WAKES_MAX)
        // A wearable's feedback loop: the necklace has one LED you cannot see
        // while it's on your chest, so the phone is where "it heard you" lands.
        app?.let { runCatching { it.deviceTools.handle("vibrate", JSONObject().put("pattern", "tap")) } }
        scope.launch(Dispatchers.IO) { forward(wake) }
    }

    /**
     * Put the wake on the owner's event ring so the agent can see it later.
     * Device-token authed (no session needed): the phone may be relaying for
     * a necklace while nobody is logged into anything on screen.
     */
    private suspend fun forward(wake: VoiceWake) {
        val a = app ?: return
        val u = _unit.value ?: return
        val tok = token(a, u.deviceId) ?: return
        runCatching {
            a.api.postJson(
                "/api/devices/event",
                JSONObject()
                    .put("deviceId", u.deviceId)
                    .put("token", tok)
                    .put("kind", "nicla_wake")
                    .put("detail", wakeDetail(wake)),
            )
        }
    }

    // ── Status ──────────────────────────────────────────────────────────────

    internal fun parseStatus(value: ByteArray): VoiceStatus? {
        val o = runCatching { JSONObject(String(value)) }.getOrNull() ?: return null
        return VoiceStatus(
            ndpUp = o.optInt("ndp") == 1,
            micOn = o.optInt("mic") == 1,
            wakes = o.optInt("w"),
            labels = o.optInt("l"),
            uptimeS = o.optInt("up"),
        )
    }

    private fun handleStatus(value: ByteArray) {
        parseStatus(value)?.let { _status.value = it }
    }
}
