package technology.tiny.app.fleet

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * The phone's eyes on nearby devices (fleet expansion: the web agent can ask
 * this phone what's around it). Native port of iOS Bluetooth.swift.
 *
 * BluetoothLeScanner scan, two consumers:
 *   - NearbySheet ("Nearby devices" surface): live list with signal strength
 *   - FleetManager relay: [scanSummary] text is appended to a nearby/bluetooth
 *     prompt proxied through /api/chat, so the server agent answers with REAL
 *     radio data the server itself could never see.
 *
 * Lazy scanner + permission-gated: the caller requests BLUETOOTH_SCAN (API 31+)
 * / FINE_LOCATION (API ≤30) before startScan; without it we surface state
 * "unauthorized" rather than throwing. Foreground-only (background BLE needs a
 * foreground service scan + different semantics — not this pass).
 */
object Bluetooth {
    data class BleDevice(val address: String, val name: String, val rssi: Int)

    // ---- pure summary formatting (iOS Bluetooth.swift scanSummary parity) -------
    // The exact text a relay answer carries. Kept device-/coroutine-free so the
    // strongest-first ordering, the 25-device cap, and the four empty-state
    // messages are JVM-unit-testable exactly like iOS builds the string inline.
    private const val SUMMARY_CAP = 25

    /** Devices → one text block, strongest signal first (iOS sorts at read time,
     *  so we sort here too rather than trusting the caller's order); empty →
     *  the state-specific reason so the agent gets WHY, not a false "nothing near". */
    fun summaryText(devices: List<BleDevice>, state: String): String {
        if (devices.isEmpty()) {
            return when (state) {
                "unauthorized" -> "Bluetooth scan permission not granted on the phone."
                "poweredOff" -> "Bluetooth is turned off on the phone."
                "unsupported" -> "This phone has no Bluetooth adapter."
                else -> "No BLE devices discovered nearby."
            }
        }
        return devices.sortedByDescending { it.rssi }.take(SUMMARY_CAP)
            .joinToString("\n") { "- ${it.name} · RSSI ${it.rssi} dBm" }
    }

    private val _devices = MutableStateFlow<List<BleDevice>>(emptyList())
    val devices: StateFlow<List<BleDevice>> = _devices

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning

    /** idle | scanning | poweredOff | unauthorized | unsupported */
    private val _state = MutableStateFlow("idle")
    val state: StateFlow<String> = _state

    private val scope = CoroutineScope(Dispatchers.Main)
    private var stopJob: Job? = null
    private var scanner: android.bluetooth.le.BluetoothLeScanner? = null
    private var callback: ScanCallback? = null
    // Accumulate off the main thread; publish snapshots so Compose reads are cheap.
    private val found = LinkedHashMap<String, BleDevice>()

    /** The runtime permission the caller must hold for a scan to work. */
    val requiredPermission: String
        get() = if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN
        else Manifest.permission.ACCESS_FINE_LOCATION

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, requiredPermission) ==
            PackageManager.PERMISSION_GRANTED

    fun startScan(context: Context, durationMs: Long = 8000) {
        val mgr = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = mgr?.adapter
        if (adapter == null) { _state.value = "unsupported"; return }
        if (!hasPermission(context)) { _state.value = "unauthorized"; return }
        if (!adapter.isEnabled) { _state.value = "poweredOff"; return }

        stopScan() // clear any prior run
        found.clear()
        _devices.value = emptyList()
        _state.value = "scanning"
        _scanning.value = true

        val s = adapter.bluetoothLeScanner
        if (s == null) { _state.value = "poweredOff"; _scanning.value = false; return }
        scanner = s
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                result ?: return
                val dev = result.device ?: return
                val addr = dev.address ?: return
                // getName needs BLUETOOTH_CONNECT on 31+; guard so we never throw —
                // fall back to the advertised local name, else "Unnamed device".
                val advName = result.scanRecord?.deviceName
                val name = advName?.takeIf { it.isNotBlank() } ?: "Unnamed device"
                found[addr] = BleDevice(addr, name, result.rssi)
                _devices.value = found.values.sortedByDescending { it.rssi }
            }

            override fun onScanFailed(errorCode: Int) {
                _state.value = "poweredOff"
                _scanning.value = false
            }
        }
        callback = cb
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        runCatching { s.startScan(null, settings, cb) }
            .onFailure { _state.value = "unauthorized"; _scanning.value = false; return }

        stopJob?.cancel()
        stopJob = scope.launch {
            delay(durationMs)
            stopScan()
        }
    }

    fun stopScan() {
        stopJob?.cancel(); stopJob = null
        val cb = callback
        val s = scanner
        if (cb != null && s != null) runCatching { s.stopScan(cb) }
        callback = null
        _scanning.value = false
        if (_state.value == "scanning") _state.value = "idle"
    }

    /**
     * One-shot scan → text block for relay answers (strongest signal first).
     * Piggybacks on a scan already running (NearbySheet open) rather than
     * resetting the list out from under it, mirroring iOS scanSummary.
     */
    suspend fun scanSummary(context: Context, durationMs: Long = 6000): String {
        if (!_scanning.value) startScan(context, durationMs)
        delay(durationMs + 500)
        return summaryText(_devices.value, _state.value)
    }
}
