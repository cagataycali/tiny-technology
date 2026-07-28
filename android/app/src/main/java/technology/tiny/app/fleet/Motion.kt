package technology.tiny.app.fleet

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.delay

/**
 * The phone's inner ear ("and with a motion too"). A short SensorManager
 * sample becomes a human-readable snapshot for relay answers: moving/still,
 * orientation, attitude, steps today. Native port of iOS Motion.swift — same
 * pattern as [Bluetooth]: sensor context the server could never see, appended
 * to a motion/steps relay prompt in FleetManager.
 *
 * TYPE_LINEAR_ACCELERATION = accel minus gravity (iOS userAcceleration, in m/s²
 * → /9.81 for g). TYPE_GRAVITY = the gravity vector (iOS gravity). Attitude via
 * TYPE_ROTATION_VECTOR → getOrientation (azimuth/pitch/roll). Step counter is a
 * since-boot cumulative counter (no daily total without a persisted baseline),
 * gated on ACTIVITY_RECOGNITION (API 29+).
 */
object Motion {

    // ---- pure classification (iOS Motion.swift parity), extracted for tests ----
    // Kept Context-/SensorManager-free so the wording that feeds a relay answer is
    // JVM-unit-testable exactly like the physics lines iOS builds inline.

    /** Movement state from the user-acceleration magnitude in g (iOS 0.05g threshold).
     *  Locale.US so the decimal is a '.' regardless of device locale — the string is
     *  fed to the agent (machine-read), matching Swift String(format:)'s POSIX '.'. */
    fun motionState(accelG: Float): String =
        if (accelG > 0.05f) "moving (user accel %.2fg)".format(java.util.Locale.US, accelG) else "still"

    /** How the phone is lying, from the gravity vector in g. Android's gravity points
     *  the OPPOSITE way to iOS (+z = face up here), so the z test is sign-flipped from
     *  Motion.swift, but the thresholds (0.75 / 0.6 g) match exactly. */
    fun facing(gzG: Float, gyG: Float): String = when {
        gzG > 0.75f -> "face up"
        gzG < -0.75f -> "face down"
        abs(gyG) > 0.6f -> "upright"
        else -> "on its side"
    }

    /** Radians → whole degrees, TRUNCATED toward zero to match iOS `Int(rad*180/π)`
     *  (Swift Int() truncates; the prior roundToInt diverged by up to a degree). */
    fun deg(rad: Float): Int = (rad * 180.0 / Math.PI).toInt()

    /** ~0.6s sample → text block. Never throws; degrades to what's available. */
    suspend fun snapshot(context: Context): String {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            ?: return "No motion sensors on this device."
        val gravity = sm.getDefaultSensor(Sensor.TYPE_GRAVITY)
        val linear = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
        val rotation = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        if (gravity == null && linear == null && rotation == null) {
            return "No motion sensors on this device."
        }

        // Single listener keeping the latest value of each sensor over the window.
        val latest = HashMap<Int, FloatArray>()
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                latest[e.sensor.type] = e.values.copyOf()
            }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        listOfNotNull(gravity, linear, rotation).forEach {
            sm.registerListener(listener, it, SensorManager.SENSOR_DELAY_GAME)
        }
        try {
            delay(600)
        } finally {
            sm.unregisterListener(listener)
        }

        val g = latest[Sensor.TYPE_GRAVITY]
        val ua = latest[Sensor.TYPE_LINEAR_ACCELERATION]
        val rot = latest[Sensor.TYPE_ROTATION_VECTOR]
        if (g == null && ua == null && rot == null) return "Motion sensors gave no reading."

        val lines = mutableListOf<String>()
        if (ua != null) {
            // Linear accel is in m/s²; iOS reports g (÷9.81) with a 0.05g threshold.
            val accelG = sqrt(ua[0] * ua[0] + ua[1] * ua[1] + ua[2] * ua[2]) / 9.81f
            lines += "- state: " + motionState(accelG)
        }
        if (g != null) {
            // Gravity is in m/s²; convert to g (÷9.81) so the thresholds match iOS.
            lines += "- lying: " + facing(g[2] / 9.81f, g[1] / 9.81f)
        }
        if (rot != null) {
            val r = FloatArray(9)
            val orient = FloatArray(3)
            SensorManager.getRotationMatrixFromVector(r, rot)
            SensorManager.getOrientation(r, orient) // [azimuth(yaw), pitch, roll] radians
            lines += "- attitude: pitch ${deg(orient[1])}°, roll ${deg(orient[2])}°, yaw ${deg(orient[0])}°"
        }
        stepsSinceBoot(context, sm)?.let { lines += "- steps (since boot): $it" }
        return lines.joinToString("\n")
    }

    /**
     * Step counter is a since-boot cumulative total (Android has no built-in
     * daily reset). Reported as-is with a "since boot" label so the answer is
     * honest. Gated on ACTIVITY_RECOGNITION (API 29+) + hardware presence. The
     * sensor only emits on a step, so we wait briefly then give up (null).
     */
    private suspend fun stepsSinceBoot(context: Context, sm: SensorManager): Int? {
        if (Build.VERSION.SDK_INT >= 29 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) !=
            PackageManager.PERMISSION_GRANTED
        ) return null
        val counter = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return null
        var steps: Int? = null
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) { steps = e.values.firstOrNull()?.toInt() }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        sm.registerListener(listener, counter, SensorManager.SENSOR_DELAY_UI)
        try {
            delay(800)
        } finally {
            sm.unregisterListener(listener)
        }
        return steps
    }
}
