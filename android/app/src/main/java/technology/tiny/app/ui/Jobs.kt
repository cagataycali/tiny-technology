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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.tools.AlertRecord
import technology.tiny.app.tools.AlertStore
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyGray
import technology.tiny.app.ui.theme.TinyWarn
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
 * 🔴 What a job's schedule line MEANS — the question this sheet answered by
 * guessing, in the one direction that invents history.
 *
 * The row rendered `ran Jan 1, 09:00 · fired 0×` about a reminder that never
 * happened, because the cadence line read:
 *
 *     if (fireCount > 0 || !enabled) "ran" else "once at"
 *
 * 🔑 `!enabled` is NOT evidence that a job ran. The scheduler clears the flag
 * from two places and only one of them is a run (verified against the CURRENT
 * `worker/src/scheduler.ts`, since the line numbers the web and
 * iOS quote have both moved since):
 *
 *   • after a successful fire — `UPDATE jobs SET enabled = 0` (:239), preceded
 *     by CLAIM_SQL (:35), which increments `fire_count`.
 *   • when it gives UP — the `skip-stale` branch (:171) writes
 *     `last_fired_at = now, enabled = 0` for a one-shot that was due more than
 *     `CATCH_UP_SECONDS` (24h) ago. `fire_count` is untouched. The job never ran
 *     and now never will: it is disabled precisely so the tick stops looking.
 *
 * So `fire_count` is the ONLY field that records a run, and `last_fired_at` on
 * such a row is the moment of ABANDONMENT — a time the job provably did not run
 * at, which this sheet was rendering as "last Jan 1, 09:00" beside "fired 0×".
 *
 * ⚠️ And the two halves of this app contradicted each other out loud: since
 * `JOB_ABANDONED_KIND` (scheduler.ts:126) the worker PUSHES "⏰ <name> never
 * ran". The user reads that notification, opens this sheet, and is told it ran.
 *
 * ⚠️ That state needs no outage to reach. `runAt` is validated only as finite,
 * so an agent that computes a timestamp from a misparsed date lands a one-shot
 * already in the past; it is created enabled, the next tick marks it stale, and
 * the sheet then claims it ran.
 *
 * Ported from the web's `lib/chat/job-cadence.ts` (and iOS's `JobCadence`, which
 * ported the same rules). Pure and `nowSec`-injectable: [cadence] formats a
 * date, this decides what the date MEANS.
 *
 * ⚠️ SECONDS throughout, matching the payload — [cadence] takes `nowMs` for the
 * `daily@` conversion and divides on the way in. Two units in one rule is how a
 * 24h window silently becomes 24000h.
 */
internal object JobCadence {
    /**
     * Mirror of the scheduler's `CATCH_UP_SECONDS` (scheduler.ts:76).
     * `tests/android-job-cadence.test.ts` asserts the worker, the web module,
     * iOS and this still say 24h — four languages, one rule, previously matched
     * only by comment.
     */
    const val CATCH_UP_SECONDS = 24 * 60 * 60L

    /**
     * What a one-shot job's fire time means right now.
     *
     *  [RAN]     — it fired. The only state `fire_count` can attest to.
     *  [MISSED]  — it will never fire: either already dropped (disabled, no
     *              runs) or past the point where it can be (still enabled but
     *              due beyond the catch-up window, so the very next tick takes
     *              the skip-stale branch). Deliberately ONE state — "already
     *              abandoned" and "certain to be abandoned" differ in
     *              bookkeeping, not in anything the user can do about it.
     *  [DUE]     — its time has passed, it is enabled, and it is inside the
     *              catch-up window: a job in flight, not a broken one.
     *  [PENDING] — its time is still ahead.
     *  [UNKNOWN] — no usable `run_at`.
     */
    enum class OneShot { RAN, MISSED, DUE, PENDING, UNKNOWN }

    /**
     * How the line should FEEL, decided here rather than in the composable so it
     * is testable without a UI. Android's cadence had no tone at all — the whole
     * detail line is one gray join — so "didn't run" would have arrived in the
     * same colour as "every 5 min", and the row's only warning would be a word
     * the eye slides over.
     */
    enum class Tone { LIVE, DONE, WARN, MUTED }

    /**
     * The usable-timestamp guard (seconds > 0), shared with the web's
     * `usableSec` and [whenStamp]'s own `n <= 0`. Kept as a named function
     * rather than inlined so the rule below and the row's `last_fired_at` read
     * the same guard.
     */
    fun usableSec(v: Long?): Long? = v?.takeIf { it > 0 }

    /**
     * Classify a one-shot. `nowSec` is unix SECONDS, matching the payload.
     *
     * Order matters, and the first branch is the whole point: a recorded run
     * outranks every flag, including a still-enabled row (the post-fire disable
     * is a separate statement inside a swallowing try/catch, so
     * `enabled = 1, fire_count = 1` is a state that can exist — and it means the
     * job RAN).
     */
    fun oneShotState(runAt: Long?, fired: Int, enabled: Boolean, nowSec: Long): OneShot {
        if (fired > 0) return OneShot.RAN
        val due = usableSec(runAt) ?: return OneShot.UNKNOWN
        // Never ran, and nothing left to run it.
        if (!enabled) return OneShot.MISSED
        if (due > nowSec) return OneShot.PENDING
        // Due. Whether it still gets to run is exactly the scheduler's own test.
        return if (nowSec - due > CATCH_UP_SECONDS) OneShot.MISSED else OneShot.DUE
    }

    /**
     * The word before the formatted time, or null when there is nothing true to
     * say about a time we cannot read.
     */
    fun prefix(state: OneShot): String? = when (state) {
        OneShot.RAN -> "ran"
        // Names the outcome, not the flag: true for both halves of MISSED and
        // impossible to mistake for a schedule.
        OneShot.MISSED -> "didn't run"
        // Not "once at" — the time has passed, so a future tense reads as a job
        // that is still coming and makes an in-flight run look overdue forever.
        OneShot.DUE -> "due"
        OneShot.PENDING -> "once at"
        OneShot.UNKNOWN -> null
    }

    /**
     * The truthful word for `last_fired_at`, or null when that timestamp records
     * nothing a person would call a run.
     *
     * "last" needs `fire_count` behind it. On a MISSED job the same field is the
     * moment the scheduler switched the job off, which is worth showing — under
     * its real name. A recurring job that skipped a stale slot also gets
     * `last_fired_at` bumped with no fire, and lands here at `fired == 0` with
     * UNKNOWN (no `run_at`): nothing true to say, so nothing is said — the row's
     * own "fired 0×" already covers it.
     */
    fun lastFiredWord(fired: Int, state: OneShot): String? = when {
        fired > 0 -> "last"
        state == OneShot.MISSED -> "switched off"
        else -> null
    }

    /**
     * The colour rule. Recurring jobs are judged by their switch (a live
     * `every 5 min` row is the common case); one-shots by what their time now
     * means.
     */
    fun tone(schedule: String?, state: OneShot, enabled: Boolean): Tone {
        if (!schedule.isNullOrEmpty()) return if (enabled) Tone.LIVE else Tone.MUTED
        return when (state) {
            OneShot.PENDING, OneShot.DUE -> Tone.LIVE
            OneShot.RAN -> Tone.DONE
            OneShot.MISSED -> Tone.WARN
            OneShot.UNKNOWN -> Tone.MUTED
        }
    }
}

/**
 * Human cadence for the worker schedule DSL (web JobsPanel.tsx `cadence()` parity):
 * `*​/Nm`|`*​/Nh` → "every N min"/"every N hr"; `daily@HH:MM` (stored UTC) → "daily
 * at <local>"; any other schedule string → verbatim; else a one-shot `runAt`, whose
 * phrasing is [JobCadence]'s to decide — "once at"/"due"/"ran"/"didn't run".
 * NOTE web converts daily@ to the viewer's local clock so a non-UTC user needn't do
 * the math — the better UX, so web is the target for this DISPLAY label (not a byte
 * contract), and iOS has since converted too. `nowMs` anchors the daily conversion
 * on today's UTC offset (incl. DST) and, /1000, the one-shot rule. Pure/testable.
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
    // ⚠️ Was `if (fireCount > 0 || !enabled) "ran" else "once at"`, which told
    // people their abandoned reminder had happened. [JobCadence] reads
    // `fire_count` as the only record of a run; `usableSec` is the same `> 0`
    // guard this branch already had, now stated once.
    val state = JobCadence.oneShotState(runAt, fireCount, enabled, nowMs / 1000)
    val at = JobCadence.usableSec(runAt)
    val prefix = JobCadence.prefix(state)
    if (prefix != null && at != null) return "$prefix ${whenStamp(at)}"
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

/**
 * Tone → colour, the only place the rule meets Compose, so [JobCadence.tone]
 * itself stays testable without a UI.
 *
 * WARN is [TinyWarn], not [TinyDanger]: an abandoned reminder is not an error the
 * app made, it is a fact the row must stop hiding — the same call Chain.kt's
 * mismatched chain id and the camera's "busy" made. DONE and MUTED are both
 * [TinyGray] on purpose: a job that has finished and a job with nothing to say
 * are equally past, and giving "ran" its own colour would make every completed
 * one-shot compete with the live rows above it.
 */
internal fun jobToneColor(tone: JobCadence.Tone): Color = when (tone) {
    JobCadence.Tone.LIVE -> TinyAccent
    JobCadence.Tone.WARN -> TinyWarn
    JobCadence.Tone.DONE, JobCadence.Tone.MUTED -> TinyGray
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
                            val state = JobCadence.oneShotState(j.runAt, j.fireCount, j.enabled, nowMs / 1000)
                            // The cadence gets its OWN Text so it can carry a
                            // tone. Android had no equivalent of iOS's green
                            // cadence line — the whole detail line is one gray
                            // join — which is worse, not better: "didn't run"
                            // arrived in the same colour as "every 5 min", and
                            // the row's only warning was a word the eye slides
                            // over. Split, not recoloured wholesale: "as tiny ·
                            // fired 0×" is not a warning about anything.
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    cadence(j.schedule, j.runAt, j.fireCount, j.enabled, nowMs),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = jobToneColor(JobCadence.tone(j.schedule, state, j.enabled)),
                                )
                                Text(
                                    listOfNotNull(
                                        j.tiny?.let { "as $it" },
                                        "fired ${j.fireCount}×",
                                        // Was `"last ${whenStamp(it)}"` for any
                                        // `last_fired_at` at all — but the
                                        // scheduler sets that field when it GIVES
                                        // UP too, so this named a time the job
                                        // provably did not run at, right beside
                                        // "fired 0×". [JobCadence.lastFiredWord]
                                        // decides what the stamp is evidence OF.
                                        JobCadence.usableSec(j.lastFired)?.let { at ->
                                            JobCadence.lastFiredWord(j.fireCount, state)
                                                ?.let { word -> "$word ${whenStamp(at)}" }
                                        },
                                    ).joinToString(" · ", prefix = " · "),
                                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                                )
                            }
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
