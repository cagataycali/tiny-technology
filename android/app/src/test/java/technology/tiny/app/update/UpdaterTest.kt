package technology.tiny.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * isUpdateTrusted is the pure OTA gate extracted from Updater.check() — the
 * decision that lets a self-hosted manifest replace the running APK. It's
 * security-relevant (a plain-http APK URL in a release build must be rejected so
 * a network attacker can't swap the binary) and pure kotlin, so it runs on the
 * local JVM. Mirrors the iOS Updater applyCheck gate.
 */
class UpdaterTest {

    @Test fun `strictly newer https build is offered`() {
        assertTrue(isUpdateTrusted(manifestCode = 3, url = "https://tiny.technology/android/tiny-3.apk", currentCode = 2, isDebug = false))
    }

    @Test fun `same version is never re-offered`() {
        assertFalse(isUpdateTrusted(2, "https://tiny.technology/android/tiny-2.apk", currentCode = 2, isDebug = false))
    }

    @Test fun `older version is never a downgrade`() {
        assertFalse(isUpdateTrusted(1, "https://tiny.technology/android/tiny-1.apk", currentCode = 2, isDebug = false))
    }

    @Test fun `plain http url is rejected in a release build`() {
        // The MITM guard: a non-https APK url must NOT be trusted when not debug,
        // even though the version is newer.
        assertFalse(isUpdateTrusted(3, "http://evil.example/tiny-3.apk", currentCode = 2, isDebug = false))
    }

    @Test fun `debug loopback http is allowed only in debug builds`() {
        // adb-reverse local OTA testing: http://127.0.0.1 is fine in debug…
        assertTrue(isUpdateTrusted(3, "http://127.0.0.1:8080/tiny-3.apk", currentCode = 2, isDebug = true))
        // …but the SAME loopback url is rejected in a release build.
        assertFalse(isUpdateTrusted(3, "http://127.0.0.1:8080/tiny-3.apk", currentCode = 2, isDebug = false))
    }

    @Test fun `arbitrary http host is rejected even in debug`() {
        // Debug only widens the exception to the loopback host, not all http.
        assertFalse(isUpdateTrusted(3, "http://192.168.1.5/tiny-3.apk", currentCode = 2, isDebug = true))
    }

    @Test fun `a newer build with a bad url is still rejected`() {
        // Both rules must pass — newer alone is not enough.
        assertFalse(isUpdateTrusted(99, "ftp://tiny.technology/tiny.apk", currentCode = 2, isDebug = false))
        assertFalse(isUpdateTrusted(99, "", currentCode = 2, isDebug = false))
    }

    // ── download integrity (manifest sha256, optional for old manifests) ─────

    @Test fun `manifest without sha256 skips the integrity check`() {
        assertTrue(apkIntegrityOk(null, "whatever-was-downloaded"))
    }

    @Test fun `matching hash passes, case-insensitively`() {
        assertTrue(apkIntegrityOk("ABCDEF01", "abcdef01"))
    }

    @Test fun `mismatched hash fails`() {
        assertFalse(apkIntegrityOk("abcdef01", "deadbeef"))
    }

    @Test fun `sha256Hex matches the known vector for abc`() {
        val f = java.io.File.createTempFile("updater-test", ".bin").apply {
            deleteOnExit()
            writeBytes("abc".toByteArray())
        }
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            sha256Hex(f),
        )
    }
}
