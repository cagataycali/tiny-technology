/**
 * Sessions — named conversation archives (web's /save + /load, phone-shaped).
 *
 * A session is a snapshot of one tiny's transcript under a user-chosen name:
 * Documents/sessions/<tiny>/<uuid>.json with {name, tiny, savedAt, messages}.
 * Saving never moves the live transcript; loading REPLACES the live
 * transcript (after auto-archiving the current one as a safety net when it
 * has content).
 *
 * Pure logic (list/round-trip) is separated from UI for testability.
 */
import SwiftUI

struct SessionArchive: Identifiable, Codable {
    var id = UUID()
    var name: String
    let tiny: String
    let savedAt: Date
    let messages: [ChatMessage]
    // Auto-backups (written on load() as a safety net) are pruned to the most
    // recent one per tiny — without this flag they were name-matched, and a
    // growing pile of near-identical "Auto-saved before loading…" entries
    // buried the user's real named sessions. Defaults false so pre-existing
    // saved files decode unchanged.
    var autoBackup: Bool = false

    var subtitle: String {
        let df = DateFormatter()
        df.dateStyle = .medium
        df.timeStyle = .short
        return "\(messages.count) messages · \(df.string(from: savedAt))"
    }
}

enum SessionStore {
    static func dir(_ tiny: String) -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("sessions").appendingPathComponent(tiny)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    static func save(_ archive: SessionArchive) throws {
        let url = dir(archive.tiny).appendingPathComponent("\(archive.id.uuidString).json")
        let data = try JSONEncoder().encode(archive)
        try data.write(to: url, options: .atomic)
    }

    /// Newest first
    static func list(_ tiny: String) -> [SessionArchive] {
        let d = dir(tiny)
        let files = (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> SessionArchive? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(SessionArchive.self, from: data)
            }
            .sorted { $0.savedAt > $1.savedAt }
    }

    static func delete(_ archive: SessionArchive) {
        let url = dir(archive.tiny).appendingPathComponent("\(archive.id.uuidString).json")
        try? FileManager.default.removeItem(at: url)
    }

    /// Keep only the newest auto-backup per tiny (the safety net only ever
    /// undoes the LAST load) so they don't accumulate and bury real sessions.
    /// User-named sessions are never touched.
    static func pruneAutoBackups(_ tiny: String, keepingNewest keep: Int = 1) {
        let backups = list(tiny).filter { $0.autoBackup }  // list() is newest-first
        for stale in backups.dropFirst(keep) { delete(stale) }
    }
}

// ── UI: sessions sheet ─────────────────────────────────────────────────────

struct SessionsView: View {
    @ObservedObject var chat: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var archives: [SessionArchive] = []
    @State private var saveName = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                if !chat.messages.isEmpty {
                    Section {
                        HStack {
                            TextField("Name this conversation…", text: $saveName)
                                .focused($nameFocused)
                                .onSubmit(saveCurrent)
                            Button("Save") { saveCurrent() }
                                .buttonStyle(.borderedProminent)
                                .tint(.green)
                                .disabled(saveName.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    } footer: {
                        Text("Snapshots the current \(chat.messages.count)-message conversation. The live chat stays put.")
                    }
                }

                Section {
                    if archives.isEmpty {
                        Text("No saved sessions for \(chat.tiny) yet.")
                            .foregroundStyle(.secondary)
                            .font(.callout)
                    }
                    ForEach(archives) { a in
                        Button {
                            load(a)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(a.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                                Text(a.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                SessionStore.delete(a)
                                archives.removeAll { $0.id == a.id }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("Saved sessions · \(chat.tiny)")
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .onAppear { archives = SessionStore.list(chat.tiny) }
        }
    }

    private func saveCurrent() {
        let name = saveName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !chat.messages.isEmpty else { return }
        let archive = SessionArchive(name: name, tiny: chat.tiny, savedAt: Date(), messages: chat.messages)
        try? SessionStore.save(archive)
        saveName = ""
        nameFocused = false
        archives = SessionStore.list(chat.tiny)
        TinyDesign.haptic()
    }

    private func load(_ a: SessionArchive) {
        // Safety net: the live conversation auto-archives before being replaced,
        // then older auto-backups are pruned so they don't pile up (the net only
        // needs to undo THIS load). Real named sessions are untouched.
        if !chat.messages.isEmpty {
            let backup = SessionArchive(name: "Auto-saved before loading “\(a.name)”",
                                        tiny: chat.tiny, savedAt: Date(),
                                        messages: chat.messages, autoBackup: true)
            try? SessionStore.save(backup)
            SessionStore.pruneAutoBackups(chat.tiny)
        }
        chat.replaceTranscript(with: a.messages)
        TinyDesign.haptic()
        dismiss()
    }
}
