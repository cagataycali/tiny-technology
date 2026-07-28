package technology.tiny.app.voice

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.collectAsState
import androidx.core.content.ContextCompat
import technology.tiny.app.TinyApp

/**
 * Full-screen voice-call surface — a breathing orb that pulses with the mic
 * level, the live transcript, an always-record banner, and a hang-up button.
 * iOS VoiceCallView parity.
 *
 * Mic permission MUST be granted before this is shown (the caller gates it).
 * On dismiss the call is torn down.
 */
@Composable
fun VoiceCallScreen(
    tiny: String,
    accent: Color,
    // A BYOK error routes here so the user lands on the app's OWN model
    // settings (the encrypted on-device key store) — opening the web /settings
    // in a browser could never set the native key. Parent tears the call down
    // and opens the settings sheet.
    onOpenSettings: () -> Unit = {},
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val app = context.applicationContext as TinyApp
    val call = remember { VoiceCall() }
    val state by call.state.collectAsState()

    LaunchedEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            call.start(
                base = app.config.serverBase,
                tiny = tiny,
                token = app.auth.token,
                // Voice is OpenAI-only — send the dedicated voice key (or the chat key
                // iff chat is itself on OpenAI), NEVER a Bedrock/Anthropic chat key.
                modelHeaders = app.modelConfig.voiceHeaders(),
            )
        }
    }
    DisposableEffect(Unit) { onDispose { call.dispose() } }

    Dialog(
        onDismissRequest = { call.stop(); onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(20.dp),
                modifier = Modifier.fillMaxWidth().padding(28.dp),
            ) {
                Text(tiny, color = Color.White, fontSize = 22.sp)
                Text(
                    statusLine(state.phase),
                    color = Color.White.copy(alpha = 0.6f),
                    fontSize = 13.sp,
                    // The call phase (connecting → live → ended/error) is the one
                    // meaning-bearing state a blind user can't otherwise perceive:
                    // the tiny's reply arrives as audio, but "connected", "call
                    // ended", and connection failures are visual-only. Announce
                    // phase changes politely with a fuller phrasing than the terse
                    // on-screen label (iOS VoiceOver parity, Wallet.announceOutcome).
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Polite
                        contentDescription = statusAnnouncement(tiny, state.phase)
                    },
                )

                Orb(accent = accent, level = if (state.phase == VoiceCall.Phase.LIVE) state.level else 0f)

                // Live transcript — what you said, what the tiny is saying.
                // Bounded height keeps the orb/controls in a fixed spot, but the
                // content scrolls so a long assistant turn reveals rather than
                // clips; auto-scroll to the bottom as tokens stream in so the
                // newest words stay in view without the user dragging.
                val transcriptScroll = rememberScrollState()
                LaunchedEffect(state.userTranscript, state.assistantTranscript) {
                    transcriptScroll.scrollTo(transcriptScroll.maxValue)
                }
                Column(
                    Modifier.fillMaxWidth().height(120.dp).verticalScroll(transcriptScroll),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (state.userTranscript.isNotEmpty()) {
                        Text(state.userTranscript, color = Color.White.copy(alpha = 0.55f), fontSize = 15.sp)
                    }
                    if (state.assistantTranscript.isNotEmpty()) {
                        Text(state.assistantTranscript, color = Color.White, fontSize = 19.sp)
                    }
                }

                state.error?.let { err ->
                    Text(
                        err,
                        color = Color(0xFFFFA726),
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                    )
                    if (state.phase == VoiceCall.Phase.BYOK_REQUIRED) {
                        // Route to the app's OWN model settings, not the web page —
                        // voice reads the key from the on-device encrypted store, so
                        // a browser tab couldn't set it. Tear down the call first.
                        TextButton(onClick = { call.stop(); onDismiss(); onOpenSettings() }) {
                            Text("Add your OpenAI key", color = accent)
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))

                // Always-record banner — recording is the v1 default (locked).
                androidx.compose.foundation.layout.Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        Icons.Filled.FiberManualRecord,
                        contentDescription = null,
                        tint = Color.White.copy(alpha = 0.4f),
                        modifier = Modifier.size(12.dp),
                    )
                    Text("This call is recorded", color = Color.White.copy(alpha = 0.4f), fontSize = 12.sp)
                }

                // Hang up.
                Box(
                    Modifier
                        .size(66.dp)
                        .background(Color(0xFFE53935), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    androidx.compose.material3.IconButton(onClick = { call.stop(); onDismiss() }) {
                        Icon(Icons.Filled.CallEnd, contentDescription = "End call", tint = Color.White)
                    }
                }
            }
        }
    }
}

@Composable
private fun Orb(accent: Color, level: Float) {
    val scale by animateFloatAsState(targetValue = 1f + level * 0.5f, label = "orb-scale")
    Box(
        Modifier
            .size(150.dp)
            .scale(scale)
            .background(
                Brush.radialGradient(
                    colors = listOf(accent.copy(alpha = 0.9f), accent.copy(alpha = 0.25f)),
                ),
                CircleShape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Filled.GraphicEq,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(38.dp),
        )
    }
}

private fun statusLine(phase: VoiceCall.Phase): String = when (phase) {
    VoiceCall.Phase.IDLE, VoiceCall.Phase.CONNECTING -> "connecting…"
    VoiceCall.Phase.LIVE -> "live"
    VoiceCall.Phase.ENDED -> "call ended"
    VoiceCall.Phase.ERROR -> "couldn't connect"
    VoiceCall.Phase.BYOK_REQUIRED -> "needs your OpenAI key"
}

/**
 * Fuller spoken phrasing of the call phase for the status line's live region
 * (pure, so it's unit-testable). The terse on-screen [statusLine] ("live",
 * "call ended") is fine visually but reads as an ambiguous fragment to
 * TalkBack; this names the tiny and states what happened, so a blind user
 * hears "Call with scout is connected" / "Call ended" without watching the
 * screen. Names the tiny only where it adds meaning (connect); keeps the
 * end/error phrasing terse so a state change is unmistakable.
 */
internal fun statusAnnouncement(tiny: String, phase: VoiceCall.Phase): String = when (phase) {
    VoiceCall.Phase.IDLE, VoiceCall.Phase.CONNECTING -> "Connecting to $tiny…"
    VoiceCall.Phase.LIVE -> "Call with $tiny is connected."
    VoiceCall.Phase.ENDED -> "Call ended."
    VoiceCall.Phase.ERROR -> "Couldn't connect the call."
    VoiceCall.Phase.BYOK_REQUIRED -> "Voice needs your OpenAI key. Add it to start the call."
}
