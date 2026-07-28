package technology.tiny.app.ui

import android.util.Base64
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage

/**
 * Sent-attachment previews on a USER chat turn (iOS ChatMessage thumbs/docs bubble
 * row): a wrapping row of small image thumbnails plus document-name chips, so an
 * attached image/PDF stays visible in the transcript after send instead of the bubble
 * collapsing to text alone. Thumbs are tiny 96px JPEG base64 strings (Attachments.thumbnail);
 * doc names are the sanitized display names — no full payloads live here.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SentAttachments(thumbs: List<String>, docNames: List<String>, topPad: Boolean) {
    Column(Modifier.padding(top = if (topPad) 8.dp else 0.dp)) {
        if (thumbs.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                thumbs.forEach { b64 ->
                    // Decode once per thumb; a corrupt string yields an empty ByteArray and
                    // Coil just draws nothing rather than crashing the bubble.
                    val bytes = remember(b64) { runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() }
                    AsyncImage(
                        model = bytes,
                        contentDescription = "attached image",
                        // Accent-tinted border to match iOS AttachmentThumb (e76d61a) + web —
                        // the sent-bubble thumb tracks the tiny accent, not a neutral edge.
                        modifier = Modifier.size(72.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.3f), RoundedCornerShape(8.dp)),
                        contentScale = ContentScale.Crop,
                    )
                }
            }
        }
        docNames.forEach { name ->
            // Accent-tinted doc chip (fill @0.12 + accent text), matching iOS DocChip
            // (e76d61a) + web — was a near-invisible onPrimary@0.15 wash.
            val accent = MaterialTheme.colorScheme.primary
            Surface(
                color = accent.copy(alpha = 0.12f),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.padding(top = 4.dp),
            ) {
                Text(
                    // 📄 document glyph — the sent-turn twin of the pending-strip
                    // chip faebc18 fixed. Web renders 📄 on the sent-message doc
                    // (Chat.tsx:3243) and iOS reuses the same DocChip (SF Symbol
                    // "doc.fill") for the sent turn (Views.swift:3427). 📎 is the
                    // attach ACTION, not a picked document.
                    "📄 $name",
                    style = MaterialTheme.typography.labelMedium,
                    color = accent,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
    }
}
