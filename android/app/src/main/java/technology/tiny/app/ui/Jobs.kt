package technology.tiny.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.tools.AlertRecord
import technology.tiny.app.tools.AlertStore
import technology.tiny.app.ui.theme.TinyGray
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// A scheduled job. `schedule` (recurring DSL) and `runAt` (one-shot unix secs)
// are mutually exclusive; `lastFired` is unix secs or null (never fired).
data class JobRow(
    val id: String,
    val name: String,
    val schedule: String?,
    val runAt: Long?,
    val tiny: String?,
    val enabled: Boolean,
    val fireCount: Int,
    val lastFired: Long?,
)

// One row of a job's run history (worker job_runs; ✓/✗ + 300-char preview).
data class JobRun(val jobId: String, val started: String, val status: String, val preview: String)

/**
 * job_runs.started renders defensively: unix seconds → relative age, anything
 * else (e.g. sqlite CURRENT_TIMESTAMP text) → the first 16 chars as-is.
 */
internal fun runStamp(started: String, nowMs: Long): String =
    started.toLongOrNull()?.let { "${ago(it, nowMs)} ago" } ?: started.take(16)

/**
 * Human cadence for the worker schedule DSL (web JobsPanel.tsx `cadence()` parity):
 * `*​/Nm`|`*​/Nh` → "every N min"/"every N hr"; `daily@HH:MM` (stored UTC) → "daily
 * at <local>"; any other schedule string → verbatim; else a one-shot `runAt` →
 * "once at"/"ran <when>" (ran once it has fired or been disabled). NOTE iOS shows
 * daily@ in raw UTC ("daily at HH:MM UTC"); web converts it to the viewer's local
 * clock so a non-UTC user needn't do the math — the better UX, so web is the target
 * for this DISPLAY label (not a byte contract). `nowMs` anchors the daily
 * conversion on today's UTC offset (incl. DST). Pure/testable.
 */
internal fun cadence(schedule: String?, runAt: Long?, fireCount: Int, enabled: Boolean, nowMs: Long): String {
    if (schedule != null) {
        Regex("""^\*/(\d+)([mh])$""").matchEntire(schedule)?.let { m ->
            val (n, unit) = m.destructured
            return "every $n${if (unit == "m") " min" else " hr"}"
        }
        Regex("""^daily@(\d{2}):(\d{2})$""").matchEntire(schedule)?.let { m ->
            val (h, min) = m.destructured
            val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
                timeInMillis = nowMs
                set(Calendar.HOUR_OF_DAY, h.toInt())
                set(Calendar.MINUTE, min.toInt())
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            // device-local tz (no setTimeZone) turns the UTC instant into local wall time
            return "daily at ${SimpleDateFormat("hh:mm a", Locale.US).format(cal.time)}"
        }
        return schedule
    }
    if (runAt != null && runAt > 0) {
        return "${if (fireCount > 0 || !enabled) "ran" else "once at"} ${whenStamp(runAt)}"
    }
    return "?"
}

/**
 * Absolute local time for a unix-SECONDS stamp (web JobsPanel.tsx `when()` parity):
 * empty string for non-positive/garbage (mirrors web's `Number.isFinite && > 0`
 * guard so a bad value never renders "Invalid Date"). "MMM d, hh:mm a" mirrors web's
 * en-US month/day + 12-hour time. Pure/testable.
 */
internal fun whenStamp(tsSec: Long?): String {
    val n = tsSec ?: 0
    if (n <= 0) return ""
    return SimpleDateFormat("MMM d, hh:mm a", Locale.US).format(Date(n * 1000))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JobsSheet(app: TinyApp, onDismiss: () -> Unit) {
    var jobs by remember { mutableStateOf<List<JobRow>?>(null) }
    var runs by remember { mutableStateOf<List<JobRun>>(emptyList()) }
    var jobsFailed by remember { mutableStateOf<String?>(null) }
    // Device-local schedule_alert notifications — need NO network, so they render
    // outside the server-load state (iOS 5ac99d9 parity: a failed /api/jobs fetch
    // must not hide the ONE screen where these can be audited/cancelled).
    var alerts by remember { mutableStateOf<List<AlertRecord>>(emptyList()) }
    // Job pending a delete-confirm. Deleting a server job also wipes its run
    // history and is irreversible — web gates it behind a danger ConfirmDialog
    // (JobsPanel.tsx:168); a full-screen sheet button can't ask inline, so hold
    // the row and show an AlertDialog (the on-brand equivalent).
    var pendingDelete by remember { mutableStateOf<JobRow?>(null) }
    val scope = rememberCoroutineScope()

    fun reloadAlerts() {
        alerts = AlertStore.loadPending(app, System.currentTimeMillis())
    }

    fun reload() {
        reloadAlerts()
        scope.launch {
            val res = runCatching { app.api.getJson("/api/jobs") }.getOrNull()
            // One rule for all six list sheets ([LoadFailure]), and it asks whether
            // the `jobs` key ARRIVED — a 200 that wasn't JSON parses to an empty
            // object carrying no `_status`, so the old `status >= 400` guard passed it
            // and the sheet lied "no jobs" about a schedule that exists.
            val body = LoadFailure.loaded(res, "jobs")
            if (body == null) {
                jobsFailed = LoadFailure.contentMessage(res, "jobs", "your jobs")
                jobs = null
                return@launch
            }
            jobsFailed = null
            val arr = body.optJSONArray("jobs")
            jobs = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
                arr?.optJSONObject(i)?.let { j ->
                    JobRow(
                        id = j.optString("id"),
                        name = j.optString("name").ifEmpty { j.optString("prompt").take(40) },
                        schedule = j.optString("schedule").takeIf { it.isNotEmpty() },
                        runAt = j.optLong("run_at").takeIf { it > 0 },
                        // worker column is tiny_slug (web reads j.tiny_slug); the old
                        // "tiny" key never existed, so the "as <tiny>" label never showed.
                        tiny = j.optString("tiny_slug").takeIf { it.isNotEmpty() },
                        enabled = j.optInt("enabled", 1) == 1,
                        fireCount = j.optInt("fire_count"),
                        lastFired = j.optLong("last_fired_at").takeIf { it > 0 },
                    )
                }
            }
            // Run history was fetched-but-dropped before this — a loop the user
            // can't observe isn't a loop, it's a leap of faith (web JobsPanel
            // shows the same runs array; iOS shows none — matches web).
            val runsArr = body.optJSONArray("runs")
            runs = (0 until (runsArr?.length() ?: 0)).mapNotNull { i ->
                runsArr?.optJSONObject(i)?.let { r ->
                    JobRun(
                        jobId = r.optString("job_id"),
                        started = r.optString("started"),
                        status = r.optString("status"),
                        preview = r.optString("result_preview"),
                    )
                }
            }
        }
    }
    LaunchedEffect(Unit) { reload() }

    val timeFmt = remember { SimpleDateFormat("M/d H:mm", Locale.US) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                SheetTitle(Icons.Outlined.Schedule, "scheduled jobs")
                Spacer(Modifier.height(12.dp))
            }

            // Nothing anywhere AND the server loaded clean → the friendly empty state.
            // (A server FAILURE is never "empty" — it shows the retry below instead.)
            if (jobs?.isEmpty() == true && alerts.isEmpty() && jobsFailed == null) {
                item {
                    Text("no jobs — ask your tiny to schedule one", color = TinyGray,
                        style = MaterialTheme.typography.bodyMedium)
                }
                return@LazyColumn
            }

            // ── Device-local alerts (no network) ──────────────────────────────
            if (alerts.isNotEmpty()) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Outlined.PhoneAndroid, contentDescription = null, tint = TinyGray, modifier = Modifier.size(15.dp))
                        Text("on this phone", style = MaterialTheme.typography.labelMedium, color = TinyGray)
                    }
                    Spacer(Modifier.height(4.dp))
                }
                items(alerts, key = { "alert-${it.id}" }) { a ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(a.title, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                listOfNotNull(timeFmt.format(Date(a.fireAt)), a.body.takeIf { it.isNotEmpty() })
                                    .joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall, color = TinyGray,
                            )
                        }
                        TextButton(onClick = {
                            androidx.work.WorkManager.getInstance(app).cancelWorkById(java.util.UUID.fromString(a.id))
                            AlertStore.remove(app, a.id)
                            reloadAlerts()
                        }) { Text("cancel", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
                    }
                }
                item { Spacer(Modifier.height(12.dp)) }
            }

            // ── Server-scheduled jobs (network) — only THIS section carries the
            //    loading/failed/loaded state, so an outage can't hide the alerts above.
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Outlined.CloudQueue, contentDescription = null, tint = TinyGray, modifier = Modifier.size(15.dp))
                    Text("scheduled jobs", style = MaterialTheme.typography.labelMedium, color = TinyGray)
                }
                Spacer(Modifier.height(4.dp))
            }
            when {
                jobsFailed != null -> item {
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Text(jobsFailed!!, color = TinyGray, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { jobs = null; jobsFailed = null; reload() }) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                jobs == null -> item { SheetLoading() }
                jobs!!.isEmpty() -> item {
                    Text("no server jobs", color = TinyGray, style = MaterialTheme.typography.bodySmall)
                }
                else -> items(jobs!!, key = { it.id }) { j ->
                    val nowMs = remember { System.currentTimeMillis() }
                    // A disabled job (one-shots auto-disable after firing) dims to
                    // read as inactive — web opacity-60 / iOS StatusDot parity.
                    val rowAlpha = if (j.enabled) 1f else 0.6f
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp).alpha(rowAlpha), verticalAlignment = Alignment.CenterVertically) {
                        // Native status dot (was 🟢/⚪ emoji): a filled accent dot when
                        // enabled, a hollow gray ring when disabled — the StatusDot
                        // idiom web/iOS use, and it inherits the row's disabled-dim alpha.
                        Icon(
                            if (j.enabled) Icons.Filled.Circle else Icons.Outlined.RadioButtonUnchecked,
                            contentDescription = if (j.enabled) "enabled" else "disabled",
                            tint = if (j.enabled) MaterialTheme.colorScheme.primary else TinyGray,
                            modifier = Modifier.size(10.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(j.name, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                listOfNotNull(
                                    cadence(j.schedule, j.runAt, j.fireCount, j.enabled, nowMs),
                                    j.tiny?.let { "as $it" },
                                    "fired ${j.fireCount}×",
                                    j.lastFired?.let { "last ${whenStamp(it)}" },
                                ).joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall, color = TinyGray,
                            )
                            // Last runs, newest first — the observability half of a
                            // background loop: ✓/✗ + result preview + when.
                            runs.filter { it.jobId == j.id }.take(3).forEach { r ->
                                Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.Top) {
                                    Text(
                                        if (r.status == "ok") "✓ " else "✗ ",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (r.status == "ok") MaterialTheme.colorScheme.primary
                                            else MaterialTheme.colorScheme.error,
                                    )
                                    Text(
                                        listOf(runStamp(r.started, nowMs), r.preview.ifEmpty { r.status })
                                            .joinToString(" · "),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = TinyGray,
                                        maxLines = 2,
                                    )
                                }
                            }
                        }
                        TextButton(onClick = { pendingDelete = j }) {
                            Text("delete", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }

    // Danger confirm before an irreversible server-job delete (web JobsPanel.tsx:168).
    pendingDelete?.let { job ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete job?") },
            text = { Text("“${job.name}” and its run history will be permanently deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    scope.launch {
                        runCatching { app.api.deleteJson("/api/jobs", JSONObject().put("id", job.id)) }
                        reload()
                    }
                }) { Text("delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("cancel", color = TinyGray) }
            },
        )
    }
}
