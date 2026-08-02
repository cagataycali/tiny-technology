/**
 * 🗺️ TinyMapView — full-screen live map (maps-location loop c9; web /map +
 * Android MapSheet parity, agi-diy grammar).
 *
 * MapKit, not the Google SDK: the app's zero-third-party-dependency posture
 * holds, and a flat dark standard map with POI/traffic stripped reads as
 * the same "clean, transparent, minimal" ambiance as agi-diy's styled
 * Google map. Same interactions as the siblings: locate-me runs the
 * permission ask on TAP, the first fix flies the camera and later ones
 * only move the accent dot, taps drop pins, the HUD shows the literal
 * `### Location` block the tiny reads, and opted-in users poll in from
 * /api/location (empty until the presence deploy gate clears).
 */
import SwiftUI
import MapKit

/// 🗺️ Ambient map behind the chat (phase 2 — web GlobalMapBackdrop /
/// Android MapBackdrop parity). Hosted as ChatView's VStack background: a
/// single-initializer subview, because ChatView's outer chain sits at the
/// type-checker's budget (the c9 lesson). Renders Color.clear (and starts
/// no GPS) until the Settings "Share location with your tiny" toggle is
/// on — @AppStorage makes the flip live, no restart.
struct AmbientMapHost: View {
    var body: some View {
        AmbientMapSwitch()
    }
}

#if DEBUG
/// Design harness (`--map-ambient-harness` launch arg): the ambient map +
/// sample chat chrome with NO auth wall, so the map-as-chat-background look
/// can be iterated in the simulator with screenshots. DEBUG builds only.
struct AmbientMapHarness: View {
    var body: some View {
        // --map-full-harness variant: the INTERACTIVE map (pins vivid over
        // the muted basemap); default renders the ambient chat background.
        if ProcessInfo.processInfo.arguments.contains("--map-full-harness") {
            TinyMapView(token: nil)
                .onAppear {
                    Geo.shared.requestPermission()
                    AgentMap.shared.handle(
                        name: "add_map_marker",
                        argsJson: #"{"lat":37.779,"lng":-122.417,"label":"coffee","id":"h1"}"#)
                }
        } else {
            ambientBody
        }
    }

    private var ambientBody: some View {
        ZStack {
            AmbientMap()
                .task {
                    // --map-fly-test: a distant pin lands at t+2s, fly_to_marker
                    // fires at t+8s — screenshots at t≈6s vs t≈14s must differ
                    // (the camera must LEAVE the user's position for Oakland).
                    guard ProcessInfo.processInfo.arguments.contains("--map-fly-test") else { return }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    AgentMap.shared.handle(
                        name: "add_map_marker",
                        argsJson: #"{"lat":37.8044,"lng":-122.2712,"label":"oakland","id":"fly-1"}"#)
                    try? await Task.sleep(nanoseconds: 6_000_000_000)
                    AgentMap.shared.handle(name: "fly_to_marker", argsJson: #"{"id":"fly-1","zoom":13}"#)
                }
            VStack(spacing: 12) {
                Spacer()
                Text("hey, what's a good coffee spot near me?")
                    .padding(12)
                    .background(Color.green.opacity(0.18), in: RoundedRectangle(cornerRadius: 16))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                Text("You're in Hayes Valley — Ritual on Octavia is a 4-minute walk. Dropping a pin 📍")
                    .padding(12)
                    .background(Color(white: 0.12).opacity(0.9), in: RoundedRectangle(cornerRadius: 16))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer().frame(height: 90)
            }
            .padding(.horizontal, 16)
        }
        .onAppear { Geo.shared.requestPermission() }
    }
}
#endif

private struct AmbientMapSwitch: View {
    @AppStorage("cfg_location_context") private var locationContext = false
    var body: some View {
        if locationContext {
            AmbientMap()
        } else {
            Color.clear
        }
    }
}

/// Gesture-less MapKit layer + the map-mode wash. The camera follows the
/// same fused snapshots the agent context reads — what the user sees drift
/// by and what the tiny is told are one thing.
private struct AmbientMap: View {
    @Environment(\.tinyAccent) private var accent
    @ObservedObject private var agentMap = AgentMap.shared
    @State private var camera: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194),
            span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
        )
    )
    @State private var fix: Geo.Fix?
    /// Opted-in tiny users (be-seen heartbeats) — quiet dots UNDER the chat:
    /// people see people using tinys, right on the background.
    @State private var presence: [(id: String, lat: Double, lng: Double)] = []

    var body: some View {
        ZStack {
            Map(position: $camera, interactionModes: []) {
                // Agent pins (add_map_marker) — drawn even under the chat wash
                // so a "look at this spot" gesture lands without opening the map.
                // They take the mute treatment too: ambient context, not UI.
                ForEach(Array(agentMap.pins.values), id: \.id) { pin in
                    Marker(pin.label ?? "your tiny's pin", coordinate: CLLocationCoordinate2D(latitude: pin.lat, longitude: pin.lng))
                        .tint(agentPinColor(pin, fallback: accent))
                }
                // Presence: small dots, not Markers — ambiance, and the grade
                // mutes them further; the interactive map is where you LOOK.
                ForEach(presence, id: \.id) { p in
                    Annotation("", coordinate: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng)) {
                        Circle()
                            .fill(accent.opacity(0.8))
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(.white.opacity(0.6), lineWidth: 1))
                    }
                }
            }
            // The agi-diy all-black neon grade, MapKit edition: MapKit takes no
            // style JSON, so the palette is built in layers — muted base map,
            // saturation strip (kills the blue cast + park/building patches),
            // contrast to keep road lines alive, multiply toward black.
            .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
            .saturation(0.15)
            .contrast(1.2)
            .colorMultiply(ambientGradeTint(accent))
            // Wash lighter than before (0.45): the grade above already owns
            // most of the darkness, this just seats the chat on top. While
            // the agent is PRESENTING (spotlight), it thins further — the
            // map comes forward for the gesture, then recedes.
            Color.black.opacity(agentMap.spotlight ? 0.12 : 0.32)
                .animation(.easeInOut(duration: 0.8), value: agentMap.spotlight)
            // You: the accent pulse rides ABOVE the grade + wash at the camera
            // center (the follow loop keeps centering on the fix), so the one
            // living thing on the map stays vivid while the map recedes.
            if fix != nil {
                AccentPulseDot(accent: accent)
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
        .onAppear { AgentMap.shared.mapDidAppear() }
        .onDisappear { AgentMap.shared.mapDidDisappear() }
        .onChange(of: agentMap.camera) { _, cam in
            guard let cam else { return }
            withAnimation(.easeInOut(duration: 1.2)) { camera = .region(agentRegion(cam)) }
        }
        .task {
            var first = true
            while !Task.isCancelled {
                if let f = await Geo.shared.current() {
                    fix = f
                    let region = MKCoordinateRegion(
                        center: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lng),
                        span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
                    )
                    if first {
                        camera = .region(region)
                        first = false
                    } else if !AgentMap.shared.followSuspended {
                        // an agent fly/tour owns the camera for 30s — panning
                        // home mid-gesture made the tools look broken
                        withAnimation(.easeInOut(duration: 1.5)) { camera = .region(region) }
                    }
                }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        // Presence poll — public read, each minute while the backdrop is up
        // (TinyMapView's loop, unauth'd: the server omits `me`, and an own
        // dot overlapping the accent pulse is harmless).
        .task {
            while !Task.isCancelled {
                if let res: [String: Any] = try? await Api.get("/api/location", token: nil),
                   let pins = res["pins"] as? [[String: Any]] {
                    let me = res["me"] as? String
                    presence = pins.compactMap { p in
                        guard let id = p["userId"] as? String, id != me,
                              let lat = p["lat"] as? Double, let lng = p["lng"] as? Double
                        else { return nil }
                        return (id: id, lat: lat, lng: lng)
                    }
                }
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }
}

/// The agi-diy `.pulse-ring`, reborn: an accent ring breathes out of the
/// "you" dot every 2s (scale 1→3.2, fade to nothing — the old design's
/// signature living detail). Shared by the ambient backdrop and the
/// full-screen map so the pulse can't drift between surfaces.
struct AccentPulseDot: View {
    let accent: Color
    @State private var pulsing = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(accent.opacity(pulsing ? 0 : 0.55), lineWidth: 2)
                .frame(width: 18, height: 18)
                .scaleEffect(pulsing ? 3.2 : 1)
            Circle().fill(accent.opacity(0.22)).frame(width: 44, height: 44)
            Circle()
                .fill(accent)
                .frame(width: 14, height: 14)
                .overlay(Circle().stroke(.white, lineWidth: 2))
        }
        .onAppear {
            withAnimation(.easeOut(duration: 2).repeatForever(autoreverses: false)) { pulsing = true }
        }
    }
}

/// Agent-pin tint: the tool's CSS hex when it parses, the tiny's accent
/// otherwise (AgentMap.rgb is pure — junk falls back, never crashes).
private func agentPinColor(_ pin: AgentMap.Pin, fallback: Color) -> Color {
    guard let rgb = AgentMap.rgb(fromHex: pin.color) else { return fallback }
    return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
}

/// The ambient grade's multiply color: dark gray leaned toward the tiny's
/// accent, so every tiny's map glows ITS color (the agi-diy grade, plus a
/// per-tiny identity the JSON style never had). `Color.mix` is iOS 18 —
/// blended by hand via UIColor components.
private func ambientGradeTint(_ accent: Color, base: Double = 0.60, lean: Double = 0.25) -> Color {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    guard UIColor(accent).getRed(&r, green: &g, blue: &b, alpha: &a) else { return Color(white: base) }
    return Color(
        red: base * (1 - lean) + Double(r) * lean,
        green: base * (1 - lean) + Double(g) * lean,
        blue: base * (1 - lean) + Double(b) * lean
    )
}

/// Agent camera gesture → MapKit region (zoom→span via AgentMap.spanDegrees).
private func agentRegion(_ cam: AgentMap.Camera) -> MKCoordinateRegion {
    let span = AgentMap.spanDegrees(forZoom: cam.zoom)
    return MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: cam.lat, longitude: cam.lng),
        span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span)
    )
}

/// Pure gate for the map screenshot harness — the twin of Android's
/// `GraphHarness.enabled(debug:raw:)`.
///
/// Split out of the `init` so the SAFETY property is a test and not a comment: this
/// flag may start tracking (the fix stays on the device) and must NEVER start
/// `beSeen`, which POSTs the user's real coordinates to `/api/location` as a public
/// presence pin. `arguments` is a parameter rather than a `ProcessInfo` read so a
/// test can pass the exact argv it wants — including the argv that must NOT trigger.
enum MapHarness {
    static let trackingFlag = "--map-tracking-harness"

    /// True only for the exact tracking flag. Deliberately not a prefix/substring
    /// match: `--map-tracking-harness-disabled` or a flag that merely *contains* the
    /// name must not arm a capture harness.
    static func startsTracking(arguments: [String]) -> Bool {
        arguments.contains(trackingFlag)
    }

    /// Always false. There is no flag, and no argv, that turns presence on for a
    /// screenshot — an asset must never be the reason a real location is published.
    /// Exists as a function so the invariant is asserted rather than assumed.
    static func startsBeingSeen(arguments: [String]) -> Bool { false }
}

/// The "be seen" control — three states, where there used to be two.
///
/// Opting out has two halves: stop publishing (local, always works) and tell the
/// server to drop the row it already holds (a request, which can fail). The old
/// button flipped its label on the first half and threw the second half's result
/// away, so a failed DELETE left the user reading "location stays on this phone"
/// while their coarsened pin was still on a map every tiny user can see —
/// for up to `staleWindowMinutes`, which is how long the worker keeps listing a
/// row nobody is refreshing.
///
/// A false privacy assurance is worse than no assurance, so an unconfirmed
/// opt-out gets its own state and says so.
enum MapPresence {
    /// Mirrors the worker's `MAP_PRESENCE_WINDOW_S` (locations.ts) — the cut its
    /// pin query uses. Named here because the warning sentence has to state it.
    static let staleWindowMinutes = 5

    enum Control: Equatable {
        case optIn          // not sharing, nothing pending
        case optOut         // sharing
        case retryOptOut    // stopped publishing, but the server never confirmed
    }

    /// Did the server actually say it dropped the row?
    ///
    /// Only an explicit `ok: true` counts. A `nil` body means the request threw
    /// — offline, 401, worker outage; `try?` erases which — and a body without
    /// `ok`, or with `ok: false`, is the server declining. All three used to be
    /// indistinguishable from success because the result wasn't read at all, and
    /// the difference between `!= true` and `== false` here is a pin that stays
    /// on a public map.
    static func optOutConfirmed(_ body: [String: Any]?) -> Bool {
        (body?["ok"] as? Bool) == true
    }

    static func control(beSeen: Bool, optOutFailed: Bool) -> Control {
        // `beSeen` wins: if the beat is running the user IS visible, whatever a
        // previous failure said.
        if beSeen { return .optOut }
        return optOutFailed ? .retryOptOut : .optIn
    }

    static func label(for c: Control) -> String {
        switch c {
        case .optIn: return "be seen"
        case .optOut: return "visible to tinys"
        case .retryOptOut: return "still visible — retry"
        }
    }

    static func caption(for c: Control) -> String {
        switch c {
        case .optOut:
            return "this is what your tiny sees — and your pin is live for others (~11m coarse)"
        case .optIn:
            return "this is what your tiny sees — location stays on this phone"
        case .retryOptOut:
            return "stopped sending, but the server didn't confirm — your pin can stay on the map "
                 + "up to \(staleWindowMinutes) min. tap to try again"
        }
    }

    /// VoiceOver hears the state, not just the action.
    static func accessibilityLabel(for c: Control) -> String {
        switch c {
        case .optIn: return "Show yourself on the map to everyone using tinys"
        case .optOut: return "Stop being visible on the map"
        case .retryOptOut:
            return "Still visible on the map — the opt-out did not reach the server. Tap to retry."
        }
    }
}

struct TinyMapView: View {
    let token: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tinyAccent) private var accent
    @ObservedObject private var agentMap = AgentMap.shared

    @State private var camera: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194),
            span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
        )
    )
    @State private var fix: Geo.Fix?
    @State private var tracking = false
    @State private var beSeen = false
    @State private var dropped: [DroppedPin] = []
    @State private var remote: [RemotePin] = []
    // beat throttle (web MapView parity): ~60s cadence OR ~50m of movement
    @State private var lastBeat: (t: Double, lat: Double, lng: Double)?
    /// The opt-out DELETE didn't land. Publishing has already stopped — the beat
    /// loop exits on `beSeen` and nothing here can restart it — but the row the
    /// server already holds outlives us, so the panel may not claim otherwise.
    @State private var optOutFailed = false

    private var presence: MapPresence.Control {
        MapPresence.control(beSeen: beSeen, optOutFailed: optOutFailed)
    }

    struct DroppedPin: Identifiable {
        let id = UUID()
        let n: Int
        let coordinate: CLLocationCoordinate2D
    }
    struct RemotePin: Identifiable {
        let id: String
        let label: String
        let coordinate: CLLocationCoordinate2D
    }

    init(token: String?) {
        self.token = token
        #if DEBUG
        // 🗺️ Screenshot harness (`--map-tracking-harness`, DEBUG builds only).
        //
        // The store shot captioned "Your phone becomes a node" was an IDLE basemap:
        // no position dot, no pins, no HUD — the caption's entire subject missing,
        // with Apple Maps attribution as the only real content. Tracking is reachable
        // ONLY by tapping "locate me" (permission must fire on the tap, never on
        // open), and the simulator CLI cannot send a tap — which is exactly why the
        // raw was idle rather than anyone choosing it.
        //
        // Set in `init`, not by assigning `tracking` after the fact: `.task(id:
        // tracking)` keys the follow loop off this value, so a later assignment
        // starts a second loop racing the first onto the same `fix` (the same trap
        // the memory-graph harness hit with `showHistory`).
        //
        // ⚠️ This starts TRACKING only — never `beSeen`. Tracking keeps the fix on
        // the device; `beSeen` POSTs the user's real coordinates to /api/location as
        // a PUBLIC presence pin. An asset must never be the reason a real location is
        // published, so the shot shows the honest default: opted out.
        //
        //   xcrun simctl location <udid> set 37.7793,-122.4193
        //   xcrun simctl launch <udid> technology.tiny.app --map-tracking-harness
        if MapHarness.startsTracking(arguments: ProcessInfo.processInfo.arguments) {
            _tracking = State(initialValue: true)
        }
        #endif
    }

    var body: some View {
        ZStack {
            MapReader { proxy in
                Map(position: $camera) {
                    // You: the agi-diy pulse marker, tinted this tiny's accent
                    if let f = fix {
                        Annotation("", coordinate: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lng)) {
                            AccentPulseDot(accent: accent)
                                .accessibilityLabel("Your location")
                        }
                    }
                    ForEach(dropped) { pin in
                        Marker("pin \(pin.n)", coordinate: pin.coordinate)
                            .tint(accent)
                    }
                    ForEach(remote) { pin in
                        Marker(pin.label, systemImage: "person.fill", coordinate: pin.coordinate)
                            .tint(accent)
                    }
                    // Agent pins (add_map_marker — web bridge parity); untitled
                    // pins still get a VoiceOver/label name
                    ForEach(Array(agentMap.pins.values), id: \.id) { pin in
                        Marker(pin.label ?? "your tiny's pin", coordinate: CLLocationCoordinate2D(latitude: pin.lat, longitude: pin.lng))
                            .tint(agentPinColor(pin, fallback: accent))
                    }
                }
                // muted = Apple's native "recede" grade: basemap drops toward
                // the old dark design while pins/markers stay VIVID (SwiftUI
                // filters would gray them too — fine for ambient, not here)
                .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
                .onTapGesture { point in
                    if let coord = proxy.convert(point, from: .local) {
                        dropped.append(DroppedPin(n: dropped.count + 1, coordinate: coord))
                        // the pin lands under a fingertip — let the fingertip know
                        // (the app's haptic grammar: acts get feedback)
                        Haptic.shared.play(pattern: "tap", times: 1, intensity: 0.6)
                    }
                }
            }
            .ignoresSafeArea()
            .onAppear { AgentMap.shared.mapDidAppear() }
            .onDisappear { AgentMap.shared.mapDidDisappear() }
            .onChange(of: agentMap.camera) { _, cam in
                guard let cam else { return }
                withAnimation(.easeInOut(duration: 1.2)) { camera = .region(agentRegion(cam)) }
            }

            // control rail (web /map grammar: close + locate, top-right)
            VStack(alignment: .trailing, spacing: 8) {
                HStack {
                    Spacer()
                    VStack(alignment: .trailing, spacing: 8) {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                                .padding(10)
                                .background(.black.opacity(0.8), in: Circle())
                                .foregroundStyle(.white)
                        }
                        .accessibilityLabel("Close map")

                        Button {
                            if tracking {
                                tracking = false
                                fix = nil
                            } else {
                                // permission fires HERE, on the tap — never on open
                                Geo.shared.requestPermission()
                                tracking = true
                            }
                        } label: {
                            Label(tracking ? "tracking" : "locate me",
                                  systemImage: "location.fill")
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(.black.opacity(0.8), in: Capsule())
                                .foregroundStyle(tracking ? accent : .white)
                        }
                        .accessibilityLabel(tracking ? "Stop tracking your location" : "Locate me")

                        // 🗺️ agent pins are process-lifetime (they survive
                        // this screen) — so the USER gets the eraser, not
                        // just the agent
                        if !agentMap.pins.isEmpty {
                            Button {
                                AgentMap.shared.clearPins()
                            } label: {
                                Label(agentMap.pins.count == 1 ? "clear 1 pin" : "clear \(agentMap.pins.count) pins",
                                      systemImage: "mappin.slash")
                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                    .background(.black.opacity(0.8), in: Capsule())
                                    .foregroundStyle(.white)
                            }
                            .accessibilityLabel("Clear your tiny's map pins")
                        }

                        // 🌍 presence opt-in (web /map parity) — signed-in
                        // only; being seen requires a position, so enabling
                        // also starts tracking. Off = immediate opt-out.
                        if token != nil {
                            Button {
                                switch presence {
                                case .optOut, .retryOptOut: stopBeingSeen()
                                case .optIn:
                                    if !tracking {
                                        Geo.shared.requestPermission()
                                        tracking = true
                                    }
                                    optOutFailed = false
                                    beSeen = true
                                }
                            } label: {
                                Text(MapPresence.label(for: presence))
                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                    .background(.black.opacity(0.8), in: Capsule())
                                    .foregroundStyle(presence == .optOut ? accent
                                                     : presence == .retryOptOut ? Color.orange : .white)
                            }
                            .accessibilityLabel(MapPresence.accessibilityLabel(for: presence))
                        }

                        if !dropped.isEmpty {
                            Button {
                                dropped.removeAll()
                            } label: {
                                Text("clear \(dropped.count) pin\(dropped.count == 1 ? "" : "s")")
                                    .font(.footnote)
                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                    .background(.black.opacity(0.8), in: Capsule())
                                    .foregroundStyle(.white.opacity(0.85))
                            }
                        }
                    }
                }
                Spacer()

                // HUD — the literal context block the tiny reads
                if tracking {
                    VStack(alignment: .leading, spacing: 6) {
                        let block = Geo.contextBlock(fix)
                        // Denied ≠ waiting: without this branch a denied user
                        // reads "waiting for position…" forever (the follow
                        // loop can never deliver). Tap-through to Settings —
                        // the ask dialog only ever fires once on iOS.
                        if block.isEmpty, Geo.shared.denied {
                            Button {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    UIApplication.shared.open(url)
                                }
                            } label: {
                                Text("location is off for tiny — tap to allow in Settings")
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(Color(white: 0.85))
                                    .underline()
                            }
                            .accessibilityLabel("Location permission denied. Tap to open Settings.")
                        } else {
                        Text(block.isEmpty ? "waiting for position…" : block)
                            // caption2 = the same 11pt at default settings, but it
                            // FOLLOWS Dynamic Type (a fixed size: ignores it)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Color(white: 0.85))
                        }
                        Text(MapPresence.caption(for: presence))
                            .font(.caption2)
                            .foregroundStyle(presence == .retryOptOut
                                             ? Color.orange : Color(white: 0.45))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.15)))
                }
            }
            .padding(12)
        }
        .preferredColorScheme(.dark)
        // Follow loop (web/Android parity): snapshots while tracking — Geo
        // caches 30s, a pocket cadence. First fix flies the camera; later
        // ones only move the dot so panning isn't fought by the GPS.
        .task(id: tracking) {
            guard tracking else { return }
            var first = true
            while tracking && !Task.isCancelled {
                if let f = await Geo.shared.current() {
                    fix = f
                    if first {
                        withAnimation {
                            camera = .region(MKCoordinateRegion(
                                center: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lng),
                                span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
                            ))
                        }
                        first = false
                    }
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        // 🌍 Presence heartbeat — beating IS the opt-in (worker contract).
        // Throttled to a cadence or a real move; POST fails silently until
        // the deploy gate clears.
        .task(id: beSeen) {
            guard beSeen else { return }
            while beSeen && !Task.isCancelled {
                if let f = fix {
                    let moved = lastBeat.map {
                        abs(f.lat - $0.lat) > 0.0005 || abs(f.lng - $0.lng) > 0.0005
                    } ?? true
                    let due = lastBeat.map { Date().timeIntervalSince1970 - $0.t > 60 } ?? true
                    if moved || due {
                        lastBeat = (Date().timeIntervalSince1970, f.lat, f.lng)
                        var body: [String: Any] = [
                            "lat": (f.lat * 1e4).rounded() / 1e4,
                            "lng": (f.lng * 1e4).rounded() / 1e4,
                        ]
                        if let v = Geo.kmh(f.speedMs), v > 0 { body["speedKmh"] = v }
                        if let c = Geo.cardinal(f.headingDeg) { body["heading"] = c }
                        if let a = f.accuracyM { body["accuracyM"] = a }
                        let _: [String: Any]? = try? await Api.post("/api/location", token: token, body: body)
                    }
                }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        // Presence pins — opted-in tiny users, each minute (silently empty
        // until the worker's deploy gate clears).
        .task {
            while !Task.isCancelled {
                if let res: [String: Any] = try? await Api.get("/api/location", token: token),
                   let pins = res["pins"] as? [[String: Any]] {
                    let me = res["me"] as? String
                    remote = pins.compactMap { p in
                        guard let id = p["userId"] as? String, id != me,
                              let lat = p["lat"] as? Double, let lng = p["lng"] as? Double
                        else { return nil }
                        let label = (p["login"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                            ?? (p["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                            ?? "tiny user"
                        return RemotePin(id: id, label: label,
                                         coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng))
                    }
                }
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    /// Opting out, both halves of it.
    ///
    /// Stopping the beat comes first and unconditionally — the loop exits on
    /// `beSeen`, so from this line on the phone publishes nothing no matter what
    /// the network does. Then the server is asked to drop the row it already
    /// holds, and THAT result is what decides whether the panel may promise the
    /// location is back on this phone alone. Before, the result was thrown away
    /// and the promise got made either way.
    ///
    /// Deliberately never restores `beSeen` on failure: the user asked to stop,
    /// and resuming the beat would keep them on the map indefinitely rather than
    /// letting the row they can't delete go stale.
    private func stopBeingSeen() {
        beSeen = false
        lastBeat = nil
        let tok = token
        Task {
            let body = try? await Api.deleteJson("/api/location", token: tok, body: [:])
            optOutFailed = !MapPresence.optOutConfirmed(body)
        }
    }
}
