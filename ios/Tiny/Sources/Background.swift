/**
 * Background — keeps the phone a live fleet node beyond the foreground.
 *
 * iOS reality: a suspended app can't hold a socket or a 5s poll. The
 * OS-sanctioned path is BGAppRefresh: opportunistic wakes (~15min+, at the
 * system's discretion) during which we heartbeat, answer at most one pending
 * relay invoke, and chain the next wake. Between wakes /devices shows
 * "last seen Xm ago" instead of 🟢 — real always-on presence needs APNs
 * silent push (server work, flagged in the backlog).
 */
import BackgroundTasks

enum Background {
    static let refreshId = "technology.tiny.refresh"

    /// Must run before the app finishes launching (TinyApp.init)
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refresh)
        }
    }

    /// Ask for the next wake — called on every background transition and
    /// after each fire (requests don't persist across fires).
    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: refreshId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule() // chain the next wake first — even if this one expires
        // BGTask is documented thread-safe but the SDK predates Sendable —
        // the capture below is fine, tell the compiler so
        nonisolated(unsafe) let task = task
        let work = Task {
            await TinySession.backgroundBeat()
            task.setTaskCompleted(success: true)
        }
        // ~30s budget: expiration cancels the chat proxy; backgroundBeat's
        // try? awaits unwind quickly and the completion above still runs
        task.expirationHandler = { work.cancel() }
    }
}
