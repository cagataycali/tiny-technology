package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Markdown BLOCK-level classifiers (iOS MarkdownProse parity — the Swift source
 * doc-comments literally say "mirrors Markdown.kt"). MarkdownTest already pins the
 * INLINE layer (bold/italic/code/strike/link/entities/escapes + imageLineMatch);
 * this closes the untested block layer — the decisions wired live into the
 * composable (Markdown.kt:126 tableBlockEnd, :157 orderedListMatch, :163
 * isThematicBreak) that turn a reply's tables into aligned grids and its `---`
 * into a rule instead of "pipe soup" / literal dashes.
 *
 * Android + web BOTH render tables and horizontal rules; iOS's inline-only
 * AttributedString does not — so byte-correct classification is MORE load-bearing
 * on Android, not less. The cases below transcribe iOS's oracle suite
 * (TinyTests.swift:41-143: gfmTableParsed, tableSurroundedByProse,
 * pipeWithoutSeparatorIsNotATable, separatorRequiresDash, borderlessPipesTolerated,
 * thematicBreakVariants) at the pure-function boundary.
 */
class MarkdownBlockTest {

    // ── isThematicBreak (iOS thematicBreakVariants) ─────────────────────────

    @Test fun `three or more of the same marker is a thematic break`() {
        assertTrue(isThematicBreak("---"))
        assertTrue(isThematicBreak("***"))
        assertTrue(isThematicBreak("___"))
        assertTrue(isThematicBreak("****")) // 4+ ok
    }

    @Test fun `spaces between markers are allowed`() {
        assertTrue(isThematicBreak("- - -"))
        assertTrue(isThematicBreak(" * * * "))
    }

    @Test fun `fewer than three markers is not a rule`() {
        assertFalse(isThematicBreak("--"))
        assertFalse(isThematicBreak("**"))
        assertFalse(isThematicBreak(""))
    }

    @Test fun `a bullet or mixed markers is not a rule`() {
        assertFalse(isThematicBreak("- item")) // bullet, not a rule
        assertFalse(isThematicBreak("-*-")) // mixed markers
        assertFalse(isThematicBreak("--- text")) // trailing prose after the dashes
    }

    // ── splitRow (iOS splitRow — border-pipe tolerance) ─────────────────────

    @Test fun `splitRow strips one optional leading and trailing pipe and trims cells`() {
        assertEquals(listOf("A", "B"), splitRow("| A | B |"))
        assertEquals(listOf("A", "B"), splitRow("A | B")) // borderless (valid GFM)
        assertEquals(listOf("1", "2"), splitRow("|1|2|"))
    }

    @Test fun `splitRow keeps empty interior cells (ragged rows handled downstream)`() {
        // A short row keeps its cells verbatim; padding to header width is the
        // table renderer's job (MdTable), not the splitter's.
        assertEquals(listOf("1"), splitRow("| 1 |"))
        assertEquals(listOf("x", "y", "z", "w"), splitRow("| x | y | z | w |"))
    }

    // ── isTableSeparator (iOS separatorRequiresDash + border tolerance) ─────

    @Test fun `a dash-only separator row is a separator`() {
        assertTrue(isTableSeparator("| --- | --- |"))
        assertTrue(isTableSeparator("--- | ---")) // borderless
        assertTrue(isTableSeparator("|:--|--:|")) // alignment colons ok
        assertTrue(isTableSeparator("| :-: | - |"))
    }

    @Test fun `a separator cell must contain at least one dash`() {
        // ":::" has no dash → not a separator (iOS separatorRequiresDash).
        assertFalse(isTableSeparator("| : | : |"))
        assertFalse(isTableSeparator("|   |   |")) // blank cells
        assertFalse(isTableSeparator("| A | B |")) // header text, not a separator
    }

    @Test fun `a separator cell may not contain other characters`() {
        assertFalse(isTableSeparator("| --x-- | --- |"))
    }

    // ── tableBlockEnd (iOS gfmTableParsed / tableSurroundedByProse / pipeWithout) ──

    @Test fun `a header plus separator plus body rows spans the whole table`() {
        // iOS gfmTableParsed: header, separator, 2 body rows → end index 4.
        val lines = listOf("| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |")
        assertEquals(4, tableBlockEnd(lines, 0))
    }

    @Test fun `the table stops at the first non-pipe line (surrounding prose)`() {
        // iOS tableSurroundedByProse: "before" at 0, table 1..4, "after" at 4.
        val lines = listOf("before", "| A | B |", "|:--|--:|", "| 1 | 2 |", "after")
        assertEquals(0, tableBlockEnd(lines, 0)) // "before" has no pipe → returns start (no table here)
        assertEquals(4, tableBlockEnd(lines, 1)) // table = lines[1..3], ends before "after"
    }

    @Test fun `a pipe line with no separator row after it is not a table`() {
        // iOS pipeWithoutSeparatorIsNotATable: a lone pipe line stays prose.
        val lines = listOf("a | b is just prose", "more prose")
        assertEquals(0, tableBlockEnd(lines, 0)) // no separator at [1] → returns start
    }

    @Test fun `a header with an invalid (dashless) separator is not a table`() {
        // iOS separatorRequiresDash: ":::" separator disqualifies the block.
        val lines = listOf("| A | B |", "| : | : |", "| 1 | 2 |")
        assertEquals(0, tableBlockEnd(lines, 0))
    }

    @Test fun `a header at the very last line cannot start a table`() {
        // Needs a following separator row; there is none.
        val lines = listOf("prose", "| A | B |")
        assertEquals(1, tableBlockEnd(lines, 1))
    }

    // ── orderedListMatch ────────────────────────────────────────────────────

    @Test fun `a dot-delimited ordered item yields its number and text`() {
        assertEquals("1" to "first item", orderedListMatch("1. first item"))
        assertEquals("42" to "answer", orderedListMatch("42. answer"))
    }

    @Test fun `a paren-delimited ordered item is also matched`() {
        assertEquals("1" to "first", orderedListMatch("1) first"))
    }

    @Test fun `the author's literal number is preserved, not renumbered`() {
        // "3." stays "3" even as the first rendered item (web <ol start> / iOS parity).
        assertEquals("3" to "third", orderedListMatch("3. third"))
    }

    @Test fun `a bullet or a number without the required trailing space is not an ordered item`() {
        assertNull(orderedListMatch("- bullet")) // unordered
        assertNull(orderedListMatch("1.no space")) // marker needs a following space
        assertNull(orderedListMatch("1.")) // no content after the marker+space
        assertNull(orderedListMatch("plain text"))
    }

    @Test fun `an over-long number is not treated as an ordered marker`() {
        // The regex caps the number at 9 digits (\d{1,9}); a 10-digit run isn't a list.
        assertNull(orderedListMatch("1234567890. too many digits"))
    }

    // ── listIndentDepth ─────────────────────────────────────────────────────
    // Nested-list indent recovery: a "  - child" used to render flat because the
    // marker was matched only at column 0. Depth = leading-space pairs (tab = 4),
    // capped at 6. Web renders nested ul/ol (remark-gfm); iOS preserves the
    // leading whitespace — Android reconstructs it into a start pad.

    @Test fun `a column-zero line is depth zero`() {
        assertEquals(0, listIndentDepth("- top level"))
        assertEquals(0, listIndentDepth("1. top level"))
        assertEquals(0, listIndentDepth("plain paragraph"))
    }

    @Test fun `two leading spaces is one level, four is two`() {
        assertEquals(1, listIndentDepth("  - child"))
        assertEquals(2, listIndentDepth("    - grandchild"))
        assertEquals(3, listIndentDepth("      - great-grandchild"))
    }

    @Test fun `an odd leading-space count floors to the pair below`() {
        // 3 spaces → 1 (a common "- " continuation indent), 1 space → 0.
        assertEquals(1, listIndentDepth("   - three spaces"))
        assertEquals(0, listIndentDepth(" - one space"))
    }

    @Test fun `a tab counts as four spaces`() {
        assertEquals(2, listIndentDepth("\t- tabbed"))
        assertEquals(4, listIndentDepth("\t\t- double-tabbed"))
    }

    @Test fun `a pathological indent is capped at six levels`() {
        // 40 spaces would be depth 20; the cap keeps content on a narrow bubble.
        assertEquals(6, listIndentDepth(" ".repeat(40) + "- runaway"))
    }
}
