package technology.tiny.app.net

import org.json.JSONObject

/**
 * 🏅 STANDING (Android) — what this builder's reputation is worth, said BEFORE
 * the wall instead of at it.
 *
 * Port of `lib/standing.ts` / `ios/Tiny/Sources/Standing.swift`, and the last of
 * the three clients to get it. The arc so far only ever speaks at the moment of
 * refusal: c8 sized a signed-in builder's daily allowance by reputation, c37
 * made the 429 explain the curve, c38 put the caller's own numbers on
 * `/api/me`, c39 taught iOS to read them. Android's mirror of that footer
 * (`Panels.kt`, "model & API key") said "Using tiny's free model
 * (rate-limited)" and named **no number at all** — so a builder with 40 points,
 * whose enforced window is 250/day, could not learn from this app that standing
 * had already bought them 200 extra requests, nor that being followed buys more.
 *
 * ⚠️ **The curve is NOT redeclared here.** `perPoint` and `maxBonus` come off
 * the wire (`/api/me` → `standing`) precisely because a `val requestsPerPoint =
 * 5` in Kotlin is a fork of `lib/rate-limit-curve.ts` that agrees with it right
 * up until the curve moves — and then lies from an installed APK the user has no
 * reason to update. Same call [WalletCore.parseFaucetInfo] already makes for the
 * faucet's `micro_per_point`/`max_micro`.
 *
 * PURE (no Compose, no OkHttp) so every sentence a user can read is asserted in
 * StandingTest rather than eyeballed on a device.
 */
data class Standing(
    /** Reputation points the network granted this user (0 = none yet). */
    val score: Int = 0,
    /** The allowance before reputation — this deployment's free tier. */
    val base: Int = 0,
    /** What the limiter actually builds the window with. */
    val allowance: Int = 0,
    /** Extra requests standing has earned (allowance − base, never negative). */
    val bonus: Int = 0,
    /** Requests one more point buys, per the SERVER's curve (never hardcoded). */
    val perPoint: Int = 0,
    /** Ceiling on the earned bonus — what "the full 200" refers to. */
    val maxBonus: Int = 0,
) {
    /**
     * Is the earning lever spent? Guarded against a [maxBonus] of 0: an older or
     * partial payload must not make every reader look capped, because the capped
     * branch is the one that goes SILENT about earning more.
     */
    val atCap: Boolean get() = maxBonus > 0 && bonus >= maxBonus

    /**
     * The allowance as a phrase — "250 requests a day". The window matters as
     * much as the count: an allowance with no period is not a limit.
     */
    val allowancePhrase: String get() = "${plural(allowance, "request")} a day"

    /**
     * The breakdown, or "" when there is nothing true to add.
     *
     * Empty at zero points on purpose: "50 = 50 free plus 0 earned from 0
     * points" is noise, and the honest message there is the invitation
     * ([nextStep]).
     */
    val detail: String get() = when {
        bonus <= 0 -> ""
        atCap -> "$base free plus the full $maxBonus that reputation can earn."
        else -> "$base free plus $bonus earned from ${plural(score, "point")} of reputation."
    }

    /**
     * What earning more would get them, or "" when nothing would.
     *
     * ⚠️ Silent at the cap: "each point adds 5 more" is FALSE there, and
     * dangling a spent lever is worse than saying nothing — a user can act on it
     * for weeks for zero effect (the rule `lib/limit-message.ts` and
     * `lib/standing.ts` both follow). Also silent when the server didn't send a
     * curve: an invented number is worse than an absent sentence.
     *
     * Names *being followed* because that is the gesture that pays — following
     * pays nothing (worker `reputation.ts`).
     */
    val nextStep: String get() {
        if (atCap || perPoint <= 0 || maxBonus <= 0) return ""
        val room = maxOf(0, maxBonus - bonus)
        return "Each reputation point adds $perPoint more a day " +
            "($room still to earn) — being followed is what pays."
    }

    companion object {
        /**
         * Parse the `standing` object from `GET /api/me`.
         *
         * null for anything unusable — a pre-c38 server (no field), a signed-out
         * probe (the 401 body carries no standing), junk. Every caller then
         * falls back to copy that quotes no number, which is what Android showed
         * before this existed: strictly no worse.
         *
         * `identified:false` also yields null, deliberately. Signed out the
         * window is IP-keyed and SHARED with everyone on that network, so there
         * is no personal allowance to report; quoting the base as "your"
         * allowance would be the exact class of bug this file fixes — a correct
         * number under a label naming something else.
         */
        fun parse(o: JSONObject?): Standing? {
            if (o == null) return null
            // truthyFlag, not optBoolean: a 0/1 integer reads FALSE under
            // optBoolean and (worse) an absent-looking non-boolean hands back
            // the default (see JsonFlags). Default true because /api/me only
            // answers for a session — an absent flag is a signed-in caller on an
            // older payload, not an anonymous one.
            if (!o.truthyFlag("identified", true)) return null
            // A base of 0 means the field is missing or nonsense; a real
            // deployment always has at least 1 (lib/free-tier fails closed to 50).
            val base = count(o.opt("base"))
            if (base < 1) return null
            val allowance = maxOf(base, count(o.opt("allowance")))
            return Standing(
                score = count(o.opt("score")),
                base = base,
                // Not `base + score × perPoint`: the bonus is the difference
                // between two numbers the SERVER sent, so a curve change needs
                // no Play release.
                allowance = allowance,
                bonus = allowance - base,
                // camelCase, matching the `atCap` this same object has shipped
                // since c38 — one convention per payload, and
                // tests/standing.test.ts asserts every key read here is a key
                // `standingFor` actually writes.
                perPoint = count(o.opt("perPoint")),
                maxBonus = count(o.opt("maxBonus")),
            )
        }

        /**
         * A JSON count → Int, without the coercion traps.
         *
         * `optInt` would read a JSON `true` as 1 (org.json coerces booleans) and
         * a `"lots"` string as 0 — the first is a plausible-looking wrong
         * number, which is worse than none. Non-finite (a `1e999` saturates to
         * Infinity in the tokener), negative and non-numeric all read 0, which
         * every caller treats as "unknown" and falls back on.
         */
        fun count(value: Any?): Int {
            val n = value as? Number ?: return 0
            val d = n.toDouble()
            if (d.isNaN() || d <= 0.0) return 0
            return if (d >= Int.MAX_VALUE.toDouble()) Int.MAX_VALUE else d.toInt()
        }

        /**
         * Count grammar without a shared helper: Android has no `pluralize`, and
         * "1 requests a day" on a free tier of 1 is the kind of tell that makes
         * a number look computed by nobody.
         */
        private fun plural(n: Int, word: String): String = "$n $word${if (n == 1) "" else "s"}"

        /**
         * The whole free-tier sentence for the model panel, standing or not.
         *
         * Built here rather than interpolated at the call site so the render
         * states are one testable function instead of an `if (s != null)` ladder
         * inside a Composable — the same reason WalletCore.ceilingNote exists.
         * The voice-call line stays at the call site: it's true on both branches
         * and has nothing to do with standing.
         */
        fun freeTierFooter(s: Standing?): String {
            // No standing (signed out, older server, junk): quote no number.
            // Naming the deployment's base would be wrong for the signed-out
            // case in the way that matters — that window is shared with every
            // visitor on this network, not theirs.
            if (s == null) return "Using tiny's free model (rate-limited). Bring your own key to bypass limits."
            val detail = s.detail
            var out = "Using tiny's free model — ${s.allowancePhrase}"
            out += if (detail.isEmpty()) ". " else ": $detail "
            out += "Bring your own key to bypass limits."
            val next = s.nextStep
            if (next.isNotEmpty()) out += " $next"
            return out
        }
    }
}
