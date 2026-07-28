/**
 * MarkdownText — real markdown for chat bubbles (NORTH_STAR P0.2).
 *
 * LocalizedStringKey's "markdown-lite" rendered code fences as backtick
 * soup and dropped links. This splits on ``` fences:
 *   - code blocks → monospaced scrollable card + language tag + copy button
 *   - prose segments → AttributedString(markdown:) — clickable links, bold,
 *     italics, inline code (with .inlineOnlyPreservingWhitespace the
 *     paragraphs survive)
 * Pure parsing (segments(_:)) is separated from the view for testability.
 */
import SwiftUI

// ── Parsing ────────────────────────────────────────────────────────────────

enum MarkdownSegment: Equatable {
    case prose(String)
    case code(lang: String?, body: String)
}

/// A prose segment further split into GFM tables and plain runs. Web renders
/// tables via remark-gfm (Chat.tsx) and android matches it (Markdown.kt), but
/// iOS's `.inlineOnlyPreservingWhitespace` AttributedString does NOT — a table
/// showed as raw pipe soup. This lifts tables out so they render as an aligned
/// grid; everything else stays a plain run for AttributedString to style.
enum ProseBlock: Equatable {
    case text(String)
    case table(header: [String], rows: [[String]])
    case quote(String)
    case rule
}

enum MarkdownProse {
    /// Split a GFM row into trimmed cells, tolerating optional leading/trailing
    /// pipes (mirrors Markdown.kt splitRow).
    static func splitRow(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// A separator row: every cell is only -, :, space and contains at least one
    /// dash (e.g. `|---|:--:|`).
    static func isTableSeparator(_ line: String) -> Bool {
        let cells = splitRow(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { c in
            !c.isEmpty && c.contains("-") && c.allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
        }
    }

    /// A CommonMark thematic break: 3+ of the same '-', '*' or '_', spaces
    /// allowed between (mirrors Markdown.kt isThematicBreak). Web renders it
    /// as an <hr>; iOS's inline-only AttributedString passes it through as
    /// literal dashes, so it's lifted out as a `.rule` block.
    static func isThematicBreak(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.count >= 3, let first = t.first,
              first == "-" || first == "*" || first == "_" else { return false }
        var count = 0
        for ch in t {
            if ch == first { count += 1 }
            else if ch != " " { return false }
        }
        return count >= 3
    }

    /// Parse inline markdown, then lift GFM strikethrough into SwiftUI's own
    /// strikethroughStyle. The parser records `~~x~~` as an inlinePresentation-
    /// Intent (bold/italic/code render from it automatically) but SwiftUI's
    /// Text does NOT render strikethrough from that intent — so `~~gone~~`
    /// showed as "gone" with the tildes stripped and no line, silently losing
    /// the author's meaning. Web (remark-gfm) and android render it; this
    /// closes the iOS gap. Returns nil on malformed markdown (caller falls
    /// back to plain text). Pure (no UI) so it's unit-testable.
    static func styled(_ s: String) -> AttributedString? {
        guard var attr = try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return nil }
        // Collect ranges first, then apply — mutating during the runs walk
        // would invalidate the iterator.
        let strikeRanges = attr.runs.compactMap { run in
            (run.inlinePresentationIntent?.contains(.strikethrough) ?? false) ? run.range : nil
        }
        for range in strikeRanges { attr[range].strikethroughStyle = .single }
        return attr
    }

    static func blocks(_ text: String) -> [ProseBlock] {
        let lines = text.components(separatedBy: "\n")
        var out: [ProseBlock] = []
        var run: [String] = []
        func flushRun() {
            if !run.isEmpty {
                let joined = run.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if !joined.isEmpty { out.append(.text(joined)) }
                run = []
            }
        }
        /// A blockquote line: leading whitespace then '>' (GFM tolerates "> x"
        /// and ">x"). Returns the content with the marker + one optional space
        /// stripped, or nil if the line isn't a quote.
        func quoteContent(_ line: String) -> String? {
            let s = line.trimmingCharacters(in: .whitespaces)
            guard s.hasPrefix(">") else { return nil }
            var body = String(s.dropFirst())
            if body.hasPrefix(" ") { body.removeFirst() }
            return body
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.contains("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flushRun()
                let header = splitRow(line)
                var bodyEnd = i + 2
                while bodyEnd < lines.count, lines[bodyEnd].contains("|"),
                      !lines[bodyEnd].trimmingCharacters(in: .whitespaces).isEmpty {
                    bodyEnd += 1
                }
                // Pad/truncate ragged rows to the header width so columns align.
                let cols = header.count
                let rows = lines[(i + 2)..<bodyEnd].map { row -> [String] in
                    let cells = splitRow(row)
                    return (0..<cols).map { c in c < cells.count ? cells[c] : "" }
                }
                out.append(.table(header: header, rows: rows))
                i = bodyEnd
            } else if isThematicBreak(line) {
                // "---" / "***" / "___" → an accent divider (web <hr>). Checked
                // before the quote/text branches; the table branch above already
                // requires a '|' so a pipe-less rule never looks like a separator.
                flushRun()
                out.append(.rule)
                i += 1
            } else if quoteContent(line) != nil {
                // Collapse a run of consecutive '>' lines into one styled quote
                // block (web's <blockquote> / android BlockQuote), so a wrapped
                // multi-line quote reads as a single accent-barred passage.
                flushRun()
                var quoteLines: [String] = []
                while i < lines.count, let c = quoteContent(lines[i]) {
                    quoteLines.append(c)
                    i += 1
                }
                out.append(.quote(quoteLines.joined(separator: "\n")))
            } else {
                run.append(line)
                i += 1
            }
        }
        flushRun()
        return out
    }
}

enum MarkdownSplitter {
    /// Split text on ``` fences. Unterminated fences render as code to EOF
    /// (streaming reality: the closing fence hasn't arrived yet).
    static func segments(_ text: String) -> [MarkdownSegment] {
        var out: [MarkdownSegment] = []
        var prose = ""
        var lines = text.components(separatedBy: "\n")[...]

        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if !prose.isEmpty {
                    out.append(.prose(prose.trimmingCharacters(in: .whitespacesAndNewlines)))
                    prose = ""
                }
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body = ""
                var closed = false
                while let cl = lines.first {
                    lines = lines.dropFirst()
                    if cl.trimmingCharacters(in: .whitespaces).hasPrefix("```") { closed = true; break }
                    body += (body.isEmpty ? "" : "\n") + cl
                }
                _ = closed
                if !body.isEmpty {
                    out.append(.code(lang: lang.isEmpty ? nil : lang, body: body))
                }
            } else {
                prose += (prose.isEmpty ? "" : "\n") + line
            }
        }
        let tail = prose.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { out.append(.prose(tail)) }
        return out
    }
}

// ── View ───────────────────────────────────────────────────────────────────

struct MarkdownText: View {
    let text: String

    var body: some View {
        let segs = MarkdownSplitter.segments(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segs.enumerated()), id: \.offset) { _, seg in
                switch seg {
                case .prose(let p):
                    proseView(p)
                case .code(let lang, let body):
                    CodeCard(lang: lang, body: body)
                }
            }
        }
    }

    @ViewBuilder
    private func proseView(_ p: String) -> some View {
        // Lift GFM tables out (AttributedString can't render them → pipe soup);
        // plain runs keep the inline-styled path below.
        let blocks = MarkdownProse.blocks(p)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let t): plainProse(t)
                case .table(let header, let rows): TableCard(header: header, rows: rows)
                case .quote(let q): QuoteCard(text: q)
                case .rule: RuleDivider()
                }
            }
        }
    }

    @ViewBuilder
    private func plainProse(_ p: String) -> some View {
        // MarkdownProse.styled keeps paragraphs/newlines while parsing
        // links/bold/italic/inline-code/strikethrough. Fall back to plain
        // text on malformed markdown (never crash a bubble).
        if let attr = MarkdownProse.styled(p) {
            Text(attr).textSelection(.enabled).tint(.green)
        } else {
            Text(p).textSelection(.enabled)
        }
    }
}

/// Thematic break → a 1px accent-at-20% divider, matching web's <hr>
/// (Chat.tsx: `border-0 h-px`, `rgba(accent,0.2)`) and android's HorizontalRule.
struct RuleDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.green.opacity(0.2))
            .frame(height: 1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
            .accessibilityHidden(true)
    }
}

/// Blockquote → accent left-bar + muted italic text, matching web's
/// `border-l-2 pl-3 italic text-gray-400` <blockquote> (Chat.tsx) and android's
/// BlockQuote (Markdown.kt). Content inline-styled via the same AttributedString
/// path as prose (so **bold** / `code` / links inside a quote still render).
struct QuoteCard: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Left bar stretches to the wrapped text's height (fixedSize keeps
            // the RoundedRectangle from collapsing in the HStack).
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color.green.opacity(0.5))
                .frame(width: 3)
            content
                .font(.body.italic())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .tint(.green)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var content: some View {
        if let attr = MarkdownProse.styled(text) {
            Text(attr)
        } else {
            Text(text)
        }
    }
}

/// GFM table → aligned, horizontally-scrollable grid. Header accent-tinted;
/// cells inline-styled via the same AttributedString path as prose (so **bold**
/// / `code` / links inside a cell still render). Mirrors Markdown.kt MdTable.
struct TableCard: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 4) {
                row(header, isHeader: true)
                Divider().overlay(Color.green.opacity(0.3))
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    row(r, isHeader: false)
                }
            }
            .padding(10)
        }
        .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.08), lineWidth: 1))
    }

    @ViewBuilder
    private func row(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                cellText(cell, isHeader: isHeader)
                    .frame(minWidth: 72, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func cellText(_ cell: String, isHeader: Bool) -> some View {
        let styled = MarkdownProse.styled(cell).map { Text($0) } ?? Text(cell)
        styled
            .font(isHeader ? .caption.weight(.semibold) : .caption)
            .foregroundStyle(isHeader ? Color.green : Color.primary)
            .textSelection(.enabled)
            .tint(.green)
    }
}

/// Code block card — monospaced, horizontally scrollable, copy button.
struct CodeCard: View {
    let lang: String?
    let body_: String
    @State private var copied = false

    init(lang: String?, body: String) {
        self.lang = lang
        self.body_ = body
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang ?? "code")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = body_
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundStyle(copied ? .green : .secondary)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.black.opacity(0.35))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(body_)
                    .font(.system(size: 13, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
            }
        }
        .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.08), lineWidth: 1))
    }
}
