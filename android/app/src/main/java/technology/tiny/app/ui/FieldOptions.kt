package technology.tiny.app.ui

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType

/**
 * What the KEYBOARD is told about a field, as opposed to what the field draws.
 *
 * iOS says this on ~30 text fields across 6 files: `.textInputAutocapitalization(.never)`
 * `.autocorrectionDisabled()` for anything machine-shaped, and `SecureField` for anything
 * secret. Android said it at **two** call sites, and both set only `capitalization`.
 *
 * ⚠️ THE DEFAULT IS THE DEFECT, and it is not the one the names suggest. Measured out of
 * the shipped Compose 1.9.0 classes rather than assumed:
 *
 *  - `KeyboardOptions.autoCorrectEnabled` is a **nullable** Boolean, and
 *    `getAutoCorrectOrDefault()` returns **true** when it is unset (`iconst_1`). So every
 *    field that says nothing is asking the keyboard to autocorrect it.
 *  - `getCapitalizationOrDefault()` resolves an unspecified value to **None**. That is why
 *    the two existing call sites were setting the knob that was already right, and it is why
 *    a grep for `KeyboardCapitalization` finds this feature "present" — the harmful default
 *    is the OTHER one.
 *  - `TextInputServiceAndroid_androidKt` builds `EditorInfo.inputType` from
 *    **`KeyboardType`**, never from `visualTransformation`. A field with
 *    `PasswordVisualTransformation` and no `KeyboardType.Password` is
 *    `TYPE_TEXT_VARIATION_NORMAL` to the IME: masked on the screen, an ordinary word to the
 *    keyboard, which may keep it in a personalised dictionary and offer it later in another
 *    app. **Masking is a drawing decision; secrecy is an inputType.**
 *  - And the autocorrect flag is OR'd **after** the KeyboardType switch, gated only on
 *    `hasFlag(inputType, TYPE_CLASS_TEXT)` — the same gate the capitalization flags sit
 *    behind. `KeyboardType.Password` is inputType **129**
 *    (`TYPE_CLASS_TEXT or TYPE_TEXT_VARIATION_PASSWORD`), so it passes that gate and
 *    **still** takes `TYPE_TEXT_FLAG_AUTO_CORRECT`. Both knobs are required; neither
 *    implies the other. This is the trap that makes a half-fix look complete.
 *    (`KeyboardType.Number` is inputType 2, no text class — a numeric field is exempt
 *    from both flags, which is why the two `KeyboardType.Number`/`Decimal` call sites in
 *    this app are already correct and deliberately left alone.)
 *
 * So these are the three shapes a field here can have, named once, because the bug was
 * never that a knob was set wrong — it was that 22 of 24 fields said nothing at all.
 */
object FieldOptions {

    /**
     * A machine-shaped value the user is transcribing: an SSID, a model id, a region, a
     * URL, an address. Autocorrect off because the keyboard rewriting one character makes
     * the value silently wrong — and unlike a sentence, nobody proofreads a hex string.
     */
    val identifier = KeyboardOptions(
        capitalization = KeyboardCapitalization.None,
        autoCorrectEnabled = false,
    )

    /** `identifier`, plus a keyboard whose action closes the row it sits in. */
    fun identifier(imeAction: ImeAction) = KeyboardOptions(
        capitalization = KeyboardCapitalization.None,
        autoCorrectEnabled = false,
        imeAction = imeAction,
    )

    /**
     * A secret: an API key, a WiFi password, an access key. `KeyboardType.Password` is the
     * part that reaches the IME (inputType 129 =
     * TYPE_CLASS_TEXT | TYPE_TEXT_VARIATION_PASSWORD), which is what keeps it out of the
     * keyboard's learned words. ⚠️ It does NOT suppress autocorrect on its own — see the
     * class docs — so `autoCorrectEnabled = false` is not redundant here.
     */
    val secret = KeyboardOptions(
        capitalization = KeyboardCapitalization.None,
        autoCorrectEnabled = false,
        keyboardType = KeyboardType.Password,
    )

    /** `secret`, plus a keyboard whose action submits. */
    fun secret(imeAction: ImeAction) = KeyboardOptions(
        capitalization = KeyboardCapitalization.None,
        autoCorrectEnabled = false,
        keyboardType = KeyboardType.Password,
        imeAction = imeAction,
    )

    /**
     * Prose the user is composing — a message, a job's instruction, a conversation name.
     * Sentence capitalisation and autocorrect are HELP here, so this is the one shape that
     * deliberately leaves the platform default alone; it exists so that a field carrying no
     * options can be read as an oversight rather than as a decision.
     *
     * ⚠️ Not `KeyboardOptions.Default`: that is the same object every unset field gets, so
     * naming it would make "chose prose" and "said nothing" indistinguishable. The
     * capitalisation is stated.
     */
    val prose = KeyboardOptions(
        capitalization = KeyboardCapitalization.Sentences,
    )

    /** `prose`, plus a keyboard whose action commits the line. */
    fun prose(imeAction: ImeAction) = KeyboardOptions(
        capitalization = KeyboardCapitalization.Sentences,
        imeAction = imeAction,
    )

    /**
     * Is this option set safe for a value that must survive verbatim?
     *
     * Pure, so the polarity is EXECUTED on the JVM rather than pinned as source text: the
     * whole defect was a default nobody had read, and a grep cannot tell
     * `autoCorrectEnabled = false` from `autoCorrectEnabled = true`, nor either from a
     * field that never mentions it. ⚠️ `autoCorrectEnabled` is nullable and **null means
     * true**, so this asks `== false` and not `!= true`.
     */
    fun keepsVerbatim(o: KeyboardOptions): Boolean =
        o.autoCorrectEnabled == false && o.capitalization != KeyboardCapitalization.Sentences

    /**
     * Does this option set keep a secret out of the keyboard's memory?
     *
     * Both halves are required and for different reasons: the password inputType is what
     * the IME reads to skip its learned-words dictionary, and the autocorrect flag is OR'd
     * in afterwards regardless of that inputType.
     */
    fun keepsSecret(o: KeyboardOptions): Boolean =
        keepsVerbatim(o) && o.keyboardType == KeyboardType.Password
}
