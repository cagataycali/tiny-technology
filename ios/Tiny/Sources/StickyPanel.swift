/**
 * 🧲 StickyPanel — the reTerminal Sticky's remote, inside the Devices sheet.
 *
 * The Sticky is an 800×480 e-ink "phone" on the fridge (platform `esp32s3`),
 * a PULL device like the necklaces: it polls `/api/devices/relay` every 5s,
 * so everything here is one envelope out, one reply back. Firmware verb
 * grammar (tiny_node.cpp dispatch): `screenshot`, `status`, `sensors`,
 * `page home|status|sensors|settings|wifi|back|next|prev`, `ask <text>`,
 * `render_ui {json}`, `say`, `sleep`.
 *
 * Three shapes borrowed from siblings on this same sheet, deliberately:
 *
 *  1. The mirror is `RelayCameraPanel`'s frame flow with `screenshot` in place
 *     of `frame` — the reply carries `images:[{url,format:"bmp"}]`, and
 *     `TinyLive.readFrameAnswer` already knows that envelope. A stale frame is
 *     worth more than a blank rectangle: refresh failures keep the last mirror
 *     and report the reason beneath (the camera panel's documented rule).
 *
 *  2. Presence gates the automatic fetch (`RelayReach`): a Sticky that hasn't
 *     heartbeat in 60s is not reading the relay, so appearing on the sheet
 *     must not spend 20s of polling to paint an alarm over a row that already
 *     says "seen 3 hours ago". A TAP still asks — Retry over silent no-op,
 *     the app-wide rule.
 *
 *  3. Failures name the thing that refused (`RelayPoll.verdict`): a lapsed
 *     session, a refused relay and a silent device are three different
 *     problems, and one blanket string sends the user to the wrong one.
 *
 * E-ink honesty, encoded in the UI copy: a page flip costs a ~1-2s full
 * refresh on glass, so the nav buttons stay disabled while an envelope is in
 * flight rather than queueing invisible flips the panel can't show.
 */
import SwiftUI
import UIKit

// ── Status projection (pure — unit-testable) ────────────────────────────────

/// The `status` verb replies JSON (fw, battery, rssi, heap, uptime…). Every
/// field is a machine's own claim, so every field is optional: absent keys
/// drop out rather than render as zeros — "battery 0%" on a missing key reads
/// as an emergency that isn't happening.
enum StickyStatus {
    /// The status object, unwrapped from however the wire dressed it.
    ///
    /// The firmware's reply contract (tiny_commands.h) is an ENVELOPE — the
    /// payload is `{"result": "<serialized status JSON>"}`, the status one
    /// stringification deeper. Reading `grammar_version` at the top level of
    /// that envelope parses fine, finds nothing, and returns nil — which the
    /// image sender's gate then reports as "the device didn't answer the
    /// grammar probe", a sentence that blames the device for a shape the app
    /// failed to unwrap (fw 0.27.x, 2026-08-29). Both shapes stay legal:
    /// a bare status object (older firmware) is used as-is.
    static func object(_ payload: String) -> [String: Any]? {
        guard let obj = try? JSONSerialization.jsonObject(
                with: Data(payload.utf8)) as? [String: Any]
        else { return nil }
        if let wrapped = obj["result"] as? String,
           let inner = try? JSONSerialization.jsonObject(
                with: Data(wrapped.utf8)) as? [String: Any] {
            return inner
        }
        return obj
    }

    static func readings(_ payload: String) -> [TelemetryReading] {
        guard let obj = object(payload) else { return [] }
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            if let v = value, !v.isEmpty { out.append(TelemetryReading(label: label, value: v)) }
        }
        add("fw", obj["fw"] as? String)
        if let g = grammarVersion(payload) { add("grammar", "v\(g)") }
        // Key drift across firmware generations: 0.27.x says battery_pct /
        // rssi_dbm; earlier builds said battery / rssi. Accept both.
        if let b = EndpointTelemetry.number(obj["battery_pct"] ?? obj["battery"]) {
            let charging = (obj["charging"] as? Bool) == true
            add("battery", "\(Int(b.rounded()))%\(charging ? " ⚡︎" : "")")
        }
        if let r = EndpointTelemetry.number(obj["rssi_dbm"] ?? obj["rssi"]) {
            add("wifi", "\(Int(r.rounded())) dBm")
        }
        if let up = EndpointTelemetry.number(obj["uptime_s"]) {
            let m = Int(up) / 60
            add("up", m >= 60 ? "\(m / 60)h \(m % 60)m" : "\(m)m")
        }
        return out
    }

    /// The firmware's own `grammar_version` claim — the gate the image
    /// sender reads (kStickyImageGrammar). Nil when the field is absent:
    /// absent is "old firmware", and old firmware must gate CLOSED.
    static func grammarVersion(_ payload: String) -> Int? {
        guard let obj = object(payload) else { return nil }
        return EndpointTelemetry.number(obj["grammar_version"]).map { Int($0) }
    }
}

// ── The panel ────────────────────────────────────────────────────────────────

struct StickyPanel: View {
    let deviceId: String
    let deviceName: String
    /// Read BEFORE the auto-fetch — see RelayReach. A tap overrides it.
    let presence: DevicePresence
    let token: String?

    @State private var mirror: UIImage?
    @State private var readings: [TelemetryReading] = []
    @State private var busy = false
    @State private var stamp: Date?
    @State private var error: String?
    /// The last `ask` answer, shown until the next one replaces it.
    @State private var askAnswer: String?
    @State private var askText = ""
    @State private var confirmSleep = false
    /// The device's grammar_version claim, from the last `status` — gates
    /// the photo sender (see kStickyImageGrammar).
    @State private var grammar: Int?
    @State private var showPhoto = false
    @State private var showSay = false
    @State private var showCard = false
    @State private var showMessages = false
    @State private var showUtilities = false
    @State private var utilNote: String?
    @State private var confirmOta = false
    /// Remote-touch mode: a tap on the mirror becomes `tap <x> <y>` on the
    /// glass (StickyTouch owns the coordinate math). Off = tap refreshes.
    @State private var touchMode = false
    @State private var mirrorSize: CGSize = .zero
    @State private var tapNote: String?

    /// The shell's page ring, in the firmware's own order (tiny_shell).
    private static let pages = ["home", "status", "sensors", "settings", "wifi"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            mirrorView
            if !readings.isEmpty { readingsRow }
            pageNav
            askRow
            sayRow
            cardRow
            messagesRow
            photoRow
            utilitiesRow
            footer
        }
        .devicePanel()
        // Automatic only when the board is heartbeating — the appearance fetch
        // on a sleeping Sticky is 20 wasted seconds ending in a false alarm.
        .task { if RelayReach.canReach(presence) { await refresh() } }
        .confirmationDialog("Put \(deviceName) to sleep?",
                            isPresented: $confirmSleep, titleVisibility: .visible) {
            Button("Sleep (AI button wakes it)", role: .destructive) {
                Task { await send("sleep") }
            }
        }
    }

    // ── Mirror ──────────────────────────────────────────────────────────────

    @ViewBuilder private var mirrorView: some View {
        if let m = mirror {
            Image(uiImage: m)
                .resizable()
                // The panel IS 800×480 — never .fill: a cropped e-ink mirror
                // lies about what's on the glass.
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10)
                    .stroke(.secondary.opacity(0.3), lineWidth: 0.5))
                .overlay(alignment: .topTrailing) {
                    if busy { ProgressView().controlSize(.mini).padding(6) }
                }
                .background(GeometryReader { g in
                    Color.clear
                        .onAppear { mirrorSize = g.size }
                        .onChange(of: g.size) { _, n in mirrorSize = n }
                })
                .overlay(alignment: .topLeading) {
                    Button {
                        touchMode.toggle()
                        tapNote = touchMode
                            ? "remote touch on — taps land on the glass" : nil
                    } label: {
                        Image(systemName: touchMode ? "hand.tap.fill" : "hand.tap")
                            .font(.caption)
                            .padding(5)
                            .background(.thinMaterial, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .padding(4)
                    .accessibilityLabel(touchMode ? "Remote touch on" : "Remote touch off")
                    .accessibilityHint("When on, tapping the mirror taps the Sticky's screen")
                }
                .contentShape(Rectangle())
                // One gesture for both modes: minimumDistance 0 means a plain
                // tap arrives as a zero-travel drag, and StickyTouch's
                // classifier (the firmware's own 24px slop) decides tap vs
                // swipe — the same call a finger's release classifier makes.
                .gesture(DragGesture(minimumDistance: 0).onEnded { v in
                    if touchMode {
                        Task { await remoteGesture(from: v.startLocation,
                                                   to: v.location) }
                    } else {
                        Task { await refresh() }
                    }
                })
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("Sticky screen mirror")
                .accessibilityHint(touchMode ? "Taps the Sticky's screen where you touch"
                                             : "Fetches the current screen")
        } else {
            HStack(spacing: 6) {
                if busy {
                    ProgressView().controlSize(.mini)
                    // A mirror is a full relay round-trip plus an e-ink
                    // framebuffer upload — say so, or 10s of spinner reads as
                    // a hang rather than a screen being photographed.
                    Text("asking the Sticky for its screen…")
                } else {
                    Image(systemName: "rectangle.and.text.magnifyingglass")
                    Text(quietNote ?? "tap to mirror the screen")
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
            .onTapGesture { Task { await refresh() } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Mirror the Sticky's screen")
        }
    }

    /// The one line under an empty mirror: the presence excuse when there is
    /// one, the last failure when there was one, the invitation otherwise.
    private var quietNote: String? {
        if let error { return error }
        if !RelayReach.canReach(presence) {
            return "\(deviceName) isn't polling the relay right now — tap to try anyway"
        }
        return nil
    }

    // ── Status readings ──────────────────────────────────────────────────────

    private var readingsRow: some View {
        HStack(spacing: 10) {
            ForEach(readings) { r in
                HStack(spacing: 3) {
                    Text(r.label).foregroundStyle(.secondary)
                    Text(r.value)
                }
            }
            Spacer(minLength: 0)
        }
        .font(.caption2)
    }

    // ── Page navigation (the shell's ring, mirrored as segments) ────────────

    private var pageNav: some View {
        HStack(spacing: 6) {
            ForEach(Self.pages, id: \.self) { p in
                Button(p) { Task { await send("page \(p)", thenMirror: true) } }
                    .font(.caption2)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
            }
            Spacer(minLength: 0)
            Button { confirmSleep = true } label: {
                Image(systemName: "moon.zzz")
            }
            .font(.caption2)
            .buttonStyle(.bordered)
            .controlSize(.mini)
            .accessibilityLabel("Sleep")
        }
        // One envelope at a time: a page flip is a 1-2s full refresh on
        // glass, and queueing three invisible flips paints none of them.
        .disabled(busy)
    }

    // ── Ask ──────────────────────────────────────────────────────────────────

    private var askRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                TextField("Ask on the Sticky's screen…", text: $askText)
                    .font(.caption)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { ask() }
                Button("Ask") { ask() }
                    .font(.caption2)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .disabled(busy || askText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let a = askAnswer {
                Text(a)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func ask() {
        let q = askText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        askText = ""
        // The answer renders on the GLASS (the firmware draws the reply card);
        // the text here is the receipt, so the user sees both surfaces agree.
        Task { await send("ask \(q)", thenMirror: true, showReply: true) }
    }

    // ── Messages (StickyMessages.swift owns the badge + verbs) ──────────────

    private var messagesRow: some View {
        DisclosureGroup(isExpanded: $showMessages) {
            StickyMessagesRow(deviceId: deviceId, deviceName: deviceName,
                              token: token,
                              onGlassChanged: { await fetchMirror() })
                .padding(.top, 4)
        } label: {
            Label("Messages on the glass", systemImage: "envelope")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // ── Photo → glass (StickyImage.swift owns the pipeline) ─────────────────

    private var photoRow: some View {
        DisclosureGroup(isExpanded: $showPhoto) {
            StickyImageSender(deviceId: deviceId, deviceName: deviceName,
                              token: token, grammar: grammar,
                              onGlassChanged: { await fetchMirror() })
                .padding(.top, 4)
        } label: {
            Label("Send a photo to the glass", systemImage: "photo.on.rectangle")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // ── Say → glass (StickySay.swift owns the composer) ─────────────────────

    private var sayRow: some View {
        DisclosureGroup(isExpanded: $showSay) {
            StickySayComposer(deviceId: deviceId, deviceName: deviceName,
                              token: token,
                              onGlassChanged: { await fetchMirror() })
                .padding(.top, 4)
        } label: {
            Label("Put words on the glass", systemImage: "text.bubble")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // ── Card composer (StickyCard.swift owns the grammar) ───────────────────

    private var cardRow: some View {
        DisclosureGroup(isExpanded: $showCard) {
            StickyCardComposer(deviceId: deviceId, deviceName: deviceName,
                               token: token,
                               onGlassChanged: { await fetchMirror() })
                .padding(.top, 4)
        } label: {
            Label("Compose a card", systemImage: "rectangle.3.group")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // ── Utilities: rotate / mic evidence / OTA ───────────────────────────────
    //
    // Firmware truth (tiny_node.cpp, 0.16.7): `rotate 0|90|180|270` sets and
    // HOLDS (manual); `rotate auto` hands the decision back to gravity;
    // `rotate test` renders the SKY-arrow evidence card (the P0 upside-down
    // bug's regression gate). `miccheck 2` records and reports RMS/peak
    // WITHOUT uploading — how sleep→wake→mic is proven with nobody home.
    // `ota` stages from the channel pointer, replies FIRST, then reboots
    // rollback-armed — so the answer arrives, and then the device goes away.

    private var utilitiesRow: some View {
        DisclosureGroup(isExpanded: $showUtilities) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("rotate").font(.caption2).foregroundStyle(.secondary)
                    ForEach(["0", "90", "180", "270", "auto"], id: \.self) { r in
                        Button(r) { Task { await sendUtil("rotate \(r)", thenMirror: true) } }
                            .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                            .disabled(busy)
                    }
                }
                HStack(spacing: 6) {
                    Button("SKY test") { Task { await sendUtil("rotate test", thenMirror: true) } }
                        .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                        .disabled(busy)
                        .accessibilityHint("Renders the orientation evidence card on the glass")
                    Button("Mic check") { Task { await sendUtil("miccheck 2") } }
                        .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                        .disabled(busy)
                        .accessibilityHint("Records 2 seconds and reports levels without uploading")
                    Button("Update firmware") { confirmOta = true }
                        .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                        .disabled(busy)
                    Spacer(minLength: 0)
                }
                if let utilNote {
                    Text(utilNote)
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 4)
        } label: {
            Label("Utilities", systemImage: "wrench.and.screwdriver")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .confirmationDialog("Update \(deviceName)'s firmware?",
                            isPresented: $confirmOta, titleVisibility: .visible) {
            Button("Stage OTA + reboot (rollback-armed)", role: .destructive) {
                Task { await sendUtil("ota", isOta: true) }
            }
        } message: {
            Text("The Sticky stages from its channel, sha-verifies, replies, then reboots into a trial that rolls back if the new firmware can't heartbeat.")
        }
    }

    /// Utility verbs get their own note line — an OTA answer must not be
    /// mistaken for an ask answer. After an OTA the device REBOOTS: no
    /// mirror chase (it would time out against a booting board), just the
    /// honest wait estimate.
    private func sendUtil(_ verb: String, thenMirror: Bool = false,
                          isOta: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        utilNote = "sending \(verb)…"
        switch await invoke(verb) {
        case .refused(let why):
            utilNote = why
        case .answered(let payload):
            let text = RelayReply.text(payload)
            if isOta, text.contains("rebooting") {
                utilNote = text + " — the glass goes dark for ~20s; tap the mirror after it's back."
            } else {
                utilNote = text
                if thenMirror {
                    try? await Task.sleep(for: .seconds(2))
                    await fetchMirror()
                }
            }
        }
    }

    // ── Footer ───────────────────────────────────────────────────────────────

    private var footer: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let asOf = ReadingAge.asOf(stamp) {
                Text(asOf).foregroundStyle(.secondary)
            }
            // A failed refresh keeps the last good mirror, so the reason needs
            // somewhere to go here too — the camera panel's rule.
            if let error, mirror != nil {
                Text("· \(error)").foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let tapNote {
                Text("· \(tapNote)").foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .font(.caption2)
    }

    // ── Wire ─────────────────────────────────────────────────────────────────

    /// One envelope: send → poll → verdict. The dance lives in StickyRelay
    /// (StickyImage.swift) now, shared with the photo sender — this wrapper
    /// just keeps the panel's call sites short.
    private func invoke(_ prompt: String) async -> StickyRelay.Outcome {
        await StickyRelay.invoke(prompt, deviceId: deviceId,
                                 deviceName: deviceName, token: token)
    }

    /// Fire a verb; optionally re-mirror after (a page flip or an ask changed
    /// the glass, and a mirror that doesn't follow is a mirror that lies).
    private func send(_ prompt: String, thenMirror: Bool = false,
                      showReply: Bool = false) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        switch await invoke(prompt) {
        case .refused(let why):
            error = why
        case .answered(let payload):
            if showReply { askAnswer = RelayReply.text(payload) }
            if thenMirror {
                // The glass needs its 1-2s refresh before a screenshot shows
                // the new page rather than the old one mid-wipe.
                try? await Task.sleep(for: .seconds(2))
                await fetchMirror()
            }
        }
    }

    /// Mirror + status in one pass — the panel's whole picture of the device.
    private func refresh() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        await fetchMirror()
        if case .answered(let payload) = await invoke("status") {
            readings = StickyStatus.readings(payload)
            grammar = StickyStatus.grammarVersion(payload)
        }
    }

    /// Remote touch: finished drag → tap or swipe verb (StickyTouch's
    /// classifier) → receipt line → re-mirror (the gesture probably changed
    /// the glass; a mirror that doesn't follow is a mirror that lies).
    private func remoteGesture(from: CGPoint, to: CGPoint) async {
        guard !busy else { return }
        guard let cmd = StickyTouch.gestureCommand(from: from, to: to,
                                                   viewSize: mirrorSize) else {
            tapNote = "that touch didn't map onto the panel — try again"
            return
        }
        busy = true
        defer { busy = false }
        tapNote = "sending \(cmd)…"
        switch await invoke(cmd) {
        case .refused(let why):
            tapNote = why
        case .answered(let payload):
            tapNote = StickyTouch.receiptLine(payload)
            try? await Task.sleep(for: .seconds(2))
            await fetchMirror()
        }
    }

    /// `screenshot` → reply's `images[0].url` → BMP bytes → UIImage.
    /// `TinyLive.readFrameAnswer` owns the envelope shape (shared with the
    /// necklace's camera); an answer WITHOUT an image is still an answer and
    /// becomes the reason line, never a timeout.
    private func fetchMirror() async {
        switch await invoke("screenshot") {
        case .refused(let why):
            error = why
        case .answered(let payload):
            switch TinyLive.readFrameAnswer(payload) {
            case .words(let said):
                error = said
            case .imageURL(let url):
                guard let (data, _) = try? await URLSession.shared.data(from: url),
                      let img = UIImage(data: data)
                else { error = "Screen arrived but wouldn't decode."; return }
                mirror = img
                stamp = Date()
            }
        }
    }
}
