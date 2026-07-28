/**
 * AgentLive — drives the Live Activity around a streaming turn (P2.1).
 *
 * ChatModel calls start(prompt:) on send, tool(_:) / spawn(_:_:) as
 * events arrive, and finish() at stream end. The lock-screen card and
 * Dynamic Island render from AgentActivityAttributes (Shared/) in the
 * TinyWidgets extension. Foreground-start only (background starts need
 * push tokens); update/end work from anywhere.
 */
// ActivityKit imports on Mac Catalyst but its types are unavailable there —
// the Catalyst build gets a same-shape no-op so ChatModel call sites compile
#if targetEnvironment(macCatalyst)
import Foundation

@MainActor
final class AgentLive {
    static let shared = AgentLive()
    private init() {}
    func start(tiny: String, prompt: String) {}
    func tool(_ name: String?) {}
    func spawn(done: Int, total: Int) {}
    func finish(error: Bool = false) {}
}
#else
import ActivityKit
import Foundation

/// Launders a non-Sendable-but-thread-safe SDK handle across a Task hop
/// (ActivityKit update/end are documented thread-safe; the SDK predates
/// Sendable — same story as BGTask in Background.swift)
private struct UncheckedBox<T>: @unchecked Sendable { let value: T }

@MainActor
final class AgentLive {
    static let shared = AgentLive()
    private var activity: Activity<AgentActivityAttributes>?
    private init() {}

    func start(tiny: String, prompt: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()  // one live turn at a time
        let attrs = AgentActivityAttributes(tiny: tiny, prompt: String(prompt.prefix(80)))
        let state = AgentActivityAttributes.ContentState(status: "thinking…", tasksDone: 0, tasksTotal: 0, finished: false)
        activity = try? Activity.request(
            attributes: attrs,
            content: .init(state: state, staleDate: Date().addingTimeInterval(10 * 60))
        )
    }

    func tool(_ name: String?) {
        update { s in s.status = name.map { "running \($0)…" } ?? "thinking…" }
    }

    func spawn(done: Int, total: Int) {
        update { s in
            s.tasksDone = done
            s.tasksTotal = total
            s.status = "\(done)/\(total) agents done"
        }
    }

    func finish(error: Bool = false) {
        guard let activity else { return }
        var s = activity.content.state
        s.status = error ? "failed" : "done"
        s.finished = true
        let content = ActivityContent(state: s, staleDate: .now)
        // ActivityKit update/end are thread-safe; the SDK just predates
        // Sendable (same story as BGTask in Background.swift)
        nonisolated(unsafe) let held = activity
        Task { @MainActor in
            // Linger 2s on the island so "done" is visible, then dismiss.
            await held.update(content)
            try? await Task.sleep(for: .seconds(2))
            await held.end(content, dismissalPolicy: .immediate)
        }
        self.activity = nil
    }

    private func end() {
        if let held = activity {
            let box = UncheckedBox(value: held)
            Task { await box.value.end(box.value.content, dismissalPolicy: .immediate) }
            activity = nil
        }
    }

    private func update(_ mutate: (inout AgentActivityAttributes.ContentState) -> Void) {
        guard let activity else { return }
        var s = activity.content.state
        mutate(&s)
        let content = ActivityContent(state: s, staleDate: Date().addingTimeInterval(10 * 60))
        nonisolated(unsafe) let held = activity
        Task { @MainActor in await held.update(content) }
    }
}
#endif
