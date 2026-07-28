/**
 * Net — reachability for the offline queue (north-star P1.5).
 * NWPathMonitor wrapped in a MainActor store; the path handler fires on its
 * own queue, so it's attached from a nonisolated bridge (the voice-crash
 * lesson: closures born in isolated contexts SIGTRAP on foreign queues).
 */
import Network
import SwiftUI

@MainActor
final class Net: ObservableObject {
    static let shared = Net()

    /// Optimistic until the monitor reports — a false "offline" at launch
    /// would queue messages that could have sent
    @Published var online = true

    private let monitor = NWPathMonitor()

    private init() {
        Self.attach(monitor)
    }

    private nonisolated static func attach(_ monitor: NWPathMonitor) {
        monitor.pathUpdateHandler = { path in
            let up = path.status == .satisfied
            Task { @MainActor in
                if Net.shared.online != up { Net.shared.online = up }
            }
        }
        monitor.start(queue: DispatchQueue(label: "technology.tiny.net-monitor"))
    }
}
