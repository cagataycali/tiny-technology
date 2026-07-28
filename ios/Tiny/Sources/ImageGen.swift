/**
 * ImageGen — on-device image generation for the agent's `generate_image`
 * tool (docs/on-device-genai-research-2026-07.md). Apple Image Playground's
 * ImageCreator (iOS 18.4+, Apple Intelligence hardware) renders the prompt
 * on the Neural Engine; the JPEG uploads once to /api/media (R2, stable
 * URL) and the outcome posts to /api/chat/tool-result — where the chat
 * route's callback is polling to hand the pixels back to the MODEL. This is
 * the first round-trip device tool: unlike speak/vibrate fire-and-forgets,
 * the agent sees what it made.
 *
 * Every path posts SOMETHING (success or a friendly error) — a silent
 * failure would strand the server callback until its 90s timeout.
 */
import UIKit
#if canImport(ImagePlayground)
import ImagePlayground
#endif

/// A generated image on an assistant message — preview renders instantly
/// (and offline) from base64; the hosted URL is the durable, shareable copy
/// every other client renders from.
struct GeneratedImage: Identifiable, Equatable, Codable {
    let id: String      // toolUseId
    let url: String     // https://plugin.tiny.technology/media/<uuid>.jpg
    let prompt: String
    let preview: String // ≤512px JPEG base64
}

@MainActor
final class ImageGen {
    static let shared = ImageGen()
    private init() {}

    enum Fail: LocalizedError {
        case unsupported
        case empty
        case upload(String)

        var errorDescription: String? {
            switch self {
            case .unsupported:
                return "This device can't generate images — Image Playground needs Apple Intelligence (iPhone 15 Pro or newer, iOS 18.4+, Apple Intelligence enabled in Settings)."
            case .empty:
                return "The on-device model returned no image for this prompt — try more concrete visual concepts."
            case .upload(let e):
                return "Image was generated but the upload failed: \(e)"
            }
        }
    }

    /// Execute the tool: generate → upload → post result. Returns the card
    /// for the chat UI on success, nil on failure (the error still posts, so
    /// the model can tell the user what happened instead of timing out).
    func run(toolUseId: String, prompt: String, style: String, token: String?) async -> GeneratedImage? {
        do {
            let image = try await generate(prompt: prompt, style: style)
            guard let full = Self.jpeg(image, maxSide: 1280, quality: 0.85) else { throw Fail.empty }
            let preview = Self.jpeg(image, maxSide: 512, quality: 0.6) ?? full

            let up: [String: Any]
            do {
                up = try await Api.post("/api/media", token: token, body: [
                    "data": full.base64EncodedString(),
                    "contentType": "image/jpeg",
                ])
            } catch { throw Fail.upload(error.localizedDescription) }
            guard let url = up["url"] as? String else {
                throw Fail.upload((up["error"] as? String) ?? "no url in response")
            }

            await postResult(toolUseId, token: token, payload: [
                "ok": true, "url": url, "format": "jpeg", "prompt": prompt,
            ])
            return GeneratedImage(id: toolUseId, url: url, prompt: prompt,
                                  preview: preview.base64EncodedString())
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            await postResult(toolUseId, token: token, payload: ["ok": false, "error": message])
            return nil
        }
    }

    /// True when this device can actually run ImageCreator — drives the
    /// platform note so the model doesn't offer image gen on an iPhone 12.
    static var isSupported: Bool {
        #if canImport(ImagePlayground)
        if #available(iOS 18.4, *) { return ImagePlaygroundViewController.isAvailable }
        #endif
        return false
    }

    // ── Generation ─────────────────────────────────────────────────────────

    private func generate(prompt: String, style: String) async throws -> UIImage {
        #if canImport(ImagePlayground)
        guard #available(iOS 18.4, *) else { throw Fail.unsupported }
        do {
            let creator = try await ImageCreator()
            let chosen: ImagePlaygroundStyle = switch style {
            case "illustration": .illustration
            case "sketch": .sketch
            default: .animation
            }
            for try await created in creator.images(for: [.text(prompt)], style: chosen, limit: 1) {
                return UIImage(cgImage: created.cgImage)
            }
            throw Fail.empty
        } catch let e as ImageCreator.Error {
            // Apple's enum is precise but user-hostile — translate the common
            // ones; anything else keeps its own description.
            switch e {
            case .notSupported: throw Fail.unsupported
            default: throw e
            }
        }
        #else
        throw Fail.unsupported
        #endif
    }

    // ── Plumbing ───────────────────────────────────────────────────────────

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

    /// Downscale + JPEG (AttachmentCodec's contract, private copy — codec
    /// returns base64 pairs shaped for outgoing attachments, not raw Data)
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
