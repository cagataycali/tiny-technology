package technology.tiny.app.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🏅 The allowance Android quotes before the wall.
 *
 * The number a user reads in the model panel is enforced somewhere they can't
 * see — the limiter's Upstash window. Web can prove the two agree by CALLING the
 * enforcer (`lib/standing.ts` imports `reputationAllowance`); Android cannot
 * import anything, so its only defence is to compute nothing and read the
 * server's numbers, the curve included. What's asserted below is exactly that
 * discipline: no arithmetic here re-derives the allowance, a missing curve makes
 * the app go QUIET rather than invent a "5 per point", and the states where
 * there is nothing true to say produce empty strings instead of plausible ones.
 *
 * Plus org.json's coercion traps, since this payload is a JSONObject off the
 * network: `optBoolean` misreads 0/1 flags (JsonFlags) and `optInt` would read
 * `true` as 1.
 */
class StandingTest {

    /** The shape `standingFor()` writes (lib/standing.ts) — keys and camelCase both. */
    private fun standingJson(
        score: Any = 10,
        base: Any = 50,
        allowance: Any = 100,
        perPoint: Any = 5,
        maxBonus: Any = 200,
        identified: Any? = true,
    ): JSONObject = JSONObject().apply {
        put("score", score); put("base", base); put("allowance", allowance)
        put("perPoint", perPoint); put("maxBonus", maxBonus)
        if (identified != null) put("identified", identified)
    }

    private fun standing(
        score: Int = 10, base: Int = 50, allowance: Int = 100,
        perPoint: Int = 5, maxBonus: Int = 200,
    ) = Standing(
        score = score, base = base, allowance = allowance,
        bonus = maxOf(0, allowance - base), perPoint = perPoint, maxBonus = maxBonus,
    )

    // -- parse: the server's numbers, or none --

    @Test fun `a full payload lands, bonus derived from the SERVERs allowance`() {
        val s = Standing.parse(standingJson())!!
        assertEquals(100, s.allowance)
        assertEquals(50, s.base)
        // Not `base + score × perPoint`: the bonus is the difference between two
        // numbers the server sent, so a curve change needs no Play release.
        assertEquals(50, s.bonus)
        assertEquals(10, s.score)
        assertEquals(5, s.perPoint)
        assertEquals(200, s.maxBonus)
        assertFalse(s.atCap)
    }

    @Test fun `no field, junk, or an empty object is null (a pre-c38 server, safely)`() {
        assertNull(Standing.parse(null))
        assertNull(Standing.parse(JSONObject()))
        // A base is the one field the copy cannot do without.
        assertNull(Standing.parse(standingJson(base = 0)))
        assertNull(Standing.parse(standingJson(base = "lots")))
    }

    @Test fun `identified false is null - that window is SHARED, not theirs`() {
        // Quoting the base as "your allowance" signed out would be the exact bug
        // this file fixes — a correct number under a label naming something else.
        assertNull(Standing.parse(standingJson(identified = false)))
        // …including the D1-ish integer form optBoolean would misread as absent.
        assertNull(Standing.parse(standingJson(identified = 0)))
        assertNull(Standing.parse(standingJson(identified = "0")))
        // Absent `identified` is a c38-or-later server answering a session probe
        // (/api/me 401s otherwise), so it must NOT be read as anonymous.
        assertNotNull(Standing.parse(standingJson(identified = null)))
        assertNotNull(Standing.parse(standingJson(identified = 1)))
    }

    @Test fun `an allowance below the base is clamped, never a negative bonus`() {
        val s = Standing.parse(standingJson(base = 50, allowance = 10))!!
        assertEquals(50, s.allowance)
        assertEquals(0, s.bonus)
        // A missing allowance reads as the base — no standing, not no access.
        val missing = Standing.parse(JSONObject().put("base", 50).put("score", 0))!!
        assertEquals(50, missing.allowance)
        assertEquals(0, missing.bonus)
    }

    @Test fun `absurd numbers do not overflow into a negative allowance`() {
        // Parsed from TEXT, the way the network delivers it — `put(key, Double)`
        // throws on NaN/Infinity (JSON has no such literals), so a test that
        // builds these programmatically tests something the wire can't do. What
        // the wire CAN send: 1e999, which org.json's tokener hands back as a
        // BigDecimal whose toDouble() is Infinity, and a value just past Int
        // range, whose naive toInt() truncates — hence the explicit clamp.
        for (junk in listOf("1e999", "-1e999", "1e308", "3000000000", "-5", "\"lots\"")) {
            val text = """{"score":$junk,"base":$junk,"allowance":$junk,"perPoint":$junk,"maxBonus":$junk}"""
            val s = Standing.parse(JSONObject(text))
            // base fails the >= 1 guard for the negatives and "lots" → null; the
            // huge ones clamp to Int.MAX_VALUE. Either is fine; a negative or
            // wrapped-around number is not.
            if (s != null) {
                assertTrue(junk, s.base >= 1)
                assertTrue(junk, s.bonus >= 0)
                assertTrue(junk, s.allowance >= s.base)
            }
        }
        // The primitives, directly: these are the values `count` must neutralize
        // even though no JSON document can carry them literally.
        assertEquals(0, Standing.count(Double.NaN))
        assertEquals(0, Standing.count(Double.NEGATIVE_INFINITY))
        assertEquals(Int.MAX_VALUE, Standing.count(Double.POSITIVE_INFINITY))
        assertEquals(Int.MAX_VALUE, Standing.count(3_000_000_000L))
        // And a junk value in ONE field can't poison the others.
        val one = Standing.parse(JSONObject("""{"score":1e999,"base":50,"allowance":100}"""))!!
        assertEquals(100, one.allowance)
        assertEquals(Int.MAX_VALUE, one.score)
    }

    @Test fun `a bool where a count belongs is zero, not a plausible 1`() {
        // org.json's optInt coerces `true` to 1, which would make base:true read
        // as a 1-request-a-day free tier — a wrong number that looks computed.
        assertEquals(0, Standing.count(true))
        assertEquals(0, Standing.count("5"))
        assertNull(Standing.parse(standingJson(base = true)))
    }

    // -- copy: true at every point on the curve --

    @Test fun `count grammar holds at 1 - no 1 requests, no 1 points`() {
        assertEquals("1 request a day", standing(base = 1, allowance = 1).allowancePhrase)
        assertEquals("100 requests a day", standing(allowance = 100).allowancePhrase)
        assertTrue(standing(score = 1, allowance = 55).detail.contains("1 point of reputation"))
        assertFalse(standing(score = 1, allowance = 55).detail.contains("1 points"))
    }

    @Test fun `no standing yet - no breakdown, just the invitation`() {
        // "50 = 50 free plus 0 earned from 0 points" is noise.
        val none = standing(score = 0, allowance = 50)
        assertEquals("", none.detail)
        assertTrue(none.nextStep.contains("adds 5 more a day"))
        assertTrue(none.nextStep.contains("followed"))
        assertTrue(none.nextStep.contains("200 still to earn"))
    }

    @Test fun `mid-curve shows the split, so the earned part is visible`() {
        assertEquals(
            "50 free plus 50 earned from 10 points of reputation.",
            standing(score = 10, allowance = 100).detail,
        )
    }

    @Test fun `AT THE CAP the next step is EMPTY - never dangle a spent lever`() {
        val capped = standing(score = 40, allowance = 250)
        assertTrue(capped.atCap)
        assertEquals("", capped.nextStep)
        assertEquals("50 free plus the full 200 that reputation can earn.", capped.detail)
    }

    @Test fun `no curve on the wire is SILENCE, not an invented 5 per point`() {
        // The whole reason perPoint/maxBonus travel: an older server that sends
        // an allowance but no curve must not make Android quote numbers it made up.
        val noCurve = standing(score = 10, allowance = 100, perPoint = 0, maxBonus = 0)
        assertEquals("", noCurve.nextStep)
        // …and a maxBonus of 0 must not make everyone look capped, because the
        // capped branch is itself a claim ("the full 0 that reputation can earn").
        assertFalse(noCurve.atCap)
        assertEquals("50 free plus 50 earned from 10 points of reputation.", noCurve.detail)
        // The allowance itself is still reportable — it came from the server.
        assertEquals("100 requests a day", noCurve.allowancePhrase)
    }

    @Test fun `the remaining-to-earn figure shrinks and never goes negative`() {
        assertTrue(standing(score = 10, allowance = 100).nextStep.contains("150 still to earn"))
        for (allowance in listOf(50, 55, 100, 249, 250, 400)) {
            val s = standing(allowance = allowance)
            val line = s.nextStep
            assertFalse("negative room in: $line", line.contains("-"))
            if (s.atCap) assertEquals("", line)
        }
    }

    @Test fun `no branch ever prints null, NaN or a placeholder`() {
        for (score in listOf(0, 1, 10, 40, 9_999)) {
            for (allowance in listOf(50, 51, 100, 250, 9_999)) {
                val s = standing(score = score, allowance = allowance)
                for (line in listOf(s.allowancePhrase, s.detail, s.nextStep,
                                    Standing.freeTierFooter(s))) {
                    assertFalse(line, line.contains("null") || line.contains("NaN") ||
                        line.contains("Infinity") || line.contains("kotlin."))
                }
            }
        }
    }

    // -- freeTierFooter: the sentence the model panel actually renders --

    @Test fun `null standing quotes NO number - signed out, the window is shared`() {
        val f = Standing.freeTierFooter(null)
        assertEquals(
            "Using tiny's free model (rate-limited). Bring your own key to bypass limits.", f)
        // Specifically: no digits. Naming the deployment's base here would claim
        // a personal allowance for a window shared with every visitor on this
        // network — and this is also the pre-c38-server case.
        assertFalse(f.any { it.isDigit() })
    }

    @Test fun `with standing it names the window, the split and the lever`() {
        val f = Standing.freeTierFooter(standing(score = 10, allowance = 100))
        assertEquals(
            "Using tiny's free model — 100 requests a day: 50 free plus 50 earned from " +
                "10 points of reputation. Bring your own key to bypass limits. " +
                "Each reputation point adds 5 more a day (150 still to earn) — " +
                "being followed is what pays.",
            f,
        )
    }

    @Test fun `zero points - a full stop after the number, then the invitation`() {
        val f = Standing.freeTierFooter(standing(score = 0, allowance = 50))
        // The colon belongs to the breakdown; without one the sentence must not
        // read "50 requests a day Bring your own key".
        assertTrue(f, f.startsWith("Using tiny's free model — 50 requests a day. Bring your own key"))
        assertTrue(f.contains("Each reputation point adds 5 more a day"))
        assertFalse(f.contains("day:"))
    }

    @Test fun `at the cap the footer stops after the breakdown`() {
        val f = Standing.freeTierFooter(standing(score = 45, allowance = 250))
        assertTrue(f, f.endsWith("bypass limits."))
        assertFalse(f.contains("still to earn"))
        assertTrue(f.contains("the full 200 that reputation can earn"))
    }

    @Test fun `the deployments base is followed, not a hardcoded 50`() {
        val s = Standing.parse(standingJson(score = 4, base = 500, allowance = 520))
        val f = Standing.freeTierFooter(s)
        assertTrue(f, f.contains("520 requests a day"))
        assertTrue(f, f.contains("500 free plus 20 earned"))
    }

    @Test fun `the footer keeps its trailing space so the voice line does not collide`() {
        // Panels.kt appends " Live voice calls (📞)…" to this string. A missing
        // separator would render "…bypass limits. Live" as "…limits.Live".
        for (s in listOf(null, standing(score = 0, allowance = 50), standing(score = 45, allowance = 250))) {
            val whole = Standing.freeTierFooter(s) + " Live voice calls (📞) need an OpenAI key."
            assertTrue(whole, whole.contains(". Live voice calls"))
            assertFalse(whole, whole.contains("  "))
        }
    }
}
