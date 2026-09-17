/**
 * 🦾 FomoScreen — the full-screen Fomo control surface (on par with the web dash).
 *
 * Top: the picture IS the joystick (drag → head looks there, centre = home, the
 * edges = the guard's legal look range from /api/state windows), with STOP, HOME,
 * Fold, Torque and Photo always visible beneath it.
 * Then a segmented body: Motions (gallery from /api/motions, tap to play, progress
 * from state.busy "motion:x i/n"), Poses (/api/poses), Telemetry (every joint in
 * degrees + rel-to-home, rail V, torque, folded, Nicla ok/age, roll/pitch, ToF),
 * RL (stage badge + the gate's reason verbatim, shadow / live / stop), and
 * Ask Fomo (the /ws/agent conversation with tool receipts).
 *
 * Every refusal is the server's own sentence (FomoToast). Identifiers:
 * fomo-screen, fomo-pad, fomo-stop, fomo-home, fomo-fold, fomo-torque, fomo-photo,
 * fomo-tab-<name>, fomo-motion-<name>, fomo-pose-<name>, fomo-ask-field, fomo-ask-send.
 */
import SwiftUI

struct FomoScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tinyAccent) private var accent
    @EnvironmentObject private var session: TinySession
    @ObservedObject private var fomo = FomoManager.shared
    @State private var tab: Tab = .motions
    @State private var dragging = false
    @State private var confirmHome = false
    @State private var showPhoto = false
    @State private var ask = ""

    enum Tab: String, CaseIterable, Identifiable {
        case servos, motions, poses, telemetry, rl, ask
        var id: String { rawValue }
        var title: String {
            switch self {
            case .servos: return "Servos"
            case .motions: return "Motions"
            case .poses: return "Poses"
            case .telemetry: return "Telemetry"
            case .rl: return "RL"
            case .ask: return "Ask"
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    Picker("View", selection: $fomo.pipView) {
                        Text("Camera").tag(FomoPiPView.camera).accessibilityIdentifier("fomo-view-camera")
                        Text("Twin").tag(FomoPiPView.twin).accessibilityIdentifier("fomo-view-twin")
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("fomo-view")
                    if fomo.pipView == .twin {
                        FomoTwinTab(fomo: fomo)
                    } else {
                        pad
                        lookHUD
                    }
                    controls
                    Picker("Section", selection: $tab) {
                        ForEach(Tab.allCases) { t in Text(t.title).tag(t).accessibilityIdentifier("fomo-tab-\(t.rawValue)") }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("fomo-tabs")
                    switch tab {
                    case .servos: FomoServosTab(fomo: fomo)
                    case .motions: motionsGrid
                    case .poses: posesList
                    case .telemetry: telemetry
                    case .rl: rlCard
                    case .ask: askFomo
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemBackground))
            .overlay(alignment: .top) { FomoToast(fomo: fomo).padding(.top, 4) }
            .animation(.easeInOut(duration: 0.2), value: fomo.toast)
            .navigationTitle(fomo.device?.name ?? "arm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let s = fomo.state {
                        Text(s.ok ? (s.folded == true ? "folded" : (s.busy ?? "ready")) : "arm off")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("fomo-state-word")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Move every joint to home?", isPresented: $confirmHome, titleVisibility: .visible) {
                Button("HOME the arm") { fomo.home() }
            } message: {
                Text("The whole arm moves, not just the head. Keep the desk clear.")
            }
            .sheet(isPresented: $showPhoto) { photoSheet }
            .onChange(of: fomo.lastPhoto) { _, img in if img != nil { showPhoto = true } }
            .task(id: "\(fomo.device?.id ?? "")|\(session.token ?? "")") {
                fomo.configure(device: fomo.device, sessionToken: session.token)
                if !UITestFlags.noDevicePolls { fomo.startPolling() }
                await fomo.refreshLists()
            }
        }
        .accessibilityIdentifier("fomo-screen")
        .onAppear { ArmManager.shared.retainViewer() }
        .onDisappear { ArmManager.shared.releaseViewer() }
    }

    // ── Pad ─────────────────────────────────────────────────────────────────

    private var pad: some View {
        GeometryReader { geo in
            let size = geo.size
            let range = fomo.lookRange
            ZStack {
                FomoPicture(fomo: fomo)
                Path { p in
                    p.move(to: CGPoint(x: size.width / 2, y: 0)); p.addLine(to: CGPoint(x: size.width / 2, y: size.height))
                    p.move(to: CGPoint(x: 0, y: size.height / 2)); p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                }
                .stroke(.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 6]))
                if let cur = fomo.currentLook {
                    Circle().stroke(.white, lineWidth: 2).frame(width: 18, height: 18)
                        .position(ArmCore.padPoint(for: cur, in: size, range: range))
                }
                if let t = fomo.target {
                    Circle().fill(accent).frame(width: 12, height: 12)
                        .position(ArmCore.padPoint(for: t, in: size, range: range))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in
                        dragging = true
                        fomo.requestLook(ArmCore.lookTarget(point: v.location, in: size, range: range))
                    }
                    .onEnded { _ in dragging = false }
            )
        }
        .aspectRatio(4.0 / 3.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(dragging ? accent : Color.secondary.opacity(0.3), lineWidth: dragging ? 2 : 1))
        .accessibilityLabel("Look pad: drag to point the head")
        .accessibilityIdentifier("fomo-pad")
    }

    private var lookHUD: some View {
        HStack(spacing: 14) {
            cell("pan", fomo.currentLook?.pan, fomo.target?.pan)
            cell("tilt", fomo.currentLook?.tilt, fomo.target?.tilt)
            Spacer()
            if let s = fomo.state {
                VStack(alignment: .trailing, spacing: 1) {
                    HStack(spacing: 6) {
                        if let v = s.voltage { Text(String(format: "%.1f V", v)).font(.caption.monospaced()) }
                        Text(s.anyTorque ? "torque on" : "torque off").font(.caption2).foregroundStyle(s.anyTorque ? .orange : .secondary)
                    }
                    if let mm = s.nicla?.tofMm { Text("\(Int(mm)) mm ahead").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-look-hud")
    }

    private func cell(_ label: String, _ cur: Double?, _ target: Double?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text(cur.map(Self.deg) ?? "—").font(.caption.monospaced())
                if let target, target != cur {
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                    Text(Self.deg(target)).font(.caption.monospaced()).foregroundStyle(accent)
                }
            }
        }
    }

    static func deg(_ d: Double) -> String { String(format: "%+.1f°", d) }

    // ── Controls ────────────────────────────────────────────────────────────

    private var controls: some View {
        HStack(spacing: 10) {
            FomoStopButton(fomo: fomo, large: true).accessibilityIdentifier("fomo-stop")
            pill("HOME", "house.fill") { confirmHome = true }.accessibilityIdentifier("fomo-home")
            pill("Fold", "arrow.down.right.and.arrow.up.left") { fomo.fold() }.accessibilityIdentifier("fomo-fold")
            let on = fomo.state?.anyTorque ?? false
            pill(on ? "Torque off" : "Torque on", on ? "bolt.slash.fill" : "bolt.fill") { fomo.torque(!on) }
                .accessibilityIdentifier("fomo-torque")
            Spacer(minLength: 0)
            Button { Task { await fomo.photo() } } label: {
                if fomo.photoBusy { ProgressView().controlSize(.small) }
                else { Image(systemName: "camera.fill").font(.title3) }
            }
            .disabled(fomo.photoBusy)
            .accessibilityLabel("Take a photo with the head camera")
            .accessibilityIdentifier("fomo-photo")
        }
    }

    private func pill(_ title: String, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(.caption.weight(.bold)).lineLimit(1)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Color.secondary.opacity(0.15), in: Capsule())
        }
    }

    // ── Motions ─────────────────────────────────────────────────────────────

    private var motionsGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            if fomo.motions.isEmpty {
                Text(fomo.listsAt == nil ? "loading motions…" : "Fomo has no motions").font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("fomo-motions-empty")
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                ForEach(fomo.motions) { m in
                    FomoMotionCard(motion: m, progress: fomo.state?.motion, accent: accent) { fomo.motion(m.name) }
                }
            }
            .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-motions")
        }
    }

    // ── Poses ───────────────────────────────────────────────────────────────

    private var posesList: some View {
        VStack(spacing: 6) {
            if fomo.poses.isEmpty {
                Text(fomo.listsAt == nil ? "loading poses…" : "no poses").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(fomo.poses) { p in
                FomoPoseRow(pose: p) { fomo.pose(p.name) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-poses")
    }

    // ── Telemetry ───────────────────────────────────────────────────────────

    private var telemetry: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let s = fomo.state {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    GridRow {
                        Text("joint").font(.caption2).foregroundStyle(.secondary)
                        Text("deg").font(.caption2).foregroundStyle(.secondary)
                        Text("rel home").font(.caption2).foregroundStyle(.secondary)
                        Text("torque").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(s.joints) { j in
                        GridRow {
                            Text(j.name).font(.caption)
                                .accessibilityIdentifier("fomo-joint-\(j.name)")
                                .accessibilityLabel("\(j.name) \(String(format: "%.1f", j.deg)) degrees, \(Self.deg(j.rel)) from home, torque \(j.torque ? "on" : "off")")
                            Text(String(format: "%.1f°", j.deg)).font(.caption.monospaced())
                            Text(Self.deg(j.rel)).font(.caption.monospaced()).foregroundStyle(.secondary)
                            Text(j.torque ? "on" : "off").font(.caption2).foregroundStyle(j.torque ? .orange : .secondary)
                        }
                    }
                }
                Divider()
                kv("rail", s.voltage.map { String(format: "%.2f V", $0) } ?? "—")
                kv("folded", s.folded.map { $0 ? "yes" : "no" } ?? "—")
                kv("busy", s.busy ?? "no")
                kv("gate", s.gate ? "open" : "closed")
                kv("bus", "\(s.source)\(s.ageS.map { String(format: " · %.1f s ago", $0) } ?? "")")
                Divider()
                if let n = s.nicla {
                    kv("Nicla", n.ok ? "ok\(n.ageS.map { String(format: " · %.1f s", $0) } ?? "")" : "offline")
                    kv("head", n.mounted ? "mounted" : "on the bench (attitude ≠ head)")
                    kv("roll / pitch", "\(n.roll.map { String(format: "%.1f°", $0) } ?? "—") / \(n.pitch.map { String(format: "%.1f°", $0) } ?? "—")")
                    kv("ToF", n.tofMm.map { "\(Int($0)) mm" } ?? "—")
                    kv("wi-fi", n.rssi.map { "\($0) dBm" } ?? "—")
                    kv("stream", n.fps.map { String(format: "%.1f fps", $0) } ?? "—")
                    if let fw = n.fw { kv("firmware", fw) }
                } else {
                    kv("Nicla", "no head data")
                }
            } else {
                Text("reaching \(fomo.device?.name ?? "the arm")…").font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-telemetry")
    }

    private func kv(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(v).font(.caption.monospaced())
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("fomo-kv-\(k)")
    }

    // ── RL ──────────────────────────────────────────────────────────────────

    private var rlCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let r = fomo.state?.rl {
                HStack(spacing: 8) {
                    Text("stage \(r.stage) · \(r.stageName)")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background((r.allowed ? Color.green : Color.orange).opacity(0.2), in: Capsule())
                        .accessibilityIdentifier("fomo-rl-stage")
                    if r.running { Text("running \(r.policy ?? "") · \(r.ticks) ticks").font(.caption2).foregroundStyle(accent) }
                    else { Text("idle").font(.caption2).foregroundStyle(.secondary) }
                }
                if let why = r.reason, !r.allowed {
                    Text(why).font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("fomo-rl-reason")
                }
                if let e = r.error { Text(e).font(.caption2).foregroundStyle(.red) }
                HStack(spacing: 8) {
                    ForEach(r.policies, id: \.self) { p in
                        Button("Shadow \(p)") { fomo.rlShadow(p) }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                            .disabled(r.running)
                            .accessibilityIdentifier("fomo-rl-shadow-\(p)")
                    }
                    Button("Live") { fomo.rlLive() }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderedProminent)
                        .disabled(!r.allowed || r.running)
                        .accessibilityIdentifier("fomo-rl-live")
                    Button("Stop") { fomo.rlStop() }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered).tint(.red)
                        .disabled(!r.running)
                        .accessibilityIdentifier("fomo-rl-stop")
                }
                if let cap = r.capDeg { Text("live moves are capped at ±\(Int(cap))° per tick").font(.caption2).foregroundStyle(.tertiary) }
                Text("Shadow reads the bus and the eyes and writes nothing; Live moves the head through the guard and only after the bench gate opens.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                Text("no RL seat reported").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-rl")
    }

    // ── Ask Fomo ────────────────────────────────────────────────────────────

    private var askFomo: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let agent = fomo.ensureAgent() {
                FomoAgentLog(agent: agent)
            } else {
                Text("no arm known yet").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                TextField("Ask Fomo — \"nod\", \"look at me\", \"take a photo\"", text: $ask)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit(sendAsk)
                    .accessibilityIdentifier("fomo-ask-field")
                Button(action: sendAsk) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(ask.trimmingCharacters(in: .whitespaces).isEmpty || (fomo.agent?.log.busy ?? false))
                    .accessibilityLabel("Send to Fomo")
                    .accessibilityIdentifier("fomo-ask-send")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-ask")
    }

    private func sendAsk() {
        let t = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let agent = fomo.ensureAgent() else { return }
        agent.send(t)
        ask = ""
    }

    private var photoSheet: some View {
        VStack(spacing: 12) {
            if let img = fomo.lastPhoto {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("fomo-photo-image")
            }
            Text(fomo.lastPhotoPath.map { "Saved on the arm: \($0)" } ?? "Saved on the arm").font(.caption2).foregroundStyle(.secondary)
                .lineLimit(2).multilineTextAlignment(.center)
            Button("Done") { showPhoto = false }
        }
        .padding()
        .presentationDetents([.medium, .large])
    }
}

/// The conversation: your prompts, Fomo's words, tool receipts inside the turn.
struct FomoAgentLog: View {
    @ObservedObject var agent: FomoAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(linkColor).frame(width: 6, height: 6)
                Text(linkWord).font(.caption2).foregroundStyle(.secondary)
                if !agent.log.tools.isEmpty { Text("· \(agent.log.tools.count) tools").font(.caption2).foregroundStyle(.tertiary) }
                Spacer()
                if !agent.log.turns.isEmpty { Button("Clear") { agent.clear() }.font(.caption2) }
            }
            .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-agent-link")
            if agent.log.turns.isEmpty {
                Text("Fomo runs the same agent the web dash talks to: it can move, look, play motions and take photos, and it answers here.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(agent.log.turns) { t in
                VStack(alignment: .leading, spacing: 4) {
                    switch t.role {
                    case .you:
                        Text(t.text).font(.subheadline).padding(8)
                            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    case .note:
                        Text(t.text).font(.caption2).foregroundStyle(.tertiary)
                    case .fomo:
                        if !t.text.isEmpty { Text(t.text).font(.subheadline) }
                        ForEach(t.receipts) { r in
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: r.status == nil ? "hourglass" : (r.status == "success" ? "checkmark.circle" : "xmark.circle"))
                                    .font(.caption2).foregroundStyle(r.status == "error" ? .red : .secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(r.name + (r.input.map { " \($0)" } ?? "")).font(.caption2.monospaced()).lineLimit(2)
                                    if let x = r.text, !x.isEmpty { Text(x).font(.caption2).foregroundStyle(.secondary).lineLimit(3) }
                                }
                            }
                        }
                        if !t.done && t.error == nil { ProgressView().controlSize(.mini) }
                        if let e = t.error { Text(e).font(.caption2).foregroundStyle(.red) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fomo-turn-\(t.id)")
            }
        }
    }

    private var linkColor: Color {
        switch agent.link {
        case .open: return .green
        case .connecting: return .orange
        case .unauthorized: return .red
        case .closed, .idle: return .secondary
        }
    }

    private var linkWord: String {
        switch agent.link {
        case .open: return "agent link open"
        case .connecting: return "connecting to Fomo's agent…"
        case .unauthorized: return "Fomo refused this login (4401)"
        case .closed: return "agent link closed — answers fall back to /api/chat"
        case .idle: return "agent idle"
        }
    }
}

/// One motion in the gallery: name, description (or why it is unplayable), frames, progress while it plays.
struct FomoMotionCard: View {
    let motion: FomoCore.Motion
    let progress: FomoCore.MotionProgress?
    let accent: Color
    let play: () -> Void

    private var playing: Bool { progress?.name == motion.name }

    var body: some View {
        Button(action: play) {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(motion.name.replacingOccurrences(of: "_", with: " ")).font(.subheadline.weight(.semibold))
                    Spacer()
                    trailing
                }
                Text(motion.ok ? motion.description : (motion.why ?? "unplayable"))
                    .font(.caption2).foregroundStyle(motion.ok ? Color.secondary : Color.red)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text("\(motion.frames) frames").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(playing ? accent.opacity(0.15) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!motion.ok)
        .accessibilityIdentifier("fomo-motion-\(motion.name)")
        .accessibilityLabel("Play \(motion.name): \(motion.description)")
    }

    @ViewBuilder private var trailing: some View {
        if playing, let p = progress, let i = p.i, let n = p.n {
            Text("\(i)/\(n)").font(.caption2.monospaced()).foregroundStyle(accent)
        } else if playing {
            ProgressView().controlSize(.mini)
        } else {
            Image(systemName: "play.fill").font(.caption2).foregroundStyle(.secondary)
        }
    }
}

/// One pose row: name, description or why it is unreachable, built-in tag.
struct FomoPoseRow: View {
    let pose: FomoCore.Pose
    let go: () -> Void

    var body: some View {
        Button(action: go) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pose.name.replacingOccurrences(of: "_", with: " ")).font(.subheadline.weight(.semibold))
                    if !pose.description.isEmpty || !pose.ok {
                        Text(pose.ok ? pose.description : (pose.why ?? "unreachable"))
                            .font(.caption2).foregroundStyle(pose.ok ? Color.secondary : Color.red)
                    }
                }
                Spacer()
                if pose.builtin { Text("built-in").font(.caption2).foregroundStyle(.tertiary) }
                Image(systemName: "arrow.right.circle").foregroundStyle(.secondary)
            }
            .padding(10)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!pose.ok)
        .accessibilityIdentifier("fomo-pose-\(pose.name)")
    }
}
