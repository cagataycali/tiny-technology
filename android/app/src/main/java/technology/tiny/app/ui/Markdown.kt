package technology.tiny.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import technology.tiny.app.ui.theme.TinyAccent
import technology.tiny.app.ui.theme.TinyCodeBg
import technology.tiny.app.ui.theme.TinyCodeStyle
import technology.tiny.app.ui.theme.TinyGray

/**
 * Fence-splitting markdown (iOS Markdown.swift parity): ``` blocks become
 * copyable code cards; prose gets lightweight inline styling (bold, inline
 * code, headers, bullets, clickable [text](url) links). No HTML.
 */
@Composable
fun MarkdownText(text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // Fences split FIRST, then media isolation runs on prose only: doing it
        // the other way injected newlines into fenced code, so a shown command
        // like `curl -o out.gif https://…/clip.gif` broke across two lines.
        splitFences(text).forEach { seg ->
            if (seg.isCode) CodeCard(seg.text, seg.lang) else ProseText(isolateMediaLines(seg.text))
        }
    }
}

// The image branch below only fires for a WHOLE-line `![alt](url)` — but
// agents butt media against prose (`…jpg)Anything else?`) and reply with bare
// .wav/.mp4 links (the necklace's clips). Give every embedded image/media URL
// its own line so the standalone branches render players instead of raw text.
private val EMBEDDED_IMAGE = Regex("(!\\[[^\\]]*]\\(https?://[^)\\s]+\\))")
private val BARE_MEDIA_URL = Regex(
    "(?<![(\\[])(https?://[^\\s<>()\"]+\\.(?:wav|mp3|m4a|aac|mp4|mov|m4v|gif))\\b",
    RegexOption.IGNORE_CASE,
)

/** Isolate media URLs onto their own lines, leaving `inline code` spans alone —
 *  a URL the user is meant to copy must not gain a newline. Fenced blocks are
 *  already excluded by MarkdownText, which splits fences before calling this. */
internal fun isolateMediaLines(text: String): String =
    text.split("`").mapIndexed { i, part ->
        if (i % 2 == 1) part                       // odd index = inside backticks
        else part.replace(EMBEDDED_IMAGE, "\n$1\n").replace(BARE_MEDIA_URL, "\n$1\n")
    }.joinToString("`")

data class Segment(val text: String, val isCode: Boolean, val lang: String? = null)

fun splitFences(text: String): List<Segment> {
    val segments = mutableListOf<Segment>()
    var rest = text
    while (true) {
        val open = rest.indexOf("```")
        if (open < 0) break
        val before = rest.take(open).trim()
        if (before.isNotEmpty()) segments.add(Segment(before, isCode = false))
        val afterOpen = rest.substring(open + 3)
        val newline = afterOpen.indexOf('\n')
        val lang = if (newline > 0) afterOpen.take(newline).trim().takeIf { it.length <= 20 && !it.contains(' ') } else null
        val codeStart = if (newline >= 0) newline + 1 else 0
        val close = afterOpen.indexOf("```", codeStart)
        if (close < 0) {
            // Unterminated fence (mid-stream): show what we have as code.
            segments.add(Segment(afterOpen.substring(codeStart).trimEnd(), isCode = true, lang = lang))
            return segments
        }
        segments.add(Segment(afterOpen.substring(codeStart, close).trimEnd(), isCode = true, lang = lang))
        rest = afterOpen.substring(close + 3)
    }
    val tail = rest.trim()
    if (tail.isNotEmpty()) segments.add(Segment(tail, isCode = false))
    return segments
}

@Composable
private fun CodeCard(code: String, lang: String?) {
    val context = LocalContext.current
    Surface(
        color = TinyCodeBg,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text(
                    lang ?: "code",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.setPrimaryClip(ClipData.newPlainText("code", code))
                    },
                    contentPadding = PaddingValues(0.dp),
                    modifier = Modifier.height(24.dp),
                ) { Text("copy", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
            }
            Text(
                code,
                style = TinyCodeStyle,
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            )
        }
    }
}

/**
 * Resolve reading direction from the text's own content (first strong-directional
 * char), so an Arabic/Hebrew reply renders RTL instead of forced-LTR. Mirrors web's
 * per-block dir="auto" (Chat.tsx:3423 etc.) and iOS's native AttributedString bidi
 * (Views.swift:3575). The composer already does this (MainActivity.kt:1858); this
 * carries it into the RENDERED bubble. Applied to content Text only — list markers
 * ("· ", "1. ") stay LTR chrome.
 */
internal fun TextStyle.bidi(): TextStyle = copy(textDirection = TextDirection.Content)

@Composable
private fun ProseText(text: String) {
    // Per-tiny accent (TinyAccentTheme overrides primary inside the chat subtree).
    val accent = MaterialTheme.colorScheme.primary
    val lines = text.lines()
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            // GFM table: a header row followed by a |---|:--:|---| separator, then
            // body rows until a blank/non-row line. Web renders these (remark-gfm,
            // Chat.tsx:2870); iOS's inlineOnly AttributedString does NOT, so it shows
            // raw pipe soup — Android matches web here (exceeds iOS).
            val tableEnd = tableBlockEnd(lines, i)
            if (tableEnd > i) {
                MdTable(lines.subList(i, tableEnd))
                i = tableEnd
                continue
            }
            // Blockquote: consecutive '>' lines COLLAPSE into ONE quote block (a single
            // continuous bar), matching web's single <blockquote> (Chat.tsx) and iOS's
            // QuoteCard (Markdown.swift 2050ce5) — not N stacked mini-bars. iOS's
            // inline-only AttributedString can't do block quotes; Android showed literal
            // "> ". Tolerate an optional space after '>' (GFM: "> x" and ">x" both quote).
            if (line.startsWith(">")) {
                var j = i
                val quoted = StringBuilder()
                while (j < lines.size && lines[j].startsWith(">")) {
                    if (j > i) quoted.append('\n')
                    quoted.append(lines[j].drop(1).removePrefix(" "))
                    j++
                }
                BlockQuote(inline(quoted.toString(), accent))
                i = j
                continue
            }
            // Standalone image line `![alt](url)` → real pixels (web parity). Checked
            // before the inline/heading branches so it isn't emitted as "!alt" text.
            val image = imageLineMatch(line)
            if (image != null) {
                MdImage(alt = image.first, url = image.second, link = image.third)
                i++
                continue
            }
            // Bare media URL on its own line (isolateMediaLines puts it there):
            // audio → play card, video → inline player, gif → MdImage (coil-gif
            // animates it).
            val mediaLine = mediaLineMatch(line)
            if (mediaLine != null) {
                when (mediaLine.second) {
                    "audio" -> AudioClipCard(mediaLine.first)
                    "video" -> VideoCard(mediaLine.first)
                    else -> MdImage(alt = "clip", url = mediaLine.first, link = null)
                }
                i++
                continue
            }
            // A nested list item carries leading whitespace ("  - child"): peel it to
            // an indent depth and match the marker on the trimmed line, so the item
            // still lists (indented) instead of falling through to flat paragraph text.
            // Only whitespace is stripped, and only for the list branches below — a
            // leading-space paragraph is untouched (its depth is just never consulted).
            val trimmed = line.trimStart(' ', '\t')
            val depth = listIndentDepth(line)
            val ordered = orderedListMatch(trimmed)
            when {
                // Thematic break "---" / "***" / "___" → an accent divider, matching web's
                // <hr> (Chat.tsx:2863, rgba(accent,0.2)). iOS's inline-only AttributedString
                // can't render one; Android printed literal dashes. Checked AFTER the bullet
                // branch so "- item" (needs a trailing space) still lists.
                isThematicBreak(line) -> HorizontalRule()
                // h1/h2/h3 → titleLarge/Medium/Small (web: 20 bold / 18 bold / 16
                // semibold — h2 and h3 used to collapse onto the same style).
                line.startsWith("### ") -> Text(inline(line.drop(4), accent), style = MaterialTheme.typography.titleSmall.bidi())
                line.startsWith("## ") -> Text(inline(line.drop(3), accent), style = MaterialTheme.typography.titleMedium.bidi())
                line.startsWith("# ") -> Text(inline(line.drop(2), accent), style = MaterialTheme.typography.titleLarge.bidi())
                trimmed.startsWith("- ") || trimmed.startsWith("* ") ->
                    Row(Modifier.padding(start = (depth * 16).dp)) { Text("· ", color = accent); Text(inline(trimmed.drop(2), accent), style = MaterialTheme.typography.bodyLarge.bidi()) }
                // Ordered list "1. step": render the author's literal number accent-tinted
                // (web <ol> + iOS AttributedString both render numbered lists; Android
                // dropped them to flat prose). Keep the author's number rather than
                // renumbering — it matches what the user reads and survives a split bubble.
                ordered != null ->
                    Row(Modifier.padding(start = (depth * 16).dp)) { Text("${ordered.first}. ", color = accent); Text(inline(ordered.second, accent), style = MaterialTheme.typography.bodyLarge.bidi()) }
                else -> Text(inline(line, accent), style = MaterialTheme.typography.bodyLarge.bidi())
            }
            i++
        }
    }
}

@Composable
private fun BlockQuote(content: AnnotatedString) {
    // IntrinsicSize.Min lets the accent bar stretch to the wrapped text's height
    // (a fixed-height Box would under/overshoot multi-line quotes).
    Row(Modifier.height(IntrinsicSize.Min).padding(vertical = 2.dp)) {
        // Accent left bar (web's blockquote border-left); text muted like a quote.
        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
        Text(
            content,
            style = MaterialTheme.typography.bodyLarge.bidi(),
            color = TinyGray,
            modifier = Modifier.padding(start = 10.dp),
        )
    }
}

/** CommonMark thematic break: 3+ of the same '-', '*' or '_', spaces allowed between. */
internal fun isThematicBreak(line: String): Boolean {
    val t = line.trim()
    if (t.length < 3) return false
    val c = t[0]
    if (c != '-' && c != '*' && c != '_') return false
    var count = 0
    for (ch in t) {
        if (ch == c) count++
        else if (ch != ' ') return false
    }
    return count >= 3
}

@Composable
private fun HorizontalRule() {
    // Web renders <hr> as a 1px accent-at-20% line (Chat.tsx:2863). Match it.
    Box(
        Modifier.fillMaxWidth().padding(vertical = 6.dp).height(1.dp)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)),
    )
}

/**
 * A standalone markdown image — Coil-loaded (already the avatar/attachment loader),
 * capped at a chat-bubble height, tap to open full-size in the browser/viewer. This
 * is where a `generate_image` result, a shared image, or any hosted image URL the
 * model returns becomes visible pixels on Android (web renders these via <img>).
 *
 * Long-press opens a Share/Copy-link menu — parity with iOS's GeneratedImageCard
 * contextMenu (Views.swift:3911: ShareLink "Share image link" + "Copy link"). The
 * link shared is the destination `link` when present, else the image `url` itself.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MdImage(alt: String, url: String, link: String?) {
    val context = LocalContext.current
    val open = link ?: url
    var menuOpen by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var viewer by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    if (viewer) MediaViewerDialog(url, "image") { viewer = false }
    Column(Modifier.padding(vertical = 4.dp)) {
        Box {
            coil.compose.AsyncImage(
                model = url,
                contentDescription = alt.ifBlank { "image" },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 320.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .combinedClickable(
                        // Tap opens the in-app viewer (iOS ChatMediaCard parity);
                        // "Open in browser" moved into the long-press menu.
                        onClick = { viewer = true },
                        onLongClick = { menuOpen = true },
                        onLongClickLabel = "Image options",
                    ),
                contentScale = androidx.compose.ui.layout.ContentScale.FillWidth,
            )
            Box(Modifier.align(Alignment.TopEnd)) { MediaActionButtons(url) { viewer = true } }
            androidx.compose.material3.DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
            ) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Download") },
                    onClick = {
                        menuOpen = false
                        downloadMedia(context, url)
                    },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Open in browser") },
                    onClick = {
                        menuOpen = false
                        runCatching {
                            context.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(open)),
                            )
                        }
                    },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Share image link") },
                    onClick = {
                        menuOpen = false
                        technology.tiny.app.chat.Sharing.shareText(context, alt.ifBlank { "Image" }, open)
                    },
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Copy link") },
                    onClick = {
                        menuOpen = false
                        technology.tiny.app.chat.Sharing.copyToClipboard(context, "image link", open)
                    },
                )
            }
        }
        if (alt.isNotBlank()) {
            Text(
                alt,
                style = MaterialTheme.typography.labelSmall,
                color = TinyGray,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

private val ORDERED_ITEM = Regex("^(\\d{1,9})[.)] +(.*)$")

/** "1. text" or "1) text" → (number, text); null if the line isn't an ordered item. */
internal fun orderedListMatch(line: String): Pair<String, String>? =
    ORDERED_ITEM.matchEntire(line)?.let { it.groupValues[1] to it.groupValues[2] }

/**
 * Nesting depth of a list line from its leading whitespace: 0 at column 0, +1 per
 * 2 leading spaces (the common author convention; a tab counts as 4), capped at 6
 * so a pathological indent can't push content off a narrow bubble. Web renders
 * nested ul/ol via remark-gfm (Chat.tsx:3464); iOS preserves leading whitespace in
 * its AttributedString (Markdown.swift:80). Android matched markers only at column
 * 0, so a "  - child" rendered flat — this recovers the indent. Non-list lines
 * never reach a render site that consults this.
 */
internal fun listIndentDepth(line: String): Int {
    var spaces = 0
    for (ch in line) {
        when (ch) {
            ' ' -> spaces++
            '\t' -> spaces += 4
            else -> break
        }
    }
    return (spaces / 2).coerceAtMost(6)
}

// A whole-line markdown image `![alt](url)` (optionally an image wrapped in a
// link: `[![alt](url)](href)`). Only http(s) URLs render — a bare filename or a
// data: URI is skipped so the line falls back to text (never a broken tile).
// Web renders these via ReactMarkdown's default <img>; iOS's inline-only
// AttributedString drops them entirely — Android matches web here (the surface
// where generated/shared image URLs finally become visible pixels, not "!alt").
private val IMAGE_LINE = Regex("^!\\[([^\\]]*)]\\((https?://[^)\\s]+)\\)$")
private val LINKED_IMAGE_LINE = Regex("^\\[!\\[([^\\]]*)]\\((https?://[^)\\s]+)\\)]\\((https?://[^)\\s]+)\\)$")

/** (alt, imageUrl, linkUrl?) for a standalone image line, else null. */
internal fun imageLineMatch(line: String): Triple<String, String, String?>? {
    val t = line.trim()
    LINKED_IMAGE_LINE.matchEntire(t)?.let {
        return Triple(it.groupValues[1], it.groupValues[2], it.groupValues[3])
    }
    IMAGE_LINE.matchEntire(t)?.let {
        return Triple(it.groupValues[1], it.groupValues[2], null)
    }
    return null
}

/**
 * If a GFM table starts at [start], returns the exclusive end index (header +
 * separator + body rows); otherwise returns [start]. A table needs a pipe-bearing
 * header line immediately followed by a separator row (cells of only -, :, space).
 */
internal fun tableBlockEnd(lines: List<String>, start: Int): Int {
    if (start + 1 >= lines.size) return start
    if (!lines[start].contains('|')) return start
    if (!isTableSeparator(lines[start + 1])) return start
    var end = start + 2
    while (end < lines.size && lines[end].contains('|') && lines[end].isNotBlank()) end++
    return end
}

internal fun isTableSeparator(line: String): Boolean {
    val cells = splitRow(line)
    return cells.isNotEmpty() && cells.all { c -> c.isNotEmpty() && c.all { it == '-' || it == ':' || it == ' ' } && c.contains('-') }
}

/** Split a GFM row into trimmed cells, tolerating optional leading/trailing pipes. */
internal fun splitRow(line: String): List<String> =
    line.trim().trim('|').split('|').map { it.trim() }

@Composable
private fun MdTable(block: List<String>) {
    val accent = MaterialTheme.colorScheme.primary
    val header = splitRow(block[0])
    val rows = block.drop(2).map { splitRow(it) } // skip header + separator
    val cols = header.size
    Column(Modifier.horizontalScroll(rememberScrollState())) {
        Row {
            header.forEach { cell ->
                Text(inline(cell, accent), style = MaterialTheme.typography.labelSmall, color = accent,
                    modifier = Modifier.widthIn(min = 72.dp).padding(end = 12.dp))
            }
        }
        rows.forEach { r ->
            Row {
                // Pad/truncate ragged rows to the header's column count so columns stay aligned.
                for (c in 0 until cols) {
                    Text(inline(r.getOrElse(c) { "" }, accent), style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.widthIn(min = 72.dp).padding(end = 12.dp))
                }
            }
        }
    }
}

/**
 * Inline **bold**, *italic*, `code`, ~~strikethrough~~, and [text](url) links;
 * everything else passes through. Links become clickable + accent-tinted, matching
 * iOS's AttributedString(markdown:) .tint(.green) (Markdown.swift:87). Italic +
 * strikethrough match WEB (remark-gfm renders both) — iOS's inline-only
 * AttributedString does italic but NOT GFM strikethrough, so this reaches web
 * parity. Text() renders the LinkAnnotation clickable automatically (Compose 1.7+).
 * Whichever marker appears first (and is well-formed) wins the next span; malformed
 * markers fall through as literal text.
 *
 * [accent] tints inline code + links; composable callers pass the theme primary
 * (per-tiny accent), the default keeps this pure fn test-callable.
 */
fun inline(line: String, accent: androidx.compose.ui.graphics.Color = TinyAccent): AnnotatedString =
    buildAnnotatedString { appendInline(line, accent) }

/**
 * Emit [line]'s inline spans into this builder. Split out of [inline] so a link
 * LABEL can recurse — `[**Download** now](url)` renders the bold inside the link
 * (web remark-gfm + iOS AttributedString(markdown:) both style link text; the old
 * code appended the label verbatim, so the `**` showed literally). The label is a
 * strict substring, so recursion always terminates; a stray `[` with no valid
 * `](` in the label matches nothing and stays literal (same well-formed-or-literal
 * contract as the top level). The URL is never re-parsed as markdown.
 */
private fun androidx.compose.ui.text.AnnotatedString.Builder.appendInline(
    line: String,
    accent: androidx.compose.ui.graphics.Color,
) {
    var i = 0
    while (i < line.length) {
        // Position of each well-formed marker at/after i (Int.MAX_VALUE = none).
        val bold = findDelim(line, i, "**")
        val strike = findDelim(line, i, "~~")
        val tick = findTick(line, i)
        val ital = findItalic(line, i)
        val uBold = findUnderscoreBold(line, i)
        val uItal = findUnderscoreItalic(line, i)
        val link = findLink(line, i)
        val next = minOf(bold, strike, tick, ital, uBold, uItal, link)
        if (next == Int.MAX_VALUE) { // no more markers — rest is literal
            append(unescapeEntities(line.substring(i)))
            break
        }
        append(unescapeEntities(line.substring(i, next))) // literal text up to the marker
        when (next) {
            bold -> {
                val end = delimClose(line, bold, "**") // findDelim guaranteed a flanked closer
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(unescapeEntities(line.substring(bold + 2, end))) }
                i = end + 2
            }
            strike -> {
                val end = delimClose(line, strike, "~~") // findDelim guaranteed a flanked closer
                withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(unescapeEntities(line.substring(strike + 2, end))) }
                i = end + 2
            }
            tick -> {
                // CommonMark: character references are NOT decoded inside code
                // spans — `a &lt; b` keeps its entities verbatim (web parity).
                val end = line.indexOf('`', tick + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = accent)) {
                    append(line.substring(tick + 1, end))
                }
                i = end + 1
            }
            ital -> {
                val end = italicClose(line, ital) // findItalic guaranteed a valid closer
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(unescapeEntities(line.substring(ital + 1, end))) }
                i = end + 1
            }
            uBold -> {
                val end = underscoreBoldClose(line, uBold) // findUnderscoreBold guaranteed a closer
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(unescapeEntities(line.substring(uBold + 2, end))) }
                i = end + 2
            }
            uItal -> {
                val end = underscoreItalicClose(line, uItal) // findUnderscoreItalic guaranteed a closer
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(unescapeEntities(line.substring(uItal + 1, end))) }
                i = end + 1
            }
            else -> { // link
                val close = line.indexOf(']', link)
                val urlStart = close + 2 // skip "]("
                val urlEnd = line.indexOf(')', urlStart)
                val label = line.substring(link + 1, close)
                val url = line.substring(urlStart, urlEnd)
                withLink(LinkAnnotation.Url(unescapeEntities(url), TextLinkStyles(SpanStyle(color = accent)))) {
                    // Recurse: the label is itself inline markdown (bold/italic/
                    // code inside link text), matching web + iOS. entity-decoding
                    // happens per-literal-run inside the recursion.
                    appendInline(label, accent)
                }
                i = urlEnd + 1
            }
        }
    }
}

/**
 * Decode the literal-text conventions the CommonMark inline pass applies before
 * a run of prose is emitted: backslash escapes AND the handful of HTML character
 * references models emit (`&lt;` `&gt;` `&quot;` `&#39;` `&nbsp;` `&amp;`). Web's
 * remark pipeline and iOS cmark both do this; this literal renderer printed both
 * raw ("tiny.technology/&lt;name&gt;" + "\\*not italic\\*" seen live on device).
 *
 * BACKSLASH ESCAPES (CommonMark 6.1): a `\` before any ASCII-punctuation char
 * yields that char literally (`\*`->`*`, `\``->backtick, `\$`->`$`, `\\`->`\`); a
 * `\` before a non-punctuation char (or at end of line) stays a literal backslash
 * ("C:\Users" and "back\slash" are preserved). The marker finders skip escaped
 * delimiters, so an escaped `\*`/`\``/`\[` lands here as literal text - a true
 * 2-vs-1: web (remark-parse+remark-gfm; remark-math only claims `$...$` so it does
 * NOT swallow `\(`/`\[`) and iOS (AttributedString(markdown:), cmark) both strip
 * the backslash; Android used to show it AND mis-italicize the content.
 *
 * Done in ONE left-to-right pass so a backslash-escaped `&` (`\&lt;`) is emitted
 * as a literal `&` and NOT then re-read as an entity start (-> literal "&lt;",
 * matching both engines). Entities are matched anchored at the `&`, so "&amp;lt;"
 * yields "&lt;" (the `&amp;` consumes first, "lt;" stays literal). `&nbsp;`
 * decodes to U+00A0 (a NON-breaking space), not a plain space - both engines emit
 * U+00A0, so "10&nbsp;MB" never wraps. Code spans/blocks never call this
 * (CommonMark keeps backslashes AND references verbatim in code).
 */
fun unescapeEntities(s: String): String {
    if ('&' !in s && '\\' !in s) return s
    val out = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
            out.append(s[i + 1]); i += 2; continue // \X -> X for punctuation X (incl. \\ -> \)
        }
        if (c == '&') {
            val ent = matchEntity(s, i)
            if (ent != null) { out.append(ent.first); i += ent.second; continue }
        }
        out.append(c); i++
    }
    return out.toString()
}

// The six references models actually emit. Anchored at a '&', so none share a
// post-'&' prefix. '&amp;'->'&' is safe mid-list because the single pass never
// revisits emitted output. U+00A0 for &nbsp; is intentional (non-breaking).
private val ENTITIES = listOf(
    "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"",
    "&#39;" to "'", "&nbsp;" to " ", "&amp;" to "&",
)

/** (decoded, consumedLength) if a known entity starts at [at], else null. */
private fun matchEntity(s: String, at: Int): Pair<String, Int>? {
    for ((name, dec) in ENTITIES) if (s.startsWith(name, at)) return dec to name.length
    return null
}

/** The 32 ASCII punctuation chars (CommonMark's backslash-escapable set). */
private fun isAsciiPunct(c: Char): Boolean =
    c in '\u0021'..'\u002F' || c in '\u003A'..'\u0040' ||
        c in '\u005B'..'\u0060' || c in '\u007B'..'\u007E'

/**
 * True when the char at [pos] is backslash-escaped - an ODD number of consecutive
 * `\` immediately precede it. CommonMark: "\*" is a literal `*` (escaped), while
 * "\\*" is a literal backslash then a LIVE `*`. The marker finders call this so
 * an escaped delimiter neither opens nor closes a span.
 */
private fun isEscaped(line: String, pos: Int): Boolean {
    var b = 0
    var j = pos - 1
    while (j >= 0 && line[j] == '\\') { b++; j-- }
    return b % 2 == 1
}

/**
 * Start index of a paired two-char delimiter (**bold** / ~~strike~~) at/after
 * `from` that has a matching closer, else Int.MAX_VALUE. Retries past an unpaired
 * opener so a stray "**" doesn't hide a real pair later on the line.
 *
 * Applies the same CommonMark flanking essence as [findItalic] so we render what
 * web (remark-gfm) and iOS (AttributedString(markdown:), cmark) do: an opener's
 * following char must be non-space, and its closer's preceding char must be
 * non-space. Without this, "a ** b ** c" bolded " b " and "**bold **" bolded
 * "bold " — both render literal on web + iOS (the closing "**" after a space
 * isn't right-flanking).
 */
private fun findDelim(line: String, from: Int, delim: String): Int {
    var open = line.indexOf(delim, from)
    while (open >= 0) {
        if (!isEscaped(line, open) && isDelimOpen(line, open, delim) && delimClose(line, open, delim) >= 0) return open
        open = line.indexOf(delim, open + 1)
    }
    return Int.MAX_VALUE
}

/** A two-char opener is valid only when the char it precedes is non-space (left-flanking). */
private fun isDelimOpen(line: String, pos: Int, delim: String): Boolean {
    val after = pos + delim.length
    val n = if (after < line.length) line[after] else ' '
    return !n.isWhitespace()
}

/**
 * Index of the closing two-char [delim] for an opener at [open], or -1 if none.
 * The closer's preceding char must be non-space (right-flanking); a whitespace-led
 * "**"/"~~" can't close, so we retry to a later flanked closer (matching cmark).
 */
private fun delimClose(line: String, open: Int, delim: String): Int {
    var close = line.indexOf(delim, open + delim.length)
    while (close >= 0) {
        val p = line[close - 1] // close > open >= 0, so a prev char always exists
        if (!p.isWhitespace() && !isEscaped(line, close)) return close
        close = line.indexOf(delim, close + 1)
    }
    return -1
}

/**
 * Start index of a *…* italic span at/after `from`, else Int.MAX_VALUE. Uses the
 * CommonMark flanking essence so we render exactly what web (remark-gfm) does: an
 * opener '*' must be followed by a non-space, non-'*' char (excludes bold "**" and
 * "a * b" arithmetic — remark-gfm treats neither as emphasis), and it must have a
 * matching closer '*' preceded by a non-space, non-'*'. Underscore emphasis
 * (`_italic_` / `__bold__`) is handled by [findUnderscoreItalic] / [findUnderscoreBold],
 * which add CommonMark's intraword guard so snake_case / 5_000 stay literal.
 */
private fun findItalic(line: String, from: Int): Int {
    var open = line.indexOf('*', from)
    while (open >= 0) {
        if (!isEscaped(line, open) && isItalicOpen(line, open) && italicClose(line, open) >= 0) return open
        open = line.indexOf('*', open + 1)
    }
    return Int.MAX_VALUE
}

/**
 * Start index of a `code span` opener at/after `from` (an unescaped backtick with
 * a later backtick to close it), else Int.MAX_VALUE. An escaped `` \` `` doesn't
 * open a span (CommonMark strips it to a literal backtick). Inside the span
 * backslashes are literal, so the closer is simply the next backtick — no
 * escape-skipping there.
 */
private fun findTick(line: String, from: Int): Int {
    var open = line.indexOf('`', from)
    while (open >= 0) {
        if (!isEscaped(line, open) && line.indexOf('`', open + 1) > open) return open
        open = line.indexOf('`', open + 1)
    }
    return Int.MAX_VALUE
}

private fun isItalicOpen(line: String, pos: Int): Boolean {
    val n = if (pos + 1 < line.length) line[pos + 1] else ' '
    return n != '*' && !n.isWhitespace()
}

/** Index of the closing '*' for an italic opener at [open], or -1 if none. */
private fun italicClose(line: String, open: Int): Int {
    var close = line.indexOf('*', open + 1)
    while (close >= 0) {
        val p = line[close - 1] // close > open >= 0, so a prev char always exists
        if (p != '*' && !p.isWhitespace() && !isEscaped(line, close)) return close
        close = line.indexOf('*', close + 1)
    }
    return -1
}

// -- underscore emphasis: `_italic_` / `__bold__` (web remark-gfm + iOS cmark both
// render these; Android used to show the raw underscores). The one rule the
// asterisk finders don't need is CommonMark's INTRAWORD guard: a '_' flanked by an
// alphanumeric on the OUTER side isn't a delimiter, so snake_case, file_name, and
// 5_000 stay literal. wordCharAt gates exactly that — the reason the old code cited
// for skipping '_' (false-italic on identifiers) is handled here, not by omission.

/** True when [idx] holds a letter/digit (the intraword-boundary test). Out of range
 *  (line edge) is NOT a word char, so an edge-anchored delimiter is free to fire. */
private fun wordCharAt(line: String, idx: Int): Boolean =
    idx in line.indices && line[idx].isLetterOrDigit()

/**
 * Start index of a `_…_` italic span at/after `from`, else Int.MAX_VALUE. Opener:
 * unescaped, not part of a `__` run (that's bold), followed by a non-space non-`_`,
 * and NOT preceded by a word char (intraword). A matching closer must exist.
 */
private fun findUnderscoreItalic(line: String, from: Int): Int {
    var open = line.indexOf('_', from)
    while (open >= 0) {
        if (!isEscaped(line, open) && isUnderscoreItalicOpen(line, open) && underscoreItalicClose(line, open) >= 0) return open
        open = line.indexOf('_', open + 1)
    }
    return Int.MAX_VALUE
}

private fun isUnderscoreItalicOpen(line: String, pos: Int): Boolean {
    val n = if (pos + 1 < line.length) line[pos + 1] else ' '
    if (n == '_' || n.isWhitespace()) return false // `__`=bold; a space can't open
    return !wordCharAt(line, pos - 1)               // intraword `_` (snake_case) can't open
}

/** Index of the closing '_' for an italic opener at [open], or -1 if none. The closer
 *  is preceded by a non-space non-`_`, not escaped, not immediately followed by another
 *  `_` (that belongs to a `__` bold run), and NOT followed by a word char (intraword). */
private fun underscoreItalicClose(line: String, open: Int): Int {
    var close = line.indexOf('_', open + 1)
    while (close >= 0) {
        val p = line[close - 1] // close > open >= 0, so a prev char always exists
        val nextUnderscore = close + 1 < line.length && line[close + 1] == '_'
        if (p != '_' && !p.isWhitespace() && !isEscaped(line, close) && !nextUnderscore && !wordCharAt(line, close + 1)) return close
        close = line.indexOf('_', close + 1)
    }
    return -1
}

/**
 * Start index of a `__…__` bold span at/after `from`, else Int.MAX_VALUE. Opener:
 * unescaped `__`, followed by a non-space, and NOT preceded by a word char
 * (intraword). A matching flanked closer must exist.
 */
private fun findUnderscoreBold(line: String, from: Int): Int {
    var open = line.indexOf("__", from)
    while (open >= 0) {
        if (!isEscaped(line, open) && isUnderscoreBoldOpen(line, open) && underscoreBoldClose(line, open) >= 0) return open
        open = line.indexOf("__", open + 1)
    }
    return Int.MAX_VALUE
}

private fun isUnderscoreBoldOpen(line: String, pos: Int): Boolean {
    val after = pos + 2
    val n = if (after < line.length) line[after] else ' '
    if (n.isWhitespace()) return false        // "__ x" can't open
    return !wordCharAt(line, pos - 1)          // intraword `__` (a__b) can't open
}

/** Index of the closing `__` for a bold opener at [open], or -1 if none. The closer's
 *  preceding char is non-space, it's unescaped, and it's NOT followed by a word char. */
private fun underscoreBoldClose(line: String, open: Int): Int {
    var close = line.indexOf("__", open + 2)
    while (close >= 0) {
        val p = line[close - 1] // close > open >= 0, so a prev char always exists
        if (p != '_' && !p.isWhitespace() && !isEscaped(line, close) && !wordCharAt(line, close + 2)) return close
        close = line.indexOf("__", close + 1)
    }
    return -1
}

/**
 * Start index of the first well-formed [text](url) at/after `from`, else
 * Int.MAX_VALUE. Scans past a stray '[' (e.g. "[not a link] but [real](url)")
 * so a malformed bracket doesn't hide a real link later on the same line.
 */
private fun findLink(line: String, from: Int): Int {
    var open = line.indexOf('[', from)
    while (open >= 0) {
        val close = line.indexOf(']', open + 1)
        if (!isEscaped(line, open) && close >= 0 && close + 1 < line.length && line[close + 1] == '(' &&
            line.indexOf(')', close + 2) >= 0
        ) return open
        open = line.indexOf('[', open + 1)
    }
    return Int.MAX_VALUE
}

// ── inline media players (necklace WAV clips, glasses MP4s) ──────────────────

private val MEDIA_LINE = Regex(
    "^(https?://\\S+\\.(wav|mp3|m4a|aac|mp4|mov|m4v|gif))$",
    RegexOption.IGNORE_CASE,
)

/** (url, kind: audio|video|image) for a whole-line media URL, else null. */
internal fun mediaLineMatch(line: String): Pair<String, String>? {
    val m = MEDIA_LINE.matchEntire(line.trim()) ?: return null
    val kind = when (m.groupValues[2].lowercase()) {
        "wav", "mp3", "m4a", "aac" -> "audio"
        "gif" -> "image"
        else -> "video"
    }
    return m.groupValues[1] to kind
}

/** A hosted audio clip as a play/stop card — iOS AudioClipCard parity.
 *  `internal` so MediaViewerDialog can reuse it for full-screen audio. */
@Composable
internal fun AudioClipCard(url: String) {
    val context = LocalContext.current
    var playing by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    val player = androidx.compose.runtime.remember { android.media.MediaPlayer() }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { player.release() } }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(14.dp),
    ) {
        Row(
            Modifier.padding(12.dp).widthIn(max = 280.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primary,
                shape = androidx.compose.foundation.shape.CircleShape,
                modifier = Modifier.size(36.dp).clickable {
                    if (playing) {
                        player.stop(); player.reset(); playing = false
                    } else {
                        runCatching {
                            player.reset()
                            player.setDataSource(url)
                            player.setOnPreparedListener { it.start() }
                            player.setOnCompletionListener { playing = false }
                            player.prepareAsync()
                            playing = true
                        }.onFailure { playing = false }
                    }
                },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(if (playing) "◼" else "▶", color = MaterialTheme.colorScheme.onPrimary)
                }
            }
            Column(Modifier.weight(1f, fill = false)) {
                Text(
                    if (playing) "PLAYING" else "AUDIO CLIP",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    url.substringAfterLast('/'),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                    maxLines = 1,
                )
            }
            androidx.compose.material3.Icon(
                Icons.Filled.Download,
                contentDescription = "Download clip",
                tint = MaterialTheme.colorScheme.outline,
                modifier = Modifier.size(20.dp).clickable { downloadMedia(context, url) },
            )
        }
    }
}

/** Inline video via classic VideoView — dependency-free (no ExoPlayer). */
@Composable
private fun VideoCard(url: String) {
    var viewer by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    if (viewer) MediaViewerDialog(url, "video") { viewer = false }
    Box {
        Surface(shape = RoundedCornerShape(14.dp)) {
            androidx.compose.ui.viewinterop.AndroidView(
                factory = { ctx ->
                    android.widget.VideoView(ctx).apply {
                        setVideoURI(android.net.Uri.parse(url))
                        setMediaController(android.widget.MediaController(ctx).also { it.setAnchorView(this) })
                        setOnPreparedListener { it.isLooping = false }
                        seekTo(1)   // show the first frame instead of black
                    }
                },
                modifier = Modifier.widthIn(max = 280.dp).height(200.dp),
            )
        }
        Box(Modifier.align(Alignment.TopEnd)) { MediaActionButtons(url) { viewer = true } }
    }
}
