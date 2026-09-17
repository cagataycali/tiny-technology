package technology.tiny.app.ui

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the keyboard is TOLD about each field shape ([FieldOptions]).
 *
 * These run on the plain JVM: KeyboardOptions / KeyboardType / KeyboardCapitalization are
 * multiplatform value classes with no Android dependency (same reason MarkdownTest works).
 *
 * ⚠️ Why any of this is tested at all: the defect these options fix was a DEFAULT nobody
 * had read — `autoCorrectEnabled` is nullable and unset means **true**. A source grep
 * cannot tell `= false` from `= true`, and cannot tell either from a field that never
 * mentions the knob. So the polarity is EXECUTED here, and the predicates that encode it
 * are exercised against wrong values too — a predicate that only ever sees correct input
 * is a spelling test.
 */
class FieldOptionsTest {

    // ── the three shapes ──

    @Test
    fun identifierRefusesAutocorrectAndCapitalization() {
        assertEquals(false, FieldOptions.identifier.autoCorrectEnabled)
        assertEquals(KeyboardCapitalization.None, FieldOptions.identifier.capitalization)
    }

    @Test
    fun secretDeclaresPasswordInputType() {
        // The part that reaches EditorInfo.inputType (129) and so keeps the value out of
        // the IME's learned words. PasswordVisualTransformation cannot do this — it only
        // changes what is drawn.
        assertEquals(KeyboardType.Password, FieldOptions.secret.keyboardType)
    }

    @Test
    fun secretAlsoRefusesAutocorrect() {
        // ⚠️ NOT redundant with the inputType: Compose ORs TYPE_TEXT_FLAG_AUTO_CORRECT in
        // after the KeyboardType switch, gated only on TYPE_CLASS_TEXT — and 129 has that
        // bit. A password field that forgot this flag still autocorrects.
        assertEquals(false, FieldOptions.secret.autoCorrectEnabled)
        assertEquals(KeyboardCapitalization.None, FieldOptions.secret.capitalization)
    }

    @Test
    fun proseAsksForSentenceCase() {
        assertEquals(KeyboardCapitalization.Sentences, FieldOptions.prose.capitalization)
    }

    @Test
    fun proseIsNotTheBareDefault() {
        // If `prose` were KeyboardOptions.Default, "this field chose prose" and "nobody
        // thought about this field" would be the same object — and the whole point of
        // naming the shapes is that the second case stays visible.
        assertNotEquals(KeyboardOptions.Default, FieldOptions.prose)
    }

    @Test
    fun proseLeavesAutocorrectAlone() {
        // Autocorrect HELPS a sentence, so prose must not inherit identifier's refusal.
        assertNotEquals(false, FieldOptions.prose.autoCorrectEnabled)
    }

    // ── the imeAction overloads carry the shape, not just the action ──

    @Test
    fun identifierWithImeActionKeepsTheGuards() {
        val o = FieldOptions.identifier(ImeAction.Done)
        assertEquals(ImeAction.Done, o.imeAction)
        assertTrue(FieldOptions.keepsVerbatim(o))
    }

    @Test
    fun secretWithImeActionKeepsTheGuards() {
        val o = FieldOptions.secret(ImeAction.Go)
        assertEquals(ImeAction.Go, o.imeAction)
        assertTrue(FieldOptions.keepsSecret(o))
    }

    @Test
    fun proseWithImeActionKeepsSentenceCase() {
        val o = FieldOptions.prose(ImeAction.Done)
        assertEquals(ImeAction.Done, o.imeAction)
        assertEquals(KeyboardCapitalization.Sentences, o.capitalization)
    }

    // ── keepsVerbatim ──

    @Test
    fun keepsVerbatimAcceptsIdentifierAndSecret() {
        assertTrue(FieldOptions.keepsVerbatim(FieldOptions.identifier))
        assertTrue(FieldOptions.keepsVerbatim(FieldOptions.secret))
    }

    @Test
    fun keepsVerbatimRejectsTheUnsetDefault() {
        // ⚠️ THE defect. A field carrying no options is not neutral — Compose resolves the
        // unset autoCorrectEnabled to TRUE, so the platform is autocorrecting SSIDs and
        // model ids on every screen that says nothing.
        assertFalse(FieldOptions.keepsVerbatim(KeyboardOptions.Default))
    }

    @Test
    fun keepsVerbatimRejectsCapitalizationOnlyOptions() {
        // The old shape of the two pre-existing call sites: it set the knob that was
        // already correct (unspecified already resolves to None) and left the harmful one
        // untouched — which is exactly why grepping for KeyboardCapitalization read as
        // "this feature is present".
        assertFalse(
            FieldOptions.keepsVerbatim(
                KeyboardOptions(capitalization = KeyboardCapitalization.None),
            ),
        )
    }

    @Test
    fun keepsVerbatimRejectsExplicitAutocorrect() {
        assertFalse(
            FieldOptions.keepsVerbatim(
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = true,
                ),
            ),
        )
    }

    @Test
    fun keepsVerbatimRejectsSentenceCase() {
        // Autocorrect off but still capitalizing: "tiny" becomes "Tiny", and a handle is
        // case-preserving.
        assertFalse(
            FieldOptions.keepsVerbatim(
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.Sentences,
                    autoCorrectEnabled = false,
                ),
            ),
        )
    }

    @Test
    fun keepsVerbatimRejectsProse() {
        assertFalse(FieldOptions.keepsVerbatim(FieldOptions.prose))
    }

    // ── keepsSecret ──

    @Test
    fun keepsSecretAcceptsOnlySecret() {
        assertTrue(FieldOptions.keepsSecret(FieldOptions.secret))
        assertTrue(FieldOptions.keepsSecret(FieldOptions.secret(ImeAction.Go)))
    }

    @Test
    fun keepsSecretRejectsAnIdentifier() {
        // Verbatim is not secret: an SSID field is fine for an SSID and wrong for the
        // password under it.
        assertFalse(FieldOptions.keepsSecret(FieldOptions.identifier))
    }

    @Test
    fun keepsSecretRejectsPasswordWithAutocorrectLeftOn() {
        // ⚠️ The half-fix. This is what "I set KeyboardType.Password" looks like on its
        // own: masked, correct inputType, and STILL carrying
        // TYPE_TEXT_FLAG_AUTO_CORRECT because 129 has the TYPE_CLASS_TEXT bit.
        assertFalse(
            FieldOptions.keepsSecret(KeyboardOptions(keyboardType = KeyboardType.Password)),
        )
    }

    @Test
    fun keepsSecretRejectsTheUnsetDefault() {
        assertFalse(FieldOptions.keepsSecret(KeyboardOptions.Default))
    }

    @Test
    fun keepsSecretRejectsNumberPassword() {
        // A PIN keyboard is not a text password: it is a different inputType (18) and the
        // predicate must not accept it just because the word "Password" is in the name.
        assertFalse(
            FieldOptions.keepsSecret(
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.NumberPassword,
                ),
            ),
        )
    }
}
