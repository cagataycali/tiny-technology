package technology.tiny.app.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

data class TinyUser(val id: String, val login: String, val name: String?, val avatar: String?)

/**
 * `expires` arrives as unix SECONDS (app/api/auth/cli/token/route.ts:51 —
 * `Math.floor(Date.now()/1000) + CLI_TOKEN_TTL`) but was stored as an opaque
 * string and never read. Older installs may hold "" (optString of a missing
 * field) — blank/garbage/non-positive all parse to null = "no known expiry".
 */
fun sessionExpiryMs(expiresUnixSeconds: String?): Long? =
    expiresUnixSeconds?.trim()?.toLongOrNull()?.takeIf { it > 0 }?.times(1000)

/**
 * Is the stored session past its expiry? `nowMs` is a parameter so the DECISION
 * is testable, not just the parser.
 *
 * It has to be: this one comparison is the whole launch gate. Flip it and every
 * valid session is refused at launch ("your session expired — sign in again")
 * while every genuinely expired token is waved through to 401 on every call —
 * and the parser tests beside it stay green either way, because they never
 * evaluate it. Unknown expiry (null) is NOT expired: a blank/garbage/absent
 * field must never lock out a working session.
 */
fun isSessionExpired(expiresUnixSeconds: String?, nowMs: Long): Boolean =
    sessionExpiryMs(expiresUnixSeconds)?.let { it < nowMs } == true

/**
 * Holds the 90-day aud:'tiny-cli' JWT obtained via the native flow:
 * Custom Tab -> https://tiny.technology/auth/cli?scheme=tinyapp&state=<nonce>
 * -> tinyapp://auth?code&state -> POST /api/auth/cli/token {code,state}.
 */
class AuthManager(context: Context) {

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "tiny_auth",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val _user = MutableStateFlow(loadUser())
    val user: StateFlow<TinyUser?> = _user

    var pendingState: String?
        get() = prefs.getString("pending_state", null)
        set(value) = prefs.edit().putString("pending_state", value).apply()

    val token: String? get() = prefs.getString("token", null)
    val isLoggedIn: Boolean get() = token != null

    /** True when the stored 90-day token is past its expiry — it can only 401
     *  from here, so the UI should route to sign-in instead of letting every
     *  call fail (the reactive 401 copy still covers mid-session expiry). */
    val isSessionExpired: Boolean
        get() = isSessionExpired(prefs.getString("expires", null), System.currentTimeMillis())

    // Fleet-node credentials (tind_… token is shown once by the server; hash-stored there)
    var deviceId: String?
        get() = prefs.getString("device_id", null)
        set(value) = prefs.edit().putString("device_id", value).apply()
    var deviceToken: String?
        get() = prefs.getString("device_token", null)
        set(value) = prefs.edit().putString("device_token", value).apply()

    fun clearDevice() {
        prefs.edit().remove("device_id").remove("device_token").apply()
    }

    fun saveSession(token: String, userJson: JSONObject, expires: String?) {
        prefs.edit()
            .putString("token", token)
            .putString("user", userJson.toString())
            .putString("expires", expires)
            .remove("pending_state")
            .apply()
        _user.value = loadUser()
    }

    fun logout() {
        prefs.edit().clear().apply()
        _user.value = null
    }

    val login: String? get() = _user.value?.login

    private fun loadUser(): TinyUser? {
        val raw = prefs.getString("user", null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            TinyUser(
                id = o.optString("id"),
                login = o.optString("login"),
                name = o.optString("name").takeIf { it.isNotEmpty() },
                avatar = o.optString("avatar").takeIf { it.isNotEmpty() },
            )
        }.getOrNull()
    }
}
