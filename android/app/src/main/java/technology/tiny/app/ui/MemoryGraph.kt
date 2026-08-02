package technology.tiny.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Schema
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray
import kotlin.coroutines.coroutineContext
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Memory graph — the native port of web components/chat/MemoryGraph.tsx: the
 * user's fact graph rendered as a force-directed node-link layout instead of a
 * flat list. Data from GET /api/graph?all=1 (session-authed; route 503s {error}
 * on outage → gated distinct from empty). iOS has NO graph viz (only a memory
 * list), so this matches web + exceeds iOS.
 *
 * Visual grammar mirrors web: accent = live fact, grey = closed history; within
 * live, fill brightness encodes recency (fresher = brighter). Node radius encodes
 * degree (hubs read as hubs). Tap a node to select (detail card + edge highlight);
 * drag to pan, pinch to zoom. The simulation runs cooled ticks then settles.
 */

data class VizNode(
    val id: String,
    val wireId: String,
    val label: String,
    val source: String?,
    val live: Boolean,
    val validFrom: Long?,
    val validTo: Long?,
)

data class VizEdge(
    val id: String,
    val src: String,
    val dst: String,
    val rel: String,
    val scope: String?,
    val closed: Boolean,
)

/** Mutable physics body — position + velocity, pinned once dragged. */
private class SimNode(val n: VizNode, var x: Float, var y: Float, val r: Float) {
    var vx = 0f
    var vy = 0f
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GraphSheet(app: TinyApp, onDismiss: () -> Unit) {
    var nodes by remember { mutableStateOf<List<VizNode>?>(null) }
    var edges by remember { mutableStateOf<List<VizEdge>>(emptyList()) }
    var failed by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    // History = closed/superseded facts too. Web MemoryPanel appends &include_closed=1;
    // default off so the graph shows only what's currently true.
    var history by remember { mutableStateOf(false) }

    LaunchedEffect(reloadKey, history) {
        failed = null
        nodes = null
        // 🕸 Screenshot harness (debug builds only) — see GraphHarness for why this
        // can't be a seeded file like the chat shots, and for exactly which parts of
        // the render stay real. Returns BEFORE the fetch so no request is made.
        if (GraphHarness.enabled(technology.tiny.app.BuildConfig.DEBUG, app.graphHarness)) {
            val (n, e) = GraphHarness.graph(history)
            nodes = n
            edges = e
            return@LaunchedEffect
        }
        val res = runCatching {
            app.api.getJson("/api/graph?all=1" + if (history) "&include_closed=1" else "")
        }.getOrNull()
        // One rule for all six list sheets ([LoadFailure]) — keep DISTINCT from a
        // clean empty graph so an outage doesn't tell a user with a rich graph they
        // have none (route comment: NOT masked-empty). The rule asks whether `nodes`
        // ARRIVED, which a 200 that wasn't JSON fails while satisfying `status < 400`.
        //
        // The `error` gate stays, and stays SEPARATE: this route can answer a 2xx
        // whose body carries an `error` string, which is the server declining inside
        // a well-formed response — invisible to a shape check.
        val body = LoadFailure.loaded(res, "nodes")
            ?.takeIf { it.optString("error").isEmpty() }
        if (body == null) {
            failed = LoadFailure.contentMessage(res, "nodes", "your memory graph")
                ?: LoadFailure.unusableBody("your memory graph")
            return@LaunchedEffect
        }
        val nArr = body.optJSONArray("nodes")
        nodes = (0 until (nArr?.length() ?: 0)).mapNotNull { i ->
            nArr?.optJSONObject(i)?.let { o ->
                VizNode(
                    id = o.optString("id"),
                    wireId = o.optString("wire_id"),
                    label = o.optString("label"),
                    source = o.optString("source").takeIf { it.isNotEmpty() },
                    live = o.optString("freshness") != "closed",
                    validFrom = o.optLong("valid_from").takeIf { it > 0 },
                    validTo = o.optLong("valid_to").takeIf { it > 0 },
                )
            }
        }
        val eArr = body.optJSONArray("edges")
        edges = (0 until (eArr?.length() ?: 0)).mapNotNull { i ->
            eArr?.optJSONObject(i)?.let { o ->
                VizEdge(
                    id = o.optString("id"),
                    src = o.optString("src"),
                    dst = o.optString("dst"),
                    rel = o.optString("rel"),
                    scope = o.optString("scope").takeIf { it.isNotEmpty() },
                    closed = o.optLong("valid_to").takeIf { it > 0 } != null,
                )
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().height(560.dp).padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                SheetTitle(Icons.Outlined.Schema, "memory graph")
                Spacer(Modifier.weight(1f))
                // History toggle — folds in closed/superseded facts (web include_closed).
                FilterChip(
                    selected = history,
                    onClick = { history = !history },
                    label = { Text("history", style = MaterialTheme.typography.labelSmall) },
                )
            }
            Spacer(Modifier.height(8.dp))
            when {
                failed != null -> Column(Modifier.padding(vertical = 8.dp)) {
                    Text(failed!!, color = TinyGray, style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                        Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                    }
                }
                nodes == null -> SheetLoading()
                nodes!!.isEmpty() -> Text(
                    "no memories yet — teach your tiny something and it'll graph here",
                    color = TinyGray, style = MaterialTheme.typography.bodyMedium,
                )
                else -> MemoryGraphCanvas(nodes!!, edges, Modifier.weight(1f).fillMaxWidth())
            }
        }
    }
}

@Composable
private fun MemoryGraphCanvas(nodes: List<VizNode>, edges: List<VizEdge>, modifier: Modifier) {
    val measurer = rememberTextMeasurer()

    // Degree → radius (hubs read as hubs), mirroring web.
    val degree = remember(edges) {
        val d = HashMap<String, Int>()
        for (e in edges) { d[e.src] = (d[e.src] ?: 0) + 1; d[e.dst] = (d[e.dst] ?: 0) + 1 }
        d
    }
    // Recency span for the live-fill brightness ramp (fresher = brighter).
    val recency = remember(nodes) { recencySpan(nodes) }

    // Physics bodies (seeded once per dataset with a golden-angle spiral —
    // deterministic, stable layout). A frame counter republishes positions.
    val sim = remember(nodes, edges) {
        nodes.mapIndexed { i, n ->
            val a = i * 2.39996f
            val r = 14f * sqrt((i + 1).toFloat())
            SimNode(n, cos(a) * r, sin(a) * r, min(6f + (degree[n.id] ?: 0) * 2f, 14f))
        }
    }
    val byId = remember(sim) { sim.associateBy { it.n.id } }
    var frame by remember(sim) { mutableStateOf(0) }
    var selected by remember(sim) { mutableStateOf<String?>(null) }

    // Camera: world offset + scale (screen px per world unit).
    var camScale by remember(sim) { mutableStateOf(1f) }
    var camOffset by remember(sim) { mutableStateOf(Offset.Zero) }
    var canvasSize by remember { mutableStateOf(Offset.Zero) }
    var didFit by remember(sim) { mutableStateOf(false) }

    // Cooled force loop (web step()): repulsion + edge springs + centering.
    LaunchedEffect(sim) {
        var alpha = 1f
        while (coroutineContext.isActive && alpha > 0.02f) {
            for (i in sim.indices) {
                for (j in i + 1 until sim.size) {
                    val a = sim[i]; val b = sim[j]
                    var dx = b.x - a.x; var dy = b.y - a.y
                    var d2 = dx * dx + dy * dy
                    if (d2 < 1f) { dx = 0.5f; dy = -0.5f; d2 = 1f }
                    val f = min(2600f / d2, 8f) * alpha
                    val d = sqrt(d2)
                    val fx = dx / d * f; val fy = dy / d * f
                    a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
                }
            }
            for (e in edges) {
                val a = byId[e.src] ?: continue; val b = byId[e.dst] ?: continue
                val dx = b.x - a.x; val dy = b.y - a.y
                val d = sqrt(dx * dx + dy * dy).coerceAtLeast(1f)
                val f = (d - 130f) * 0.02f * alpha
                val fx = dx / d * f; val fy = dy / d * f
                a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
            }
            for (n in sim) {
                n.vx -= n.x * 0.005f * alpha; n.vy -= n.y * 0.005f * alpha
                n.vx *= 0.85f; n.vy *= 0.85f
                n.x += n.vx; n.y += n.vy
            }
            alpha *= 0.995f
            frame++
            delay(16)
        }
        // Settled: fit the camera to the layout once (web setView fit).
        if (sim.isNotEmpty() && canvasSize != Offset.Zero && !didFit) {
            var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
            var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
            for (n in sim) {
                if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x
                if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y
            }
            camScale = graphFitScale(maxX - minX, maxY - minY, canvasSize.x, canvasSize.y)
            // Center the graph centroid in the viewport.
            val cx = (minX + maxX) / 2; val cy = (minY + maxY) / 2
            camOffset = Offset(canvasSize.x / 2 - cx * camScale, canvasSize.y / 2 - cy * camScale)
            didFit = true
        }
    }

    // Resolved here (composable scope) — the Canvas DrawScope below can't
    // read MaterialTheme; follows the per-tiny accent like the rest of the UI.
    val accent = MaterialTheme.colorScheme.primary
    Column(modifier) {
        Canvas(
            Modifier.weight(1f).fillMaxWidth()
                .pointerInput(sim) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        camScale = (camScale * zoom).coerceIn(0.1f, 6f)
                        camOffset += pan
                    }
                }
                .pointerInput(sim) {
                    detectTapGestures { tap ->
                        // Hit-test in world space (inverse of the camera transform).
                        val wx = (tap.x - camOffset.x) / camScale
                        val wy = (tap.y - camOffset.y) / camScale
                        val hit = sim.minByOrNull { (it.x - wx) * (it.x - wx) + (it.y - wy) * (it.y - wy) }
                        selected = if (hit != null &&
                            sqrt((hit.x - wx) * (hit.x - wx) + (hit.y - wy) * (hit.y - wy)) < (hit.r + 10f)
                        ) {
                            if (selected == hit.n.id) null else hit.n.id
                        } else null
                    }
                },
        ) {
            canvasSize = Offset(size.width, size.height)
            @Suppress("UNUSED_EXPRESSION") frame // read → recompose-per-tick
            drawGraph(sim, edges, byId, selected, camScale, camOffset, recency, measurer, accent)
        }

        // Legend + selected-fact detail card (web legend + detail card).
        Text(
            "${nodes.size} facts · ${edges.size} links  ·  🟢 live (brighter = newer) · ⚪ closed",
            style = MaterialTheme.typography.labelSmall, color = TinyGray,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        selected?.let { id ->
            byId[id]?.let { s ->
                val links = edges.count { it.src == id || it.dst == id }
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(
                        "${if (s.n.live) "🟢" else "⚪"} #${s.n.wireId}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface,
                    )
                    // Bitemporal validity line — "learned <date>[ · closed <date>]"
                    // (iOS MemoryGraph.swift:308 / web MemoryGraph.tsx:447-449 parity).
                    // validFrom/validTo are epoch seconds; formatToolCreated → "Jul 23, 2026".
                    graphValidityLine(s.n.validFrom, s.n.validTo)?.let { line ->
                        Text(line, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    }
                    Text(
                        s.n.source ?: s.n.label,
                        style = MaterialTheme.typography.bodySmall, color = TinyGray, maxLines = 3,
                    )
                    if (links > 0) Text(
                        "$links link${if (links > 1) "s" else ""} — highlighted above",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

/**
 * The selected-node bitemporal validity line — "learned <date>[ · closed <date>]"
 * (iOS MemoryGraph.swift:308 / web MemoryGraph.tsx:447-449). [validFrom]/[validTo]
 * are epoch seconds (null when absent). Dates render via formatToolCreated →
 * "Jul 23, 2026" (the shared en-US "MMM d, yyyy" UTC shape iOS/web both use).
 * Returns null when there's no learned date so the caller omits the line entirely.
 */
internal fun graphValidityLine(validFrom: Long?, validTo: Long?): String? {
    val learned = validFrom?.let { formatToolCreated(it) } ?: return null
    val closed = validTo?.let { formatToolCreated(it) }
    return "learned $learned" + (closed?.let { " · closed $it" } ?: "")
}

/**
 * Screen px per world unit that fits a settled layout into a [viewW]×[viewH] canvas
 * — the twin of iOS `GraphSim.fitScale` (MemoryGraph.swift).
 *
 * This was `min(canvasW, canvasH) / (max(spanX, spanY) + 120)`, and both halves of
 * that were wrong in the same way iOS's hardcoded-340 version was:
 *  - **`min(canvasW, canvasH)` throws away the long axis.** A phone canvas is far
 *    taller than it is wide, so the fit was computed as if the viewport were square
 *    at its NARROW dimension — the graph settled into a small central island with
 *    most of the height unused.
 *  - **`max(spanX, spanY)` drives both axes.** A wide-and-short layout (the usual
 *    spring/repulsion outcome) got scaled by its width and then left vertically
 *    tiny; a tall-and-narrow one under-zoomed for the opposite reason.
 * Fitting each axis against its own viewport dimension and taking the tighter of
 * the two is what "fit to view" means.
 *
 * [labelPad] reserves px for the captions, which are drawn at a fixed sp size above
 * each node and therefore do NOT scale with the camera — a world-unit margin (the
 * old `+ m * 2`) cannot reserve room for them, which is why labels clipped off the
 * canvas edges. Padding never eats more than 70% of a dimension, so a small canvas
 * still gets a sane scale instead of collapsing to the floor.
 *
 * Returns 1f (neutral) for an unmeasured canvas or a zero-span layout (single node),
 * rather than clamping to the minimum and flashing a pinhole graph.
 */
internal fun graphFitScale(
    spanX: Float,
    spanY: Float,
    viewW: Float,
    viewH: Float,
    labelPad: Float = 74f,
    minScale: Float = 0.15f,
    maxScale: Float = 4f,
): Float {
    if (viewW <= 0f || viewH <= 0f) return 1f
    val availW = (viewW - labelPad * 2).coerceAtLeast(viewW * 0.3f)
    val availH = (viewH - labelPad * 2).coerceAtLeast(viewH * 0.3f)
    val sx = if (spanX > 0f) availW / spanX else Float.MAX_VALUE
    val sy = if (spanY > 0f) availH / spanY else Float.MAX_VALUE
    val s = min(sx, sy)
    if (s == Float.MAX_VALUE || !s.isFinite()) return 1f
    return s.coerceIn(minScale, maxScale)
}

/**
 * The min/max valid_from span across LIVE dated nodes, driving liveFill's
 * recency brightness ramp — or null when there's nothing to ramp. Byte-for-byte
 * twin of web's recencySpan (MemoryGraph.tsx:297-302 `max > min ? … : null`) and
 * iOS recencySpan() (MemoryGraph.swift:339-342 `hi > lo else return nil`). The
 * `mx > mn` collapse is load-bearing: when every live dated node shares ONE
 * timestamp (or there's a single dated node), a span would make liveFill divide
 * by zero — `(vf - mn)/(mx - mn)` = 0/0 = NaN → an invisible node. Returning null
 * makes all nodes fall to the 0.85 default instead. Extracted from the composable
 * so this guard is pinnable. Considers only live+dated nodes (closed history
 * draws grey, undated nodes have no position on the ramp).
 */
internal fun recencySpan(nodes: List<VizNode>): Pair<Long, Long>? {
    val ts = nodes.filter { it.live && it.validFrom != null }.map { it.validFrom!! }
    if (ts.isEmpty()) return null
    val mn = ts.min(); val mx = ts.max()
    return if (mx > mn) mn to mx else null
}

/** The dash style a graph edge draws with — solid, or one of the two dashed kinds. */
internal enum class EdgeDash { NONE, CLOSED, SUPERSEDES }

/**
 * Which dash an edge renders with, given whether it's closed (bitemporally retired)
 * and its relation. CLOSED takes precedence over SUPERSEDES: an edge that is BOTH a
 * supersedes relation AND closed reads as history, so it gets the "3 3" closed dash —
 * matching web (MemoryGraph.tsx:350 `closed ? "3 3" : supersedes ? "6 3" : undefined`)
 * and iOS (MemoryGraph.swift:252 `if closed … else if supersedes …`). Extracted so the
 * precedence is pinned by a test — Android previously checked supersedes first, so the
 * same edge drew a different dash than the other two clients.
 */
internal fun edgeDash(closed: Boolean, rel: String): EdgeDash = when {
    closed -> EdgeDash.CLOSED
    rel == "supersedes" -> EdgeDash.SUPERSEDES
    else -> EdgeDash.NONE
}

private val ACCENT_RGB = Triple(0, 255, 136)

/** Live-fill brightness ramp (web liveFill): fresher facts render brighter. */
private fun liveFill(n: VizNode, recency: Pair<Long, Long>?): Color {
    val (r, g, b) = ACCENT_RGB
    val alpha = if (recency == null || n.validFrom == null) 0.85f else {
        val (mn, mx) = recency
        val t = (n.validFrom - mn).toFloat() / (mx - mn).toFloat()
        (0.3f + t * 0.65f)
    }
    return Color(r, g, b, (alpha * 255).toInt())
}

private fun DrawScope.drawGraph(
    sim: List<SimNode>,
    edges: List<VizEdge>,
    byId: Map<String, SimNode>,
    selected: String?,
    scale: Float,
    offset: Offset,
    recency: Pair<Long, Long>?,
    measurer: TextMeasurer,
    // Resolved in the composable caller — DrawScope can't read MaterialTheme.
    accent: Color,
) {
    fun sx(wx: Float) = wx * scale + offset.x
    fun sy(wy: Float) = wy * scale + offset.y
    val touching = HashSet<String>()
    if (selected != null) for (e in edges) if (e.src == selected || e.dst == selected) {
        touching.add(e.src); touching.add(e.dst)
    }

    // Edges (recessive; selection lights the incident set). Dashed for closed
    // history (web "3 3") and supersedes (web "6 3") — solid otherwise. CLOSED
    // takes precedence: an edge that is BOTH a supersedes relation AND closed
    // reads as history, so the "3 3" dash wins (web MemoryGraph.tsx:350
    // `closed ? "3 3" : supersedes ? "6 3" : undefined`, iOS MemoryGraph.swift:252
    // `if closed … else if supersedes …`). Checking supersedes first would render
    // the same edge with a different dash than the other two clients.
    val supersedesDash = PathEffect.dashPathEffect(floatArrayOf(6f, 3f))
    val closedDash = PathEffect.dashPathEffect(floatArrayOf(3f, 3f))
    for (e in edges) {
        val a = byId[e.src] ?: continue; val b = byId[e.dst] ?: continue
        val hot = selected != null && (e.src == selected || e.dst == selected)
        val dash = when (edgeDash(e.closed, e.rel)) {
            EdgeDash.CLOSED -> closedDash
            EdgeDash.SUPERSEDES -> supersedesDash
            EdgeDash.NONE -> null
        }
        drawLine(
            color = if (hot) accent else Color(255, 255, 255, 40),
            start = Offset(sx(a.x), sy(a.y)),
            end = Offset(sx(b.x), sy(b.y)),
            strokeWidth = if (hot) 2.5f else 1.4f,
            pathEffect = dash,
        )
    }

    // Nodes + labels.
    for (s in sim) {
        val isSel = s.n.id == selected
        val dim = selected != null && !isSel && !touching.contains(s.n.id)
        val baseFill = if (!s.n.live) Color(255, 255, 255, 56) else liveFill(s.n, recency)
        val fill = if (dim) baseFill.copy(alpha = baseFill.alpha * 0.25f) else baseFill
        val cx = sx(s.x); val cy = sy(s.y); val rad = s.r * scale
        drawCircle(color = fill, radius = rad, center = Offset(cx, cy))
        drawCircle(
            color = if (isSel) Color.White else if (!s.n.live) Color(255, 255, 255, 90) else accent,
            radius = rad, center = Offset(cx, cy), style = Stroke(if (isSel) 2.5f else 1.2f),
        )
        // Label: always for the selection/hubs; others only when reasonably zoomed.
        if (isSel || s.r > 6f || scale > 0.9f) {
            val caption = (s.n.source ?: s.n.label).replace(Regex("\\s+"), " ").trim()
                .let { if (it.length > 26) it.take(25) + "…" else it }
            val text = if (isSel) "#${s.n.wireId} · $caption" else caption
            val layout = measurer.measure(
                text,
                style = TextStyle(
                    color = if (isSel) Color.White else if (!s.n.live) Color(255, 255, 255, 115) else Color(255, 255, 255, 200),
                    fontSize = if (isSel) 12.sp else 10.sp,
                ),
            )
            drawText(layout, topLeft = Offset(cx - layout.size.width / 2f, cy - rad - layout.size.height - 2f))
        }
    }
}
