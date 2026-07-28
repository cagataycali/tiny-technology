package technology.tiny.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import technology.tiny.app.ui.theme.TinyGray

/**
 * Native spawn_agents fan-out tree (iOS TaskTree.swift / web TaskTree.tsx).
 *
 * Tool input arrives at beforeToolCallEvent (tasks known, all "running"), the
 * batch result lands with afterToolCallEvent and flips nodes to ✓/✗. Rows expand
 * to show each sub-agent's result text.
 */
data class SpawnNode(
    val id: Int,          // 1-based task number
    val prompt: String,
    val ok: Boolean? = null, // null = running
    val result: String? = null,
)

data class SpawnTree(
    val id: String,       // toolUseId
    val nodes: List<SpawnNode>,
    val elapsedMs: Double? = null,
) {
    /** Parse the spawn_agents tool-result JSON: {ok, elapsed_ms, results:[{task, ok, result?, error?}]}. */
    fun applyResults(resultsJson: String): SpawnTree {
        val obj = runCatching { JSONObject(resultsJson) }.getOrNull() ?: return this
        val elapsed = if (obj.has("elapsed_ms")) obj.optDouble("elapsed_ms") else null
        val results = obj.optJSONArray("results")
        val byTask = HashMap<Int, Pair<Boolean, String?>>()
        for (i in 0 until (results?.length() ?: 0)) {
            val r = results!!.optJSONObject(i) ?: continue
            val task = r.optInt("task", -1)
            if (task < 0) continue
            val ok = r.optBoolean("ok", false)
            val text = r.optString("result").takeIf { it.isNotEmpty() }
                ?: r.optString("error").takeIf { it.isNotEmpty() }
            byTask[task] = ok to text
        }
        val updated = nodes.map { n ->
            byTask[n.id]?.let { (ok, text) -> n.copy(ok = ok, result = text) }
            // Anything unreported is a failure (batch timeout isolation).
                ?: n.copy(ok = n.ok ?: false)
        }
        return copy(nodes = updated, elapsedMs = elapsed)
    }
}

@androidx.compose.runtime.Composable
fun TaskTreeCard(tree: SpawnTree) {
    val running = tree.nodes.any { it.ok == null }
    val okCount = tree.nodes.count { it.ok == true }
    var openId by remember(tree.id) { mutableStateOf<Int?>(null) }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Color.Black.copy(alpha = 0.4f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // header
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (running) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
            } else {
                Icon(Icons.Outlined.AccountTree, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(6.dp))
            Text(
                "spawn_agents · ${tree.nodes.size} parallel",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.weight(1f))
            tree.elapsedMs?.let { ms ->
                val secs = ((ms / 100).toInt() / 10.0) // one decimal, no Locale/format dep
                Text(
                    "$okCount/${tree.nodes.size} ok · ${secs}s",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
            }
        }
        tree.nodes.forEachIndexed { i, node ->
            SpawnNodeRow(
                node = node,
                isLast = i == tree.nodes.lastIndex,
                isOpen = openId == node.id,
                onToggle = { openId = if (openId == node.id) null else node.id },
            )
        }
    }
}

@androidx.compose.runtime.Composable
private fun SpawnNodeRow(node: SpawnNode, isLast: Boolean, isOpen: Boolean, onToggle: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(
                if (isLast) "└" else "├",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.4f),
            )
            Spacer(Modifier.width(6.dp))
            Row(
                Modifier.let { if (node.result != null) it.clickable { onToggle() } else it },
                verticalAlignment = Alignment.Top,
            ) {
                StatusIcon(node.ok)
                Spacer(Modifier.width(6.dp))
                Text(
                    "#${node.id} ${node.prompt}",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (node.ok == null) TinyGray else MaterialTheme.colorScheme.onSurface,
                    maxLines = if (isOpen) Int.MAX_VALUE else 1,
                )
            }
        }
        if (isOpen && node.result != null) {
            Text(
                node.result,
                style = MaterialTheme.typography.labelMedium,
                color = if (node.ok == true) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f)
                else MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .padding(start = 18.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.3f))
                    .padding(8.dp),
            )
        }
    }
}

@androidx.compose.runtime.Composable
private fun StatusIcon(ok: Boolean?) {
    when (ok) {
        null -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = TinyGray)
        true -> Text("✓", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        false -> Text("✗", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
    }
}
