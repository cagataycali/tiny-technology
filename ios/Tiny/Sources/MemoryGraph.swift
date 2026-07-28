/**
 * Memory Graph — force-directed node-link viz of the signed-in user's fact
 * graph (GET /api/graph?all=1). iOS port of web components/chat/MemoryGraph.tsx
 * + android's MemoryGraph, matching web's visual grammar: accent fill = live
 * fact (brightness ramps with recency), grey = closed history; node radius
 * encodes degree; recessive edges under nodes; tap-to-select → detail card.
 *
 * The force simulation lives in the PURE, testable `GraphSim` — the byte-for-
 * byte twin of the web step(): golden-angle spiral seed, pairwise repulsion
 * (min(2600/d²,8)·α), edge springs (rest-length 130, k 0.02), weak centering
 * (0.005), velocity damping (0.85), α cooled ×0.995 until <0.02. Kept free of
 * SwiftUI so the physics can be unit-pinned. Scope matches android: pan/pinch/
 * tap-select (web's drag-to-pin is not ported).
 */
import SwiftUI

/// Which store/social asset harness a launch is arming, as a pure decision over
/// the argument list so it can be unit-pinned.
///
/// Two flags, because a SCREENSHOT and a VIDEO need different things from the
/// same demo dataset:
///  - `--memory-graph-harness` substitutes the dataset AND auto-opens the Graph
///    sheet. Right for a still: the sheet is the whole frame and nothing has to
///    navigate to it.
///  - `--graph-dataset-harness` substitutes the dataset and opens NOTHING. Right
///    for an app preview, where the cut opens on the chat hero and a driver taps
///    its way to the sheet — auto-opening would put the sheet on screen during
///    beat 1 and swallow the driver's first tap.
///
/// ⚠️ Why this exists at all: all FOUR shipped video encodes were recorded with
/// only `--session-harness`, so their graph beat rendered the signed-in user's
/// REAL fact graph — "FINANCIAL FLAG", "LEDGER READ", "SHIPMENT OF RECORD", a
/// named third party, ~40 private repo names — legibly, in an App Store app
/// preview and an Instagram Reel. The same defect c28–c30 fixed on three
/// screenshot sets; the videos were built before those fixes and nobody re-read
/// them. A capture route that can reach the real graph is the leak.
enum GraphHarness {
    static let sheetFlag = "--memory-graph-harness"
    static let datasetFlag = "--graph-dataset-harness"

    /// Substitute the demo dataset for the user's real facts? Either flag.
    static func usesDemoDataset(arguments: [String]) -> Bool {
        arguments.contains(sheetFlag) || arguments.contains(datasetFlag)
    }

    /// Auto-present the Graph sheet on appear? ONLY the stills flag.
    static func autoOpensSheet(arguments: [String]) -> Bool {
        arguments.contains(sheetFlag)
    }

    /// Start with History ON, so the legend's "closed" swatch has a referent.
    /// Tied to the dataset, not to the sheet: a video that navigates to the
    /// sheet itself still needs the grey nodes present when it arrives.
    static func startsWithHistory(arguments: [String]) -> Bool {
        usesDemoDataset(arguments: arguments)
    }
}

// ── Pure data + physics (testable) ──────────────────────────────────────────

struct GraphNode: Identifiable {
    let id: String
    let wireId: String
    let label: String
    let source: String?
    let live: Bool
    let validFrom: Double?
    let validTo: Double?
}

struct GraphEdge: Identifiable {
    let id: String
    let src: String
    let dst: String
    let rel: String
    let scope: String?
    let validTo: Double?
}

/// One physics body. Index-keyed (not id-keyed) so the hot loop is array math.
struct SimBody {
    var x: Double
    var y: Double
    var vx: Double = 0
    var vy: Double = 0
    var r: Double
}

/// The force simulation, extracted pure. Edges are pre-resolved to index pairs.
enum GraphSim {
    /// Deterministic golden-angle spiral seed — stable layouts across reopens
    /// beat random scatter. Radius scales √index so density stays even.
    /// `degree[i]` sizes the node (hubs read as hubs): r = min(6 + deg·2, 14).
    static func seed(count: Int, degree: [Int]) -> [SimBody] {
        (0..<count).map { i in
            let a = Double(i) * 2.39996  // golden angle
            let r = 14 * (Double(i) + 1).squareRoot()
            let deg = i < degree.count ? degree[i] : 0
            return SimBody(x: cos(a) * r, y: sin(a) * r,
                           r: min(6 + Double(deg) * 2, 14))
        }
    }

    /// One cooled tick, mutating bodies in place. `jitter(i,j)` supplies the
    /// tiny separation nudge for coincident nodes (injectable so tests stay
    /// deterministic — the web uses Math.random()). Returns the next alpha.
    static func step(_ b: inout [SimBody], edges: [(Int, Int)], alpha: Double,
                     jitter: (Int, Int) -> (Double, Double) = { _, _ in (0.01, 0.01) }) -> Double {
        let n = b.count
        // pairwise repulsion (O(n²); capacity bounds n, real graphs ~100)
        for i in 0..<n {
            for j in (i + 1)..<n {
                var dx = b[j].x - b[i].x, dy = b[j].y - b[i].y
                var d2 = dx * dx + dy * dy
                if d2 < 1 { let jt = jitter(i, j); dx = jt.0; dy = jt.1; d2 = 1 }
                let f = Swift.min(2600 / d2, 8) * alpha  // labels need breathing room
                let d = d2.squareRoot()
                let fx = (dx / d) * f, fy = (dy / d) * f
                b[i].vx -= fx; b[i].vy -= fy
                b[j].vx += fx; b[j].vy += fy
            }
        }
        // edge springs (rest length sized for two stacked labels)
        for (s, t) in edges {
            guard s < n, t < n else { continue }
            let dx = b[t].x - b[s].x, dy = b[t].y - b[s].y
            let dist = (dx * dx + dy * dy).squareRoot()
            let d = dist == 0 ? 1 : dist
            let f = (d - 130) * 0.02 * alpha
            let fx = (dx / d) * f, fy = (dy / d) * f
            b[s].vx += fx; b[s].vy += fy
            b[t].vx -= fx; b[t].vy -= fy
        }
        // weak centering + integrate + damping
        for i in 0..<n {
            b[i].vx -= b[i].x * 0.005 * alpha
            b[i].vy -= b[i].y * 0.005 * alpha
            b[i].vx *= 0.85; b[i].vy *= 0.85
            b[i].x += b[i].vx; b[i].y += b[i].vy
        }
        return alpha * 0.995
    }

    static let alphaFloor = 0.02

    /// Human-readable relation phrase (matches web REL_PHRASE).
    static func relPhrase(_ rel: String) -> String {
        switch rel {
        case "supersedes": return "supersedes"
        case "part_of": return "part of"
        case "authored": return "authored"
        case "relates_to": return "relates to"
        case "about": return "about"
        default: return rel
        }
    }

    /// Degree per node id (edge endpoints), for radius sizing.
    static func degrees(_ nodes: [GraphNode], _ edges: [GraphEdge]) -> [Int] {
        var d = [String: Int]()
        for e in edges { d[e.src, default: 0] += 1; d[e.dst, default: 0] += 1 }
        return nodes.map { d[$0.id] ?? 0 }
    }

    /// Screen points per world unit that fits a settled layout into `viewport`.
    ///
    /// This used to be `min(340 / max(spanX, spanY), …)` inline in the view, and
    /// both halves of that were wrong:
    ///  - **340 was a hardcoded width.** It's roughly a compact iPhone's panel, so
    ///    on anything bigger the graph shrank to a small central island — on a
    ///    6.9" phone the settled layout used barely a third of the canvas height.
    ///  - **One span drove both axes.** A layout that is wide and short (the usual
    ///    outcome of the spring/repulsion balance) was scaled by its WIDTH and then
    ///    left vertically tiny, so the empty space showed up as letterboxing.
    /// Fitting each axis against the real canvas and taking the tighter of the two
    /// is what "fit to view" means; `labelPad` reserves screen space for the
    /// captions, which are drawn in screen points above each node and therefore do
    /// NOT scale with the camera (a world-unit margin can't reserve room for them).
    ///
    /// Returns 1 (neutral, no zoom) when the viewport isn't measured yet — the
    /// alternative is clamping to `minScale` and flashing a pinhole graph before
    /// geometry arrives.
    static func fitScale(spanX: Double, spanY: Double, viewport: CGSize,
                         labelPad: CGFloat = 74,
                         minScale: CGFloat = 0.15, maxScale: CGFloat = 5) -> CGFloat {
        guard viewport.width > 0, viewport.height > 0 else { return 1 }
        // Never let padding eat the whole viewport (tiny canvases, big pad).
        let availW = max(viewport.width - labelPad * 2, viewport.width * 0.3)
        let availH = max(viewport.height - labelPad * 2, viewport.height * 0.3)
        let sx = spanX > 0 ? availW / CGFloat(spanX) : CGFloat.infinity
        let sy = spanY > 0 ? availH / CGFloat(spanY) : CGFloat.infinity
        let s = Swift.min(sx, sy)
        guard s.isFinite else { return 1 }  // single node / degenerate layout
        return Swift.min(Swift.max(s, minScale), maxScale)
    }
}

// ── SwiftUI view ──────────────────────────────────────────────────────────────

struct MemoryGraphView: View {
    let token: String?
    @Environment(\.dismiss) private var dismiss

    init(token: String?) {
        self.token = token
        #if DEBUG
        // Store shot: start with History ON so the three grey `live: false` nodes
        // are present. Without them the legend's "closed" swatch has no referent
        // anywhere on screen — the shot would advertise a distinction it doesn't
        // show. Done in `init` (not by assigning showHistory later) because
        // mutating it after the first load fires the onChange refetch, racing two
        // simulations onto the same `bodies`.
        _showHistory = State(initialValue:
            GraphHarness.startsWithHistory(arguments: ProcessInfo.processInfo.arguments))
        #endif
    }

    @State private var nodes: [GraphNode] = []
    @State private var edges: [GraphEdge] = []
    @State private var bodies: [SimBody] = []
    @State private var state: LoadState = .loading
    @State private var selected: String?
    /// Off = only what's currently true (valid_to IS NULL). On appends
    /// &include_closed=1 so superseded/unlearned facts join as grey history —
    /// the visible signature of bitemporal validity (web "Show history").
    @State private var showHistory = false

    // camera: world point at screen center + screen points per world unit
    @State private var camCenter = CGPoint.zero
    @State private var camScale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var panBy: CGSize = .zero
    @State private var settled = false
    /// The Canvas's measured size, published by the GeometryReader in `graphBody`.
    /// `fitCamera` runs from the simulation task, which has no geometry of its own,
    /// so the fit has to read the last measurement rather than assume a width.
    @State private var canvasSize: CGSize = .zero

    private var idIndex: [String: Int] {
        Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
    }

    private var isLoading: Bool { if case .loading = state { return true }; return false }

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading: ProgressView("Loading graph…")
                case .failed(let e):
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "point.3.connected.trianglepath.dotted")
                    } description: { Text(e) } actions: {
                        Button("Retry") { Task { state = .loading; await load() } }
                    }
                case .loaded:
                    if nodes.isEmpty {
                        ContentUnavailableView("No memories yet", systemImage: "brain",
                            description: Text("Facts the agent learns show up here as a graph."))
                    } else {
                        graphBody
                    }
                }
            }
            .navigationTitle("🕸 Graph")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // History changes the graph's CONTENTS (include_closed), so
                    // toggling refetches — a settled live layout can't just
                    // reveal hidden nodes. Selection is cleared on reseed.
                    Toggle(isOn: $showHistory) {
                        Label("History", systemImage: showHistory ? "clock.fill" : "clock")
                    }
                    .toggleStyle(.button)
                    .disabled(isLoading)
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .onChange(of: showHistory) { selected = nil; Task { state = .loading; await load() } }
        }
        .task { await load() }
    }

    private var graphBody: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                Canvas { ctx, size in var c = ctx; draw(&c, size) }
                    .gesture(
                        DragGesture()
                            .updating($panBy) { v, s, _ in s = v.translation }
                            .onEnded { v in
                                camCenter.x -= v.translation.width / effectiveScale
                                camCenter.y -= v.translation.height / effectiveScale
                            }
                    )
                    .simultaneousGesture(
                        MagnificationGesture()
                            .updating($pinch) { v, s, _ in s = v }
                            .onEnded { v in
                                camScale = min(max(camScale * v, 0.15), 5)
                            }
                    )
                    .onTapGesture { pt in selectAt(pt, size: geo.size) }
                    .contentShape(Rectangle())
                    // Publish the canvas size for fitCamera. Also RE-fits after a
                    // rotation or an iPad split-view resize: the layout is already
                    // settled by then, so nothing else would recompute the zoom and
                    // the graph would keep the old device's framing.
                    .onChange(of: geo.size, initial: true) { _, new in
                        canvasSize = new
                        if settled { fitCamera(bodies) }
                    }
            }
            legend
            if let sel = selectedNode { detailCard(sel) }
        }
    }

    private var effectiveScale: CGFloat { camScale * pinch }

    private var selectedNode: GraphNode? {
        guard let sel = selected else { return nil }
        return nodes.first { $0.id == sel }
    }

    // world → screen
    private func project(_ wx: Double, _ wy: Double, size: CGSize) -> CGPoint {
        let s = effectiveScale
        let cx = size.width / 2 + panBy.width + (CGFloat(wx) - camCenter.x) * s
        let cy = size.height / 2 + panBy.height + (CGFloat(wy) - camCenter.y) * s
        return CGPoint(x: cx, y: cy)
    }

    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let idx = idIndex
        let touching = selected.map { sel in
            Set(edges.filter { $0.src == sel || $0.dst == sel }.flatMap { [$0.src, $0.dst] })
        }
        let accent = Color(red: 0.30, green: 0.86, blue: 0.42)  // approx --tiny-accent
        let recency = recencySpan()

        // edges (recessive; selection lights the incident set)
        for e in edges {
            guard let si = idx[e.src], let ti = idx[e.dst], si < bodies.count, ti < bodies.count else { continue }
            let a = project(bodies[si].x, bodies[si].y, size: size)
            let b = project(bodies[ti].x, bodies[ti].y, size: size)
            let hot = selected != nil && (e.src == selected || e.dst == selected)
            var path = Path(); path.move(to: a); path.addLine(to: b)
            let closed = e.validTo != nil
            var style = StrokeStyle(lineWidth: hot ? 2 : 1.2)
            if closed { style.dash = [3, 3] } else if e.rel == "supersedes" { style.dash = [6, 3] }
            ctx.stroke(path, with: .color(hot ? accent : Color.white.opacity(0.16)), style: style)
        }

        // nodes + labels
        for (i, n) in nodes.enumerated() where i < bodies.count {
            let p = project(bodies[i].x, bodies[i].y, size: size)
            let isSel = n.id == selected
            let dim = selected != nil && !(touching?.contains(n.id) ?? false) && !isSel
            let r = CGFloat(bodies[i].r)
            let fill: Color = n.live ? liveFill(n, accent: accent, span: recency) : Color.white.opacity(0.22)
            let rect = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
            ctx.opacity = dim ? 0.25 : 1
            ctx.fill(Circle().path(in: rect), with: .color(fill))
            ctx.stroke(Circle().path(in: rect),
                       with: .color(isSel ? .white : n.live ? accent : Color.white.opacity(0.35)),
                       lineWidth: isSel ? 2 : 1)
            // label — the viz at this scale (density-gated: hubs + selection
            // always; everyone once zoomed in past ~0.9 world-units/px)
            if isSel || bodies[i].r > 6 || effectiveScale > 1.1 {
                let cap = caption(n)
                let text = Text(isSel ? "#\(n.wireId) · \(cap)" : cap)
                    .font(.system(size: isSel ? 11 : 9.5, weight: isSel ? .semibold : .regular))
                    .foregroundStyle(isSel ? Color.white : n.live ? Color.white.opacity(0.82) : Color.white.opacity(0.5))
                ctx.draw(text, at: CGPoint(x: p.x, y: p.y - r - 8), anchor: .bottom)
            }
            ctx.opacity = 1
        }
    }

    private var legend: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                Circle().fill(Color.green.opacity(0.35)).frame(width: 8, height: 8)
                Circle().fill(Color.green.opacity(0.95)).frame(width: 8, height: 8).offset(x: -4)
                Text("live (brighter = newer)")
            }
            HStack(spacing: 4) {
                Circle().fill(Color.white.opacity(0.25)).frame(width: 8, height: 8)
                Text("closed")
            }
            Spacer()
            Text("\(nodes.count) facts · \(edges.count) links")
        }
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .overlay(Divider(), alignment: .top)
    }

    private func detailCard(_ n: GraphNode) -> some View {
        let links = edges.filter { $0.src == n.id || $0.dst == n.id }.count
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(n.live ? "🟢" : "⚪")
                Text("#\(n.wireId)").fontWeight(.semibold)
                Text("learned \(dateStr(n.validFrom))\(n.validTo != nil ? " · closed \(dateStr(n.validTo))" : "")")
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            Text(n.source ?? n.label).font(.caption)
            if links > 0 {
                Text("\(links) link\(links > 1 ? "s" : "") — highlighted above")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.green.opacity(0.06))
        .overlay(Divider(), alignment: .top)
        .accessibilityElement(children: .combine)
    }

    // ── selection hit-test (screen → nearest node) ──────────────────────────
    private func selectAt(_ pt: CGPoint, size: CGSize) {
        var best: String?
        var bestD = CGFloat.greatestFiniteMagnitude
        for (i, n) in nodes.enumerated() where i < bodies.count {
            let p = project(bodies[i].x, bodies[i].y, size: size)
            let d = hypot(p.x - pt.x, p.y - pt.y)
            let hit = max(CGFloat(bodies[i].r) + 8, 22)  // hit target ≥ mark
            if d < hit && d < bestD { bestD = d; best = n.id }
        }
        selected = (best == selected) ? nil : best
    }

    // ── recency ramp for live fills (sequential-within-status) ──────────────
    private func recencySpan() -> (min: Double, max: Double)? {
        let ts = nodes.filter { $0.live && $0.validFrom != nil }.map { $0.validFrom! }
        guard let lo = ts.min(), let hi = ts.max(), hi > lo else { return nil }
        return (lo, hi)
    }
    private func liveFill(_ n: GraphNode, accent: Color, span: (min: Double, max: Double)?) -> Color {
        guard let span, let vf = n.validFrom else { return accent.opacity(0.85) }
        let t = (vf - span.min) / (span.max - span.min)
        return accent.opacity(0.3 + t * 0.65)
    }

    private func dateStr(_ ts: Double?) -> String {
        guard let ts, ts > 0 else { return "" }
        return Date(timeIntervalSince1970: ts).formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// Distinctive caption: strip a dataset-common prefix, then truncate to 26.
    /// Simplified from web buildCaptions — same intent (drop shared boilerplate),
    /// computed per-node here since the common-prefix cohort logic is heavy.
    private func caption(_ n: GraphNode) -> String {
        let t = (n.source ?? n.label).replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return t.count > 26 ? String(t.prefix(25)) + "…" : t
    }

    // ── load + run the simulation ───────────────────────────────────────────
    private func load() async {
        #if DEBUG
        // 🕸 Screenshot harness (`--memory-graph-harness`, DEBUG builds only).
        //
        // Why it exists: the graph draws the SIGNED-IN USER'S OWN FACTS, at a font
        // size that is perfectly legible once the shot is blown up to 1320×2868.
        // Slot 2 of BOTH store sets was doing exactly that — a named third party,
        // "FINANCIAL FLAG", "SHIPMENT OF RECORD", and a wall of private repo names,
        // all readable in a public listing. Unlike the chat shots there is no file to
        // seed: the graph is a network fetch, so the substitution has to happen here.
        //
        // It is HONEST about what it demonstrates. Only the DATASET is chosen; the
        // layout is the real `GraphSim` (same golden-angle seed, repulsion, springs),
        // the recency brightness ramp is the real `liveFill`, the grey history nodes
        // are the real `live: false` path, and "N facts · M links" counts these very
        // arrays. Nothing renders that a real graph wouldn't render — the pixels are
        // the shipping view on the shipping code path, with different words in it.
        if GraphHarness.usesDemoDataset(arguments: ProcessInfo.processInfo.arguments) {
            let demo = harnessGraph(includeClosed: showHistory)
            nodes = demo.nodes
            edges = demo.edges
            state = .loaded
            await runSimulation()
            return
        }
        #endif
        // Gate on the proxy's honest 503 {error}: an outage must NOT read as an
        // empty graph (masked-empty discipline — /api/graph route comment).
        let path = "/api/graph?all=1" + (showHistory ? "&include_closed=1" : "")
        guard let d: [String: Any] = try? await Api.get(path, token: token),
              (d["error"] == nil) else {
            state = .failed("Login required or network error"); return
        }
        let rawNodes = d["nodes"] as? [[String: Any]] ?? []
        let rawEdges = d["edges"] as? [[String: Any]] ?? []
        nodes = rawNodes.compactMap { parseNode($0) }
        edges = rawEdges.compactMap { parseEdge($0) }
        state = .loaded
        await runSimulation()
    }

    #if DEBUG
    /// The harness dataset (see `load()`), built to be a truthful portrait of the
    /// feature rather than a pretty picture:
    ///  - it is one PERSONA's knowledge (a baking tiny), which is what a new user's
    ///    graph actually looks like — the store shot should show the product's
    ///    premise, not a power user's 105-fact hairball where nothing is readable;
    ///  - every fact is something the `learn` tool genuinely stores (short, factual);
    ///  - `validFrom` spans several days so the real recency ramp in `liveFill` has a
    ///    span to interpolate over — a single timestamp would flatten every node to
    ///    the same brightness and quietly hide half of what the shot claims;
    ///  - with History ON, three superseded facts join as grey `live: false` nodes,
    ///    so the bitemporal story is demonstrated and not just asserted.
    /// It goes through `parseNode`/`parseEdge` so it can only express what the wire
    /// format can express — a shape the real API couldn't return can't sneak in here.
    func harnessGraph(includeClosed: Bool) -> (nodes: [GraphNode], edges: [GraphEdge]) {
        // A fixed epoch, since Date() would make the shot vary run to run.
        let day = 86_400.0
        let t0 = 1_753_000_000.0
        let live: [(String, String, Double)] = [
            ("f1", "Bakes sourdough every Sunday morning", 0),
            ("f2", "Keeps a rye starter named Bubbles, fed Saturday night", 1),
            ("f3", "Kitchen runs cold — proofs in the oven with the light on", 1),
            ("f4", "Prefers 78% hydration for an open crumb", 2),
            ("f5", "Dutch oven preheats 45 min at 250°C", 2),
            ("f6", "Scores a single long slash, never a cross", 3),
            ("f7", "Bread flour from the mill on Grand St", 3),
            ("f8", "Hates a gummy crumb more than a pale crust", 4),
            ("f9", "Sunday bake has to be out of the oven by 11", 4),
            ("f10", "Learning to shape baguettes, still tearing the skin", 5),
            ("f11", "Wants the alarm 25 min before the bulk ends", 5),
            ("f12", "Bakes for four; doubles the recipe on holidays", 6),
        ]
        let closed: [(String, String, Double)] = [
            ("c1", "Proofed on the counter (superseded — kitchen too cold)", 0),
            ("c2", "Used 65% hydration (superseded — wanted a more open crumb)", 1),
            ("c3", "Fed the starter every morning (superseded — Saturdays only)", 2),
        ]
        // Build WIRE dictionaries and decode them with the production parsers, so the
        // dataset can only express what /api/graph can express (and so a change to
        // the wire contract breaks the harness instead of silently diverging from it).
        let wire: ((String, String, Double)) -> [String: Any] = { t in
            let isClosed = t.0.hasPrefix("c")
            var o: [String: Any] = [
                "id": t.0, "wire_id": t.0, "label": t.1, "source": t.1,
                "freshness": isClosed ? "closed" : "live",
                "valid_from": NSNumber(value: t0 + t.2 * day),
            ]
            if isClosed { o["valid_to"] = NSNumber(value: t0 + (t.2 + 3) * day) }
            return o
        }
        // Uneven degree on purpose: node radius encodes degree, so a uniform ring
        // would erase that channel. The starter and the Sunday bake are the hubs.
        let links: [(String, String, String)] = [
            ("f1", "f2", "requires"), ("f1", "f5", "uses"), ("f1", "f9", "constrains"),
            ("f1", "f12", "scales_with"), ("f2", "f3", "affected_by"), ("f2", "f7", "made_from"),
            ("f4", "f8", "avoids"), ("f4", "f1", "applies_to"), ("f5", "f6", "precedes"),
            ("f6", "f10", "practised_in"), ("f9", "f11", "needs"), ("f3", "f5", "compensated_by"),
            ("f10", "f7", "made_from"), ("f12", "f4", "applies_to"),
            ("c1", "f3", "superseded_by"), ("c2", "f4", "superseded_by"), ("c3", "f2", "superseded_by"),
        ]
        let ns = (live + (includeClosed ? closed : [])).map(wire).compactMap(parseNode)
        let ids = Set(ns.map(\.id))
        let es = links.enumerated()
            .filter { ids.contains($0.element.0) && ids.contains($0.element.1) }
            .map { i, l -> [String: Any] in ["id": "e\(i)", "src": l.0, "dst": l.1, "rel": l.2] }
            .compactMap(parseEdge)
        return (ns, es)
    }
    #endif

    private func parseNode(_ o: [String: Any]) -> GraphNode? {
        guard let id = (o["id"] as? String) ?? (o["id"] as? NSNumber)?.stringValue else { return nil }
        let wire = (o["wire_id"] as? NSNumber)?.stringValue ?? (o["wire_id"] as? String) ?? id
        return GraphNode(
            id: id, wireId: wire,
            label: o["label"] as? String ?? "",
            source: o["source"] as? String,
            live: (o["freshness"] as? String ?? "live") == "live",
            validFrom: (o["valid_from"] as? NSNumber)?.doubleValue,
            validTo: (o["valid_to"] as? NSNumber)?.doubleValue)
    }
    private func parseEdge(_ o: [String: Any]) -> GraphEdge? {
        guard let id = (o["id"] as? String) ?? (o["id"] as? NSNumber)?.stringValue,
              let src = (o["src"] as? String) ?? (o["src"] as? NSNumber)?.stringValue,
              let dst = (o["dst"] as? String) ?? (o["dst"] as? NSNumber)?.stringValue else { return nil }
        return GraphEdge(id: id, src: src, dst: dst,
                         rel: o["rel"] as? String ?? "relates_to",
                         scope: o["scope"] as? String,
                         validTo: (o["valid_to"] as? NSNumber)?.doubleValue)
    }

    /// Run the cooled sim to settle, republishing each tick so the Canvas
    /// animates. Fits the camera to the layout once settled.
    private func runSimulation() async {
        let idx = idIndex
        let pairs: [(Int, Int)] = edges.compactMap {
            guard let s = idx[$0.src], let t = idx[$0.dst] else { return nil }
            return (s, t)
        }
        var b = GraphSim.seed(count: nodes.count, degree: GraphSim.degrees(nodes, edges))
        bodies = b
        var alpha = 1.0
        var tick = 0
        while alpha > GraphSim.alphaFloor && !Task.isCancelled {
            // deterministic-ish jitter varied by tick+index (no Math.random in
            // this codebase's pure layer — vary by counter instead)
            alpha = GraphSim.step(&b, edges: pairs, alpha: alpha) { i, j in
                let s = Double((i &+ j &+ tick) % 7) / 7 - 0.5
                return (s, -s)
            }
            tick += 1
            bodies = b
            try? await Task.sleep(nanoseconds: 16_000_000)  // ~60fps
        }
        fitCamera(b)
    }

    private func fitCamera(_ b: [SimBody]) {
        guard !b.isEmpty else { return }
        let xs = b.map(\.x), ys = b.map(\.y)
        let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
        camCenter = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
        // Fit BOTH axes against the canvas we actually measured (see
        // GraphSim.fitScale) instead of the old `340`-point guess.
        camScale = GraphSim.fitScale(spanX: maxX - minX, spanY: maxY - minY,
                                     viewport: canvasSize)
        settled = true
    }
}
