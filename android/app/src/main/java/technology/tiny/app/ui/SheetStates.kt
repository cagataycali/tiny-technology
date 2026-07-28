package technology.tiny.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import technology.tiny.app.ui.theme.TinyGray

/**
 * Shared sheet loading row — a small accent spinner beside muted text, replacing
 * the bare gray "loading…" string every sheet grew independently (9 call sites).
 * Web shows accent skeletons, iOS a ProgressView + caption; this is the Android
 * voice: one shape, theme-accented, centered in the sheet's measure.
 */
@Composable
fun SheetLoading(label: String = "loading…") {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 20.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            Modifier.size(16.dp),
            strokeWidth = 2.dp,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = TinyGray)
    }
}

/**
 * Shared sheet header: a native Material glyph beside the accent title. Every
 * panel sheet grew its own "<emoji> <name>" titleLarge string; iOS renders these
 * as plain nav titles with the surface's own SF Symbol chrome, so the emoji was a
 * 2-vs-1 polish gap + the user's native-icon request. One shape, accent-tinted.
 */
@Composable
fun SheetTitle(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        Text(text, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
    }
}

/**
 * Shared whole-sheet empty state: a big muted glyph over the sheet's copy, with
 * an optional what-to-do hint. For SECTION-level empties inside a sheet keep the
 * small inline text — a 36dp glyph per section would shout.
 *
 * The glyph is a native Material icon (was an emoji): iOS draws every empty state
 * with ContentUnavailableView's SF Symbol (bolt/brain/clock/person.slash…), so an
 * emoji here was a 2-vs-1 polish gap AND the user asked for native icons. Tinted
 * TinyGray to read as a muted placeholder, not a lit control.
 */
@Composable
fun SheetEmpty(icon: ImageVector, headline: String, hint: String? = null) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = TinyGray, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(8.dp))
        Text(
            headline,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
        hint?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, style = MaterialTheme.typography.bodySmall, color = TinyGray, textAlign = TextAlign.Center)
        }
    }
}
