package technology.tiny.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray

data class TinyEvent(val id: Long, val kind: String, val detail: String, val created: Long)

/**
 * Event-kind → glyph, matching web lib/chat/event-icons.ts (prefix match, so
 * `job` covers job_result/job_error, `telegram` covers all telegram_* kinds).
 * `tiny_visit` is keyed in full because the bare `visit`/`tiny` prefix wouldn't
 * reach it. `device` covers `device_result` — a use_device task whose reply
 * landed after the 45s wait, which only the event ring can surface.
 * Unknown kind → ⚡ (graceful degrade, web parity).
 *
 * 🚨 `pay_alarm` is keyed IN FULL, like tiny_visit: a bare `pay` prefix would also
 * swallow a future pay_* kind that is NOT an emergency. It drew the same ⚡ as a
 * corrupt event until the roster (EMITTED_KINDS in lib/chat/event-icons.ts, and
 * EMITTED_KINDS below) made the gap fail a test — an unmapped SHIPPED kind is
 * indistinguishable from an unknown one, so the fallback hid it.
 *
 * ⛔ `job_missed` — a one-shot the scheduler gave up on — is the sharper case:
 * `job` IS a prefix of it, so it inherited ⏰, the glyph of a job that ran.
 * `iconFor` matches longest-key-first rather than trusting this list's order; a
 * correctness that depends on line position is one reorder away from wrong.
 *
 * 🚫 `device_missed` is that trap again on the device side: `device` is a real
 * prefix, so a task the laptop NEVER picked up would draw 💻 — the glyph for one
 * it FINISHED — on the only surface that reports the loss. Keyed in full.
 */
private val KIND_ICONS = listOf(
    "job" to "⏰", "job_missed" to "⛔", "telegram" to "✈️", "tiny_visit" to "👀", "learn" to "🧬",
    "device" to "💻", "device_missed" to "🚫", "pay_alarm" to "🚨",
    "pay_earned" to "💵", "pay_received" to "💰", "pay_withdrawn" to "🏦", "pay_refunded" to "↩️",
    "push" to "🔔", "share" to "🔗", "tool" to "🔧", "follow" to "🤝", "dm" to "💬",
)

/** Every kind the worker can emit — mirrors EMITTED_KINDS in
 *  lib/chat/event-icons.ts so the pin in ActivityAgoTest fails here too when the
 *  worker grows a kind this HUD has no glyph for. */
internal val EMITTED_KINDS = listOf(
    "job_result", "job_error", "dm", "follow", "tiny_visit", "device_result",
    "tool-update", "telegram", "telegram_out", "telegram_button", "pay_alarm",
    "pay_earned", "pay_received", "pay_withdrawn", "pay_refunded",
    "job_missed", "device_missed",
)

private val KIND_KEYS_BY_SPECIFICITY = KIND_ICONS.sortedByDescending { it.first.length }

internal fun iconFor(kind: String): String {
    for ((key, glyph) in KIND_KEYS_BY_SPECIFICITY) if (kind.startsWith(key)) return glyph
    return "⚡"
}

/**
 * Relative age from a seconds-since-epoch timestamp (web ActivityHUD `ago()`).
 * A non-positive/garbage `created` floors to "1s" rather than rendering a bogus
 * huge value (web guards the same NaN/epoch-zero case).
 */
internal fun ago(created: Long, nowMs: Long): String {
    val s = if (created > 0) maxOf(1L, nowMs / 1000 - created) else 1L
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}

/**
 * ⚡ Activity — "what happened while you were away": the signed-in user's event
 * ring (scheduler fires, telegram, visits, learns, follows, DMs). GET /api/events
 * (session-authed proxy over the worker's 200-cap ring). Web ActivityHUD +
 * iOS Activity.swift parity — the same KIND_ICONS glyph map and ago() logic.
 * Newest-first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivitySheet(app: TinyApp, onDismiss: () -> Unit) {
    var events by remember { mutableStateOf<List<TinyEvent>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val nowMs = remember { System.currentTimeMillis() }

    LaunchedEffect(reloadKey) {
        failed = null
        events = null
        val res = runCatching { app.api.getJson("/api/events") }.getOrNull()
        // null = transport failure; the route 502s (ok:false) when the worker ring
        // is unreachable — keep DISTINCT from a clean empty so an outage doesn't
        // render as "nothing yet" (web ActivityHUD errored-vs-empty; iOS panel parity).
        val status = res?.optInt("_status", 0) ?: 0
        if (res == null || status >= 400 || !res.optBoolean("ok", status in 200..399)) {
            failed = status.takeIf { it >= 400 }
                ?.let { technology.tiny.app.net.friendlyHttpError(it) } ?: "couldn't load your activity"
            return@LaunchedEffect
        }
        val arr = res.optJSONArray("events")
        val loaded = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
            arr?.optJSONObject(i)?.let { e ->
                TinyEvent(
                    id = e.optLong("id"),
                    kind = e.optString("kind"),
                    detail = e.optString("detail"),
                    created = e.optLong("created"),
                )
            }
        }
        events = loaded
        // Everything shown here is now seen — advance the high-water mark + clear the
        // ⚡ badge (web ActivityHUD markSeen on open). Empty ring leaves it untouched.
        loaded.maxOfOrNull { it.id }?.let { app.fleet.markEventsSeen(it) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                SheetTitle(Icons.Outlined.Bolt, "activity")
                Spacer(Modifier.height(12.dp))
            }
            when {
                failed != null -> item {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text(failed!!, color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                events == null -> item { SheetLoading() }
                events!!.isEmpty() -> item {
                    SheetEmpty(Icons.Outlined.Bolt, "nothing yet", "schedule a job or pair Telegram and life shows up here")
                }
                // Ring arrives oldest→… ; show newest-first like web ([...events].reverse()).
                else -> items(events!!.sortedByDescending { it.id }, key = { it.id }) { e ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
                        Text(iconFor(e.kind), style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                e.detail.ifEmpty { e.kind },
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                "${e.kind} · ${ago(e.created, nowMs)} ago",
                                style = MaterialTheme.typography.labelSmall, color = TinyGray,
                            )
                        }
                    }
                }
            }
        }
    }
}
