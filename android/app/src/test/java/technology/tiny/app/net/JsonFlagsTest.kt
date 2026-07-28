package technology.tiny.app.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * truthyFlag is the coercion that repairs org.json optBoolean's two silent
 * misreads of a D1-integer flag (`private` arrives as 0/1 from get.ts:230):
 *   - optBoolean(key, false) returns FALSE for the integer 1 (a private tiny
 *     read as public → leaked payable URLs / no lock).
 *   - optBoolean(key, true) returns the TRUE default for the integer 0 (a
 *     public priced tiny read as private → payable URLs wrongly suppressed).
 * Both are proven against the bundled json-20240303.jar. These pin the fix at
 * BOTH null-policies, since fetchAccent uses default=false (fail-open) and
 * x402Hint uses default=true (fail-closed).
 */
class JsonFlagsTest {

    private fun flag(json: String, default: Boolean): Boolean =
        JSONObject(json).truthyFlag("private", default)

    @Test fun `an integer 1 coerces to true under either default`() {
        assertEquals(true, flag("""{"private":1}""", default = false))  // optBoolean would say false
        assertEquals(true, flag("""{"private":1}""", default = true))
    }

    @Test fun `an integer 0 coerces to false under either default`() {
        assertEquals(false, flag("""{"private":0}""", default = false))
        assertEquals(false, flag("""{"private":0}""", default = true))  // optBoolean would hand back true
    }

    @Test fun `a real json boolean is honored under either default`() {
        assertEquals(true, flag("""{"private":true}""", default = false))
        assertEquals(false, flag("""{"private":false}""", default = true))
    }

    @Test fun `string forms coerce like the wire booleans`() {
        assertEquals(true, flag("""{"private":"1"}""", default = false))
        assertEquals(true, flag("""{"private":"true"}""", default = false))
        assertEquals(false, flag("""{"private":"0"}""", default = true))
        assertEquals(false, flag("""{"private":"false"}""", default = true))
    }

    @Test fun `an absent key falls back to the per-site default`() {
        assertEquals(false, flag("""{}""", default = false))  // fetchAccent fail-open
        assertEquals(true, flag("""{}""", default = true))    // x402Hint fail-closed
    }

    @Test fun `an explicit json null falls back to the per-site default`() {
        assertEquals(false, flag("""{"private":null}""", default = false))
        assertEquals(true, flag("""{"private":null}""", default = true))
    }

    @Test fun `an unexpected value type falls back to the default`() {
        // A stray array/object is neither truthy nor falsy — take the caller's policy.
        assertEquals(false, flag("""{"private":[1]}""", default = false))
        assertEquals(true, flag("""{"private":{"x":1}}""", default = true))
    }
}
