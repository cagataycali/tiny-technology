/**
 * Torch — the agent's `flashlight` tool (device tools, user request).
 * on (auto-off ≤60s so a forgotten torch doesn't cook the battery),
 * off, blink ≤30×. One control task at a time; new commands cancel old.
 */
import AVFoundation

@MainActor
final class Torch {
    static let shared = Torch()
    private var task: Task<Void, Never>?

    private init() {}

    func run(mode: String, times: Int, seconds: Double) {
        task?.cancel()
        switch mode {
        case "off":
            set(false)
        case "blink":
            let n = max(1, min(times, 30))
            task = Task {
                // Cancellation checks BEFORE every set(): a cancelled sleep
                // returns immediately (try? swallows it), and the stale
                // task's set(false) would otherwise land AFTER a newer "on"
                // command's set(true), killing the torch it just lit.
                for _ in 0..<n {
                    if Task.isCancelled { return }
                    set(true)
                    try? await Task.sleep(for: .milliseconds(250))
                    if Task.isCancelled { return }
                    set(false)
                    try? await Task.sleep(for: .milliseconds(250))
                }
                if !Task.isCancelled { set(false) }
            }
        default: // "on"
            set(true)
            let cap = max(1, min(seconds, 60))
            task = Task {
                try? await Task.sleep(for: .seconds(cap))
                if !Task.isCancelled { set(false) }
            }
        }
    }

    private func set(_ on: Bool) {
        guard let dev = AVCaptureDevice.default(for: .video), dev.hasTorch else { return }
        guard (try? dev.lockForConfiguration()) != nil else { return }
        if on { try? dev.setTorchModeOn(level: 1.0) } else { dev.torchMode = .off }
        dev.unlockForConfiguration()
    }
}
