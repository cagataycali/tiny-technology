import Foundation

/// Launch arguments the TinyUITests bundle passes to isolate a hypothesis on
/// the real phone. Every flag is OFF in a normal launch; nothing here changes
/// shipped behaviour.
enum UITestFlags {
    private static let args = ProcessInfo.processInfo.arguments

    /// `-ui-testing-no-device-polls`: the arm / UNO Q toolbar buttons still
    /// discover their device (so the buttons render) but never start the
    /// state/camera loops. Used to test whether their published ticks
    /// (MJPEG frames, 500 ms state, 2 s board state) are what swallows the
    /// first tap on the neighbouring account Menu (2026-09-09 report).
    static let noDevicePolls = args.contains("-ui-testing-no-device-polls")

    /// `-ui-testing-fake-arm-frames`: ArmManager publishes a synthetic camera
    /// frame every 100 ms (what a live Nicla MJPEG stream does) without any
    /// network, so the toolbar-re-render hypothesis can be tested while the
    /// real camera is down. DEBUG builds only.
    /// `-ui-testing-fake-glasses-linked`: render the glasses toolbar button as
    /// if Meta glasses were linked (the owner's phone has them; simulators
    /// never do), so the toolbar has the same FIVE trailing items as the phone.
    /// Never tapped by the tests. DEBUG builds only.
    static let fakeGlassesLinked: Bool = {
        #if DEBUG
        return args.contains("-ui-testing-fake-glasses-linked")
        #else
        return false
        #endif
    }()

    static let fakeArmFrames: Bool = {
        #if DEBUG
        return args.contains("-ui-testing-fake-arm-frames")
        #else
        return false
        #endif
    }()

    /// `-ui-testing-fake-online-bodies fomo,scout,reachy,qBrain,necklace,glasses`:
    /// BodyPresence reads the listed bodies as ONLINE with a flat synthetic
    /// tile — no network — so the top-bar strip and its "+N" overflow can be
    /// screenshotted with more bodies than the phone has today. DEBUG only.
    static let fakeOnlineBodies: Set<BodyId> = {
        #if DEBUG
        guard let i = args.firstIndex(of: "-ui-testing-fake-online-bodies"), i + 1 < args.count else { return [] }
        return Set(args[i + 1].split(separator: ",").compactMap { BodyId(rawValue: String($0)) })
        #else
        return []
        #endif
    }()
}
