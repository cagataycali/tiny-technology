/**
 * RenderUi — native rendering for the agent's `render_ui` tool.
 *
 * The web evals React componentCode; here that source is NEVER executed.
 * Instead the props JSON is inspected and drawn with real SwiftUI:
 *   - array of {label, value…} rows → Swift Charts (bars, or lines when
 *     dense/multi-series)
 *   - scalar dictionary → key/value grid
 *   - array of strings → bullet list
 *   - anything else → titled card noting the full version lives on the web
 *
 * The iOS platform note in Api.chatStream steers agents to put data in
 * props, so most live calls land in the chart/key-value paths.
 */
import SwiftUI
import Charts

struct RenderUiItem: Identifiable, Equatable, Codable {
    let id: String       // toolUseId
    let title: String?
    let propsJson: String
}

// ── Props interpretation ───────────────────────────────────────────────────

struct ChartPoint: Identifiable {
    let id = UUID()
    let label: String
    let value: Double
    let series: String
}

enum RenderUiContent {
    case chart(points: [ChartPoint], seriesCount: Int)
    case keyValues([(key: String, value: String)])
    case list([String])
    /// props.markdown — prose the agent wants formatted (north-star P2.2)
    case markdown(String)
    /// props.columns + props.rows (or props.table{columns,rows}) → grid
    case table(columns: [String], rows: [[String]])
    /// props.items: [{title, subtitle?}] → titled rows
    case titledItems([(title: String, subtitle: String?)])
    case empty
}

func parseRenderUi(_ propsJson: String) -> RenderUiContent {
    guard let data = propsJson.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) else { return .empty }

    if let dict = obj as? [String: Any] {
        // Explicit shapes first — the agent chose them on purpose
        if let md = dict["markdown"] as? String, !md.isEmpty { return .markdown(md) }
        if let t = parseTable(dict) ?? (dict["table"] as? [String: Any]).flatMap(parseTable) { return t }
        if let items = dict["items"] as? [[String: Any]] {
            // Cap like the chart/table paths do — the props are untrusted agent
            // JSON, and each row builds real SwiftUI views eagerly. Without a
            // bound a million-item array allocates a million Text views on the
            // main thread (hang/OOM).
            // render_ui props are freeform, so an item's title arrives under any
            // of label/title/name/text and its detail under value/detail/
            // subtitle/description (the natural agent shapes). Recognizing only
            // title/name dropped {label,value}/{text,detail} rows — they fell
            // through to a bogus chart guess or the web fallback. Matches
            // android's ItemList label/detail extraction.
            let rows = items.prefix(RENDER_LIST_CAP).compactMap { it -> (title: String, subtitle: String?)? in
                guard let title = firstString(it, "label", "title", "name", "text") else { return nil }
                return (title: title, subtitle: firstString(it, "value", "detail", "subtitle", "description"))
            }
            if !rows.isEmpty { return .titledItems(rows) }
        }
        // Chart candidates: props.data first, then any array-of-rows value
        var candidates: [[[String: Any]]] = []
        if let d = dict["data"] as? [[String: Any]] { candidates.append(d) }
        for v in dict.values { if let a = v as? [[String: Any]] { candidates.append(a) } }
        for rows in candidates {
            if let (points, series) = chartPoints(rows) { return .chart(points: points, seriesCount: series) }
        }
        // Scalar dict → key/value rows (capped — untrusted props, eager views)
        let kvs = dict.compactMap { (k, v) -> (key: String, value: String)? in
            if v is [String: Any] || v is [Any] || v is NSNull { return nil }
            return (key: k, value: "\(v)")
        }.sorted { $0.key < $1.key }.prefix(RENDER_LIST_CAP)
        if !kvs.isEmpty { return .keyValues(Array(kvs)) }
        return .empty
    }
    if let rows = obj as? [[String: Any]], let (points, series) = chartPoints(rows) {
        return .chart(points: points, seriesCount: series)
    }
    if let arr = obj as? [Any] {
        let items = arr.prefix(RENDER_LIST_CAP).compactMap { $0 as? String }
        if !items.isEmpty { return .list(items) }
    }
    return .empty
}

/// Cap on the unbounded list/key-value/titled-item paths — the chart (60) and
/// table (30) paths are already bounded; these render untrusted agent JSON as
/// eager SwiftUI views, so a huge array/object must not allocate unbounded.
private let RENDER_LIST_CAP = 100

/// First present key whose value is a non-null scalar, stringified. Lets the
/// items path accept label/title/name/text (title) and value/detail/subtitle
/// (detail) where the detail is often a number (`{label, value: 3}`) — a bare
/// `as? String` would drop it, so scalars are coerced like android's optString.
private func firstString(_ dict: [String: Any], _ keys: String...) -> String? {
    for k in keys {
        guard let v = dict[k], !(v is NSNull) else { continue }
        if v is [String: Any] || v is [Any] { continue } // never stringify a container
        let s = "\(v)"
        if !s.isEmpty { return s }
    }
    return nil
}

/// {columns:[String], rows:[…]} → table (≤6 cols, ≤30 rows, cells stringified).
/// render_ui props are freeform, so a row arrives EITHER as a positional array
/// (["a","b"]) OR as an object keyed by column name ({col:"a"}) — a natural
/// agent shape. The object form used to fail the `[[Any]]` cast: parseTable
/// returned nil, the table never rendered, and the rows array (being
/// [[String:Any]]) was then mis-picked as a chart candidate downstream. Read
/// cells by column name for object rows so both shapes render (matches
/// android's SimpleTable and web's table renderer).
private func parseTable(_ dict: [String: Any]) -> RenderUiContent? {
    guard let cols = dict["columns"] as? [String], !cols.isEmpty else { return nil }
    let columns = Array(cols.prefix(6))
    func stringify(_ cell: Any?) -> String {
        guard let cell = cell, !(cell is NSNull) else { return "" }
        return "\(cell)"
    }
    if let rawRows = dict["rows"] as? [[Any]], !rawRows.isEmpty {
        let rows = rawRows.prefix(30).map { row in
            (0..<columns.count).map { c in c < row.count ? stringify(row[c]) : "" }
        }
        return .table(columns: columns, rows: Array(rows))
    }
    if let objRows = dict["rows"] as? [[String: Any]], !objRows.isEmpty {
        let rows = objRows.prefix(30).map { row in
            columns.map { col in stringify(row[col]) }
        }
        return .table(columns: columns, rows: Array(rows))
    }
    return nil
}

/// Rows share ≥1 all-numeric column → chart data. First all-string column
/// becomes the x label; up to 3 numeric columns become series.
private func chartPoints(_ rows: [[String: Any]]) -> ([ChartPoint], Int)? {
    guard rows.count >= 2, let first = rows.first else { return nil }
    let keys = Array(first.keys)
    // NB: `is Bool` bridges TRUE for NSNumber(0/1) — a chart of 0s and 1s
    // would be rejected. objCType 'c' identifies REAL booleans (JSON
    // true/false) without misclassifying small integers. (Caught by
    // TinyTests.chartFromLabeledRows with value:1 rows.)
    let numericKeys = keys.filter { k in
        rows.allSatisfy { row in
            guard let n = row[k] as? NSNumber else { return false }
            return String(cString: n.objCType) != "c"
        }
    }.sorted()
    guard !numericKeys.isEmpty else { return nil }
    let labelKey = keys.sorted().first { k in rows.allSatisfy { $0[k] is String } }
    let seriesKeys = Array(numericKeys.prefix(3))

    var points: [ChartPoint] = []
    for (i, row) in rows.prefix(60).enumerated() {
        let label = labelKey.flatMap { row[$0] as? String } ?? String(i + 1)
        for k in seriesKeys {
            // A non-finite value (agent JSON `-1e400` parses to -inf; NaN
            // likewise) flows into Swift Charts' axis-domain math → invalid
            // CoreGraphics geometry / broken render. Coerce to 0.
            let raw = (row[k] as? NSNumber)?.doubleValue ?? 0
            let v = raw.isFinite ? raw : 0
            points.append(ChartPoint(label: label, value: v, series: k))
        }
    }
    return (points, seriesKeys.count)
}

// ── Card ───────────────────────────────────────────────────────────────────

struct RenderUiCard: View {
    let item: RenderUiItem
    @Environment(\.tinyAccent) private var accent

    var body: some View {
        let content = parseRenderUi(item.propsJson)
        VStack(alignment: .leading, spacing: 8) {
            if let t = item.title, !t.isEmpty {
                Text(t)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            switch content {
            case .chart(let points, let seriesCount):
                chart(points, seriesCount: seriesCount)
            case .keyValues(let kvs):
                keyValueGrid(kvs)
            case .list(let items):
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items.indices, id: \.self) { i in
                        Text("• \(items[i])").font(.subheadline)
                    }
                }
            case .markdown(let md):
                Text((try? AttributedString(markdown: md,
                        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(md))
                    .font(.subheadline)
                    .textSelection(.enabled)
            case .table(let columns, let rows):
                tableGrid(columns: columns, rows: rows)
            case .titledItems(let items):
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(items.indices, id: \.self) { i in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(items[i].title).font(.subheadline.weight(.medium))
                            if let sub = items[i].subtitle, !sub.isEmpty {
                                Text(sub).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            case .empty:
                Label("Interactive version on the web app", systemImage: "safari")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .tinyCard() // the one shared card chrome (Theme.swift)
    }

    @ViewBuilder
    private func chart(_ points: [ChartPoint], seriesCount: Int) -> some View {
        let labelCount = Set(points.map(\.label)).count
        // Few categories, one series → bars; dense or multi-series → lines
        let useBars = seriesCount == 1 && labelCount <= 10
        Chart(points) { p in
            if useBars {
                BarMark(x: .value("Label", p.label), y: .value("Value", p.value))
                    .foregroundStyle(accent)
                    .cornerRadius(3)
            } else {
                LineMark(x: .value("Label", p.label), y: .value("Value", p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                PointMark(x: .value("Label", p.label), y: .value("Value", p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                    .symbolSize(labelCount > 20 ? 0 : 20)
            }
        }
        .chartLegend(seriesCount > 1 ? .visible : .hidden)
        .frame(height: 190)
    }

    /// Horizontal-scrolling grid: header row + data rows (parse caps 6×30)
    private func tableGrid(columns: [String], rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                GridRow {
                    ForEach(columns.indices, id: \.self) { c in
                        Text(columns[c])
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Divider()
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { c in
                            Text(rows[r][c])
                                .font(.caption)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
    }

    private func keyValueGrid(_ kvs: [(key: String, value: String)]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
            ForEach(kvs, id: \.key) { kv in
                GridRow {
                    Text(kv.key)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .gridColumnAlignment(.leading)
                    Text(kv.value)
                        .font(.subheadline.weight(.medium))
                        .textSelection(.enabled)
                }
            }
        }
    }
}
