package technology.tiny.app.voice

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import technology.tiny.app.chat.ChatViewModel

/**
 * Owner-only per-tiny call-voice picker (iOS VoicePickerSheet parity).
 *
 * Sets the OpenAI Realtime voice the tiny speaks with on a live call. This is a
 * PER-TINY SERVER field (docs/voice-sessions-design.md, locked design) —
 * everyone who calls this tiny hears the chosen voice, NOT a per-device
 * override. Writes via ChatViewModel.saveVoice → POST /api/control (worker
 * /upsert, owner-gated). The on-device "spoken-reply voice (TTS)" in Settings
 * is a separate thing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoicePickerSheet(
    vm: ChatViewModel,
    accent: Color,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // "" (unset) shows as the marin default — matches the server fallback.
    val current = vm.callVoice.ifEmpty { "marin" }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                "🎙 Call voice",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                "The voice ${vm.tiny} speaks with on a live call (📞). Set on the tiny itself — everyone who calls ${vm.tiny} hears it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(8.dp))

            REALTIME_VOICES.forEach { v ->
                val selected = v == current
                Row(
                    Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = selected,
                            enabled = !saving,
                            onClick = {
                                if (v == current) return@selectable
                                saving = true; error = null
                                vm.saveVoice(v) { ok ->
                                    saving = false
                                    if (!ok) error = "Couldn't save — try again."
                                }
                            },
                        )
                        .padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(v.replaceFirstChar { it.uppercase() }, fontSize = 16.sp)
                    if (v == "marin") {
                        Text(
                            "default",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    if (selected) {
                        Icon(Icons.Filled.Check, contentDescription = "selected", tint = accent)
                    }
                }
            }

            if (saving) {
                Spacer(Modifier.height(4.dp))
                CircularProgressIndicator(Modifier.height(20.dp), color = accent, strokeWidth = 2.dp)
            }
        }
    }
}

/**
 * The OpenAI Realtime voices a tiny can speak with — mirrors the worker
 * allowlist (upsert.ts normalizeVoice); `marin` is the server default.
 */
private val REALTIME_VOICES = listOf(
    "alloy", "ash", "ballad", "coral", "echo",
    "sage", "shimmer", "verse", "marin", "cedar",
)
