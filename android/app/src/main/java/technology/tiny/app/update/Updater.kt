package technology.tiny.app.update

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import technology.tiny.app.BuildConfig
import java.io.File

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val url: String,
    val notes: String?,
    /** Hex SHA-256 of the APK from the manifest; null on older manifests (skip check). */
    val sha256: String? = null,
)

/**
 * Pure integrity gate for a downloaded OTA APK: manifests that carry a sha256
 * must match the downloaded bytes (defense-in-depth over https — catches a
 * truncated download or a CDN serving stale/wrong bytes BEFORE the system
 * installer throws its opaque "App not installed"). Manifests without the
 * field (pre-v0.4.x) skip the check for backward compatibility.
 */
fun apkIntegrityOk(expectedSha256Hex: String?, actualSha256Hex: String): Boolean =
    expectedSha256Hex == null || expectedSha256Hex.equals(actualSha256Hex, ignoreCase = true)

/** Streaming hex SHA-256 of a file (64 KiB chunks — APKs are ~70 MB). */
fun sha256Hex(file: File): String {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    file.inputStream().use { ins ->
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = ins.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}

/**
 * Pure OTA gate: should the manifest's build be offered to a device on
 * [currentCode]? Two rules, both security/UX-relevant:
 *  1. strictly newer — `manifestCode > currentCode` (never offer a downgrade or
 *     re-offer the running build);
 *  2. the download URL must be https, OR a debug-only loopback
 *     (`http://127.0.0.1`, for local adb-reverse OTA testing) — a plain-http
 *     APK URL in a release build is rejected so a MITM can't swap the binary.
 * Extracted from check() so it's unit-testable without a live manifest fetch.
 */
fun isUpdateTrusted(manifestCode: Int, url: String, currentCode: Int, isDebug: Boolean): Boolean {
    val urlOk = url.startsWith("https://") || (isDebug && url.startsWith("http://127.0.0.1"))
    return manifestCode > currentCode && urlOk
}

/**
 * Self-hosted OTA (no Play Store): polls <base>/android/manifest.json
 * `{versionCode, versionName, url, notes?}` on foreground (15-min debounce —
 * iOS Updater parity), downloads the APK, hands it to the system installer.
 * Same-signature installs update in place and keep all app data.
 */
class Updater(private val context: Context, private val baseProvider: () -> String) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("tiny_updater", Context.MODE_PRIVATE)
    private val client = OkHttpClient()

    private val _available = MutableStateFlow<UpdateInfo?>(null)
    val available: StateFlow<UpdateInfo?> = _available
    private val _installing = MutableStateFlow(false)
    val installing: StateFlow<Boolean> = _installing

    // The version we just handed to the system installer. Tapping "update" opens
    // the install sheet and backgrounds us; the next foreground re-checks while
    // this binary is still old, so without suppression the banner reappears
    // mid-install (the bug iOS hit on build 22 — Update.swift installingVersion).
    // Suppressed for 10 min: long enough for the swap, short enough that a
    // cancelled/failed install re-offers.
    @Volatile private var installingVersion: Int = 0
    @Volatile private var installingUntil: Long = 0

    suspend fun checkSoon() {
        val last = prefs.getLong("last_check", 0)
        if (System.currentTimeMillis() - last < 15 * 60_000) return
        check()
    }

    suspend fun check() = withContext(Dispatchers.IO) {
        prefs.edit().putLong("last_check", System.currentTimeMillis()).apply()
        val manifest = runCatching {
            client.newCall(
                Request.Builder().url("${baseProvider()}/android/manifest.json").get().build()
            ).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                JSONObject(resp.body?.string().orEmpty())
            }
        }.getOrNull() ?: return@withContext
        val code = manifest.optInt("versionCode", 0)
        val url = manifest.optString("url")
        // https-only (except a debug loopback for local OTA testing via adb reverse)
        // and strictly-newer — see isUpdateTrusted.
        if (isUpdateTrusted(code, url, BuildConfig.VERSION_CODE, BuildConfig.DEBUG)) {
            // Install in flight for this version → don't nag while the system swaps
            // the APK (iOS Update.swift applyCheck installingVersion guard).
            if (code == installingVersion && System.currentTimeMillis() < installingUntil) return@withContext
            _available.value = UpdateInfo(
                versionCode = code,
                versionName = manifest.optString("versionName", code.toString()),
                url = url,
                notes = manifest.optString("notes").takeIf { it.isNotEmpty() },
                sha256 = manifest.optString("sha256").takeIf { it.isNotEmpty() },
            )
        }
    }

    /** Download the APK and open the system install sheet. */
    suspend fun install(info: UpdateInfo): String? = withContext(Dispatchers.IO) {
        _installing.value = true
        try {
            val apk = File(context.cacheDir, "update-${info.versionCode}.apk")
            client.newCall(Request.Builder().url(info.url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext "download failed (${resp.code})"
                apk.outputStream().use { out -> resp.body?.byteStream()?.copyTo(out) }
            }
            // Verify against the manifest hash BEFORE handing to the installer —
            // a truncated/corrupt download otherwise surfaces as the system's
            // opaque "App not installed" with no way back to a retry.
            if (!apkIntegrityOk(info.sha256, sha256Hex(apk))) {
                apk.delete()
                return@withContext "update didn't verify — check your connection and try again"
            }
            val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.files", apk)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            // Suppress re-offering this version while the install sheet backgrounds
            // us; clear the banner + reset the debounce so a re-check is allowed but
            // won't re-surface the same version (iOS Update.swift installUpdate).
            installingVersion = info.versionCode
            installingUntil = System.currentTimeMillis() + 10 * 60_000
            _available.value = null
            prefs.edit().putLong("last_check", 0).apply()
            context.startActivity(intent)
            null
        } catch (t: Throwable) {
            t.message ?: "install failed"
        } finally {
            _installing.value = false
        }
    }

    fun dismiss() {
        _available.value = null
    }
}
