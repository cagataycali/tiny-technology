package technology.tiny.app.ui

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import technology.tiny.app.BuildConfig
import technology.tiny.app.TinyApp
import java.io.File

/**
 * DmMediaUi — the Compose half of DM media: what an attachment looks like in a
 * thread, and the three controls that make one.
 *
 * Split from DmMedia.kt so the rules and the codecs stay loadable from a JVM unit
 * test (`DmMediaKt`) with no Compose or Android graphics on the classpath. The
 * refusal STRINGS live over there too — this file never composes an error message,
 * it only shows the one it was handed, because a sentence that names the file, the
 * number and the fix is the whole point and rewording it here would be the third
 * copy to keep in sync.
 *
 * Layout parity with iOS (`DmMediaBubble`, `DmStagedStrip`, `DmAttachControls`,
 * `DmRecordingBar`) and with the web composer.
 */

// ── reading: what an attachment looks like in a bubble ───────────────────────

/**
 * The attachments on one DM, above its text.
 *
 * Above, not below, because the picture IS the message when there is no caption —
 * and a caption reads as a caption only when it follows what it captions.
 */
@Composable
internal fun DmAttachmentColumn(attachments: List<DmAttachment>) {
    if (attachments.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // No `mine` flag: the bubble already sets the content colour it wants, and
        // everything below reads `LocalContentColor` — so a sent bubble's caption
        // and a received one's stay legible without either side knowing which is
        // which.
        attachments.forEach { a -> DmAttachmentView(a) }
    }
}

@Composable
private fun DmAttachmentView(a: DmAttachment) {
    val context = LocalContext.current
    var viewing by remember(a.id) { mutableStateOf(false) }
    when (a.kind) {
        "image" -> {
            // The box is reserved from the stored pixel size, so the thread does
            // not jump under the reader's thumb as photos decode.
            val box = Modifier
                .widthIn(max = 220.dp)
                .height(dmPreviewHeight(a.width, a.height).dp)
                .clip(RoundedCornerShape(12.dp))
                .clickable { viewing = true }
            // 🎞️ A GIF needs ImageDecoderDecoder or coil shows frame one and the
            // joke doesn't land — the same loader the landing logos use.
            val loader = remember(context, a.contentType) {
                if (a.contentType == "image/gif") {
                    coil.ImageLoader.Builder(context)
                        .components { add(coil.decode.ImageDecoderDecoder.Factory()) }
                        .build()
                } else {
                    null
                }
            }
            if (loader != null) {
                coil.compose.AsyncImage(
                    model = a.url,
                    imageLoader = loader,
                    contentDescription = "attached gif",
                    contentScale = ContentScale.Crop,
                    modifier = box,
                )
            } else {
                coil.compose.AsyncImage(
                    model = a.url,
                    contentDescription = "attached photo",
                    contentScale = ContentScale.Crop,
                    modifier = box,
                )
            }
        }
        "video" -> Box(
            Modifier
                .widthIn(max = 220.dp)
                .height(dmPreviewHeight(a.width, a.height).dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color.Black)
                .clickable { viewing = true },
            contentAlignment = Alignment.Center,
        ) {
            // The poster frame is not on the wire (it would double the payload for
            // a frame the player fetches anyway), so the bubble shows the play
            // affordance and the length — enough to decide whether to open it.
            Icon(Icons.Filled.PlayArrow, contentDescription = "play clip", tint = Color.White)
            dmDuration(a.durationMs).takeIf { it.isNotEmpty() }?.let { len ->
                Surface(
                    color = Color.Black.copy(alpha = 0.55f),
                    shape = RoundedCornerShape(6.dp),
                    modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp),
                ) {
                    Text(
                        len,
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
        }
        "audio" -> DmVoiceNoteView(a)
        // Not dropped: a type this build doesn't render is still something the
        // sender attached, and a bubble that shows nothing says the message was
        // empty. A tappable link is honest and still works.
        else -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.clickable { downloadMedia(context, a.url) },
        ) {
            Icon(Icons.Outlined.Description, contentDescription = null, Modifier.size(16.dp))
            Text("Attachment", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (viewing) {
        MediaViewerDialog(url = a.url, kind = a.kind) { viewing = false }
    }
}

/**
 * 🎤 A voice note: the player, its length, and what the phone heard.
 *
 * The transcript is shown INLINE rather than behind a tap. It is the only part a
 * reader can take in silently, in a meeting, on a train — and it is what the agent
 * reads too (`read_messages`), so showing it keeps both readers looking at the
 * same thing. Italic and slightly dimmed because it is a machine's guess at
 * someone's words, not their words.
 */
@Composable
private fun DmVoiceNoteView(a: DmAttachment) {
    val ink = androidx.compose.material3.LocalContentColor.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.widthIn(max = 240.dp)) {
        AudioClipCard(a.url)
        val length = dmDuration(a.durationMs)
        if (length.isNotEmpty()) {
            Text(
                "Voice note · $length",
                style = MaterialTheme.typography.labelSmall,
                color = ink.copy(alpha = 0.6f),
            )
        }
        a.transcript?.takeIf { it.isNotEmpty() }?.let { heard ->
            Text(
                heard,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = ink.copy(alpha = 0.85f),
            )
        }
    }
}

// ── writing: staging, uploading, retrying ────────────────────────────────────

/** The composer's media buttons, bundled so the recording bar's Stop and the
 *  strip's Retry drive the same code the mic button does. */
internal class DmMediaActions(
    val pickMedia: () -> Unit,
    val takePhoto: () -> Unit,
    val toggleMic: () -> Unit,
    val stopRecording: () -> Unit,
    val discardRecording: () -> Unit,
    val retry: (Long) -> Unit,
    val cameraAvailable: Boolean,
)

/**
 * Wires the pickers, the camera, the mic permission and the recording ticker to
 * [composer]. One call site (`DmThreadView`), because every launcher has to be
 * registered during composition.
 */
@Composable
internal fun rememberDmMedia(app: TinyApp, composer: DmComposerState): DmMediaActions {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // The id is minted when the mic OPENS and carried to the finished note, so a
    // note keeps the position it was started in even if a photo is staged while
    // it records.
    var noteId by remember(composer) { mutableStateOf<Long?>(null) }
    var cameraUri by remember(composer) { mutableStateOf<Uri?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(DM_MAX_ATTACHMENTS),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        // The WHOLE pick is refused when it doesn't fit, rather than keeping the
        // first few: a photo that vanishes silently from a composer is one the
        // sender believes they sent.
        composer.roomRefusal(uris.size)?.let { composer.error = it; return@rememberLauncherForActivityResult }
        composer.error = null
        scope.launch { uris.forEach { dmStagePick(app, context, composer, it) } }
    }

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val uri = cameraUri
        cameraUri = null
        if (!taken || uri == null) return@rememberLauncherForActivityResult
        scope.launch { dmStagePick(app, context, composer, uri) }
    }

    fun beginRecording() {
        noteId = composer.startRecording(context)
    }

    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            beginRecording()
        } else {
            // Names the switch and where it lives — "permission denied" tells
            // someone nothing they can act on.
            composer.error = "Voice notes need the microphone — enable it in Settings › Apps › Tiny."
        }
    }

    fun finishRecording(discard: Boolean) {
        val id = noteId
        val pcm = composer.stopRecording(discard)
        noteId = null
        if (discard || pcm == null || id == null) {
            runCatching { pcm?.delete() }
            return
        }
        scope.launch {
            // Staged UPLOADING immediately: transcription can take a few seconds,
            // and a mic that goes quiet with nothing on screen looks like a
            // recording that was thrown away.
            val placeholder = StagedDmMedia(
                id = id, kind = "audio", contentType = "audio/wav", bytes = ByteArray(0),
                name = "voice-note.wav", durationMs = dmPcmMs(pcm.length()).toInt(),
            )
            composer.add(placeholder)
            when (val prepared = dmPrepareVoiceNote(context, pcm, id)) {
                is DmMediaResult.Refused -> {
                    composer.remove(id)
                    composer.error = prepared.message
                }
                is DmMediaResult.Ok -> {
                    composer.patch(id) { prepared.media }
                    dmUploadStaged(app, composer, prepared.media)
                }
            }
            runCatching { pcm.delete() }
        }
    }

    // 🎤 The ticker: the counter the user watches, AND where the 60s cap lands.
    // It reads the recorder's own byte clock (`tick`), so a mic that took 300ms to
    // open does not lose 300ms off the end of the take.
    LaunchedEffect(composer.recording) {
        while (composer.recording) {
            composer.tick()
            if (composer.recordMs >= DM_VOICE_MAX_MS) {
                // Stopped, not refused: the audio up to the cap is a perfectly
                // good voice note, and the bar said "max 60s" the whole time.
                finishRecording(discard = false)
                break
            }
            delay(150)
        }
    }

    val cameraAvailable = remember(context) {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    return remember(composer, app, cameraAvailable) {
        DmMediaActions(
            pickMedia = {
                composer.error = null
                picker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            },
            takePhoto = {
                composer.error = null
                val noRoom = composer.roomRefusal(1)
                val uri = if (noRoom == null) dmCameraTarget(context) else null
                when {
                    noRoom != null -> composer.error = noRoom
                    uri == null -> composer.error = "Couldn't open the camera — nothing was sent."
                    else -> {
                        cameraUri = uri
                        camera.launch(uri)
                    }
                }
            },
            toggleMic = {
                if (composer.recording) {
                    finishRecording(discard = false)
                } else if (
                    androidx.core.content.ContextCompat.checkSelfPermission(
                        context, android.Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                ) {
                    beginRecording()
                } else {
                    micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                }
            },
            stopRecording = { finishRecording(discard = false) },
            discardRecording = { finishRecording(discard = true) },
            retry = { id ->
                composer.staged.firstOrNull { it.id == id }?.let { m ->
                    composer.patch(id) { it.copy(state = DmUploadState.UPLOADING, error = null) }
                    // Re-posts the bytes it still holds — the user does not have to
                    // find the file again.
                    scope.launch { dmUploadStaged(app, composer, m) }
                }
            },
            cameraAvailable = cameraAvailable,
        )
    }
}

/** A cache file the camera can write to through the existing FileProvider. */
private fun dmCameraTarget(context: Context): Uri? = runCatching {
    val dir = File(context.cacheDir, "camera").apply { mkdirs() }
    val file = File.createTempFile("dm", ".jpg", dir)
    FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.files", file)
}.getOrNull()

/** The picker's own name for a file, for refusals that name what was refused. */
private fun dmDisplayName(context: Context, uri: Uri): String = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
}.getOrNull() ?: uri.lastPathSegment ?: "that file"

/** Prepare one picked uri and start its upload. */
private suspend fun dmStagePick(
    app: TinyApp,
    context: Context,
    composer: DmComposerState,
    uri: Uri,
) {
    val id = composer.nextId()
    val type = runCatching { context.contentResolver.getType(uri) }.getOrNull()?.lowercase() ?: ""
    val prepared = when {
        type.startsWith("video/") -> dmPrepareClip(context, uri, id)
        // Everything else goes down the image path, which re-encodes to JPEG —
        // that is also the HEIC/AVIF converter, and a non-image simply fails to
        // decode and is refused by name.
        else -> dmPrepareImage(context, uri, id, dmDisplayName(context, uri))
    }
    when (prepared) {
        is DmMediaResult.Refused -> composer.error = prepared.message
        is DmMediaResult.Ok -> {
            composer.add(prepared.media)
            dmUploadStaged(app, composer, prepared.media)
        }
    }
}

/**
 * Upload one staged item and record the outcome on its chip.
 *
 * A failure is left VISIBLE and retryable rather than swallowed or auto-retried:
 * the send gate refuses while any chip is failed, so the alternative to showing
 * this is a DM that leaves without the photo the sender watched attach.
 */
private suspend fun dmUploadStaged(app: TinyApp, composer: DmComposerState, m: StagedDmMedia) {
    runCatching { dmUploadMedia(app, m) }
        .onSuccess { att ->
            composer.patch(m.id) {
                it.copy(state = DmUploadState.READY, attachment = att, error = null)
            }
        }
        .onFailure { e ->
            composer.patch(m.id) {
                it.copy(state = DmUploadState.FAILED, error = e.message ?: "upload failed")
            }
        }
}

// ── writing: the composer's own surfaces ─────────────────────────────────────

/** Staged attachments, with their upload state on their faces. */
@Composable
internal fun DmStagedStrip(composer: DmComposerState, onRetry: (Long) -> Unit) {
    if (composer.staged.isEmpty()) return
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        items(composer.staged, key = { it.id }) { m ->
            Box(Modifier.size(64.dp)) {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.size(64.dp),
                ) {
                    val thumb = m.thumb
                    if (thumb != null) {
                        Image(
                            bitmap = thumb.asImageBitmap(),
                            contentDescription = m.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.size(64.dp),
                        )
                    } else {
                        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
                            Icon(
                                when (m.kind) {
                                    "audio" -> Icons.Outlined.GraphicEq
                                    "video" -> Icons.Filled.PlayArrow
                                    else -> Icons.Outlined.Image
                                },
                                contentDescription = m.kind,
                            )
                        }
                    }
                }
                when (m.state) {
                    DmUploadState.UPLOADING -> Box(
                        Modifier.size(64.dp).background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                    }
                    DmUploadState.FAILED -> Box(
                        Modifier
                            .size(64.dp)
                            .background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(10.dp))
                            .clickable { onRetry(m.id) }
                            // The failure reason rides the a11y label — the chip is
                            // 64dp and has no room for a sentence, but a screen
                            // reader (and a QA screenshot) can still get at it.
                            .semantics { contentDescription = m.error ?: "upload failed — tap to retry" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Outlined.Refresh, contentDescription = null, tint = Color.White)
                    }
                    DmUploadState.READY -> {
                        val length = dmDuration(m.durationMs)
                        if (m.kind != "image" && length.isNotEmpty()) {
                            Surface(
                                color = Color.Black.copy(alpha = 0.55f),
                                shape = RoundedCornerShape(6.dp),
                                modifier = Modifier.align(Alignment.BottomStart).padding(3.dp),
                            ) {
                                Text(
                                    length,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Color.White,
                                    modifier = Modifier.padding(horizontal = 4.dp),
                                )
                            }
                        }
                    }
                }
                IconButton(
                    onClick = { composer.remove(m.id) },
                    modifier = Modifier.align(Alignment.TopEnd).size(22.dp),
                ) {
                    Surface(shape = RoundedCornerShape(11.dp), color = Color.Black.copy(alpha = 0.6f)) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "remove ${m.name}",
                            tint = Color.White,
                            modifier = Modifier.padding(3.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Library / camera / mic. Disabled — not hidden — when the message is full, so
 *  the cap is discoverable before it is hit. */
@Composable
internal fun DmAttachControls(composer: DmComposerState, media: DmMediaActions) {
    val full = composer.isFull
    Row(horizontalArrangement = Arrangement.spacedBy(0.dp), verticalAlignment = Alignment.Bottom) {
        IconButton(onClick = media.pickMedia, enabled = !full && !composer.recording) {
            Icon(Icons.Outlined.PhotoLibrary, contentDescription = "attach photo or clip")
        }
        if (media.cameraAvailable) {
            IconButton(onClick = media.takePhoto, enabled = !full && !composer.recording) {
                Icon(Icons.Outlined.CameraAlt, contentDescription = "take a photo")
            }
        }
        IconButton(onClick = media.toggleMic, enabled = !full || composer.recording) {
            Icon(
                Icons.Outlined.Mic,
                contentDescription = if (composer.recording) "stop recording" else "record a voice note",
                tint = if (composer.recording) MaterialTheme.colorScheme.error
                else androidx.compose.material3.LocalContentColor.current,
            )
        }
    }
}

/** 🎤 While the mic is open: the elapsed count, the ceiling, and both exits.
 *  Discard is beside Stop deliberately — a recording nobody wants must not need a
 *  second screen to get rid of. */
@Composable
internal fun DmRecordingBar(composer: DmComposerState, onDiscard: () -> Unit, onStop: () -> Unit) {
    if (!composer.recording) return
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp).heightIn(min = 36.dp),
        ) {
            Icon(Icons.Outlined.Mic, contentDescription = null, Modifier.size(16.dp))
            Text(
                "Recording ${dmDuration(composer.recordMs.toInt())}",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "max ${DM_VOICE_MAX_MS / 1000}s",
                style = MaterialTheme.typography.labelSmall,
                color = androidx.compose.material3.LocalContentColor.current.copy(alpha = 0.6f),
            )
            Box(Modifier.width(4.dp))
            TextButton(onClick = onDiscard) { Text("Discard") }
            TextButton(onClick = onStop) { Text("Stop") }
        }
    }
}
