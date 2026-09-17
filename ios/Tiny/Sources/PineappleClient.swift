import Foundation
import CryptoKit

/// Small replies through the existing owner-scoped relay, never public media URLs
/// or a model conversation. Nothing is retried by sending a second mutation.
@MainActor enum PineappleClient {
    static func invoke(device: String, token: String?, prompt: String) async throws -> [String: Any] {
        guard let token, !token.isEmpty else { throw PineappleError.message("Sign in to reach your Pager.") }
        try Task.checkCancellation()
        let sent: [String: Any] = try await Api.post("/api/devices/relay", token: token, body: [
            "toDevice": device, "payload": ["type": "invoke", "prompt": prompt]
        ])
        guard let id = sent["id"] as? String, !id.isEmpty,
              let query = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw PineappleError.message("The relay did not return a request ID. Check status before trying again.")
        }
        var refusal: String?
        let deadline = Date().addingTimeInterval(70)
        while Date() < deadline {
            try await Task.sleep(for: .seconds(1))
            switch await RelayPoll.read(inReplyTo: query, token: token) {
            case .empty: refusal = nil
            case .unreadable(let reason, let status):
                refusal = reason
                if RelayPoll.isTerminal(status: status) { throw PineappleError.message(reason) }
            case .answered(let payload):
                guard payload.utf8.count <= 8192,
                      let raw = try JSONSerialization.jsonObject(with: Data(RelayReply.text(payload).utf8)) as? [String: Any] else {
                    throw PineappleError.message("Unexpected reply from Pager.")
                }
                guard raw["ok"] as? Bool == true else {
                    throw PineappleError.refused(raw["error"] as? String ?? "Pager refused this request.")
                }
                return raw
            }
        }
        throw PineappleError.message(refusal ?? "Pager has not replied. The request may still be queued; refresh status before trying again.")
    }
    static func command(device: String, token: String?, request: [String: Any]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
        return try await invoke(device: device, token: token, prompt: String(decoding: data, as: UTF8.self))
    }

    /// At most 256 KiB, streamed to a protected local file in <=3072-byte chunks.
    /// Caller must obtain the explicit private-relay export confirmation first.
    static func download(_ capture: PineappleCore.Capture, device: String, token: String?,
                         progress: (Double) -> Void) async throws -> URL {
        try await download(capture, read: { request in
            try await command(device: device, token: token, request: request)
        }, progress: progress)
    }

    /// Transport seam keeps file/hash/cancellation behavior identical in fixture tests.
    static func download(_ capture: PineappleCore.Capture,
                         read: ([String: Any]) async throws -> [String: Any],
                         progress: (Double) -> Void) async throws -> URL {
        guard capture.downloadable, PineappleCore.uuid(capture.id), let expectedHash = capture.sha256 else {
            throw PineappleError.message("Only finalized captures with a valid size and hash can be downloaded.")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Pineapple-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false,
                                              attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
        let url = dir.appendingPathComponent(capture.id + ".pcap")
        guard FileManager.default.createFile(atPath: url.path, contents: nil,
                                             attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600]) else {
            try? FileManager.default.removeItem(at: dir)
            throw PineappleError.message("Could not create a protected capture file.")
        }
        var completed = false
        defer { if !completed { try? FileManager.default.removeItem(at: dir) } }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        var offset = 0
        var hash = SHA256()
        while offset < capture.size {
            try Task.checkCancellation()
            let requested = min(PineappleCore.chunkBytes, capture.size - offset)
            let reply = try await read([
                "action": "capture_read", "job_id": capture.id, "offset": offset,
                "length": requested, "export_confirmed": true
            ])
            try Task.checkCancellation()
            let bytes = try PineappleCore.chunk(reply, job: capture.id, offset: offset, size: capture.size)
            guard bytes.count == requested else { throw PineappleError.message("Incomplete capture chunk.") }
            try handle.write(contentsOf: bytes)
            hash.update(data: bytes)
            offset += bytes.count
            progress(Double(offset) / Double(capture.size))
        }
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expectedHash else {
            throw PineappleError.message("Capture hash did not match. The incomplete download was removed.")
        }
        try Task.checkCancellation()
        try handle.synchronize()
        completed = true
        return url
    }
}
