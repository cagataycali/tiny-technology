/**
 * AgentActivityAttributes — the Live Activity contract (north-star P2.1).
 * Compiled into BOTH the app and the widget extension (Shared/ sources):
 * the app starts/updates the activity around a streaming turn; the
 * TinyWidgets extension renders it on the lock screen + Dynamic Island.
 */
// Shared/ compiles into the watchOS targets too — ActivityKit only exists
// on iOS (canImport passes on Mac Catalyst but the types are marked
// unavailable there), so the whole contract is platform-guarded
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
import Foundation

struct AgentActivityAttributes: ActivityAttributes {
    /// Static per-run info
    let tiny: String
    let prompt: String   // first ~80 chars of the user prompt

    struct ContentState: Codable, Hashable {
        /// "thinking…" | "running shell…" | "3/5 agents done" | "done"
        var status: String
        /// Sub-agent progress when spawn_agents is live (0 = no fan-out)
        var tasksDone: Int
        var tasksTotal: Int
        var finished: Bool
    }
}
#endif
