/**
 * TaskTree — native spawn_agents fan-out tree (web: TaskTree.tsx).
 *
 * Tool input arrives at beforeToolCallEvent (tasks known, all "running"),
 * the batch result lands with afterToolCallEvent and flips nodes to ✓/✗.
 * Rows expand to show each sub-agent's result text.
 */
import SwiftUI

struct SpawnNode: Identifiable, Equatable, Codable {
    var id: Int          // 1-based task number
    var prompt: String
    var ok: Bool?        // nil = running
    var result: String?
}

struct SpawnTreeItem: Identifiable, Equatable, Codable {
    let id: String       // toolUseId
    var nodes: [SpawnNode]
    var elapsedMs: Double?

    /// Parse the spawn_agents tool-result JSON: {ok, elapsed_ms, results:[{task, ok, result?, error?}]}
    mutating func apply(resultsJson: String) {
        guard let data = resultsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        elapsedMs = (obj["elapsed_ms"] as? NSNumber)?.doubleValue
        let results = obj["results"] as? [[String: Any]] ?? []
        for r in results {
            guard let task = r["task"] as? Int, let i = nodes.firstIndex(where: { $0.id == task }) else { continue }
            let ok = (r["ok"] as? Bool) ?? false
            nodes[i].ok = ok
            nodes[i].result = (r["result"] as? String) ?? (r["error"] as? String)
        }
        // Anything unreported is a failure (batch timeout isolation)
        for i in nodes.indices where nodes[i].ok == nil { nodes[i].ok = false }
    }
}

struct TaskTreeCard: View {
    let item: SpawnTreeItem
    @Environment(\.tinyAccent) private var accent
    @State private var openIdx: Int?

    private var running: Bool { item.nodes.contains { $0.ok == nil } }
    private var okCount: Int { item.nodes.filter { $0.ok == true }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            ForEach(item.nodes) { node in
                SpawnNodeRow(node: node,
                             isLast: node.id == item.nodes.count,
                             isOpen: openIdx == node.id) {
                    openIdx = openIdx == node.id ? nil : node.id
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(accent.opacity(running ? 0.5 : 0.3), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 6) {
            if running {
                ProgressView().scaleEffect(0.6)
            } else {
                Text("🤖")
            }
            Text("spawn_agents · \(item.nodes.count) parallel")
                .font(.caption.weight(.semibold).monospaced())
                .foregroundStyle(accent)
            Spacer()
            if let ms = item.elapsedMs {
                let secs = String(format: "%.1f", ms / 1000)
                Text("\(okCount)/\(item.nodes.count) ok · \(secs)s")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SpawnNodeRow: View {
    @Environment(\.tinyAccent) private var accent
    let node: SpawnNode
    let isLast: Bool
    let isOpen: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                Text(isLast ? "└" : "├")
                    .font(.caption.monospaced())
                    .foregroundStyle(accent.opacity(0.4))
                Button(action: toggle) {
                    HStack(alignment: .top, spacing: 6) {
                        statusIcon
                        Text("#\(node.id) \(node.prompt)")
                            .font(.caption)
                            .foregroundStyle(node.ok == nil ? Color.secondary : Color.primary)
                            .lineLimit(isOpen ? nil : 1)
                            .multilineTextAlignment(.leading)
                    }
                }
                .disabled(node.result == nil)
            }
            if isOpen, let r = node.result {
                Text(r)
                    .font(.caption)
                    .foregroundStyle(node.ok == true ? Color.primary.opacity(0.85) : Color.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.leading, 18)
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        if node.ok == nil {
            ProgressView().scaleEffect(0.5).frame(width: 12, height: 12)
        } else if node.ok == true {
            Text("✓").font(.caption.bold()).foregroundStyle(accent)
        } else {
            Text("✗").font(.caption.bold()).foregroundStyle(Color.red)
        }
    }
}
