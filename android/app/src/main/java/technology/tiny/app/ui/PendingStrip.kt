package technology.tiny.app.ui

import android.util.Base64
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.clickable
import coil.compose.AsyncImage
import technology.tiny.app.chat.PendingDoc

/** Shared pending-preview tile size — web `h-14 w-14` (56px) + iOS
 *  AttachmentThumb `size: 56`. Both image thumbs and doc chips use it so the
 *  strip is one consistent row height across all three clients. */
private val THUMB_DP = 56.dp

/**
 * The pre-send composer preview strip (iOS Views.swift pending strip parity): a wrapping
 * row of the picked image thumbnails and document-name chips, each with its OWN ✕ remove
 * badge — so the user can see exactly what's attached and drop a single wrong pick before
 * sending, instead of the old bare "N images attached" text with only a bulk clear.
 *
 * `images` are the full-res base64 JPEGs staged in ChatViewModel.pendingImages (decoded
 * once each for the 72dp preview); `docs` are the PendingDoc picks. Remove callbacks take
 * the item index so the caller mutates the backing mutableStateList in place.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PendingStrip(
    images: List<String>,
    docs: List<PendingDoc>,
    onRemoveImage: (Int) -> Unit,
    onRemoveDoc: (Int) -> Unit,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        images.forEachIndexed { i, b64 ->
            // 56dp thumb — the shared pending-preview size: web `h-14 w-14`
            // (56px, Chat.tsx:2547) and iOS AttachmentThumb (size: 56,
            // Attachments.swift:202). Android sat at 72dp, so its preview strip
            // ran visibly chunkier than both references on the same surface.
            Box(Modifier.size(THUMB_DP)) {
                // Decode once per pick; a corrupt string draws nothing rather than crashing.
                val bytes = remember(b64) { runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() }
                AsyncImage(
                    model = bytes,
                    contentDescription = "attached image ${i + 1}",
                    // Accent-tinted border, matching web (rgba(var(--tiny-accent-rgb),0.3))
                    // and iOS AttachmentThumb (e76d61a) — the whole composer is accent-themed,
                    // so a thumbnail edge shouldn't read neutral on a non-green tiny.
                    modifier = Modifier.size(THUMB_DP)
                        .clip(RoundedCornerShape(10.dp))
                        .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.3f), RoundedCornerShape(10.dp)),
                    contentScale = ContentScale.Crop,
                )
                RemoveBadge(Modifier.align(Alignment.TopEnd), label = "remove image ${i + 1}") { onRemoveImage(i) }
            }
        }
        docs.forEachIndexed { i, doc ->
            Box(contentAlignment = Alignment.TopEnd) {
                // Accent-tinted doc chip (fill @0.12 + accent text), matching iOS DocChip
                // (e76d61a) and web's rgba(var(--tiny-accent-rgb),…) attachment tint —
                // was a neutral surfaceVariant that read grey on every tiny.
                val accent = MaterialTheme.colorScheme.primary
                Surface(
                    color = accent.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    // Match the 56dp thumb height so images + doc chips share one
                    // row height (web h-14 on both, Chat.tsx:2547/2551; max-w-[8rem]
                    // = 128px). Was 72dp min / 160dp max — taller + wider than both
                    // references.
                    modifier = Modifier.heightIn(min = THUMB_DP).widthIn(max = 128.dp).padding(end = 6.dp, top = 6.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // 📄 document glyph — matches web's doc chip (Chat.tsx
                        // "📄") and iOS DocChip (SF Symbol "doc.fill"). Android
                        // used 📎 (paperclip = attach action), a different symbol
                        // than the document both references show.
                        Text("📄", style = MaterialTheme.typography.labelLarge)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            doc.name,
                            style = MaterialTheme.typography.labelSmall,
                            color = accent,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                RemoveBadge(Modifier.align(Alignment.TopEnd), label = "remove ${doc.name}") { onRemoveDoc(i) }
            }
        }
    }
}

/**
 * The small top-trailing ✕ that drops one pick (iOS xmark.circle.fill). `label` names the
 * specific attachment (web `Remove ${att.name}` parity) so TalkBack announces which pick the
 * button removes, not a generic "remove attachment" repeated down the strip.
 */
@Composable
private fun RemoveBadge(modifier: Modifier = Modifier, label: String = "remove attachment", onClick: () -> Unit) {
    // The clickable lives on a 32dp transparent box, not the 20dp circle — a bare
    // 20dp target in a thumbnail corner is cramped (iOS cycle-34/35 hit-area parity).
    // The visible circle stays 20dp, centered, so the badge doesn't grow over the preview.
    Box(
        modifier = modifier.size(32.dp).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.size(20.dp),
            shape = CircleShape,
            color = Color.Black.copy(alpha = 0.6f),
        ) {
            Icon(
                Icons.Filled.Close,
                contentDescription = label,
                tint = Color.White,
                modifier = Modifier.padding(3.dp),
            )
        }
    }
}
