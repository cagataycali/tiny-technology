package technology.tiny.app.ui

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.ui.unit.dp
import technology.tiny.app.ui.theme.TinyGray

/**
 * 🎙️ The words a take has heard so far — the live half of a recording.
 *
 * Both Record buttons on this phone (the Voice device panel in [Panels.kt], the
 * Transcripts sheet) showed a ten-bar level meter and no text, because the
 * recognizer's partials lived in a local variable inside `PhoneRecorder.listen`
 * and died there. **A meter proves the mic hears SOMETHING; only words prove it
 * hears YOU** — which is the thing a person actually wants to know before
 * trusting a screen with two minutes of speech. iOS carried the identical gap and
 * its own comment admitted it ("partial recognition text is not shown anywhere
 * else in this view"); it was fixed at `e99e3c53`, which this ports.
 *
 * It lives in its own file, as one composable over one pure rule, because the
 * alternative is the failure mode this tree keeps paying for: a surface pasted
 * into N screens, where the N+1th forgets it and nothing goes red. There are two
 * Record buttons today and they render the same bars twice already.
 */
internal object LiveTake {

    /**
     * Whether there is anything worth drawing.
     *
     * Blank, not just empty: `PhoneRecorder.partial` is built by `snapshot()`,
     * which joins the finals and the live partial — a recognizer that has only
     * produced whitespace would otherwise open an empty bordered box that reads
     * as a rendering bug rather than as silence.
     */
    fun hasWords(heard: String): Boolean = heard.isNotBlank()

    /**
     * The line under the meter, which is the ONLY place the app can distinguish
     * two states that look identical: silence because the take just started, and
     * silence because the microphone is not hearing this person at all.
     *
     * So the caption changes the moment the first word lands. Without this, a take
     * that never hears anything and a take mid-sentence both say "Recording…".
     */
    fun caption(heard: String): String =
        if (hasWords(heard)) "Transcribing on-device — tap Stop when you're done."
        else "Recording — tap Stop when you're done."
}

/**
 * The live words plus their caption. Renders the caption ALWAYS and the words only
 * once there are some — a take with no words yet still has something to say.
 *
 * Height-capped and tailing: a 120-second memo is ~1,700 characters, which would
 * push the Stop button off a bottom sheet, and the newest words are the ones that
 * answer "is it hearing me RIGHT NOW" — so the scroll follows the bottom as text
 * arrives.
 */
@Composable
internal fun LiveTakeWords(heard: String) {
    val scroll = rememberScrollState()
    // Follow the tail. `heard` is republished on the recorder's 200ms tick, so this
    // runs at most five times a second no matter how fast the recognizer revises.
    LaunchedEffect(heard) { scroll.animateScrollTo(scroll.maxValue) }
    Column(Modifier.fillMaxWidth()) {
        if (LiveTake.hasWords(heard)) {
            Spacer(Modifier.height(6.dp))
            Text(
                heard,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.fillMaxWidth().heightIn(max = 140.dp).verticalScroll(scroll),
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(
            LiveTake.caption(heard),
            style = MaterialTheme.typography.labelSmall,
            color = TinyGray,
        )
    }
}
