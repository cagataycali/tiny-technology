/**
 * Motion — the phone's inner ear ("and with a motion too"). A short
 * CoreMotion sample becomes a human-readable snapshot for relay answers:
 * moving/still, orientation, attitude, steps today. Same pattern as the
 * Bluetooth scan — radio/sensor context the server could never see.
 */
import CoreMotion

@MainActor
final class Motion {
    static let shared = Motion()
    private let manager = CMMotionManager()

    private init() {}

    /// ~0.6s sample → text block. Never throws; degrades to what's available.
    func snapshot() async -> String {
        guard manager.isDeviceMotionAvailable else { return "No motion sensors on this device." }
        manager.deviceMotionUpdateInterval = 0.1
        manager.startDeviceMotionUpdates()
        try? await Task.sleep(for: .milliseconds(600))
        let m = manager.deviceMotion
        manager.stopDeviceMotionUpdates()
        guard let m else { return "Motion sensors gave no reading." }

        let ua = m.userAcceleration
        let accel = (ua.x * ua.x + ua.y * ua.y + ua.z * ua.z).squareRoot()
        let g = m.gravity
        let state = accel > 0.05 ? "moving (user accel \(String(format: "%.2f", accel))g)" : "still"
        let facing = g.z < -0.75 ? "face up" : g.z > 0.75 ? "face down"
                   : abs(g.y) > 0.6 ? "upright" : "on its side"
        var lines = [
            "- state: \(state)",
            "- lying: \(facing)",
            "- attitude: pitch \(Int(m.attitude.pitch * 180 / .pi))°, roll \(Int(m.attitude.roll * 180 / .pi))°, yaw \(Int(m.attitude.yaw * 180 / .pi))°",
        ]
        if CMPedometer.isStepCountingAvailable() {
            let steps = await Self.stepsToday()
            if steps >= 0 { lines.append("- steps today: \(steps)") }
        }
        return lines.joined(separator: "\n")
    }

    /// Pedometer fires its callback on a private queue — closure must be
    /// created nonisolated (voice-crash lesson). -1 = unavailable/denied.
    private nonisolated static func stepsToday() async -> Int {
        let pedometer = CMPedometer()
        let start = Calendar.current.startOfDay(for: Date())
        return await withCheckedContinuation { cont in
            pedometer.queryPedometerData(from: start, to: Date()) { data, _ in
                cont.resume(returning: data?.numberOfSteps.intValue ?? -1)
            }
        }
    }
}
