package technology.tiny.wear

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Switch
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.ToggleChip

/**
 * TinyWatch on Wear OS — tiny on the wrist. Mirrors iOS WatchRootView:
 * an unlinked prompt until the phone pushes a token, then a scrolling chat
 * (dictation via the system voice recognizer → the same /api/chat loop, steered
 * wrist-short), a live tool/spinner line, and tap-to-ask followup chips.
 */
class MainActivity : ComponentActivity() {

    private val vm: WearViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Screenshot harness (debug builds only) — MUST run before anything touches
        // `vm`, because WearViewModel reads the token and the transcript out of
        // WearStore in its constructor, and `by viewModels()` builds it lazily on
        // first access (the composition below). Seeding after that point would write
        // state nothing re-reads and still render Unlinked().
        if (BuildConfig.DEBUG) applyHarness(intent)
        setContent {
            MaterialTheme {
                val voice = rememberVoiceInput { spoken -> vm.ask(spoken) }
                WearRoot(vm, onDictate = voice)
            }
        }
        // A launch from a face tap-action (iOS BriefingIntent / FollowupIntent
        // parity): fire it once. Guard on savedInstanceState so a config-change
        // recreate — which keeps the launch intent — doesn't re-ask.
        if (savedInstanceState == null) handleFaceTap(intent)
    }

    // singleTop: a second tap while we're already foreground arrives here rather
    // than recreating, so the live VM (token, transcript) is reused.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleFaceTap(intent)
    }

    /**
     * Seed wrist state from launch extras so a Wear OS screenshot can show the app
     * past its link gate ([WearHarness] holds the rules + the why). Debug-only,
     * guarded at the call site; writes straight to [WearStore] because the VM does
     * not exist yet — which is the point, since it reads the store on construction.
     */
    private fun applyHarness(intent: Intent?) {
        val store = WearStore(this)
        // ⚠️ Both seeds OVERWRITE real state (the encrypted session token, the
        // transcript file), so ask first whether this wrist's state is ours to
        // clobber. On a phone-linked watch the answer is no — the capture recipe
        // sideloads a DEBUG apk, so one wrong --serial would otherwise unlink a real
        // watch and delete the conversation on it, silently. See WearHarness.
        if (!WearHarness.mayOverwrite(BuildConfig.DEBUG, store.token != null, store.harnessSeeded)) return
        var seeded = false
        WearHarness.token(BuildConfig.DEBUG, intent?.getStringExtra(WearHarness.EXTRA_TOKEN))
            ?.let { store.token = it; seeded = true }
        WearHarness.turns(BuildConfig.DEBUG, intent?.getStringExtra(WearHarness.EXTRA_TURNS))
            ?.let { store.saveTurns(it); seeded = true }
        // Mark the provenance only when something was actually written, so a launch
        // with no (or unparseable) extras doesn't label a wrist as demo state.
        if (seeded) store.harnessSeeded = true
    }

    /** Run a face tap-action carried on [intent] once — a briefing or the stored
     *  follow-up — consuming the flag so a later recreate can't replay it. No-op
     *  until the wrist is linked (both need a token); askFollowup additionally
     *  no-ops when nothing fresh is stored. */
    private fun handleFaceTap(intent: Intent?) {
        intent ?: return
        when {
            intent.getBooleanExtra(TinyLaunch.EXTRA_FOLLOWUP, false) -> {
                intent.removeExtra(TinyLaunch.EXTRA_FOLLOWUP)
                if (vm.token != null) vm.askFollowup()
            }
            intent.getBooleanExtra(TinyLaunch.EXTRA_BRIEFING, false) -> {
                intent.removeExtra(TinyLaunch.EXTRA_BRIEFING)
                if (vm.token != null) vm.askBriefing()
            }
        }
    }
}

/** System free-form dictation (RecognizerIntent) → callback with the transcript. */
@Composable
private fun rememberVoiceInput(onResult: (String) -> Unit): () -> Unit {
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data
                ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                ?.firstOrNull()
                ?.let(onResult)
        }
    }
    return {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Ask tiny")
        }
        runCatching { launcher.launch(intent) }
    }
}

/** Compose Color wrapper over the shared WatchCore.accentArgb — the tile/
 *  complication use the Int form; the app's Compose UI wants a Color. One parse. */
private fun accentColor(hex: String?): Color =
    Color(technology.tiny.app.wear.WatchCore.accentArgb(hex))

@Composable
private fun WearRoot(vm: WearViewModel, onDictate: () -> Unit) {
    val accent = accentColor(vm.accentHex)
    var showSettings by remember { mutableStateOf(false) }
    when {
        vm.token == null -> Unlinked()
        showSettings -> Settings(vm, accent, onClose = { showSettings = false })
        else -> Chat(vm, accent, onDictate, onSettings = { showSettings = true })
    }
}

/** Wrist-local settings — a trimmed twin of iOS WatchSettingsView: the autoSpeak
 *  (TTS autoplay) toggle and the briefing-prompt presets (what the wrist briefing
 *  asks). Both are wrist-local prefs backed by WearStore; the selected preset is
 *  ticked via WearBriefing.isSelected (iOS's checkmark rule). */
@Composable
private fun Settings(vm: WearViewModel, accent: Color, onClose: () -> Unit) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(modifier = Modifier.fillMaxSize(), state = listState) {
        item { TimeText() }
        item {
            Text(
                "Settings",
                color = accent,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.title3,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = vm.autoSpeak,
                onCheckedChange = { vm.toggleAutoSpeak(it) },
                label = { Text("Speak replies", style = MaterialTheme.typography.button) },
                toggleControl = {
                    Switch(checked = vm.autoSpeak, modifier = Modifier.semantics { contentDescription = "Speak replies" })
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Text(
                "When tiny uses its speak tool, play it on the wrist.",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colors.onSurfaceVariant,
                style = MaterialTheme.typography.caption2,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            )
        }

        // Briefing asks (iOS WatchSettings "Briefing asks" section) — tap a preset
        // to set what the wrist briefing prompt asks; the chosen one is ticked.
        item {
            Text(
                "⚡ Briefing asks",
                color = accent,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.caption1,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
        }
        items(WearBriefing.presets.size) { i ->
            val preset = WearBriefing.presets[i]
            val selected = WearBriefing.isSelected(preset, vm.briefingPrompt)
            Chip(
                label = { Text(preset.label, maxLines = 1, style = MaterialTheme.typography.caption1) },
                secondaryLabel = if (selected) ({ Text("✓ selected", style = MaterialTheme.typography.caption2) }) else null,
                onClick = { vm.chooseBriefing(preset.prompt) },
                colors = if (selected) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            Chip(
                label = { Text("Done", style = MaterialTheme.typography.button) },
                onClick = onClose,
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun Unlinked() {
    androidx.compose.foundation.layout.Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🌱", fontSize = 34.sp)
        Text(
            "tiny",
            fontWeight = FontWeight.SemiBold,
            style = MaterialTheme.typography.title3,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Open tiny on your phone\nto link this watch.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colors.onSurfaceVariant,
            style = MaterialTheme.typography.caption1,
        )
    }
}

@Composable
private fun Chat(vm: WearViewModel, accent: Color, onDictate: () -> Unit, onSettings: () -> Unit) {
    val listState = rememberScalingLazyListState()

    // Auto-scroll to the newest turn as the answer streams in (iOS onChange parity).
    LaunchedEffect(Unit) {
        snapshotFlow { vm.turns.lastOrNull()?.a?.length to vm.turns.size }
            .collect {
                val n = vm.turns.size + vm.followups.size
                if (n > 0) runCatching { listState.animateScrollToItem(n) }
            }
    }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
    ) {
        item { TimeText() }

        // Wrist wordmark — the persistent identity header (iOS WatchRootView's
        // navigationTitle "🌱 tiny"). Accent-tinted because the theme accent is
        // the only per-tiny identity signal the phone pushes to the wrist.
        item {
            Text(
                "🌱 tiny",
                color = accent,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.caption1,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Fleet presence + unread mirrored from the phone (iOS absorbSnapshot parity).
        vm.snapshot?.let { snap ->
            item {
                Text(
                    technology.tiny.app.wear.WatchCore.presenceLine(snap.online, snap.total, snap.unread),
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    style = MaterialTheme.typography.caption2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (vm.turns.isEmpty()) {
            item {
                Text(
                    "Ask anything — dictate\nor tap the mic.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    style = MaterialTheme.typography.caption1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        items(vm.turns.size) { idx ->
            val turn = vm.turns[idx]
            androidx.compose.foundation.layout.Column(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                Text(
                    turn.q,
                    color = accent,
                    fontWeight = FontWeight.Medium,
                    style = MaterialTheme.typography.caption1,
                )
                if (turn.a.isEmpty() && !turn.done) {
                    androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(16.dp),
                            indicatorColor = accent,
                            strokeWidth = 2.dp,
                        )
                        vm.activeTool?.let {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "  $it",
                                // caption3 IS Wear Material's 10sp token — use it
                                // instead of a raw fontSize (last type hardcode here).
                                style = MaterialTheme.typography.caption3,
                                color = MaterialTheme.colors.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                } else {
                    Text(turn.a, style = MaterialTheme.typography.body2)
                }
            }
        }

        if (vm.followups.isNotEmpty() && !vm.busy) {
            items(vm.followups.size) { i ->
                val chip = vm.followups[i]
                Chip(
                    label = { Text(chip, maxLines = 2, style = MaterialTheme.typography.caption2) },
                    onClick = { vm.ask(chip) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        item {
            Button(
                onClick = onDictate,
                enabled = !vm.busy,
                colors = ButtonDefaults.buttonColors(backgroundColor = accent),
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            ) {
                Text("🎤 Ask tiny")
            }
        }

        // One-tap briefing — asks the Settings-chosen prompt (iOS ⚡ BriefingIntent).
        item {
            Chip(
                label = { Text("⚡ Briefing", style = MaterialTheme.typography.caption2) },
                onClick = { vm.askBriefing() },
                enabled = !vm.busy,
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }

        // Settings (iOS WatchRootView's nav-bar gear) — wrist-local prefs.
        item {
            Chip(
                label = { Text("⚙︎ Settings", style = MaterialTheme.typography.caption2) },
                onClick = onSettings,
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }
    }
}
