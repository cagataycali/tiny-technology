package technology.tiny.app.net

import org.json.JSONObject

/**
 * Read a server boolean flag that may arrive as a JSON boolean OR a D1 integer
 * (0/1) OR a string. org.json's [JSONObject.optBoolean] does NOT coerce
 * integers — `optBoolean("private", false)` returns FALSE for the integer 1,
 * and (worse) `optBoolean("private", true)` returns the DEFAULT `true` for the
 * integer 0, because a non-boolean value is treated as absent and the default
 * is handed back. Both are silent misreads whenever the field is a raw D1
 * column serialized as 0/1.
 *
 * [truthyFlag] instead coerces truthiness when the key is PRESENT (1/"1"/true →
 * true; 0/"0"/false/other → false) and falls back to [default] only when the
 * key is truly absent or JSON null. Web does the same with `!!t.private`
 * (wallet/page.tsx:137, [slug]/page.tsx:342). The per-site [default] preserves
 * each caller's null-policy:
 *   - fetchAccent reads `private` fail-OPEN (default false) — an unspecified
 *     tiny is public; the fix is that an authorized owner's `private:1` now
 *     reads private (was leaking as public → no lock shown).
 *   - x402Hint reads `private` fail-CLOSED (default true) — an unresolvable
 *     tiny is treated private and its payable URLs suppressed; the fix is that
 *     a `private:0` PUBLIC priced tiny now advertises (was suppressed because
 *     optBoolean(true) handed back the default for the integer 0).
 * See the c299/c301 watch-items. iOS has the identical latent bug
 * (Wallet.swift:556, Views.swift:464 `as? Bool ?? false`), flagged for its backlog.
 */
fun JSONObject.truthyFlag(key: String, default: Boolean): Boolean {
    if (!has(key) || isNull(key)) return default
    return when (val v = opt(key)) {
        is Boolean -> v
        is Number -> v.toInt() != 0
        is String -> v == "true" || v == "1"
        else -> default
    }
}

/**
 * Read an optional string, returning null when the field is absent, JSON null,
 * OR empty. org.json's [JSONObject.optString] has a notorious trap: for an
 * EXPLICIT JSON null (`"linked_address": null`, not merely absent) it returns
 * the literal three-char string `"null"`, NOT the default — so the common
 * `optString(key, "").ifEmpty { null }` still yields `"null"`, which then
 * renders verbatim ("✓ null" on the wallet's linked-address line was exactly
 * this). Guard [isNull] first, then coerce blank/"null" to null so a
 * server-side null never leaks into the UI as text.
 */
fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val v = optString(key, "")
    return if (v.isEmpty() || v == "null") null else v
}
