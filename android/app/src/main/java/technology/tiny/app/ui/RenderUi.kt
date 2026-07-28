package technology.tiny.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.ui.theme.TinyGray

/** Cap on the unbounded list / key-value paths (iOS RENDER_LIST_CAP) — props are
 *  untrusted agent JSON and each row builds a real view eagerly, so an unbounded
 *  array would allocate a view per element on the main thread (hang/OOM). */
private const val RENDER_LIST_CAP = 100

/**
 * The shape a render_ui `props` blob resolves to — the PURE half of RenderUiCard,
 * extracted so the classification (iOS parseRenderUi parity) is unit-testable
 * without Compose. Deliberately mirrors iOS's decision ORDER: explicit shapes
 * (markdown/text, table, items) first because the agent chose them on purpose,
 * then chart candidates, then a scalar-dict key/value fallback, then raw.
 */
internal sealed interface RenderContent {
    data class Chart(val entries: List<JSONObject>) : RenderContent // → DataRows (chart or kv)
    data class Items(val items: JSONArray) : RenderContent
    data class Table(val columns: JSONArray, val rows: JSONArray) : RenderContent
    data class Md(val text: String) : RenderContent
    data class KeyValues(val pairs: List<Pair<String, String>>) : RenderContent
    data class StringList(val items: List<String>) : RenderContent
    data class Raw(val text: String) : RenderContent
    object Empty : RenderContent
}

/** Array-of-objects (every element a JSONObject), else null. */
private fun objectRows(arr: JSONArray?): List<JSONObject>? {
    if (arr == null || arr.length() == 0) return null
    val out = ArrayList<JSONObject>(arr.length())
    for (i in 0 until arr.length()) out.add(arr.optJSONObject(i) ?: return null)
    return out
}

/**
 * Classify a render_ui props blob the way iOS `parseRenderUi` does. Previously
 * RenderUiCard did `JSONObject(propsJson)` inline and returned NOTHING for a
 * top-level JSON array (an agent emitting `[{month,sales},…]` got a blank card),
 * and dumped raw JSON for a scalar dict (`{temp:20}`) instead of key/value rows.
 * This closes both, plus the "array-of-rows under a non-`data` key" and nested
 * `table:{columns,rows}` shapes iOS accepts.
 */
internal fun classifyRenderUi(propsJson: String): RenderContent {
    // Top-level object — the common shape (the platform note steers agents here).
    val obj = runCatching { JSONObject(propsJson) }.getOrNull()
    if (obj != null) {
        // Explicit shapes first — the agent picked them deliberately.
        obj.optString("markdown").takeIf { it.isNotEmpty() }?.let { return RenderContent.Md(it) }
        obj.optString("text").takeIf { it.isNotEmpty() }?.let { return RenderContent.Md(it) }
        // Table: {columns,rows} OR the nested {table:{columns,rows}} form (iOS parseTable).
        val tbl = obj.optJSONObject("table") ?: obj
        val cols = tbl.optJSONArray("columns"); val rows = tbl.optJSONArray("rows")
        if (cols != null && rows != null) return RenderContent.Table(cols, rows)
        obj.optJSONArray("items")?.let { return RenderContent.Items(it) }
        // Chart candidates: props.data first, then ANY array-of-objects value (iOS :71-77).
        // iOS returns .chart only for the FIRST candidate whose chartPoints SUCCEEDS,
        // advancing past non-charting ones. The old code committed to the first
        // array-of-objects regardless: given e.g. {a:[{x:"one"}], b:[{m,v},…]} it
        // charted `a` (which can't chart — 1 row / no numeric column) and rendered
        // its degenerate label/value rows, never surfacing `b`'s real chart. Collect
        // candidates and prefer the first that charts. If NONE chart, keep the first
        // array-of-objects as a Chart so DataRows still renders it as label/value rows
        // — Android's fallback iOS lacks (iOS drops it: a container value is skipped by
        // the scalar-dict path below, so it would land on .empty).
        val candidates = ArrayList<List<JSONObject>>()
        objectRows(obj.optJSONArray("data"))?.let { candidates.add(it) }
        val keys = obj.keys()
        while (keys.hasNext()) {
            objectRows(obj.optJSONArray(keys.next()))?.let { candidates.add(it) }
        }
        candidates.firstOrNull { chartPoints(it) != null }?.let { return RenderContent.Chart(it) }
        candidates.firstOrNull()?.let { return RenderContent.Chart(it) }
        // Scalar dict → sorted key/value rows (iOS :78-83) — NOT a raw JSON dump.
        // Skip nested objects/arrays/null; stringify scalars; sort by key; cap.
        val pairs = obj.keys().asSequence().mapNotNull { k ->
            val v = obj.opt(k)
            if (v == null || v == JSONObject.NULL || v is JSONObject || v is JSONArray) null
            else k to v.toString()
        }.sortedBy { it.first }.take(RENDER_LIST_CAP).toList()
        if (pairs.isNotEmpty()) return RenderContent.KeyValues(pairs)
        return RenderContent.Empty
    }
    // Top-level array (iOS :86-92): array-of-objects → chart, array-of-strings → list.
    val arr = runCatching { JSONArray(propsJson) }.getOrNull()
    if (arr != null) {
        objectRows(arr)?.let { return RenderContent.Chart(it) }
        val strings = (0 until arr.length()).mapNotNull { arr.opt(it) as? String }.take(RENDER_LIST_CAP)
        if (strings.isNotEmpty()) return RenderContent.StringList(strings)
    }
    // Not JSON at all — show the text rather than drop it (never a blank card).
    return propsJson.takeIf { it.isNotBlank() }?.let { RenderContent.Raw(it) } ?: RenderContent.Empty
}

/**
 * render_ui tool → native card from `props` ONLY. The componentCode field is
 * React source for the web client and is NEVER evaluated here (iOS parity).
 * Shapes: {data:[…]}/top-level array → chart/rows · {items:[…]} → list ·
 * {columns,rows}/{table:{…}} → table · {markdown|text} → markdown · scalar dict
 * → key/value rows · else raw text.
 */
@Composable
fun RenderUiCard(title: String?, propsJson: String) {
    val content = classifyRenderUi(propsJson)
    Surface(
        color = technology.tiny.app.ui.theme.TinyCodeBg,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            title?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            }
            when (content) {
                is RenderContent.Chart -> DataRows(content.entries)
                is RenderContent.Items -> ItemList(content.items)
                is RenderContent.Table -> SimpleTable(content.columns, content.rows)
                is RenderContent.Md -> MarkdownText(content.text)
                is RenderContent.KeyValues -> KeyValueRows(content.pairs)
                is RenderContent.StringList -> StringList(content.items)
                is RenderContent.Raw -> Text(
                    content.text.take(1200),
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                // Unclassifiable props (empty {}, or a componentCode-only call the
                // model emitted despite the native props-required tool contract): iOS
                // shows a "view on web" fallback card (RenderUi.swift .empty) rather
                // than nothing — Android used to `return` here, so the SAME call drew
                // a card on iOS/web but a blank void on this phone (the "render_ui
                // renders nothing" report). Match iOS: a titled fallback, never empty.
                RenderContent.Empty -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        Icons.Outlined.Public,
                        contentDescription = null,
                        tint = TinyGray,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        "Interactive version on the web app",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray,
                    )
                }
            }
        }
    }
}

/** Scalar-dict → aligned key/value rows (iOS keyValues path). */
@Composable
private fun KeyValueRows(pairs: List<Pair<String, String>>) {
    pairs.forEach { (k, v) ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Text(k, style = MaterialTheme.typography.labelSmall, color = TinyGray, modifier = Modifier.weight(1f))
            Text(v, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
    }
}

/** Top-level string array → bulleted list (iOS .list path). */
@Composable
private fun StringList(items: List<String>) {
    items.forEach { s ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Text("· ", color = MaterialTheme.colorScheme.primary)
            Text(s, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
    }
}

// A single (x-label, value) sample within a named series (iOS ChartPoint parity).
private data class ChartPoint(val label: String, val value: Double, val series: String)

// Palette for multi-series lines, built in-composable so series 1 follows the
// per-tiny accent (colorScheme.primary): accent → neutral gray → accent@45%.
// One-accent brand rule (iOS DESIGN.md) — the old sky/amber Material leftovers
// were the only chrome off the tiny's palette.
@Composable
private fun seriesColors(): List<Color> = listOf(
    MaterialTheme.colorScheme.primary,
    TinyGray,
    MaterialTheme.colorScheme.primary.copy(alpha = 0.45f),
)

/**
 * Extract chart points the way iOS `chartPoints` does: every key that is numeric
 * across ALL rows becomes a series (up to 3, sorted); the first all-string key is
 * the x label. ≥2 rows required. Returns null when there's no numeric column —
 * caller then falls back to key-value rows. Rows capped at 60 (iOS parity).
 */
private fun chartPoints(entries: List<JSONObject>): Pair<List<ChartPoint>, Int>? {
    if (entries.size < 2) return null
    val keys = entries.first().keys().asSequence().toList()
    // org.json stores JSON true/false as Boolean (NOT Number), so `is Number`
    // already excludes booleans — no NSNumber-style bridging pitfall as on iOS.
    val numericKeys = keys.filter { k -> entries.all { it.opt(k) is Number } }.sorted()
    if (numericKeys.isEmpty()) return null
    val labelKey = keys.sorted().firstOrNull { k -> entries.all { it.opt(k) is String } }
    val seriesKeys = numericKeys.take(3)
    val points = ArrayList<ChartPoint>()
    entries.take(60).forEachIndexed { i, row ->
        val label = labelKey?.let { row.opt(it) as? String } ?: (i + 1).toString()
        for (k in seriesKeys) {
            val raw = (row.opt(k) as? Number)?.toDouble() ?: 0.0
            // Non-finite (agent JSON -1e400 → -inf, NaN) breaks axis math → coerce to 0 (iOS parity).
            points.add(ChartPoint(label, if (raw.isFinite()) raw else 0.0, k))
        }
    }
    return points to seriesKeys.size
}

@Composable
private fun DataRows(entries: List<JSONObject>) {
    val chart = chartPoints(entries)
    if (chart != null) {
        val (points, seriesCount) = chart
        val labelCount = points.map { it.label }.distinct().size
        // Few categories, one series → bars; dense or multi-series → lines (iOS parity).
        if (seriesCount == 1 && labelCount <= 10) BarChart(points) else LineChart(points, seriesCount)
        return
    }
    // No numeric column across every row → key-value rows (agent-varied label keys).
    fun labelOf(e: JSONObject) = e.optString("label")
        .ifEmpty { e.optString("name") }
        .ifEmpty { e.optString("x") }
    fun valueOf(e: JSONObject): Any? = e.opt("value") ?: e.opt("y") ?: e.opt("count")
    entries.forEach { e ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Text(labelOf(e), style = MaterialTheme.typography.labelSmall,
                color = TinyGray, modifier = Modifier.weight(1f))
            Text(valueOf(e)?.toString().orEmpty(), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// Single-series small-category chart → labelled proportional accent bars.
@Composable
private fun BarChart(points: List<ChartPoint>) {
    val max = points.maxOf { it.value }.takeIf { it > 0 } ?: 1.0
    points.forEach { p ->
        Column {
            Row(Modifier.fillMaxWidth()) {
                Text(p.label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                Text(trimNum(p.value), style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            Box(
                Modifier
                    .fillMaxWidth(fraction = (p.value / max).toFloat().coerceIn(0.02f, 1f))
                    .height(6.dp)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.8f), RoundedCornerShape(3.dp)),
            )
        }
    }
}

// Dense or multi-series data → line chart (one polyline per series), a legend,
// and min/max y guides. Matches iOS's LineMark+PointMark+chartLegend path.
@Composable
private fun LineChart(points: List<ChartPoint>, seriesCount: Int) {
    val seriesNames = points.map { it.series }.distinct()
    // Stable x order = first-seen label order (rows already in agent order).
    val labels = points.map { it.label }.distinct()
    val minV = points.minOf { it.value }
    val maxV = points.maxOf { it.value }
    val span = (maxV - minV).takeIf { it > 0 } ?: 1.0
    val palette = seriesColors()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.fillMaxWidth().height(150.dp)) {
            val n = labels.size
            fun x(i: Int) = if (n <= 1) 0f else size.width * i / (n - 1)
            fun y(v: Double) = size.height * (1f - ((v - minV) / span).toFloat())
            seriesNames.forEachIndexed { si, name ->
                val color = palette[si % palette.size]
                val byLabel = points.filter { it.series == name }.associate { it.label to it.value }
                val path = Path()
                var started = false
                labels.forEachIndexed { i, lbl ->
                    val v = byLabel[lbl] ?: return@forEachIndexed
                    val px = x(i); val py = y(v)
                    if (!started) { path.moveTo(px, py); started = true } else path.lineTo(px, py)
                    // Point marker only when the series isn't too dense (iOS drops symbols >20 labels).
                    if (n <= 20) drawCircle(color, radius = 3.dp.toPx(), center = Offset(px, py))
                }
                drawPath(path, color, style = Stroke(width = 2.dp.toPx()))
            }
        }
        // y-range guide + legend (shown only for multi-series, iOS parity).
        Row(Modifier.fillMaxWidth()) {
            Text("${trimNum(minV)} – ${trimNum(maxV)}", style = MaterialTheme.typography.labelSmall, color = TinyGray)
        }
        if (seriesCount > 1) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                seriesNames.forEachIndexed { si, name ->
                    Row(verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(Modifier.size(8.dp).background(palette[si % palette.size], CircleShape))
                        Text(name, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    }
                }
            }
        }
    }
}

@Composable
private fun ItemList(items: JSONArray) {
    for (i in 0 until items.length()) {
        val raw = items.opt(i)
        // render_ui props are freeform: a list item arrives as a plain string OR
        // as an object ({label/title/name/text} + optional value/detail/subtitle).
        // .toString() on an object dumped raw JSON ({"label":"x"…}) — pull a
        // readable label + trailing detail instead.
        val obj = raw as? JSONObject
        val label = obj?.let {
            it.optString("label").ifEmpty { it.optString("title") }
                .ifEmpty { it.optString("name") }.ifEmpty { it.optString("text") }
                .ifEmpty { it.toString() } // no known key → raw JSON beats dropping it
        } ?: raw?.toString().orEmpty()
        val detail = obj?.let {
            // Alias chain mirrors iOS firstString(value/detail/subtitle/description)
            // — `description` was missing here, so {label, description} items dropped
            // their detail on Android alone while iOS/web showed it.
            (it.opt("value") ?: it.opt("detail") ?: it.opt("subtitle") ?: it.opt("description"))?.toString()
        }?.takeIf { it.isNotEmpty() }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Text("· ", color = MaterialTheme.colorScheme.primary)
            Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            detail?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray) }
        }
    }
}

@Composable
private fun SimpleTable(columns: JSONArray, rows: JSONArray) {
    Row(Modifier.fillMaxWidth()) {
        for (c in 0 until columns.length()) {
            Text(
                columns.opt(c)?.toString().orEmpty(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
        }
    }
    for (r in 0 until rows.length()) {
        // render_ui props are freeform, so a row arrives EITHER as a positional
        // array (["a","b"]) OR as an object keyed by column name ({col:"a"}). The
        // object shape used to be dropped (optJSONArray→null→continue), leaving a
        // header with an empty body — read cells by column name in that case.
        val arr = rows.optJSONArray(r)
        val obj = if (arr == null) rows.optJSONObject(r) else null
        if (arr == null && obj == null) continue
        Row(Modifier.fillMaxWidth()) {
            for (c in 0 until columns.length()) {
                val cell = if (arr != null) arr.opt(c)
                           else obj!!.opt(columns.opt(c)?.toString().orEmpty())
                Text(
                    cell?.toString().orEmpty(),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

internal fun trimNum(v: Double): String =
    // Locale.US pins the dot decimal — the bare "%.2f".format(v) uses the device
    // locale, so a de/fr/tr phone would render "1,25" where web (toFixed) and iOS
    // (String(format:)) always emit "1.25", diverging the render_ui table/chart text.
    if (v == v.toLong().toDouble()) v.toLong().toString() else String.format(java.util.Locale.US, "%.2f", v)
