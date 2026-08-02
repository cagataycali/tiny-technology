package technology.tiny.app.ui

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * ⬇⤢ Chat media controls — download + full-screen, iOS MediaCards.swift parity.
 *
 * iOS gets these from ShareLink ("Save Image") and .fullScreenCover; Android has
 * no equivalent freebie, so: DownloadManager drops the file straight into
 * Downloads (no runtime permission needed at minSdk 29 for the public Downloads
 * dir), and a full-screen Dialog shows the media large with pinch-zoom.
 */

/** Queue `url` into the system Downloads dir; the notification shows progress. */
fun downloadMedia(context: Context, url: String) {
    val name = url.substringAfterLast('/').substringBefore('?').ifBlank { "tiny-media" }
    runCatching {
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setDescription("tiny")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.enqueue(req)
        Toast.makeText(context, "Saving $name…", Toast.LENGTH_SHORT).show()
    }.onFailure {
        Toast.makeText(context, "Download failed", Toast.LENGTH_SHORT).show()
    }
}

/** Floating ⬇ / ⤢ pills for a media card corner. */
@Composable
fun MediaActionButtons(url: String, onFullScreen: () -> Unit) {
    val context = LocalContext.current
    Row(
        Modifier.padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ActionPill(Icons.Filled.Download, "Download") { downloadMedia(context, url) }
        ActionPill(Icons.Filled.Fullscreen, "View full screen", onFullScreen)
    }
}

@Composable
private fun ActionPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Surface(
        color = Color.Black.copy(alpha = 0.45f),
        shape = CircleShape,
        modifier = Modifier.size(30.dp).clickable(onClick = onClick),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(17.dp))
        }
    }
}

/**
 * Full-screen media viewer. `kind` is mediaLineMatch's vocabulary
 * ("image" covers GIFs — coil-gif animates them — plus "video"/"audio").
 */
@Composable
fun MediaViewerDialog(url: String, kind: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when (kind) {
                "video" -> androidx.compose.ui.viewinterop.AndroidView(
                    factory = { ctx ->
                        android.widget.VideoView(ctx).apply {
                            setVideoURI(Uri.parse(url))
                            setMediaController(
                                android.widget.MediaController(ctx).also { it.setAnchorView(this) },
                            )
                            setOnPreparedListener { it.start() }
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
                "audio" -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AudioClipCard(url)
                }
                else -> ZoomableImage(url)
            }
            Row(
                Modifier.align(Alignment.TopEnd).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ActionPill(Icons.Filled.Download, "Download") { downloadMedia(context, url) }
                ActionPill(Icons.Filled.Close, "Close", onDismiss)
            }
        }
    }
}

/** Pinch-to-zoom (1–5×) with pan, matching the iOS viewer's MagnificationGesture. */
@Composable
private fun ZoomableImage(url: String) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        coil.compose.AsyncImage(
            model = url,
            contentDescription = "media",
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 5f)
                        if (scale > 1f) {
                            offsetX += pan.x
                            offsetY += pan.y
                        } else {
                            offsetX = 0f; offsetY = 0f
                        }
                    }
                }
                .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offsetX, translationY = offsetY),
        )
    }
}
