package technology.tiny.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SaveAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import technology.tiny.app.chat.ChatViewModel
import technology.tiny.app.chat.SessionArchive
import technology.tiny.app.chat.SessionStore
import technology.tiny.app.ui.theme.TinyGray

/**
 * Local named-session picker — the Android analog of iOS SessionsView
 * (ios/Tiny/Sources/Sessions.swift). Save the current conversation under a name,
 * reload a saved one (which auto-archives the outgoing transcript as a recoverable
 * safety net), or delete. Entirely offline — distinct from the cloud /save·/load·
 * /archives account archives (those hit /api/archives; this is on-device only).
 *
 * All persistence lives in the (unit-tested) ChatViewModel session API; this sheet
 * is pure UI glue. list()/delete are file I/O so they run off the main thread.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsSheet(vm: ChatViewModel, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var sessions by remember { mutableStateOf<List<SessionArchive>?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var pendingDelete by remember { mutableStateOf<SessionArchive?>(null) }

    LaunchedEffect(reloadKey) {
        sessions = withContext(Dispatchers.IO) { vm.listSessions() }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item {
                SheetTitle(Icons.Outlined.SaveAlt, "sessions")
                Spacer(Modifier.height(4.dp))
                Text(
                    "Saved on this device only.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                Spacer(Modifier.height(12.dp))
            }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        placeholder = { Text("Name this conversation…") },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    )
                    Spacer(Modifier.width(8.dp))
                    val canSave = name.isNotBlank() && vm.messages.isNotEmpty()
                    TextButton(
                        onClick = {
                            val label = name.trim()
                            vm.saveSession(label)
                            // saveSession writes async on IO — a re-list here could miss it.
                            // Optimistically prepend the archive carrying the real snapshot,
                            // so tapping it loads correctly even before the write lands; the
                            // on-disk archive replaces this row on the next open.
                            val snapshot = vm.messages.toList()
                            sessions = listOf(
                                SessionArchive(
                                    name = label, tiny = vm.tiny,
                                    savedAt = System.currentTimeMillis(),
                                    messagesJson = technology.tiny.app.chat.MessageCodec.encodeToString(snapshot),
                                    messageCount = snapshot.size,
                                ),
                            ) + sessions.orEmpty()
                            name = ""
                        },
                        enabled = canSave,
                    ) {
                        Text("save", color = if (canSave) MaterialTheme.colorScheme.primary else TinyGray)
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    SessionStore.saveFooter(vm.messages.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    SessionStore.savedHeader(vm.tiny),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(8.dp))
            }
            if (sessions == null) item { SheetLoading() }
            if (sessions?.isEmpty() == true) {
                item { SheetEmpty(Icons.Outlined.SaveAlt, "no saved sessions for ${vm.tiny} yet", "save one with /save in the composer") }
            }
            items(sessions.orEmpty()) { s ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { vm.loadSession(s); onDismiss() }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            s.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (s.autoBackup) TinyGray else MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            SessionStore.subtitle(s.messageCount, s.savedAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = TinyGray,
                        )
                    }
                    TextButton(onClick = { pendingDelete = s }) {
                        Text("delete", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }

    pendingDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete session?") },
            text = { Text("“${s.name}” — this only removes the local snapshot.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    vm.deleteSession(s)
                    // Drop the row locally so it vanishes without racing the async
                    // file delete + a full re-list (DevicesSheet revoke pattern).
                    sessions = sessions?.filterNot { it.id == s.id }
                }) { Text("delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("cancel", color = TinyGray) } },
        )
    }
}
