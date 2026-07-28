package technology.tiny.app.geo

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.math.roundToInt
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 📍 Device location → agent context (maps-location loop c6; web lib/geo.ts
 * parity, agi-diy context-injector grammar).
 *
 * The pure half (kmh / cardinal / contextBlock) matches the web's `###
 * Location` block byte-for-byte so every client teaches the tiny the same
 * shape. The FusedLocation half is snapshot-based like [Motion]: one
 * getCurrentLocation per ask (bounded, cached 30s), never a standing
 * watch — the chat toggle costs a GPS fix per message, not a duty cycle.
 */
object Geo {
    data class Fix(
        val lat: Double,
        val lng: Double,
        /** meters, null when the platform won't say */
        val accuracyM: Int? = null,
        /** meters above sea level */
        val altitudeM: Int? = null,
        /** m/s from the platform — converted at render time */
        val speedMs: Double? = null,
        /** degrees clockwise from true north, null when not moving */
        val headingDeg: Double? = null,
        val timestampMs: Long = 0,
    )

    private val CARDINALS = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

    /** m/s → km/h at 1dp; null for junk/negative (web speedKmh parity). */
    fun kmh(speedMs: Double?): Double? {
        if (speedMs == null || !speedMs.isFinite() || speedMs < 0) return null
        return (speedMs * 3.6 * 10).roundToInt() / 10.0
    }

    /** 0-360° → compass point; wraps, null for junk (web headingCardinal parity). */
    fun cardinal(deg: Double?): String? {
        if (deg == null || !deg.isFinite()) return null
        val norm = ((deg % 360.0) + 360.0) % 360.0
        return CARDINALS[((norm / 45.0).roundToInt()) % 8]
    }

    /**
     * The agent-facing `### Location` markdown block — same grammar as web
     * lib/geo.ts locationContext / agi-diy context-injector. Locale.US
     * pinned: a tr-TR device would otherwise print "37,7749" and split the
     * coordinate pair on its own comma.
     */
    fun contextBlock(fix: Fix?): String {
        if (fix == null || !fix.lat.isFinite() || !fix.lng.isFinite()) return ""
        val lines = mutableListOf("### Location")
        lines += "- **Coordinates**: ${"%.4f".format(Locale.US, fix.lat)}, ${"%.4f".format(Locale.US, fix.lng)}"
        fix.accuracyM?.let { lines += "- **Accuracy**: ±${it}m" }
        fix.altitudeM?.let { lines += "- **Altitude**: ${it}m" }
        kmh(fix.speedMs)?.takeIf { it > 0 }?.let {
            lines += "- **Speed**: ${"%.1f".format(Locale.US, it)} km/h"
        }
        cardinal(fix.headingDeg)?.let {
            lines += "- **Heading**: $it (${fix.headingDeg!!.roundToInt()}°)"
        }
        return lines.joinToString("\n")
    }

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun fromLocation(loc: Location): Fix = Fix(
        lat = loc.latitude,
        lng = loc.longitude,
        accuracyM = if (loc.hasAccuracy()) loc.accuracy.roundToInt() else null,
        altitudeM = if (loc.hasAltitude()) loc.altitude.roundToInt() else null,
        speedMs = if (loc.hasSpeed()) loc.speed.toDouble() else null,
        headingDeg = if (loc.hasBearing()) loc.bearing.toDouble() else null,
        timestampMs = loc.time,
    )

    @Volatile private var cached: Fix? = null
    private const val CACHE_MS = 30_000L
    private const val FIX_TIMEOUT_MS = 5_000L

    /**
     * One bounded fix: 30s cache → fused getCurrentLocation (≤5s) → null.
     * Null on no-permission — callers degrade to "no location line", the
     * Motion/Bluetooth snapshot contract.
     */
    @SuppressLint("MissingPermission") // guarded by hasPermission
    suspend fun current(context: Context): Fix? {
        if (!hasPermission(context)) return null
        cached?.takeIf { System.currentTimeMillis() - it.timestampMs < CACHE_MS }?.let { return it }
        val fix = withTimeoutOrNull(FIX_TIMEOUT_MS) {
            suspendCancellableCoroutine<Fix?> { cont ->
                val cts = CancellationTokenSource()
                LocationServices.getFusedLocationProviderClient(context)
                    .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, cts.token)
                    .addOnSuccessListener { loc -> if (cont.isActive) cont.resume(loc?.let(::fromLocation)) }
                    .addOnFailureListener { if (cont.isActive) cont.resume(null) }
                cont.invokeOnCancellation { cts.cancel() }
            }
        }
        if (fix != null) cached = fix
        return fix
    }

    /**
     * The per-send hook (ChatViewModel extraSystem): the location block when
     * the settings toggle is on AND permission is granted, else null and the
     * request is byte-identical to before — web mergeLocationMeta parity.
     */
    suspend fun contextIfEnabled(context: Context, enabled: Boolean): String? {
        if (!enabled) return null
        val block = contextBlock(current(context) ?: return null)
        return block.ifBlank { null }
    }
}
