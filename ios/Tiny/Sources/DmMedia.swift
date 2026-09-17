/**
 * DmMedia — what a DM can carry besides text, on the device that actually has
 * the camera and the microphone (migration 0031).
 *
 * The rail: bytes → POST /api/media (base64 → R2) → `<worker>/media/<uuid>.<ext>`
 * → `attachments[]` on POST /api/messages. The worker validates that URL again
 * (`decideDmAttachments`, lib/chat/dm-attachments.ts) and nothing here trusts
 * the server's `kind` either — it is DERIVED from `contentType` on both ends, so
 * a mislabelled mp4 can never be handed to an image view (or, on the read side,
 * to the model as a picture).
 *
 * Three rules, which are one rule wearing three hats:
 *
 *  1. REFUSE, NEVER PARTIALLY DELIVER. A DM cannot be unsent. Every refusal
 *     below names the file, the number it broke and what to do instead; none
 *     drops an attachment the sender watched themselves attach. Same reason
 *     `dmSendRefusal` exists for the text half (Messages.swift).
 *
 *  2. THE CAP IS ARITHMETIC, NOT TASTE. /api/media is an EDGE route (~4.5MB
 *     request body) and the payload is base64, +4/3×. `kDmUploadMaxBytes` is the
 *     decoded-byte ceiling that leaves room for the JSON around it — the same
 *     2.6MB the web composer uses (lib/chat/dm-media-upload.ts), pinned by
 *     tests/ios-dm-media.test.ts so the two cannot drift apart.
 *
 *  3. WHAT THE OTHER CLIENTS CAN PLAY DECIDES THE FORMAT. A voice note is AAC
 *     in an m4a container (`audio/mp4`) and a clip is H.264 in mp4, because
 *     those are what Chrome, Android and this app all play. The web recorder
 *     re-encodes to WAV for the mirror-image reason: iOS cannot play the
 *     `audio/webm` Chrome records.
 */
import AVKit
import PhotosUI
import Speech
import SwiftUI
import UniformTypeIdentifiers

// ── the wire contract (mirrors lib/chat/dm-attachments.ts) ───────────────────

/// A photo or three, a clip, a voice note — that's a message. Twenty files is
/// an upload session. `DM_MAX_ATTACHMENTS`: the worker refuses a fifth, so the
/// composer must not offer one.
let kDmMaxAttachments = 4

/// Decoded-bytes cap for ONE attachment. `DM_UPLOAD_MAX_BYTES` — see rule 2 in
/// the header: base64 is 4/3×, and /api/media is an edge route.
let kDmUploadMaxBytes = 2_600_000

/// Longest edge for an uploaded photo (`DM_IMAGE_MAX_DIM`). It is also where
/// the vision models downscale anyway, and the agent reads DM photos through
/// those models (`read_messages`), so more pixels buy nothing.
let kDmImageMaxDim: CGFloat = 1568
/// Web parity (`DM_IMAGE_QUALITY`, and the chat rail's `MODEL_IMAGE_QUALITY`).
let kDmImageQuality: CGFloat = 0.85
/// Soft byte target for a DM photo (chat rail's MAX_IMAGE_BYTES sibling):
/// the prepare walk stops at the first rung under this. ~20KB uploads in
/// ~1s on weak cellular — the upload-timeout class of send failure mostly
/// stops existing when the body is this small. `kDmUploadMaxBytes` stays
/// the HARD cap (clips/voice notes need the room).
let kDmImageTargetBytes = 20_000

/// 🎤 Voice-note ceiling, enforced by STOPPING the recorder — nobody should
/// talk for two minutes and only then be told it can't be sent. 60s of AAC at
/// 32kbps is ~240KB, comfortably inside the upload cap.
let kDmVoiceMaxSeconds: TimeInterval = 60
/// Under this, the "recording" is a mis-tap on the mic button.
let kDmVoiceMinSeconds: TimeInterval = 0.7

/// 🎥 Clip ceiling. A phone camera makes 4K/60 at ~50Mbit; nothing gets a
/// 3-minute clip of that under 2.6MB, and pretending otherwise means a long
/// export that ends in a refusal. Refuse on DURATION first, before spending a
/// minute of someone's battery, and say how to fix it.
let kDmClipMaxSeconds: TimeInterval = 30

/// A voice note's transcript cap — the same 2000 the body uses
/// (`DM_MAX_TRANSCRIPT_CHARS`); the worker clips to it independently.
let kDmMaxTranscriptChars = kDmMaxChars

/// contentType → kind. THIS IS THE ALLOWLIST, and it is the media store's own
/// (`EXT` in worker/src/media.ts) via
/// `DM_ATTACHMENT_TYPES` — a type absent here is refused end to end.
let kDmAttachmentTypes: [String: String] = [
    "image/jpeg": "image",
    "image/png": "image",
    "image/webp": "image",
    "image/gif": "image",
    "video/mp4": "video",
    "audio/mp4": "audio",
    "audio/mpeg": "audio",
    "audio/wav": "audio",
    "audio/ogg": "audio",
]

/// The kind an attachment IS, from the only field that can say so.
func dmAttachmentKind(_ contentType: String) -> String? {
    kDmAttachmentTypes[contentType.lowercased().trimmingCharacters(in: .whitespaces)]
}

/// "0:07", "1:42" — `dmDuration` (dm-attachments.ts), so a bubble can show the
/// length without fetching the bytes. Empty for a missing/zero duration rather
/// than "0:00", which reads like a broken file.
func dmDuration(_ durationMs: Int?) -> String {
    guard let ms = durationMs, ms > 0 else { return "" }
    let total = Int((Double(ms) / 1000).rounded())
    return "\(total / 60):\(String(format: "%02d", total % 60))"
}

/// Bytes as a person reads them — MiB with one decimal, like the web's `mb()`
/// and the chat rail's `docCapLabel`. One formatter, so a size and the cap it
/// broke are never rendered in different units in the same sentence.
func dmMB(_ bytes: Int) -> String {
    String(format: "%.1fMB", Double(bytes) / 1_048_576)
}

/// Over-cap refusal, or nil when it fits. Word-for-word the web's
/// `dmSizeRefusal` — "is X, over the Y limit", never "is X — the limit is Y",
/// because at one byte over both numbers round to the same string and the
/// message then reads like a bug report about itself.
func dmSizeRefusal(_ bytes: Int, _ label: String = "That file") -> String? {
    guard bytes > kDmUploadMaxBytes else { return nil }
    return "\(label) is \(dmMB(bytes)), over the \(dmMB(kDmUploadMaxBytes)) limit — nothing was sent."
}

/// Room left in this message. Refuses the whole pick instead of quietly keeping
/// the first four — web parity (`dmAttachmentRoom`), and the same promise the
/// text rule makes.
func dmAttachmentRoom(_ staged: Int, _ incoming: Int, _ max: Int = kDmMaxAttachments) -> String? {
    guard staged + incoming > max else { return nil }
    return "A message can carry \(max) attachments — you have \(staged) and picked \(incoming). "
        + "Send these first, then the rest."
}

/// Too-long-clip refusal, decided from the SOURCE duration so it lands before
/// the transcode instead of after it.
func dmClipRefusal(_ seconds: Double) -> String? {
    guard seconds.isFinite, seconds > kDmClipMaxSeconds else { return nil }
    return "That clip is \(Int(seconds.rounded()))s — messages carry clips up to "
        + "\(Int(kDmClipMaxSeconds))s. Trim it in Photos and pick it again."
}

/// One stored attachment on a DM.
///
/// `kind` is derived from `contentType` at decode; an unknown type becomes
/// `"other"` and renders as a plain link rather than disappearing — a read path
/// that silently drops what it can't display tells the reader a message had
/// nothing in it.
struct DmAttachment: Identifiable, Equatable, Sendable {
    /// Stable across polls (so `DmMsg` diffing doesn't churn the scroll) AND
    /// unique within a message (the same photo can legitimately be attached
    /// twice, and two identical ids in a ForEach is a rendering bug).
    var id: String { "\(slot):\(url)" }
    let slot: Int
    let kind: String
    let url: String
    let contentType: String
    let bytes: Int?
    let transcript: String?
    let durationMs: Int?
    let width: Int?
    let height: Int?

    init(slot: Int = 0, kind: String, url: String, contentType: String, bytes: Int? = nil,
         transcript: String? = nil, durationMs: Int? = nil, width: Int? = nil, height: Int? = nil) {
        self.slot = slot
        self.kind = kind
        self.url = url
        self.contentType = contentType
        self.bytes = bytes
        self.transcript = transcript
        self.durationMs = durationMs
        self.width = width
        self.height = height
    }

    init?(json: [String: Any], slot: Int) {
        guard let url = json["url"] as? String, !url.isEmpty else { return nil }
        let type = (json["contentType"] as? String ?? "").lowercased()
        self.init(
            slot: slot,
            // Not `json["kind"]`: see the type note in the header.
            kind: dmAttachmentKind(type) ?? "other",
            url: url,
            contentType: type,
            bytes: json["bytes"] as? Int,
            transcript: (json["transcript"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            durationMs: json["durationMs"] as? Int,
            width: json["width"] as? Int,
            height: json["height"] as? Int
        )
    }

    var link: URL? { URL(string: url) }

    /// What POST /api/messages carries. Only the fields the server names —
    /// anything else it would drop anyway (`decideDmAttachments`).
    var wire: [String: Any] {
        var out: [String: Any] = ["kind": kind, "url": url, "contentType": contentType]
        if let bytes { out["bytes"] = bytes }
        if let transcript, !transcript.isEmpty { out["transcript"] = transcript }
        if let durationMs { out["durationMs"] = durationMs }
        if let width { out["width"] = width }
        if let height { out["height"] = height }
        return out
    }

    /// The box a thumbnail occupies BEFORE its bytes arrive. Reserved from the
    /// stored pixel size so the thread doesn't reflow mid-scroll as photos load
    /// — the reason `width`/`height` are on the wire at all.
    func previewBox(maxWidth: CGFloat) -> CGSize {
        guard let w = width, let h = height, w > 0, h > 0 else {
            return CGSize(width: maxWidth, height: maxWidth * 0.75)
        }
        let tall = maxWidth * CGFloat(h) / CGFloat(w)
        return CGSize(width: maxWidth, height: min(maxWidth * 1.4, max(80, tall)))
    }
}

/// Decode a message's attachments. Order is preserved (it is the order they
/// were attached in) and an unparseable entry is skipped rather than aborting
/// the message — a bad row must not cost the reader the text beside it.
func dmAttachments(from json: Any?) -> [DmAttachment] {
    guard let list = json as? [[String: Any]] else { return [] }
    return list.enumerated().compactMap { DmAttachment(json: $0.element, slot: $0.offset) }
}

/// The POST /api/messages body for a DM, media or not.
///
/// `nonisolated` and a free function rather than a `var` inside `DmModel.send`
/// for a Swift-6 reason worth writing down, because the obvious version does not
/// compile: `[String: Any]` is not Sendable, so a dictionary assembled inside
/// the @MainActor model joins the main actor's region and cannot be passed to
/// the nonisolated `Api.post` — "sending 'body' risks causing data races".
/// Assembled here it is born disconnected and crosses cleanly, and it keeps the
/// wire shape next to the `DmAttachment.wire` that fills half of it.
nonisolated func dmSendBody(to login: String, text: String, attachments: [DmAttachment]) -> [String: Any] {
    var body: [String: Any] = ["to": login, "message": text]
    // Omitted rather than sent empty: `decideDmAttachments` treats a missing key
    // and an empty array identically, but the absent key is what every
    // text-only client has always sent, so it is the shape with the mileage.
    if !attachments.isEmpty { body["attachments"] = attachments.map(\.wire) }
    return body
}

// ── staging: prepared bytes waiting for their upload ─────────────────────────

/// An attachment the user has picked, on its way to the store.
struct StagedDmMedia: Identifiable, Sendable {
    enum Status: String, Sendable {
        case uploading, ready, failed
    }

    let id: UUID
    let kind: String
    let contentType: String
    /// The exact bytes /api/media will get. Kept after a failure so Retry
    /// re-posts the same file instead of asking the user to find it again.
    let bytes: Data
    let name: String
    /// 96px JPEG, base64 — the composer chip (`AttachmentThumb`).
    let thumb: String?
    let durationMs: Int?
    let transcript: String?
    let width: Int?
    let height: Int?
    var status: Status
    var error: String?
    var attachment: DmAttachment?

    init(kind: String, contentType: String, bytes: Data, name: String, thumb: String? = nil,
         durationMs: Int? = nil, transcript: String? = nil, width: Int? = nil, height: Int? = nil) {
        self.id = UUID()
        self.kind = kind
        self.contentType = contentType
        self.bytes = bytes
        self.name = name
        self.thumb = thumb
        self.durationMs = durationMs
        self.transcript = transcript
        self.width = width
        self.height = height
        self.status = .uploading
    }

    /// The glyph for a chip with no thumbnail (a voice note has no picture).
    var glyph: String {
        switch kind {
        case "audio": return "waveform"
        case "video": return "film"
        default: return "photo"
        }
    }
}

/// Prepared, or refused with a line to show the user. Mirrors
/// `AttachmentCodec.DocResult`: a `nil` return is how a rejected pick becomes a
/// file that silently vanished from the composer.
enum DmMediaResult: Sendable {
    case ok(StagedDmMedia)
    case refused(String)
}

/// A movie picked from the library, copied out of the Photos sandbox.
///
/// `loadTransferable(type: Data.self)` would work — and would also pull a 4K
/// clip into memory whole before we know its duration. A file copy costs disk
/// we delete straight after and lets `AVURLAsset` read the duration first.
struct DmPickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("dm-pick-\(UUID().uuidString).\(ext)")
            try? FileManager.default.removeItem(at: copy)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

/// Picked file → uploadable bytes. Pure-ish: no session, no network, no UI —
/// every branch ends in `.ok` or a `.refused` sentence.
enum DmMediaCodec {
    // ── photos ───────────────────────────────────────────────────────────────

    /// Downscale to `kDmImageMaxDim` and re-encode as JPEG. Also the HEIC→JPEG
    /// converter: the store's allowlist has no `image/heic` and HEIC is exactly
    /// what an iPhone picker hands over, so refusing it would make the commonest
    /// photo on this phone unsendable.
    ///
    /// ⚠️ Deliberately NOT `AttachmentCodec.downscale`: that one renders through
    /// `UIGraphicsImageRenderer(size:)` with the default format, whose `scale` is
    /// the SCREEN's (3.0 here) — so a "1568pt" render is 4704 pixels wide and a
    /// 4032px photo comes out BIGGER than it went in. Fine-ish for the chat rail
    /// (it only inflates the payload), fatal here, where the byte cap is what
    /// decides whether the DM can be sent at all. Flagged, not fixed, because
    /// that path has its own payload pins.
    @MainActor
    static func prepareImage(_ image: UIImage, name: String) -> DmMediaResult {
        // Byte-budget walk (chat rail's encodeWithinBudget pattern): best-case
        // first, then quality down, then dims — a small upload is a FAST upload
        // and DM photos ride cellular more often than not. First fit wins.
        let rungs: [(dim: CGFloat, q: CGFloat)] = [
            (kDmImageMaxDim, kDmImageQuality), (kDmImageMaxDim, 0.7),
            (kDmImageMaxDim, 0.6), (kDmImageMaxDim, 0.5),
            (1280, 0.6), (1024, 0.6), (1024, 0.5),
            (896, 0.5), (768, 0.5), (640, 0.45), (512, 0.45), (512, 0.35),
        ]
        var scaled = pixelPerfectDownscale(image, maxDim: kDmImageMaxDim)
        var jpeg: Data? = nil
        for rung in rungs {
            let candidate = pixelPerfectDownscale(image, maxDim: rung.dim)
            guard let data = candidate.jpegData(compressionQuality: rung.q) else { continue }
            scaled = candidate
            jpeg = data
            if data.count <= kDmImageTargetBytes { break }
        }
        guard let jpeg else {
            return .refused("“\(name)” couldn't be prepared for sending — nothing was sent.")
        }
        // Checked AFTER the shrink: a 12MP camera shot is over the cap as picked
        // and comfortably under it once re-encoded, so refusing on the original
        // size would reject the single commonest attachment there is.
        if let tooBig = dmSizeRefusal(jpeg.count, "“\(name)”") { return .refused(tooBig) }
        let thumb = pixelPerfectDownscale(image, maxDim: 96)
            .jpegData(compressionQuality: 0.6)?.base64EncodedString()
        return .ok(StagedDmMedia(
            kind: "image", contentType: "image/jpeg", bytes: jpeg, name: name, thumb: thumb,
            width: Int(scaled.size.width * scaled.scale), height: Int(scaled.size.height * scaled.scale)
        ))
    }

    /// `AttachmentCodec.downscale` with the scale pinned to 1, so "points" and
    /// "pixels" are the same number and the cap means what it says.
    @MainActor
    static func pixelPerfectDownscale(_ image: UIImage, maxDim: CGFloat) -> UIImage {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let ratio = min(1, maxDim / max(pixels.width, pixels.height, 1))
        let target = CGSize(width: max(1, (pixels.width * ratio).rounded()),
                            height: max(1, (pixels.height * ratio).rounded()))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    // ── clips ────────────────────────────────────────────────────────────────

    /// Transcode a picked clip to H.264/mp4 small enough to send.
    ///
    /// The preset ladder is the whole design: presets are the only bitrate
    /// control `AVAssetExportSession` offers, so instead of predicting a size we
    /// export, MEASURE, and step down once if the result is still over. Two
    /// exports at most, and if the smaller one still doesn't fit the refusal says
    /// so in bytes rather than blaming the file.
    static func prepareClip(url: URL) async -> DmMediaResult {
        defer { try? FileManager.default.removeItem(at: url) }
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration), duration.isNumeric, duration.seconds > 0 else {
            return .refused("That clip couldn't be read — nothing was sent.")
        }
        if let refusal = dmClipRefusal(duration.seconds) { return .refused(refusal) }

        var lastFailure = ""
        var oversize: Int?
        // 540p first (legible on any phone), then LowQuality. Both presets are
        // H.264 — the HEVC ones are named `…HEVC…`, and HEVC in mp4 is what a
        // Chrome recipient cannot play.
        for preset in [AVAssetExportPreset960x540, AVAssetExportPresetLowQuality] {
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("dm-clip-\(UUID().uuidString).mp4")
            guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
                lastFailure = "this phone can't compress that clip"
                continue
            }
            do {
                try await session.export(to: out, as: .mp4)
            } catch {
                lastFailure = error.localizedDescription
                try? FileManager.default.removeItem(at: out)
                continue
            }
            guard let data = try? Data(contentsOf: out), !data.isEmpty else {
                lastFailure = "the compressed clip came back empty"
                try? FileManager.default.removeItem(at: out)
                continue
            }
            if data.count > kDmUploadMaxBytes {
                oversize = data.count
                try? FileManager.default.removeItem(at: out)
                continue  // ← the whole point of the ladder
            }
            let thumb = await jpegThumb(out)
            let size = await pixelSize(out)
            try? FileManager.default.removeItem(at: out)
            return .ok(StagedDmMedia(
                kind: "video", contentType: "video/mp4", bytes: data, name: "clip.mp4", thumb: thumb,
                durationMs: Int(duration.seconds * 1000), width: size?.width, height: size?.height
            ))
        }
        if let oversize {
            // Honest about which limit was hit, and the only remedy that works.
            return .refused(
                "Even compressed, that clip is \(dmMB(oversize)) — over the "
                + "\(dmMB(kDmUploadMaxBytes)) limit, so nothing was sent. Send a shorter piece of it."
            )
        }
        return .refused("That clip couldn't be compressed for sending (\(lastFailure)) — nothing was sent.")
    }

    /// First-frame poster for a clip chip/bubble.
    private static func jpegThumb(_ url: URL) async -> String? {
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        gen.appliesPreferredTrackTransform = true   // or a portrait clip lies down
        gen.maximumSize = CGSize(width: 192, height: 192)
        guard let (frame, _) = try? await gen.image(at: CMTime(seconds: 0.1, preferredTimescale: 600)) else {
            return nil
        }
        return UIImage(cgImage: frame).jpegData(compressionQuality: 0.6)?.base64EncodedString()
    }

    /// Pixel size of the EXPORTED clip, transform applied — the box a recipient
    /// reserves for it.
    private static func pixelSize(_ url: URL) async -> (width: Int, height: Int)? {
        guard let track = try? await AVURLAsset(url: url).loadTracks(withMediaType: .video).first,
              let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform)
        else { return nil }
        let shown = natural.applying(transform)
        return (Int(abs(shown.width).rounded()), Int(abs(shown.height).rounded()))
    }

    // ── voice notes ──────────────────────────────────────────────────────────

    /// A finished recording → an uploadable voice note (+ what the phone heard).
    ///
    /// `seconds` is the recorder's own count, passed in because
    /// `AVAudioRecorder.currentTime` reads 0 once stopped — it has to be captured
    /// before `stop()`, and a duration of "0:00" on every voice note is exactly
    /// what forgetting that produces.
    static func prepareVoiceNote(url: URL, seconds: TimeInterval) async -> DmMediaResult {
        defer { try? FileManager.default.removeItem(at: url) }
        guard seconds >= kDmVoiceMinSeconds else {
            return .refused("That was too short to send — tap the mic and talk, then tap Stop.")
        }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return .refused("The recording couldn't be read back — nothing was sent.")
        }
        if let tooBig = dmSizeRefusal(data.count, "That voice note") { return .refused(tooBig) }
        // The file's own duration beats the recorder's counter by a few ms of
        // trailing buffer, and it's free.
        let measured = (try? await AVURLAsset(url: url).load(.duration))?.seconds ?? seconds
        let heard = await transcribe(url)
        return .ok(StagedDmMedia(
            kind: "audio", contentType: "audio/mp4", bytes: data, name: "voice-note.m4a",
            durationMs: Int(max(seconds, measured) * 1000), transcript: heard
        ))
    }

    /// 🗣️ On-device transcript, or nil.
    ///
    /// Nil is a real answer: `dmAttachmentSummary` reports "no transcript
    /// available" rather than an empty utterance, and the audio sends either way.
    /// The transcript is what lets the AGENT read a voice note (`read_messages`)
    /// instead of only knowing one exists — but it is a bonus, and a bonus must
    /// never fail the message.
    ///
    /// `requiresOnDeviceRecognition` is not negotiable here: a DM is between two
    /// people, and shipping its audio to Apple's servers to get a nicer
    /// transcript is not a trade this app gets to make quietly (`Voice.swift`
    /// makes the same call for the same reason). Where on-device isn't available
    /// for the locale, there is simply no transcript.
    static func transcribe(_ url: URL) async -> String? {
        guard await speechAuthorized() else { return nil }
        // Bounded: a recogniser that never calls back would otherwise leave the
        // chip spinning forever with the audio already recorded and sendable.
        let heard = await withTaskGroup(of: String?.self) { group in
            group.addTask { await recognizeOnDevice(url) }
            group.addTask {
                try? await Task.sleep(for: .seconds(20))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let heard, !heard.isEmpty else { return nil }
        // Clipped locally too, though the worker clips independently: `prefix`
        // counts graphemes and the server counts code points, so this is the
        // looser of the two and can only ever under-trim.
        return String(heard.prefix(kDmMaxTranscriptChars))
    }

    /// Everything the recogniser touches is created INSIDE this function: none
    /// of `SFSpeechRecognizer`/`SFSpeechURLRecognitionRequest`/`UIImage` is
    /// Sendable, and this file is Swift 6 language mode.
    private static func recognizeOnDevice(_ url: URL) async -> String? {
        guard let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return nil }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        // A voice note is a sentence someone said, and it is read as text by
        // both the recipient and the agent — without punctuation it arrives as
        // one unreadable run-on.
        request.addsPunctuation = true
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let once = DmResumeOnce(continuation)
            // `[recognizer]`: the task does not keep it alive, and a deallocated
            // recogniser stops calling back at all — which, without the timeout
            // above, would hang this continuation forever.
            recognizer.recognitionTask(with: request) { [recognizer] result, error in
                _ = recognizer
                if error != nil { once.finish(nil); return }
                guard let result, result.isFinal else { return }
                once.finish(result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    private static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
    }
}

/// A continuation a callback may reach more than once. `recognitionTask`'s
/// handler can fire with a result AND an error, and resuming twice is a crash,
/// not a warning.
private final class DmResumeOnce: @unchecked Sendable {
    private var continuation: CheckedContinuation<String?, Never>?
    private let lock = NSLock()

    init(_ continuation: CheckedContinuation<String?, Never>) {
        self.continuation = continuation
    }

    func finish(_ value: String?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}

// ── the composer's staging area ──────────────────────────────────────────────

/// Attachments staged for a DM, and the recorder that makes one of them.
///
/// Keyed BY PEER, like the drafts the web composer keys the same way and for the
/// same reason: the composer stays alive across a peer switch, so a single
/// shared list would carry a photo meant for A into a send to B. The login is
/// also captured before every await, so a slow upload lands in the thread it was
/// picked for and not in whichever one is open when it finishes.
@MainActor
final class DmComposer: ObservableObject {
    @Published private(set) var pending: [String: [StagedDmMedia]] = [:]
    /// The last refusal, shown verbatim in the composer. Every one of them names
    /// the cause and the fix; replacing them with "couldn't attach that" throws
    /// away the actionable half.
    @Published var error: String?
    @Published private(set) var recording = false
    @Published private(set) var recordSeconds: TimeInterval = 0

    private var recorder: AVAudioRecorder?
    private var recordURL: URL?
    private var recordLogin = ""
    private var recordToken: String?
    private var ticker: Task<Void, Never>?

    func list(_ login: String) -> [StagedDmMedia] { pending[login] ?? [] }

    func isFull(_ login: String) -> Bool { list(login).count >= kDmMaxAttachments }

    /// The attachments a send may carry — only the uploaded ones.
    func ready(_ login: String) -> [DmAttachment] { list(login).compactMap(\.attachment) }

    /// Why this send must NOT go yet, or nil. A DM that leaves while an upload is
    /// in flight arrives without the photo, and it cannot be unsent.
    func blockingReason(_ login: String) -> String? {
        let items = list(login)
        if items.contains(where: { $0.status == .uploading }) {
            return "Still uploading — one moment."
        }
        if items.contains(where: { $0.status == .failed }) {
            return "An attachment didn't upload. Retry it or remove it — nothing was sent."
        }
        return nil
    }

    /// Called with the peer that was actually SENT to, not whoever is on screen
    /// when the POST resolves.
    func clear(_ login: String) {
        pending[login] = nil
    }

    func remove(_ id: UUID, from login: String) {
        pending[login]?.removeAll { $0.id == id }
        if pending[login]?.isEmpty == true { pending[login] = nil }
        error = nil
    }

    // ── picking ──────────────────────────────────────────────────────────────

    func addPicks(_ picks: [PhotosPickerItem], login: String, token: String?) async {
        guard !picks.isEmpty else { return }
        error = nil
        // The whole batch, or none of it: keeping the first N would make a photo
        // the user watched themselves attach vanish before the send.
        if let refusal = dmAttachmentRoom(list(login).count, picks.count) {
            error = refusal
            return
        }
        var refusals: [String] = []
        for pick in picks {
            guard !isFull(login) else { break }
            switch await prepare(pick) {
            case .refused(let why): refusals.append(why)
            case .ok(let media): await attach(media, login: login, token: token)
            }
        }
        // Each refusal names a different file; collapsing them to one line would
        // hide which pick didn't make it.
        if !refusals.isEmpty { error = refusals.joined(separator: "\n") }
    }

    func addCamera(_ image: UIImage, login: String, token: String?) async {
        error = nil
        if let refusal = dmAttachmentRoom(list(login).count, 1) {
            error = refusal
            return
        }
        switch DmMediaCodec.prepareImage(image, name: "photo.jpg") {
        case .refused(let why): error = why
        case .ok(let media): await attach(media, login: login, token: token)
        }
    }

    private func prepare(_ pick: PhotosPickerItem) async -> DmMediaResult {
        if pick.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
            guard let movie = try? await pick.loadTransferable(type: DmPickedMovie.self) else {
                return .refused("That clip couldn't be loaded from your library — nothing was sent.")
            }
            return await DmMediaCodec.prepareClip(url: movie.url)
        }
        guard let data = try? await pick.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            return .refused("That photo couldn't be loaded from your library — nothing was sent.")
        }
        return DmMediaCodec.prepareImage(image, name: "photo.jpg")
    }

    // ── uploading ────────────────────────────────────────────────────────────

    private func attach(_ media: StagedDmMedia, login: String, token: String?) async {
        pending[login, default: []].append(media)
        await upload(media.id, login: login, token: token)
    }

    func retry(_ id: UUID, login: String, token: String?) async {
        patch(id, login: login) { item in
            item.status = .uploading
            item.error = nil
        }
        await upload(id, login: login, token: token)
    }

    /// Deliberately no automatic retry: an auto-retried multi-megabyte body on a
    /// bad connection is how you get four copies in R2 and a composer that looks
    /// stuck. The chip keeps its bytes and offers Retry instead.
    private func upload(_ id: UUID, login: String, token: String?) async {
        guard let media = list(login).first(where: { $0.id == id }) else { return }
        do {
            // 120s, not the 30s JSON house rule: this body is megabytes of
            // base64 and a cellular uplink at ~1MB/min needs the room — the 30s
            // default was the silent "photo/voice note won't send" on LTE.
            // The server side allows 30s worker time AFTER the body lands, so
            // the long bound here is about the uplink, not the worker.
            let res: [String: Any] = try await Api.post("/api/media", token: token, body: [
                "data": media.bytes.base64EncodedString(),
                "contentType": media.contentType,
            ], timeoutSeconds: 120)
            guard let url = res["url"] as? String, !url.isEmpty else {
                // A 200 that carried no url is a failure, not an upload.
                throw ApiError.http(200, res["error"] as? String ?? "the upload returned no url")
            }
            patch(id, login: login) { item in
                item.status = .ready
                item.attachment = DmAttachment(
                    kind: media.kind, url: url, contentType: media.contentType,
                    bytes: media.bytes.count, transcript: media.transcript,
                    durationMs: media.durationMs, width: media.width, height: media.height
                )
            }
        } catch {
            patch(id, login: login) { item in
                item.status = .failed
                item.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func patch(_ id: UUID, login: String, _ change: (inout StagedDmMedia) -> Void) {
        guard var items = pending[login], let at = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[at])
        pending[login] = items
    }

    // ── 🎤 recording ─────────────────────────────────────────────────────────

    func startRecording(login: String, token: String?) {
        guard !recording else { return }
        error = nil
        if let refusal = dmAttachmentRoom(list(login).count, 1) {
            error = refusal
            return
        }
        Task { @MainActor in
            guard await AVAudioApplication.requestRecordPermission() else {
                self.error = "Voice notes need the microphone — enable it in Settings › Tiny."
                return
            }
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.allowBluetooth, .defaultToSpeaker])
                try session.setActive(true)
            } catch {
                self.error = "The microphone isn't available right now (\(error.localizedDescription))."
                return
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("dm-note-\(UUID().uuidString).m4a")
            // AAC mono at 16kHz/32kbps: intelligible speech, ~4KB/s, and
            // `audio/mp4` is in the store's allowlist and plays in every browser.
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ]
            guard let rec = try? AVAudioRecorder(url: url, settings: settings), rec.record() else {
                self.releaseSession()
                self.error = "Couldn't start recording — nothing was sent."
                return
            }
            self.recorder = rec
            self.recordURL = url
            self.recordLogin = login
            self.recordToken = token
            self.recording = true
            self.recordSeconds = 0
            self.ticker = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(200))
                    guard let self, let rec = self.recorder, rec.isRecording else { return }
                    // The RECORDER's own clock, not wall time since the tap: a
                    // cold mic takes a moment to start, and counting that would
                    // report — and cut off at — a length the audio doesn't have.
                    self.recordSeconds = rec.currentTime
                    if rec.currentTime >= kDmVoiceMaxSeconds {
                        // Capped by STOPPING, not by refusing afterwards.
                        self.stopRecording(discard: false)
                        return
                    }
                }
            }
        }
    }

    func stopRecording(discard: Bool) {
        ticker?.cancel()
        ticker = nil
        guard let rec = recorder else {
            if recording { recording = false }
            return
        }
        // ⚠️ Read the length BEFORE stop(): `currentTime` is 0 on a stopped
        // recorder, and reading it after is how every voice note gets "0:00".
        let seconds = rec.currentTime
        rec.stop()
        recorder = nil
        recording = false
        recordSeconds = 0
        releaseSession()
        let url = recordURL
        recordURL = nil
        guard let url else { return }
        guard !discard else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        let login = recordLogin
        let token = recordToken
        Task { @MainActor in
            switch await DmMediaCodec.prepareVoiceNote(url: url, seconds: seconds) {
            case .refused(let why): self.error = why
            case .ok(let media): await self.attach(media, login: login, token: token)
            }
        }
    }

    /// Hand the mic back and let whatever was playing before resume. Same call
    /// `NiclaRecorder` makes after a take.
    private func releaseSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// ── rendering ────────────────────────────────────────────────────────────────

/// A message's attachments, in its bubble. Tapping opens the same full-screen
/// viewer the chat rail uses (`MediaViewerSheet`), so a DM photo behaves exactly
/// like an agent-sent one.
struct DmMediaBubble: View {
    let attachments: [DmAttachment]
    let mine: Bool
    @State private var viewing: ChatMedia?

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            ForEach(attachments) { item in
                switch item.kind {
                case "image": photo(item)
                case "video": clip(item)
                case "audio": DmVoiceNoteView(attachment: item)
                default: other(item)
                }
            }
        }
        .sheet(item: $viewing) { MediaViewerSheet(media: $0) }
    }

    private func open(_ item: DmAttachment) {
        guard let url = item.link else { return }
        viewing = ChatMedia.classify(url) ?? .image(url)
    }

    private func photo(_ item: DmAttachment) -> some View {
        let box = item.previewBox(maxWidth: 220)
        return Group {
            if item.contentType == "image/gif", let url = item.link {
                // SwiftUI's Image only ever shows frame 1 of a GIF.
                ChatGIFView(url: url)
            } else {
                AsyncImage(url: item.link) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    case .failure:
                        // Never a blank box: a photo that didn't load must not
                        // look like a message with nothing in it.
                        VStack(spacing: 4) {
                            Image(systemName: "photo.badge.exclamationmark")
                            Text("Photo didn't load").font(.caption2)
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    default:
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
        }
        // The box is reserved from the stored pixel size, so the thread doesn't
        // jump as each photo arrives.
        .frame(width: box.width, height: box.height)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { open(item) }
        .accessibilityLabel("Photo — tap to open")
    }

    private func clip(_ item: DmAttachment) -> some View {
        let box = item.previewBox(maxWidth: 220)
        // No poster frame is stored server-side (the sender's thumbnail never
        // leaves their composer), so the tile itself is the affordance and the
        // tap plays it in the shared viewer.
        return ZStack {
            Color.black
            VStack(spacing: 6) {
                Image(systemName: "play.circle.fill").font(.system(size: 34))
                Text(dmDuration(item.durationMs).isEmpty ? "Video" : dmDuration(item.durationMs))
                    .font(.caption2.monospacedDigit())
            }
            .foregroundStyle(.white)
        }
        .frame(width: box.width, height: box.height)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { open(item) }
        .accessibilityLabel("Video \(dmDuration(item.durationMs)) — tap to play")
    }

    /// A type this build doesn't render. Shown as a link rather than dropped —
    /// see the `kind` note on `DmAttachment`.
    private func other(_ item: DmAttachment) -> some View {
        Label {
            Text(item.contentType.isEmpty ? "Attachment" : item.contentType).font(.caption)
        } icon: {
            Image(systemName: "paperclip")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color(.secondarySystemBackground), in: Capsule())
        .onTapGesture { open(item) }
    }
}

/// 🎤 A voice note: play/pause, its length, and what the sender's phone heard.
///
/// The transcript is shown, not hidden behind a disclosure: it is the only part
/// that is searchable, readable in a noisy room, and readable by someone who
/// can't play audio at all.
struct DmVoiceNoteView: View {
    let attachment: DmAttachment
    @State private var player: AVPlayer?
    @State private var playing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button(action: toggle) {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Color.green, in: Circle())
                }
                .accessibilityLabel(playing ? "Pause voice note" : "Play voice note")
                Image(systemName: "waveform")
                    .foregroundStyle(.secondary)
                Text(dmDuration(attachment.durationMs).isEmpty
                     ? "Voice note" : "Voice note · \(dmDuration(attachment.durationMs))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let said = attachment.transcript, !said.isEmpty {
                Text("“\(said)”")
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: 250, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .onDisappear {
            player?.pause()
            playing = false
        }
    }

    private func toggle() {
        if playing {
            player?.pause()
            playing = false
            return
        }
        guard let url = attachment.link else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        let p = player ?? AVPlayer(url: url)
        player = p
        // Rewind a finished note so the button plays it again instead of doing
        // nothing at the end of the file.
        if let item = p.currentItem, item.currentTime() >= item.duration, item.duration.isNumeric {
            p.seek(to: .zero)
        }
        NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
        ) { _ in Task { @MainActor in playing = false } }
        p.play()
        playing = true
    }
}

/// The staged-attachment strip above the composer: thumbnail, progress, retry,
/// remove.
struct DmStagedStrip: View {
    let items: [StagedDmMedia]
    let onRemove: (UUID) -> Void
    let onRetry: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    ZStack(alignment: .topTrailing) {
                        chip(item)
                        Button { onRemove(item.id) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .offset(x: 5, y: -5)
                        .accessibilityLabel("Remove attachment")
                    }
                    .padding(.top, 5).padding(.trailing, 5)
                }
            }
            .padding(.horizontal)
        }
        .frame(height: 78)
    }

    private func chip(_ item: StagedDmMedia) -> some View {
        ZStack {
            if let thumb = item.thumb {
                AttachmentThumb(base64: thumb, size: 56)
            } else {
                Image(systemName: item.glyph)
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, height: 56)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            }
            switch item.status {
            case .uploading:
                // A chip that looks finished while its bytes are still moving is
                // how a send leaves without the photo.
                RoundedRectangle(cornerRadius: 10).fill(.black.opacity(0.45))
                    .frame(width: 56, height: 56)
                ProgressView().tint(.white).accessibilityLabel("Uploading attachment")
            case .failed:
                RoundedRectangle(cornerRadius: 10).fill(.black.opacity(0.55))
                    .frame(width: 56, height: 56)
                Button { onRetry(item.id) } label: {
                    VStack(spacing: 2) {
                        Image(systemName: "arrow.clockwise")
                        Text("Retry").font(.caption2)
                    }
                    .foregroundStyle(.white)
                }
                .accessibilityLabel("Retry upload — \(item.error ?? "upload failed")")
            case .ready:
                if let length = durationLabel(item) {
                    Text(length)
                        .font(.caption2.monospacedDigit())
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(.black.opacity(0.6), in: Capsule())
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56, alignment: .bottomTrailing)
                }
            }
        }
    }

    private func durationLabel(_ item: StagedDmMedia) -> String? {
        let label = dmDuration(item.durationMs)
        return label.isEmpty ? nil : label
    }
}

/// Attach buttons for the DM composer — library, camera, mic.
struct DmAttachControls: View {
    @ObservedObject var composer: DmComposer
    let login: String
    let token: String?
    @State private var picks: [PhotosPickerItem] = []
    @State private var showCamera = false

    var body: some View {
        HStack(spacing: 12) {
            PhotosPicker(
                selection: $picks,
                // Never offer more slots than the message can carry.
                maxSelectionCount: max(1, kDmMaxAttachments - composer.list(login).count),
                matching: .any(of: [.images, .videos])
            ) {
                Image(systemName: "photo.on.rectangle.angled")
            }
            .disabled(composer.isFull(login))
            .accessibilityLabel("Attach photo or video")

            Button { showCamera = true } label: { Image(systemName: "camera") }
                .disabled(composer.isFull(login))
                .accessibilityLabel("Take a photo")

            Button { composer.startRecording(login: login, token: token) } label: {
                Image(systemName: "mic")
            }
            .disabled(composer.isFull(login))
            .accessibilityLabel("Record a voice note")
        }
        .font(.system(size: 19))
        .foregroundStyle(composer.isFull(login) ? .secondary : .primary)
        .onChange(of: picks) { _, new in
            guard !new.isEmpty else { return }
            // Cleared first so re-picking the same asset fires again (the
            // selection is the state, and an unchanged selection is no change).
            picks = []
            Task { await composer.addPicks(new, login: login, token: token) }
        }
        .sheet(isPresented: $showCamera) {
            CameraPicker { image in
                Task { await composer.addCamera(image, login: login, token: token) }
            }
        }
    }
}

/// The composer row while a voice note is being recorded: elapsed time, the cap,
/// and both ways out.
struct DmRecordingBar: View {
    @ObservedObject var composer: DmComposer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(.red)
                .frame(width: 10, height: 10)
                .opacity(pulse ? 0.35 : 1)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.7).repeatForever()) { pulse = true }
                }
            Text(dmDuration(Int(composer.recordSeconds * 1000)).isEmpty
                 ? "0:00" : dmDuration(Int(composer.recordSeconds * 1000)))
                .font(.subheadline.monospacedDigit())
            Text("max \(Int(kDmVoiceMaxSeconds))s")
                .font(.caption2).foregroundStyle(.tertiary)
            Spacer(minLength: 8)
            Button("Discard") { composer.stopRecording(discard: true) }
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                composer.stopRecording(discard: false)
            } label: {
                Text("Stop").font(.caption.weight(.semibold))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.green, in: Capsule())
                    .foregroundStyle(.black)
            }
        }
        .padding()
    }
}
