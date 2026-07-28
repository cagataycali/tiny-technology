/**
 * Haptic — the agent's `vibrate` tool made physical (user request: "vibrate
 * the phone, should be able to vibrate a lot, and with a motion too").
 *
 * CoreHaptics patterns with real motion: transient taps, sustained buzzes,
 * intensity curves (escalate ramps, wave swells). Repeats clamp to ~15s so
 * an enthusiastic agent can't buzz forever. Falls back to
 * UINotificationFeedbackGenerator on devices without a haptic engine.
 */
import CoreHaptics
import UIKit

@MainActor
final class Haptic {
    static let shared = Haptic()
    private var engine: CHHapticEngine?

    private init() {}

    func play(pattern: String, times: Int, intensity: Double) {
        let reps = max(1, min(times, 20))
        let strength = Float(max(0.1, min(intensity, 1.0)))
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            fallback(reps: reps)
            return
        }
        do {
            let engine = try ensureEngine()
            let events = Self.events(for: pattern, strength: strength)
            guard let last = events.map({ $0.relativeTime + max($0.duration, 0.1) }).max() else { return }
            let gap = 0.25
            var all: [CHHapticEvent] = []
            // Repeat the motif, clamped to a 15s ceiling
            for r in 0..<reps {
                let offset = Double(r) * (last + gap)
                if offset + last > 15 { break }
                all += events.map { ev in
                    CHHapticEvent(eventType: ev.type, parameters: ev.params,
                                  relativeTime: ev.relativeTime + offset, duration: ev.duration)
                }
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: all, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            fallback(reps: reps)
        }
    }

    private func ensureEngine() throws -> CHHapticEngine {
        if let engine { return engine }
        let e = try CHHapticEngine()
        Self.installHandlers(e)
        try e.start()
        engine = e
        return e
    }

    /// Engine handlers fire on CoreHaptics' own queue — closures must be
    /// born nonisolated or Swift 6 SIGTRAPs (dispatch_assert_queue)
    private nonisolated static func installHandlers(_ e: CHHapticEngine) {
        e.resetHandler = {
            Task { @MainActor in Haptic.shared.engine = nil }
        }
        e.stoppedHandler = { _ in }
    }

    private func fallback(reps: Int) {
        let gen = UINotificationFeedbackGenerator()
        for i in 0..<min(reps, 10) {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.4) {
                gen.notificationOccurred(.warning)
            }
        }
    }

    // ── Pattern library ────────────────────────────────────────────────────

    private struct Ev {
        let type: CHHapticEvent.EventType
        let params: [CHHapticEventParameter]
        let relativeTime: TimeInterval
        let duration: TimeInterval
    }

    private static func tap(_ t: TimeInterval, _ i: Float, sharp: Float = 0.6) -> Ev {
        Ev(type: .hapticTransient,
           params: [CHHapticEventParameter(parameterID: .hapticIntensity, value: i),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: sharp)],
           relativeTime: t, duration: 0)
    }

    private static func buzz(_ t: TimeInterval, _ dur: TimeInterval, _ i: Float, sharp: Float = 0.3) -> Ev {
        Ev(type: .hapticContinuous,
           params: [CHHapticEventParameter(parameterID: .hapticIntensity, value: i),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: sharp)],
           relativeTime: t, duration: dur)
    }

    private static func events(for pattern: String, strength s: Float) -> [Ev] {
        switch pattern {
        case "double":    return [tap(0, s), tap(0.15, s)]
        case "success":   return [tap(0, s * 0.6), tap(0.12, s)]
        case "warning":   return [tap(0, s), buzz(0.2, 0.3, s * 0.7)]
        case "error":     return [tap(0, s), tap(0.12, s), tap(0.24, s)]
        case "heartbeat": return [tap(0, s, sharp: 0.3), tap(0.18, s * 0.6, sharp: 0.2)]
        case "sos":       return [tap(0, s), tap(0.2, s), tap(0.4, s),
                                  buzz(0.7, 0.35, s), buzz(1.15, 0.35, s), buzz(1.6, 0.35, s),
                                  tap(2.1, s), tap(2.3, s), tap(2.5, s)]
        case "long":      return [buzz(0, 1.0, s)]
        case "escalate":  return stride(from: 0.0, to: 1.5, by: 0.15).map {
                              buzz($0, 0.14, s * Float(0.25 + 0.5 * $0))
                          }
        case "wave":      return stride(from: 0.0, to: 2.0, by: 0.2).map {
                              let phase = Float(sin($0 / 2.0 * .pi))
                              return buzz($0, 0.19, max(0.15, s * abs(phase)))
                          }
        default:          return [tap(0, s)]   // "tap"
        }
    }
}
