/**
 * FlipperBlePanel — the phone's own Flipper link, on this phone's device row.
 *
 * FlipperDevicePanel (Panels.swift) is about a Flipper on the far end of a USB
 * cable: it reports the HOST's name and presence, because that machine being
 * asleep is the usual reason the Flipper is unreachable. This panel is the other
 * route — no cable and no host, just the board in the user's pocket and the phone
 * next to it. So it sits on this phone's row, where the link actually lives.
 *
 * The pairing flow is a scan rather than a QR or a code entry, because the
 * Flipper's serial characteristics are ATTR_PERMISSION_AUTHEN_* in firmware: iOS
 * raises the system pairing sheet the moment we subscribe, and the 6-digit code
 * appears on the Flipper's own screen. Nothing this file can do replaces that
 * moment, so it gets out of the way and explains what to expect.
 */
import CoreGraphics
import SwiftUI

struct FlipperBlePanel: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @State private var showPairing = false
    @State private var showFiles = false
    @State private var showScreen = false
    @State private var busy = false
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "wave.3.right").foregroundStyle(.orange)
                Text("Flipper Zero").font(.caption.bold())
                Text("over Bluetooth").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if busy { ProgressView().controlSize(.mini) }
            }

            if flipper.unit == nil {
                // The pitch, in one line, because this is the only place the
                // feature is discoverable.
                Text("Link the Flipper to this phone and it answers from your pocket — no cable, no laptop awake.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Find my Flipper") { showPairing = true }
                    .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
            } else {
                paired
            }

            if let n = note {
                Text(n).font(.caption2).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // `note` is what the button this row owns just did; the link's own
            // problem belongs to every surface, so it comes from the shared view.
            FlipperLinkProblem()
        }
        .devicePanel()
        .sheet(isPresented: $showPairing) { FlipperPairingSheet() }
        .sheet(isPresented: $showFiles) { FlipperFilesSheet() }
        .sheet(isPresented: $showScreen) { FlipperScreenSheet() }
    }

    @ViewBuilder private var paired: some View {
        let u = flipper.unit
        HStack(spacing: 6) {
            Circle()
                .fill(flipper.linked ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
            Text(u?.name ?? "Flipper").font(.caption2)
            Spacer()
        }
        if flipper.linked {
            if let info = flipper.info {
                Text(info.summary)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // Inside the same branch, so an age is never drawn without the
                // reading it ages — and dated by when the board answered, not by
                // when anyone asked. The line it dates is a battery percentage
                // and a free-space figure, and neither stays true because the
                // panel is still open. Same rule FlipperDevicePanel established.
                if let asOf = ReadingAge.asOf(flipper.infoAt) {
                    Text(asOf).font(.caption2).foregroundStyle(.secondary)
                }
                // ⚠️ Live off the stored reading, not off the last tap. Every bit of
                // `summary` is conditional, so a reading that came back without the
                // battery just draws a shorter line — and the age line above then
                // dates that short line as current. `note` cannot cover this: the
                // refresh after a link comes up is the gateway's own
                // (`finishLink`), so the first line this row ever shows is one
                // nobody tapped for.
                if let missing = FlipperGateway.missingLine(info.gaps) {
                    Text(missing).font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !flipper.activity.isEmpty {
                Text(flipper.activity).font(.caption2).foregroundStyle(.blue)
            }
            HStack(spacing: 6) {
                Button("Refresh") { Task { await refresh() } }
                // Find-my-Flipper, and the friendliest proof the link is real —
                // the board makes itself heard in the user's hand. What comes back
                // is the board's ACKNOWLEDGEMENT, though, never a sound anyone
                // heard: see `FlipperGateway.alertSent(for:)`.
                Button("Beep") { Task { await beep() } }
                Button("Files") { showFiles = true }
                // The half of this feature the cable has no answer for at all.
                Button("Screen") { showScreen = true }
            }
            .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
            .disabled(busy)
        } else {
            // "Out of range" is the normal state of something in a bag, not an
            // error. Say what it means rather than colouring it red.
            //
            // ⚠️ It used to say "make sure Bluetooth is on in its settings" — the
            // BOARD's Settings → Bluetooth, one row above "Forget all paired
            // devices" — and this branch renders ONLY when `unit != nil`, so the
            // advice was given exactly when there was a pairing to lose. The
            // pairing sheet says the same thing legitimately: there, no bond
            // exists yet. `outageLine(for:)` is shared with the relay reply and
            // `statusLine()`, and it names THIS phone's radio when that is the
            // reason, which is the one cause with a one-tap fix.
            Text(flipper.outageLine(for: .panelSheet))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button("Reconnect") { flipper.start() }
                Button("Unlink") { flipper.forget() }
            }
            .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
        }
    }

    private func refresh() async {
        busy = true
        defer { busy = false }
        note = nil
        // ⚠️ The age line is dated by `flipper.infoAt` — when the READING was
        // taken — never by when this button was pressed. Stamping `Date()` here
        // unconditionally is what this used to do, and a refresh whose every
        // request timed out then relabelled the old battery figure "as of" the
        // moment the user tapped: the one mechanism in the app for admitting a
        // reading's age, certifying a stale one instead.
        // ⚠️ The CAUSE comes from the reading, not from this method. This note used
        // to say "the link is up but it didn't answer" for every failure, which is
        // the one thing it could not know: `linked` may have gone false during the
        // read, and an out-of-range board is the commonest way this button fails.
        // `whyNoReading` puts the board's own words here when the board spoke
        // (`.status(17)`, "close it on the device first") and this phone's radio in
        // the frame when it was the radio — hazard 21, one fact, one sentence, both
        // surfaces.
        // ⚠️ And it is asked of the READING, not of one error out of it. This call
        // passes no budget, so no read here can ever be skipped: "this phone ran out
        // of its own time before it could ask" was, on this rail, only ever printed
        // when it was false.
        let reading = await flipper.refresh()
        if !reading.didLearn {
            let why = FlipperGateway.whyNoReading(reading, for: .panelSheet)
            // "The figures above" only exist when there are figures — the sheet
            // renders them under `if let info = flipper.info`.
            note = flipper.info == nil
                ? "Couldn't read the Flipper just now. \(why)"
                : "Couldn't read the Flipper just now. \(why) The figures above are the last ones that worked."
        } else {
            // A partial reading is not a failed one, so it must not be noted as
            // one — but this tap made the row SHORTER and reset its age, and the
            // reason belongs to the tap. The row above says what is missing for as
            // long as the reading stands; this says why it is missing, once.
            let gap = FlipperGateway.gapClause(reading, for: .panelSheet)
            if !gap.isEmpty { note = "Read the Flipper, but not all of it.\(gap)" }
        }
    }

    private func beep() async {
        busy = true
        defer { busy = false }
        note = nil
        do {
            try await flipper.alert()
            note = FlipperGateway.alertSent(for: .panelSheet)
        } catch {
            // Not a bare `localizedDescription`. A timeout whose request reached
            // the board may have sounded the alert already, and the person
            // reading this is holding the phone next to it — so the one sentence
            // worth adding is "listen before you tap again". Shared with the
            // relay reply through `actionFailed`, so the agent and the room
            // cannot be told different things about the same beep.
            note = FlipperGateway.actionFailed(error, action: "alert", for: .panelSheet)
        }
    }
}

/// Why the Flipper link is unhappy, wherever the user happens to be looking.
///
/// ⚠️ `FlipperGateway.lastError` has thirteen writers and used to have exactly ONE
/// reader: the row in `FlipperBlePanel` above. Every other Flipper surface is a
/// SHEET that covers that row — so a sentence written while one was open could not
/// be read by the person it was written for.
///
/// `resumeScreenStreamIfWanted` is the proof, not the edge case. Its guard is
/// `streamWanted, foreground`, which is precisely "a screen sheet is open on this
/// phone right now" — so the one diagnosis in the gateway written specifically to
/// stop the user being left with a bare "Not streaming." was the one sentence in
/// the app that could never be seen. Bluetooth switched off from Control Centre
/// with the mirror open, and a pairing scan that cannot start, are the same shape.
///
/// So the sentence lives in a view rather than in a row, and each surface mounts
/// it. All of these readers are the same person holding the same phone, so they get
/// the same words — unlike the relay, whose reader is somewhere else entirely and
/// which keeps its own thrown-error channel for that reason.
struct FlipperLinkProblem: View {
    @ObservedObject private var flipper = FlipperGateway.shared

    var body: some View {
        if let e = flipper.lastError {
            Text(e).font(.caption2).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The scan list. Foreground-only and short-lived by design.
struct FlipperPairingSheet: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(flipper.found) { f in
                        Button {
                            flipper.pair(f.id, name: f.name)
                            dismiss()
                        } label: {
                            HStack {
                                Image(systemName: "wave.3.right").foregroundStyle(.orange)
                                Text(f.name)
                                Spacer()
                                Text("\(f.rssi) dBm").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if flipper.found.isEmpty {
                        // ⚠️ A spinner and the word "Looking…" are a claim about the
                        // RADIO, so they are gated on the flag the radio itself sets.
                        // With Bluetooth off this row used to spin "Looking…" for as
                        // long as the user was willing to watch: `startScan()` builds
                        // the central, `beginScanIfPossible()` returns at its
                        // `.poweredOn` guard, and nothing here ever looked at anything.
                        // The reason was already written down — to the panel row behind
                        // this sheet, which is why the line below is here too.
                        HStack(spacing: 8) {
                            if flipper.scanning { ProgressView().controlSize(.mini) }
                            Text(flipper.scanning ? "Looking…" : "Not scanning.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    // Outside the isEmpty branch: a board found before Bluetooth went
                    // away leaves a stale row standing, and that is when the reason
                    // matters most.
                    FlipperLinkProblem()
                } header: {
                    Text("Flippers nearby")
                } footer: {
                    // The one thing the user must know before tapping, because
                    // the prompt comes from iOS and the code comes from the
                    // board — neither is something this app can show.
                    Text("Bluetooth has to be enabled on the Flipper itself (Settings → Bluetooth). When you pick it, iOS asks to pair and the Flipper shows a 6-digit code — confirm it on both.")
                }
            }
            .navigationTitle("Link a Flipper")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { flipper.stopScan(); dismiss() }
                }
            }
        }
        .onAppear { flipper.startScan() }
        .onDisappear { flipper.stopScan() }
    }
}

/// Browse the SD card over BLE. Storage.List is genuinely nicer than the CLI's
/// text listing here — sizes arrive as fields, so nothing has to be parsed.
struct FlipperFilesSheet: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @Environment(\.dismiss) private var dismiss
    @State private var path = "/ext"
    @State private var entries: [FlipperEntry] = []
    @State private var loading = false
    @State private var error: String?
    @State private var preview: (name: String, body: String)?

    var body: some View {
        NavigationStack {
            List {
                if path != "/ext" {
                    Button {
                        path = Self.parent(of: path)
                        Task { await load() }
                    } label: {
                        Label("Up", systemImage: "arrow.up.left")
                    }
                }
                ForEach(entries) { e in
                    Button { Task { await open(e) } } label: {
                        HStack {
                            Image(systemName: e.isDir ? "folder" : "doc")
                                .foregroundStyle(e.isDir ? .blue : .secondary)
                            Text(e.name)
                            Spacer()
                            if !e.isDir {
                                Text(Self.bytes(e.size))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text("Reading the card…").foregroundStyle(.secondary)
                    }
                }
                if let e = error {
                    Text(e).font(.caption).foregroundStyle(.orange)
                }
                // Both, not either: the thrown error says the listing failed, this
                // says the link is down and which switch turned it off.
                FlipperLinkProblem()
                if let p = preview {
                    Section(p.name) {
                        Text(p.body).font(.caption2.monospaced())
                    }
                }
            }
            .navigationTitle(path)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        error = nil
        preview = nil
        do {
            entries = try await flipper.list(path)
        } catch let err {
            // Bound explicitly: a bare `catch` shadows `error` with the thrown
            // value, so `error = error.localizedDescription` assigns to the
            // immutable binding and never reaches the @State the view reads.
            entries = []
            // A listing changes nothing on the card, and this reader can walk the
            // board closer — the one remedy the relay's copy of this sentence
            // cannot offer. Both come out of `actionFailed`.
            error = FlipperGateway.actionFailed(err, action: "list", for: .panelSheet)
        }
    }

    private func open(_ e: FlipperEntry) async {
        if e.isDir {
            path = path.hasSuffix("/") ? path + e.name : path + "/" + e.name
            await load()
            return
        }
        loading = true
        defer { loading = false }
        error = nil
        let full = path.hasSuffix("/") ? path + e.name : path + "/" + e.name
        // The row that was just tapped already showed this size, so the refusal
        // owes nobody a round trip: `read()` would spend a stat over Bluetooth to
        // learn a number that is on screen, then refuse. read() keeps its own
        // check — the relay has no listing to learn the size from, and a listing
        // is not an authority anyway (the card can change under it).
        if e.size > UInt64(FlipperGateway.maxReadBytes) {
            error = FlipperGateway.tooBig(full, size: e.size,
                                         limit: FlipperGateway.maxReadBytes, for: .panelSheet)
            return
        }
        do {
            let data = try await flipper.read(full, for: .panelSheet)
            let text = String(data: data, encoding: .utf8)
            // A .nfc or .sub dump that isn't UTF-8 shows as hex rather than as
            // replacement characters pretending to be content — through the same
            // helper the relay reply uses, because this sheet used to cut its own
            // bare `prefix(512)` and say nothing about it. A 2 KB .fap then read
            // one way here and another way through the agent, and this one looked
            // like the whole file. The window and the admission that it IS a
            // window are the helper's, not this view's.
            if let t = text, !t.contains("\u{FFFD}") {
                preview = (e.name, t)
            } else {
                let p = FlipperGateway.hexPreview(data)
                preview = (e.name, p.hex + p.cut)
            }
        } catch let err {
            // The credential guard's refusal lands here, in the user's own words
            // — it is a sentence, not a failure code. `actionFailed` passes every
            // non-timeout through unchanged for exactly that reason: appending
            // "it may have happened anyway" to a refusal would invent a read that
            // was declined.
            error = FlipperGateway.actionFailed(err, action: "read", for: .panelSheet)
        }
    }

    static func parent(of p: String) -> String {
        let parts = p.split(separator: "/").dropLast()
        return parts.isEmpty ? "/ext" : "/" + parts.joined(separator: "/")
    }

    static func bytes(_ n: UInt64) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1_048_576)
    }
}

/// The Flipper's own 128×64 screen, mirrored, with its six buttons underneath.
///
/// This is the half of the story the cable cannot tell. The USB CLI has no
/// screenshot command and no way to inject input; BLE has both. So the honest
/// shape of this feature is not "BLE is a worse cable" — each transport can do
/// something the other cannot, and this is BLE's side of it. It is also the
/// answer to `flipper_listen`'s cable-only refusal: a person can drive a capture
/// on the board from here and then read the saved file over the same link.
///
/// ⚠️ It stays a PANEL feature, on purpose, and the relay handler must never grow
/// a `press` action. Navigating to a saved .sub and tapping OK TRANSMITS it —
/// so a remote button press is a transmit by another name: physical action on
/// someone's gate, car or lock, from a sentence the user never said. The buttons
/// here are under the user's own thumb, on their own phone, looking at the screen.
struct FlipperScreenSheet: View {
    @ObservedObject private var flipper = FlipperGateway.shared
    @Environment(\.dismiss) private var dismiss
    @State private var img: CGImage?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                screen
                // Directly under the mirror, because that is what it explains — and
                // above the d-pad, because a link that cannot carry frames cannot
                // carry a keypress either. `error` below is the other channel: what
                // THIS sheet's last request did, rather than what the link is doing.
                FlipperLinkProblem()
                dpad
                Text("A press here is a press on the board — including the ones that transmit.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let e = error {
                    Text(e).font(.caption2).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle(flipper.unit?.name ?? "Flipper")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .task { await start() }
        // Stopping is not optional: the board pushes a kilobyte per redraw until
        // told otherwise, on its own battery, and nobody is watching after this.
        .onDisappear { Task { await flipper.stopScreenStream() } }
        .onChange(of: flipper.screenFrame) { _, f in
            img = f.flatMap(Self.image)
        }
    }

    @ViewBuilder private var screen: some View {
        ZStack {
            if let cg = img {
                // .none, or the 128×64 grid gets blurred into something that looks
                // like a photo of the screen instead of the screen.
                Image(decorative: cg, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(2, contentMode: .fit)
                    .rotationEffect(rotation)
            } else {
                Color.black.opacity(0.85)
                    .aspectRatio(2, contentMode: .fit)
                    .overlay {
                        // Not an error, and worth spelling out: the firmware sends
                        // a frame when the screen REDRAWS, so a Flipper resting on
                        // a static menu sends nothing at all until something moves.
                        Text(flipper.streaming
                             ? "Waiting for the Flipper to redraw — press a button and it appears."
                             : "Not streaming.")
                            .font(.caption2).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding()
                    }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
    }

    @ViewBuilder private var dpad: some View {
        // The board's own arrangement: a round d-pad with OK in the middle and
        // Back below-right, so muscle memory transfers.
        VStack(spacing: 8) {
            FlipperKeyButton(key: .up, press: press)
            HStack(spacing: 8) {
                FlipperKeyButton(key: .left, press: press)
                FlipperKeyButton(key: .ok, press: press)
                FlipperKeyButton(key: .right, press: press)
            }
            HStack(spacing: 8) {
                FlipperKeyButton(key: .down, press: press)
                FlipperKeyButton(key: .back, press: press)
            }
        }
    }

    /// PB_Gui.ScreenOrientation. The buffer is always 128×64 page-major; this is
    /// only how the board wants it shown.
    private var rotation: Angle {
        switch flipper.screenFrame?.orientation ?? 0 {
        case 1: return .degrees(180)
        case 2: return .degrees(90)
        case 3: return .degrees(270)
        default: return .zero
        }
    }

    private func start() async {
        error = nil
        do {
            try await flipper.startScreenStream()
        } catch let err {
            error = FlipperGateway.actionFailed(err, action: "screen", for: .panelSheet)
        }
    }

    private func press(_ key: FlipperKey, hold: Bool) {
        Task {
            do {
                try await flipper.send(key, hold: hold)
            } catch let err {
                // Bound explicitly — a bare `catch` shadows the @State `error`
                // with the thrown value, and the assignment then goes nowhere.
                //
                // ⚠️ And a press is the site where "didn't answer" reads most
                // wrongly as "didn't happen". `send(_:hold:)`'s own doc already
                // says it — *"a FAILED press is not a press that didn't land:
                // `.timeout` means the reply never came back, and the frame may
                // well have been delivered and acted on"* — which is why it sends
                // the RELEASE regardless. That fact was written down for the next
                // programmer and never for the person watching the mirror, who
                // sees "the Flipper didn't answer OK in time", presses again, and
                // sends a second OK to a board that already took the first.
                error = FlipperGateway.actionFailed(err, action: "press", for: .panelSheet)
            }
        }
    }

    /// 1024 bytes of u8g2 page buffer → a 128×64 image in the Flipper's own
    /// colours, dark pixels on that orange backlight.
    ///
    /// The layout is the trap: eight PAGES of 128 columns, one byte per column
    /// per page, and the byte's bits run DOWN the screen — bit `y % 8`, LSB at
    /// the top. Read it as 128 bytes per row instead and the result is a
    /// recognisable-looking smear, not an obvious failure.
    static func image(_ f: FlipperFrame) -> CGImage? {
        let w = 128, h = 64
        let bytes = [UInt8](f.data)
        // A short frame draws nothing rather than half a screen of garbage.
        guard bytes.count >= w * h / 8 else { return nil }
        var rgba = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h {
            let page = y / 8
            let mask = UInt8(1 << (y % 8))
            for x in 0..<w {
                let lit = bytes[page * w + x] & mask != 0
                let i = (y * w + x) * 4
                rgba[i] = lit ? 0x20 : 0xFF
                rgba[i + 1] = lit ? 0x14 : 0x82
                rgba[i + 2] = 0x00
            }
        }
        guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: false,
                       intent: .defaultIntent)
    }
}

/// One key. Tap and long press are DIFFERENT firmware events, not a slower
/// version of each other — a Flipper submenu opens on OK short and offers delete
/// on OK long — so this reports both.
private struct FlipperKeyButton: View {
    let key: FlipperKey
    let press: (FlipperKey, Bool) -> Void
    @State private var held = false

    var body: some View {
        Image(systemName: key.symbol)
            .font(.title3.weight(.semibold))
            .frame(width: 54, height: 44)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            // One gesture, both events: the tap is derived from the RELEASE, so
            // a press that already fired as a long press is not also sent as a
            // short one. Two gestures stacked here would send both.
            .onLongPressGesture(minimumDuration: 0.45, pressing: { down in
                if down {
                    held = false
                } else if !held {
                    press(key, false)
                }
            }, perform: {
                held = true
                press(key, true)
            })
            .accessibilityLabel(key.label)
    }
}
