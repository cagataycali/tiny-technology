/**
 * Screenshot — on-device screen capture for the agent's `screenshot` tool
 * (docs/use-device-screenshot-scoping-2026-07-23.md). generate_image's twin:
 * ReplayKit grabs ONE frame of the whole screen, the JPEG uploads once to
 * /api/media (R2, stable URL), and the outcome posts to /api/chat/tool-result
 * — where the chat route's callback is polling to hand the pixels back to the
 * MODEL. The agent literally sees what's on the user's screen.
 *
 * Product decisions (2026-07-23): WHOLE screen via ReplayKit (with a
 * self-window fallback when capture is unavailable/denied by the OS), and
 * consent is asked EVERY capture. The app-level "allow this capture?" prompt
 * lives at the call site in the chat view (a user decline posts {denied:true}
 * without ever entering this module); ReplayKit additionally shows the system
 * recording indicator. This module assumes the app-level consent already
 * passed and performs the capture itself.
 *
 * Every path posts SOMETHING (success or a friendly error) — a silent failure
 * would strand the server callback until its 90s timeout.
 */
import UIKit
import ReplayKit
import CoreMedia
import CoreImage
// Catalyst-only import: ScreenCaptureKit exists on iOS only since 18.2 and
// the deployment target is 18.0 — keeping the import out of the iOS build
// avoids linking a framework older devices don't have
#if targetEnvironment(macCatalyst)
import ScreenCaptureKit
#endif

@MainActor
final class Screenshot {
    static let shared = Screenshot()
    private init() {}

    enum Fail: LocalizedError {
        case unavailable
        case noFrame
        case encode
        case upload(String)

        var errorDescription: String? {
            switch self {
            case .unavailable:
                #if targetEnvironment(macCatalyst)
                return "Screen capture isn't available — grant tiny Screen Recording permission in System Settings → Privacy & Security, then ask again."
                #else
                return "Screen capture isn't available on this device right now — recording may be restricted (Screen Time / MDM), or another app is already capturing."
                #endif
            case .noFrame:
                return "Screen capture started but no frame arrived — try again."
            case .encode:
                return "Captured the screen but couldn't encode the image."
            case .upload(let e):
                return "Screen was captured but the upload failed: \(e)"
            }
        }
    }

    /// True when ReplayKit reports it can record. Drives the platform note so
    /// the model doesn't offer screenshot where the OS forbids it. On the Mac
    /// the ScreenCaptureKit path (18.2+) exists regardless of what ReplayKit
    /// claims, so the tool is offered there too.
    static var isSupported: Bool {
        #if targetEnvironment(macCatalyst)
        if #available(macCatalyst 18.2, *) { return true }
        #endif
        return RPScreenRecorder.shared().isAvailable
    }

    /// Execute the tool: capture one frame → upload → post result. `fallback`
    /// is the app's own key-window snapshot, passed by the caller as a
    /// last-resort image when ReplayKit can't grab the whole screen (e.g.
    /// capture disabled) — nil means "no fallback, surface the error."
    /// Returns a `GeneratedImage` card for the chat UI on success (reusing the
    /// generate_image card verbatim), nil on failure (the error still posts so
    /// the model can explain instead of timing out).
    func run(toolUseId: String, token: String?, fallback: UIImage? = nil) async -> GeneratedImage? {
        do {
            let image: UIImage
            // On the Mac, ReplayKit-under-Catalyst mirrors the app's own
            // window (ReplayKitMacHelper wraps the UIWindow) — the WHOLE
            // screen the product decision asks for comes from
            // ScreenCaptureKit, so that path goes first there.
            #if targetEnvironment(macCatalyst)
            var captured = try? await Self.macDisplayCapture()
            if captured == nil { captured = try? await captureFrame() }
            #else
            let captured = try? await captureFrame()
            #endif
            if let captured {
                image = captured
            } else if let fb = fallback {
                // Couldn't get the whole screen — degrade to the app's own
                // window rather than fail the turn entirely.
                image = fb
            } else {
                throw Fail.unavailable
            }

            guard let jpeg = Self.jpeg(image, maxSide: 1600, quality: 0.8) else { throw Fail.encode }
            // Small on-device thumbnail so the chat card renders instantly and
            // offline (the hosted URL is the durable copy). Mirrors ImageGen.
            let preview = Self.jpeg(image, maxSide: 512, quality: 0.6) ?? jpeg

            let up: [String: Any]
            do {
                up = try await Api.post("/api/media", token: token, body: [
                    "data": jpeg.base64EncodedString(),
                    "contentType": "image/jpeg",
                ])
            } catch { throw Fail.upload(error.localizedDescription) }
            guard let url = up["url"] as? String else {
                throw Fail.upload((up["error"] as? String) ?? "no url in response")
            }

            await postResult(toolUseId, token: token, payload: [
                "ok": true, "url": url, "format": "jpeg",
            ])
            return GeneratedImage(id: toolUseId, url: url, prompt: "Screen capture",
                                  preview: preview.base64EncodedString())
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            await postResult(toolUseId, token: token, payload: ["ok": false, "error": message])
            return nil
        }
    }

    /// Self-window fallback the caller hands to `run` — a render of the app's
    /// own key window. Used when ReplayKit whole-screen capture is unavailable
    /// (Screen Time / MDM / another capturer). Must be called on the main actor.
    static func keyWindowSnapshot() -> UIImage? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        guard let window else { return nil }
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        return renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
    }

    /// Post a user decline as a first-class {denied:true} outcome so the model
    /// treats it as "the user said no", not a retryable error. Called by the
    /// chat view when the app-level consent prompt is dismissed.
    func postDenied(toolUseId: String, token: String?) async {
        await postResult(toolUseId, token: token, payload: ["denied": true])
    }

    /// Consent arrived after the asking request died. Posted best-effort (the
    /// row is almost certainly swept — see `askRemoteConsent`), and NOT as
    /// `{denied:true}`: the user allowed it, and blaming them for a deadline
    /// they never saw would be a lie the model would then repeat.
    func postExpired(toolUseId: String, token: String?) async {
        await postResult(toolUseId, token: token, payload: [
            "ok": false,
            "error": "the capture request expired before the user answered — nothing was captured",
        ])
    }

    // ── Remote consent (use_device relay path) ────────────────────────────────

    /// Ask for consent and run the capture for a REMOTE ask — the web agent
    /// reached this phone through use_device, so there is no chat view on
    /// screen to host the prompt, so the executor presents it itself.
    ///
    /// Three things make this deliberately unlike the chat path:
    ///
    /// 1. **It does not return the user's answer.** The relay caller must NOT
    ///    await a human: `runDeviceEvent` runs inside the relay poll loop's
    ///    current iteration, and that loop claims envelopes for the whole fleet
    ///    rail — including the {type:"notify"} pushes that ARE iOS's push
    ///    transport. Parking it on an unanswered alert would cost the user
    ///    their notifications. So this dispatches and returns; the outcome
    ///    reaches the server through the tool-result mailbox its callback is
    ///    already polling (90s), exactly as Android's fire-and-forget consent
    ///    activity does.
    /// 2. **UIAlertController, not the SwiftUI alert.** That one is bound to
    ///    ChatView's ChatModel, which a `nonisolated static` relay handler
    ///    cannot reach — and ChatView's modifier chain is at both the
    ///    type-checker's and the Release demangler's limits. A key-window
    ///    presentation also correctly follows the user to whatever screen
    ///    they're actually on, since a remote ask has nothing to do with chat.
    /// 3. **Consent is still asked EVERY capture** (product decision,
    ///    2026-07-23) — being remote earns no standing grant.
    ///
    /// Returns true when the prompt was actually presented; false means no
    /// window/scene to present in, and the caller must post the failure itself
    /// (nothing may leave the server's poll stranded).
    ///
    /// ⏱️ **The prompt expires with the request that asked for it.** A remote ask
    /// is one the user is not waiting for — the phone is in a pocket, so an
    /// unnoticed alert is the NORMAL case, not the edge case. Without a deadline
    /// the two clocks come apart: the server's callback gives up at 90s and the
    /// turn ends, while the alert sits there indefinitely. A tap 40 minutes
    /// later would then capture whatever is on screen AT THAT MOMENT — a
    /// different app, someone's messages — upload it permanently (nothing ever
    /// deletes R2 media), and deliver it to NOBODY, because the poll is long
    /// over and the mailbox row was swept at 15 minutes.
    ///
    /// That is consent applied to a moment it was never given for. So the tap is
    /// only honoured while the asking request is still alive; afterwards the
    /// alert says so and captures nothing. Declining stays valid forever —
    /// "no" needs no deadline.
    @discardableResult
    func askRemoteConsent(toolUseId: String, token: String?, reason: String, tiny: String) -> Bool {
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
        else { return false }

        // Walk to whatever is actually on top: presenting on a controller that
        // already has a sheet up (settings, a panel) silently does nothing.
        var host: UIViewController = root
        while let presented = host.presentedViewController, !presented.isBeingDismissed {
            host = presented
        }

        let body = reason.isEmpty
            ? "It will capture your screen once and can read what's shown."
            : "\(reason)\n\nIt will capture your screen once and can read what's shown."
        let alert = UIAlertController(
            // Names the REMOTE origin — the user didn't ask for this on this
            // device, and a prompt that looked local would be a trust bug.
            title: "Let \(tiny) see your screen?",
            message: "Asked from another device.\n\n\(body)",
            preferredStyle: .alert)
        // Captured when the ask ARRIVES, so the countdown covers the time the
        // alert spends waiting to be noticed — not the time after it's tapped.
        let asked = Date()
        alert.addAction(UIAlertAction(title: "Allow once", style: .default) { _ in
            Task { @MainActor in
                guard Self.isConsentStillLive(asked) else {
                    // The screen in front of the user now is NOT the screen the
                    // agent asked about, and nothing is listening any more. Say
                    // so on the phone: silently doing nothing after an explicit
                    // "Allow" reads as the app being broken.
                    self.explainExpired(host: host, tiny: tiny)
                    return
                }
                _ = await self.run(toolUseId: toolUseId, token: token,
                                   fallback: Self.keyWindowSnapshot())
            }
        })
        alert.addAction(UIAlertAction(title: "Don't allow", style: .cancel) { _ in
            Task { @MainActor in
                // No deadline on "no": posting a late decline is harmless (the
                // row is swept or ignored) and it keeps this path dead simple.
                await self.postDenied(toolUseId: toolUseId, token: token)
            }
        })
        host.present(alert, animated: true)
        return true
    }

    /// What a consent prompt resolved to. `expired` is deliberately NOT folded
    /// into `denied`: the user DID allow it, and reporting "the user declined"
    /// would be the same species of confabulation the device audit exists to
    /// stop. Nobody is listening by then either way — the distinction is about
    /// telling the truth locally, not about the wire.
    enum ConsentOutcome { case allowed, denied, expired }

    /// How long the server callback waits for a result: `lib/chat/tools/platform.ts`
    /// loops 45× over `sleep(2s)` THEN check — so its checks land at t≈2,4,…,90,
    /// and a result must already be IN the mailbox at t=90 to be seen at all.
    static let serverPollBudget: TimeInterval = 90

    /// What still has to happen AFTER the tap before the result exists: ReplayKit's
    /// first video frame, the JPEG encode, the upload to /api/media, then the
    /// mailbox POST. None of it is instant (the two network legs are bounded at
    /// 30s each), so the tap deadline has to be the poll budget MINUS this.
    static let deliveryGrace: TimeInterval = 20

    /// How long an "Allow once" tap stays good for.
    ///
    /// ⚠️ This must sit BELOW `serverPollBudget`, not above it. A window of 100s
    /// (shipped briefly, 2026-08-02) let a tap at t=95s pass this check, capture
    /// the screen, and store it in R2 *permanently* for a poll that had already
    /// given up — the same rot the deadline exists to prevent, just bounded at ten
    /// seconds instead of unbounded. Consent has to expire early enough that the
    /// capture it authorises can still REACH someone.
    static let consentWindow: TimeInterval = serverPollBudget - deliveryGrace

    static func isConsentStillLive(_ asked: Date) -> Bool {
        Date().timeIntervalSince(asked) < consentWindow
    }

    /// Replace an expired prompt with an explanation. Deliberately NOT an error
    /// about a "timeout": the user did nothing wrong, and what they most need to
    /// know is that nothing was captured and nothing was sent.
    private func explainExpired(host: UIViewController, tiny: String) {
        var top: UIViewController = host
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        let alert = UIAlertController(
            title: "That request expired",
            message: "\(tiny) stopped waiting for this one, so nothing was captured and nothing was sent. Ask again if you still want it to see your screen.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        top.present(alert, animated: true)
    }

    // ── Capture ──────────────────────────────────────────────────────────────

    #if targetEnvironment(macCatalyst)
    /// Whole-screen capture on the Mac via ScreenCaptureKit (macCatalyst
    /// 18.2+). The first-ever call triggers the system Screen Recording
    /// permission prompt and THROWS (TCC grants don't apply retroactively) —
    /// run() then degrades to the window fallback for that turn; once the
    /// user grants in System Settings, subsequent captures get the full
    /// display.
    private static func macDisplayCapture() async throws -> UIImage {
        guard #available(macCatalyst 18.2, *) else { throw Fail.unavailable }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw Fail.noFrame }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // Point resolution is plenty — the upload path caps the long side at
        // 1600px anyway, so retina pixels would be thrown away.
        config.width = display.width
        config.height = display.height
        let cg: CGImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return UIImage(cgImage: cg)
    }
    #endif

    /// Grab a single frame from ReplayKit, then immediately stop. startCapture
    /// streams CMSampleBuffers; we take the first video buffer, convert its
    /// pixel buffer to a UIImage, and tear the recorder down.
    private func captureFrame() async throws -> UIImage {
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else { throw Fail.unavailable }
        recorder.isMicrophoneEnabled = false
        recorder.isCameraEnabled = false

        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            // Guard against multiple resumes: the sample handler fires many
            // times, but we only want the first usable video frame.
            let done = Latch()
            recorder.startCapture(handler: { sampleBuffer, bufferType, error in
                guard bufferType == .video else { return }
                guard done.tryClose() else { return }
                if let error = error {
                    RPScreenRecorder.shared().stopCapture(handler: { _ in })
                    cont.resume(throwing: error)
                    return
                }
                let ui = Self.imageFromSampleBuffer(sampleBuffer)
                RPScreenRecorder.shared().stopCapture(handler: { _ in })
                if let ui = ui {
                    cont.resume(returning: ui)
                } else {
                    cont.resume(throwing: Fail.noFrame)
                }
            }, completionHandler: { error in
                // startCapture failed to even begin (permission denied, in use).
                guard done.tryClose() else { return }
                cont.resume(throwing: error ?? Fail.unavailable)
            })
        }
        return image
    }

    private static func imageFromSampleBuffer(_ sb: CMSampleBuffer) -> UIImage? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sb) else { return nil }
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(ci, from: ci.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    // ── Plumbing (mirrors ImageGen) ────────────────────────────────────────────

    private func postResult(_ toolUseId: String, token: String?, payload: [String: Any]) async {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        // Best-effort: a failed post degrades to the server's 90s timeout
        // message — worse UX, still honest.
        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
            "toolUseId": toolUseId, "payload": json,
        ]) as [String: Any]
    }

    /// Downscale + JPEG (private copy of ImageGen's helper — a screenshot is
    /// already screen-sized, so cap the long side to keep the upload small).
    private static func jpeg(_ image: UIImage, maxSide: CGFloat, quality: CGFloat) -> Data? {
        let side = max(image.size.width, image.size.height)
        guard side > maxSide else { return image.jpegData(compressionQuality: quality) }
        let scale = maxSide / side
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }
}

/// One-shot latch — the ReplayKit sample handler and completion handler can
/// both fire (on background queues); only the first caller through wins the
/// continuation. The NSLock makes it safe to share across those @Sendable
/// closures, so it's an unchecked Sendable.
private final class Latch: @unchecked Sendable {
    private var closed = false
    private let lock = NSLock()
    func tryClose() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if closed { return false }
        closed = true
        return true
    }
}
