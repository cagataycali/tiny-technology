/**
 * AgentLiveWidget — lock-screen card + Dynamic Island for a running agent
 * turn (P2.1). Renders AgentActivityAttributes; the app drives the state.
 */
import ActivityKit
import WidgetKit
import SwiftUI

struct AgentLiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            // ── Lock screen / banner ──
            HStack(spacing: 10) {
                Text("🌱")
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.prompt)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    HStack(spacing: 6) {
                        if !context.state.finished {
                            ProgressView().scaleEffect(0.55).frame(width: 10, height: 10)
                        }
                        Text(context.state.status)
                            .font(.caption2)
                            .foregroundStyle(context.state.finished ? .green : .secondary)
                    }
                }
                Spacer()
                if context.state.tasksTotal > 0 {
                    ProgressView(value: Double(context.state.tasksDone), total: Double(context.state.tasksTotal))
                        .progressViewStyle(.circular)
                        .tint(.green)
                        .frame(width: 24, height: 24)
                }
            }
            .padding(12)
            .activityBackgroundTint(Color.black.opacity(0.8))
            .activitySystemActionForegroundColor(.green)
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Expanded ──
                DynamicIslandExpandedRegion(.leading) {
                    Text("🌱").font(.title2)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.prompt)
                            .font(.caption)
                            .lineLimit(1)
                        Text(context.state.status)
                            .font(.caption2)
                            .foregroundStyle(context.state.finished ? .green : .secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.tasksTotal > 0 {
                        Text("\(context.state.tasksDone)/\(context.state.tasksTotal)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.green)
                    }
                }
            } compactLeading: {
                Text("🌱")
            } compactTrailing: {
                if context.state.finished {
                    Image(systemName: "checkmark").foregroundStyle(.green)
                } else if context.state.tasksTotal > 0 {
                    Text("\(context.state.tasksDone)/\(context.state.tasksTotal)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.green)
                } else {
                    ProgressView().scaleEffect(0.6)
                }
            } minimal: {
                Text("🌱")
            }
        }
    }
}
