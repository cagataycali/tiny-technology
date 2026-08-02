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

/// What one sub-agent's row is actually saying. `ok: Bool?` alone cannot say
/// it: `nil` means four different things depending on how the BATCH ended, and
/// three of them are not failure.
enum SpawnState: Equatable, CaseIterable {
    case running       // the batch is live and this one hasn't reported yet
    case queued        // launched in the background — it reports elsewhere, later
    case succeeded
    case failed
    case didNotRun     // the batch ended and never reported this task

    /// What VoiceOver says. Lives on the state, not the row (house shape:
    /// `DevicePeek.spoken`), because `didNotRun` and `failed` SHARE a glyph —
    /// dimmed vs full red — so these words are the only thing separating "we
    /// never started this" from "this one broke".
    var spoken: String {
        switch self {
        case .running: return "running"
        case .queued: return "queued"
        case .succeeded: return "succeeded"
        case .failed: return "failed"
        case .didNotRun: return "didn't run"
        }
    }
}

struct SpawnTreeItem: Identifiable, Equatable, Codable {
    /// How the batch itself ended — the missing half of every `ok == nil`.
    enum Outcome: String, Equatable, Codable {
        case live        // tasks announced, result not in yet
        case background  // wait:false — the fan-out was LAUNCHED, not finished
        case settled     // a results array arrived
        case aborted     // the tool errored, or its payload was unreadable
    }

    let id: String       // toolUseId
    var nodes: [SpawnNode]
    var elapsedMs: Double?
    var outcome: Outcome = .live

    /// ⚠️ Old persisted history has no `outcome`, and the default must NOT be
    /// `.live` there: a restored tree can never resume — its stream is gone —
    /// so a node that never reported didn't run, rather than spinning forever
    /// in a chat the user scrolled back to.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nodes = try c.decode([SpawnNode].self, forKey: .nodes)
        elapsedMs = try c.decodeIfPresent(Double.self, forKey: .elapsedMs)
        outcome = try c.decodeIfPresent(Outcome.self, forKey: .outcome) ?? .settled
    }

    init(id: String, nodes: [SpawnNode], elapsedMs: Double?, outcome: Outcome = .live) {
        self.id = id
        self.nodes = nodes
        self.elapsedMs = elapsedMs
        self.outcome = outcome
    }

    /// The one place `ok` and `outcome` are read together. Pure, so the truth
    /// table is a test and not a screenshot.
    static func state(ok: Bool?, outcome: Outcome) -> SpawnState {
        if let ok { return ok ? .succeeded : .failed }
        switch outcome {
        case .live: return .running
        case .background: return .queued
        // Both are terminal for this node: nothing more is coming on this
        // stream, and it never reported. Saying "failed" would be a claim about
        // work the app never saw run.
        case .settled, .aborted: return .didNotRun
        }
    }

    func state(of node: SpawnNode) -> SpawnState { Self.state(ok: node.ok, outcome: outcome) }

    /// Parse the spawn_agents tool-result JSON: {ok, elapsed_ms, results:[{task, ok, result?, error?}]}
    mutating func apply(resultsJson: String) {
        guard let data = resultsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // Was a bare `return`, which left every node `nil` with the tree
            // still `.live` — the spinner that never stopped.
            outcome = .aborted
            return
        }
        // wait:false returns {ok, pending:true, batch_id, tasks} and NO results:
        // the batch is off and running, reporting later through a push and
        // use_device action:'result'. The old code read the absent results as a
        // total wipeout and painted every row red — "3 agents failed" about 3
        // agents that were all still working.
        if (obj["pending"] as? Bool) == true {
            outcome = .background
            return
        }
        elapsedMs = (obj["elapsed_ms"] as? NSNumber)?.doubleValue
        let results = obj["results"] as? [[String: Any]] ?? []
        for r in results {
            guard let task = r["task"] as? Int, let i = nodes.firstIndex(where: { $0.id == task }) else { continue }
            let ok = (r["ok"] as? Bool) ?? false
            nodes[i].ok = ok
            nodes[i].result = (r["result"] as? String) ?? (r["error"] as? String)
        }
        // An unreported task stays `nil` on purpose now. `.settled` makes it
        // read as "didn't run", which is all the app knows: the batch finished
        // and this one is simply not in the report.
        outcome = .settled
    }
}

struct TaskTreeCard: View {
    let item: SpawnTreeItem
    @Environment(\.tinyAccent) private var accent
    @State private var openIdx: Int?

    /// ⚠️ `.live` is the whole condition. Without it, a background batch (whose
    /// nodes never report on this stream) and an aborted one both spun forever.
    private var running: Bool { item.outcome == .live && item.nodes.contains { $0.ok == nil } }
    private var okCount: Int { item.nodes.filter { $0.ok == true }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            ForEach(item.nodes) { node in
                SpawnNodeRow(state: item.state(of: node),
                             node: node,
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

    /// The right-hand summary, or nothing. ⚠️ `okCount` is only an answer once a
    /// report exists: "0/3 ok" beside a background batch is a scoreboard for a
    /// game that hasn't been played.
    private var summary: String? {
        switch item.outcome {
        case .live: return nil
        case .background: return "running in the background"
        case .aborted: return "ended without reporting"
        case .settled:
            guard let ms = item.elapsedMs else { return "\(okCount)/\(item.nodes.count) ok" }
            return "\(okCount)/\(item.nodes.count) ok · \(String(format: "%.1f", ms / 1000))s"
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            if running {
                ProgressView().scaleEffect(0.6)
            } else {
                // SF Symbol, not the 🤖 that was here: the house rule (and the
                // web's IconCpu) — and VoiceOver reads an emoji aloud as
                // "robot face" in the middle of a status line.
                Image(systemName: "cpu")
                    .font(.caption)
                    .foregroundStyle(accent)
                    .accessibilityHidden(true)
            }
            Text("spawn_agents · \(item.nodes.count) parallel")
                .font(.caption.weight(.semibold).monospaced())
                .foregroundStyle(accent)
            Spacer()
            if let summary {
                Text(summary)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SpawnNodeRow: View {
    @Environment(\.tinyAccent) private var accent
    let state: SpawnState
    let node: SpawnNode
    let isLast: Bool
    let isOpen: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                // Decorative rail. Unhidden, VoiceOver announces the box-drawing
                // character before every prompt.
                Text(isLast ? "└" : "├")
                    .font(.caption.monospaced())
                    .foregroundStyle(accent.opacity(0.4))
                    .accessibilityHidden(true)
                Button(action: toggle) {
                    HStack(alignment: .top, spacing: 6) {
                        statusIcon
                        Text("#\(node.id) \(node.prompt)")
                            .font(.caption)
                            .foregroundStyle(state == .succeeded || state == .failed
                                             ? Color.primary : Color.secondary)
                            .lineLimit(isOpen ? nil : 1)
                            .multilineTextAlignment(.leading)
                    }
                }
                .disabled(node.result == nil)
                // The glyph carries the state, so it has to be spoken. Without
                // it a VoiceOver user hears every prompt and not one outcome —
                // the one thing that matters in a tree of parallel agents.
                .accessibilityLabel("#\(node.id) \(node.prompt), \(state.spoken)")
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
        switch state {
        case .running:
            ProgressView().scaleEffect(0.5).frame(width: 12, height: 12)
        case .queued:
            // A dot, not a spinner: nothing is happening on this screen, and a
            // spinner promises an update that will arrive by push instead.
            Text("·").font(.caption.bold()).foregroundStyle(.secondary)
        case .succeeded:
            Text("✓").font(.caption.bold()).foregroundStyle(accent)
        case .failed:
            Text("✗").font(.caption.bold()).foregroundStyle(Color.red)
        case .didNotRun:
            // Dimmed, because the app is not claiming this one ran and broke.
            Text("✗").font(.caption.bold()).foregroundStyle(Color.red.opacity(0.55))
        }
    }
}
