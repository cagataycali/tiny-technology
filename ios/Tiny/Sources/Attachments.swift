/**
 * Attachments — web parity for photos-to-the-agent, on the device that
 * actually has the camera. Library picks ride PhotosPicker; camera rides
 * UIImagePickerController. Images downscale to ≤1568px JPEG (q0.85, web parity)
 * and travel as the same Converse content blocks the web sends:
 * { image: { format: "jpeg", source: { bytes: <base64> } } }.
 *
 * History persists only tiny 96px thumbs (web pattern: base64 payloads are
 * stripped on persist — a photo would blow the store).
 */
import SwiftUI
import PhotosUI

struct PendingAttachment: Identifiable, Equatable {
    let id = UUID()
    /// ≤1568px JPEG or raw document bytes, base64 — what the agent sees
    let base64: String
    /// 96px JPEG, base64 — bubble/history preview (images only)
    let thumb: String?
    /// Documents only: display name (extension stripped) + Converse format
    let docName: String?
    let docFormat: String?

    var isImage: Bool { docFormat == nil }

    /// Decoded byte size of the model-bound payload (base64 inflates 4/3×, so
    /// the raw bytes are length × 0.75) — web `base64Bytes` (lib/file-
    /// attachments.ts). The 96px thumb is history-only and never sent, so it
    /// doesn't count toward the request budget.
    var payloadBytes: Int { Int(Double(base64.count) * 0.75) }

    init(base64: String, thumb: String? = nil, docName: String? = nil, docFormat: String? = nil) {
        self.base64 = base64
        self.thumb = thumb
        self.docName = docName
        self.docFormat = docFormat
    }
}

/// Cap per message — Converse payloads have limits and mobile data is real
let MAX_ATTACHMENTS = 4

/// Per-document byte cap — the canonical cross-client limit (web
/// MAX_DOCUMENT_BYTES, lib/file-attachments.ts:38; Android MAX_DOC_BYTES,
/// Attachments.kt:28). iOS previously hardcoded 2.5MB here and rejected
/// 2.5–3.0MB docs the other clients accept.
let MAX_DOCUMENT_BYTES = 3_000_000

/// Total decoded-payload cap across all staged attachments (web
/// MAX_PAYLOAD_BYTES, lib/file-attachments.ts): base64 inflates 4/3× and the
/// history + system context ride along in the same request, so the body must
/// stay comfortably under the worker's ~4.5MB cap. The per-item caps
/// (3MB/doc, downscaled images) don't stop FOUR large picks from summing past
/// it — this is the batch guard the mobile clients were missing (only web had
/// it), so a too-heavy set was caught server-side as a send failure instead of
/// up front in the composer.
let MAX_ATTACHMENTS_PAYLOAD_BYTES = 3_500_000

extension Array where Element == PendingAttachment {
    /// Sum of the model-bound payloads (web `attachmentsPayloadBytes`).
    var payloadBytes: Int { reduce(0) { $0 + $1.payloadBytes } }
}

/// Longest edge for the model-bound image — the canonical cross-client value
/// (web MAX_IMAGE_DIM, lib/file-attachments.ts:33). Anthropic's vision pipeline
/// downscales past ~1568px anyway, so this is the sweet spot: any larger just
/// inflates the payload without buying the model detail. iOS + Android both sat
/// at 1280px, so a chart/receipt/screenshot reached the agent SOFTER and smaller
/// from mobile than from web — the natives had drifted to match each other, not
/// the reference.
let MAX_IMAGE_DIM: CGFloat = 1568
/// JPEG quality for the model-bound image (web JPEG_QUALITY, lib/file-
/// attachments.ts:34). iOS sat at 0.7 — visibly softer than web's 0.85 on the
/// same photo; text in a screenshot lost crispness the model then had to guess at.
let MODEL_IMAGE_QUALITY: CGFloat = 0.85

enum AttachmentCodec {
    static func encode(_ image: UIImage) -> PendingAttachment? {
        // Model-bound image at web parity (1568px / q0.85). The 96px thumb is a
        // history-only preview — deliberately tiny so the persisted store stays
        // light (never sent to the model), so it keeps its own low settings.
        guard let full = downscale(image, maxDim: MAX_IMAGE_DIM).jpegData(compressionQuality: MODEL_IMAGE_QUALITY),
              let thumb = downscale(image, maxDim: 96).jpegData(compressionQuality: 0.6)
        else { return nil }
        return PendingAttachment(base64: full.base64EncodedString(), thumb: thumb.base64EncodedString())
    }

    static func downscale(_ image: UIImage, maxDim: CGFloat) -> UIImage {
        let size = image.size
        let scale = min(1, maxDim / max(size.width, size.height, 1))
        guard scale < 1 else { return image }
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// Outcome of a document pick — mirrors Android's `DocResult` (Attachments.kt)
    /// so a rejected doc surfaces WHY in the composer banner instead of vanishing.
    /// iOS previously returned `PendingAttachment?`; a `nil` from an oversize or
    /// unreadable pick was silently swallowed by the file-importer/drop callers,
    /// while web toasts a named error and Android sets `vm.error`. Now the reject
    /// reason rides `.err(message)`, phrased to match web (lib/file-attachments.ts)
    /// and Android word-for-word ("<file> is X.XMB — documents must be under 2.9MB").
    enum DocResult: Equatable {
        case ok(PendingAttachment)
        case err(String)
    }

    /// Byte cap rendered for reject copy — "2.9MB": web renders the cap in MiB
    /// (`(MAX_DOCUMENT_BYTES/1024/1024).toFixed(1)` → "2.9MB" for 3_000_000) and
    /// Android's MAX_DOC_LABEL computes the same. Derived, not hardcoded, so the
    /// copy self-updates (and stays consistent with the file-size figure in the
    /// same sentence, which is also MiB) if MAX_DOCUMENT_BYTES moves.
    private static var docCapLabel: String {
        String(format: "%.1fMB", Double(MAX_DOCUMENT_BYTES) / 1_048_576)
    }

    /// Documents (PDF/CSV/…): raw bytes → Converse document block fields.
    /// Same shape the web sends: { document: { name, format, source: { bytes } } }
    static func encodeDocument(url: URL) -> DocResult {
        // File URLs only — iPad drag-and-drop can hand over https URLs
        // (Safari link drags); Data(contentsOf:) would synchronously fetch
        // those over the network on the main thread. Web content isn't a
        // document attachment; reject the scheme, not just the size. (The drop
        // router already sends links to the composer, so this is defensive.)
        guard url.isFileURL else { return .err("Only files can be attached") }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent  // full filename incl. extension (web `file.name`)
        // Couldn't-read / empty — web: "Couldn't read <name> — unsupported or
        // corrupted"; Android: "couldn't read <file>".
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return .err("Couldn't read \(name) — unsupported or corrupted")
        }
        // 3MB per-document cap (MAX_DOCUMENT_BYTES) — the canonical cross-client
        // limit. Was a silent nil; now names the file + its size like web/Android.
        guard data.count <= MAX_DOCUMENT_BYTES else {
            let mb = Double(data.count) / 1_048_576
            return .err(String(format: "%@ is %.1fMB — documents must be under %@", name, mb, docCapLabel))
        }
        // Extension → Converse doc format. Mirrors web's accept list + Android's
        // EXT_TO_FORMAT (Attachments.kt): htm folds to html, markdown to md, and
        // json/xml are first-class — before this they fell through to "txt", so a
        // picked .json reached the agent mislabeled as plain text.
        let formats = ["pdf": "pdf", "csv": "csv", "doc": "doc", "docx": "docx",
                       "xls": "xls", "xlsx": "xlsx", "html": "html", "htm": "html",
                       "md": "md", "markdown": "md", "txt": "txt", "json": "json", "xml": "xml"]
        let format = formats[url.pathExtension.lowercased()] ?? "txt"
        let docName = url.deletingPathExtension().lastPathComponent
        return .ok(PendingAttachment(base64: data.base64EncodedString(), docName: docName, docFormat: format))
    }

    /// Converse content blocks: text first (never empty — web sends
    /// "Have a look." for image-only messages), then one block per attachment
    static func blocks(text: String, attachments: [PendingAttachment]) -> [[String: Any]] {
        var out: [[String: Any]] = [["text": text.isEmpty ? "Have a look." : text]]
        for att in attachments.prefix(MAX_ATTACHMENTS) {
            if let format = att.docFormat {
                // Name rules mirror the web: safe charset, ≤200 chars
                let safe = (att.docName ?? "document")
                    .replacingOccurrences(of: "[^a-zA-Z0-9\\s\\-()\\[\\]]", with: "_", options: .regularExpression)
                    .prefix(200)
                out.append(["document": ["name": safe.isEmpty ? "document" : String(safe), "format": format, "source": ["bytes": att.base64]]])
            } else {
                out.append(["image": ["format": "jpeg", "source": ["bytes": att.base64]]])
            }
        }
        return out
    }
}

/// What a dropped URL should become — pure decision, no I/O, testable.
/// (Views.swift's dropDestination executes these; TinyTests covers the
/// routing table that was previously inline-in-closure and untestable.)
enum DropIntake: Equatable {
    /// file:// URL with attachment capacity left → encodeDocument path
    case document(URL)
    /// https/mailto/… link drag → append to the composer draft
    case composerText(String)
    /// file:// URL but attachments are full → dropped on the floor
    case overCapacity
}

extension AttachmentCodec {
    /// Route dropped URLs: files become documents while capacity lasts
    /// (MAX_ATTACHMENTS cap counts existing pending + accepted-this-drop),
    /// non-file links become composer text regardless of capacity.
    static func routeDrop(urls: [URL], pendingCount: Int, max: Int = MAX_ATTACHMENTS) -> [DropIntake] {
        var capacity = max - pendingCount
        return urls.map { url in
            if url.isFileURL {
                guard capacity > 0 else { return .overCapacity }
                capacity -= 1
                return .document(url)
            }
            return .composerText(url.absoluteString)
        }
    }

    /// Merge a dragged link into the composer draft (single space seam,
    /// no leading space on an empty draft).
    static func mergeLink(_ draft: String, _ link: String) -> String {
        draft.isEmpty ? link : draft + " " + link
    }
}

/// Doc chip for the pending strip + history bubbles
struct DocChip: View {
    let name: String
    // The tiny's accent is the ONLY brand color (Theme.swift) — web tints the
    // attachment chips with rgba(var(--tiny-accent-rgb),…), so a hardcoded green
    // clashed on every non-green tiny. Read it from the environment ChatView
    // already injects (Views.swift .environment(\.tinyAccent, chat.accent)).
    @Environment(\.tinyAccent) private var accent

    var body: some View {
        Label(name, systemImage: "doc.fill")
            .font(.caption)
            .lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(accent.opacity(0.12), in: Capsule())
            .foregroundStyle(accent)
    }
}

/// UIImagePickerController wrapper — PhotosPicker has no camera source
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// Thumbnail from a stored base64 thumb (bubbles + pending strip)
struct AttachmentThumb: View {
    let base64: String
    var size: CGFloat = 56
    // Accent-tinted border to match web (rgba(var(--tiny-accent-rgb),0.3)) and
    // the accent-themed composer/chips — not a hardcoded green on every tiny.
    @Environment(\.tinyAccent) private var accent

    var body: some View {
        if let data = Data(base64Encoded: base64), let img = UIImage(data: data) {
            Image(uiImage: img)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(accent.opacity(0.3), lineWidth: 1))
        }
    }
}

// ── Share-link plumbing (conversation share links) ─────────────────────────

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// UIActivityViewController wrapped for .sheet — ShareLink can't present
/// from a Menu action's async completion, this can.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
