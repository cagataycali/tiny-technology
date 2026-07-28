package technology.tiny.app.ui

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The markdown renderer's pure core — splitFences (``` fence segmentation) and
 * inline (bold/italic/code/strike/link spans). These decide whether every reply
 * bubble renders formatted or as literal marker soup; they had no coverage
 * (trust-killer loop cycle 4). AnnotatedString is multiplatform Kotlin — plain JVM.
 */
class MarkdownTest {

    // ── splitFences ──────────────────────────────────────────────────────────

    @Test fun `prose only - single non-code segment`() {
        val segs = splitFences("just words")
        assertEquals(listOf(Segment("just words", isCode = false)), segs)
    }

    @Test fun `fence with lang splits into prose-code-prose`() {
        val segs = splitFences("before\n```kotlin\nval x = 1\n```\nafter")
        assertEquals(3, segs.size)
        assertEquals(Segment("before", isCode = false), segs[0])
        assertEquals(Segment("val x = 1", isCode = true, lang = "kotlin"), segs[1])
        assertEquals(Segment("after", isCode = false), segs[2])
    }

    @Test fun `unterminated fence renders as code, not swallowed`() {
        // Mid-stream state: the model has opened a fence but not closed it yet.
        val segs = splitFences("intro\n```py\nprint(1)")
        assertEquals(Segment("intro", isCode = false), segs[0])
        assertEquals(Segment("print(1)", isCode = true, lang = "py"), segs[1])
    }

    @Test fun `fence header with spaces is not a lang`() {
        val segs = splitFences("```not a lang\ncode\n```")
        assertEquals(Segment("code", isCode = true, lang = null), segs.single())
    }

    // ── inline: happy paths ──────────────────────────────────────────────────

    @Test fun `plain text passes through untouched`() {
        val a = inline("no markers here")
        assertEquals("no markers here", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `bold strips markers and bolds the span`() {
        val a = inline("one **bold** word")
        assertEquals("one bold word", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        assertEquals("bold", a.text.substring(span.start, span.end))
    }

    @Test fun `italic strips markers and italicizes`() {
        val a = inline("an *emphasized* word")
        assertEquals("an emphasized word", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontStyle.Italic, span.item.fontStyle)
        assertEquals("emphasized", a.text.substring(span.start, span.end))
    }

    // -- underscore emphasis: web remark-gfm + iOS cmark both render `_x_`/`__x__`;
    // Android used to leave the underscores literal. The intraword guard keeps
    // snake_case / 5_000 literal (CommonMark), matching both engines.

    @Test fun `underscore italic strips markers and italicizes`() {
        val a = inline("an _emphasized_ word")
        assertEquals("an emphasized word", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontStyle.Italic, span.item.fontStyle)
        assertEquals("emphasized", a.text.substring(span.start, span.end))
    }

    @Test fun `underscore bold strips markers and bolds`() {
        val a = inline("a __strong__ word")
        assertEquals("a strong word", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        assertEquals("strong", a.text.substring(span.start, span.end))
    }

    @Test fun `intraword underscores stay literal - snake_case is not italic`() {
        // The whole reason the old code skipped '_': an identifier must not italicize.
        // CommonMark's intraword rule (a '_' flanked by word chars can't open/close)
        // keeps this literal on remark-gfm + cmark too.
        val a = inline("call get_user_name() now")
        assertEquals("call get_user_name() now", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `intraword double underscores stay literal - a__b is not bold`() {
        val a = inline("var my__field here")
        assertEquals("var my__field here", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `a number with grouping underscores stays literal`() {
        val a = inline("cap is 5_000_000 micro")
        assertEquals("cap is 5_000_000 micro", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `space-flanked underscores stay literal - not emphasis`() {
        // "a _ b _ c": space after the opener, space before the closer — neither flanks.
        val a = inline("a _ b _ c")
        assertEquals("a _ b _ c", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `an escaped underscore stays literal`() {
        val a = inline("keep \\_this\\_ plain")
        assertEquals("keep _this_ plain", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `underscore emphasis at the line edges fires`() {
        // Edge-anchored '_' has no outer word char, so it's a valid delimiter.
        val a = inline("_lead_ and __end__")
        assertEquals("lead and end", a.text)
        assertEquals(2, a.spanStyles.size)
        assertTrue(a.spanStyles.any { it.item.fontStyle == FontStyle.Italic && a.text.substring(it.start, it.end) == "lead" })
        assertTrue(a.spanStyles.any { it.item.fontWeight == FontWeight.Bold && a.text.substring(it.start, it.end) == "end" })
    }

    @Test fun `inline code strips ticks and goes monospace`() {
        val a = inline("run `ls -la` now")
        assertEquals("run ls -la now", a.text)
        val span = a.spanStyles.single()
        assertEquals("ls -la", a.text.substring(span.start, span.end))
    }

    @Test fun `strikethrough strips tildes and strikes`() {
        val a = inline("~~gone~~ kept")
        assertEquals("gone kept", a.text)
        val span = a.spanStyles.single()
        assertEquals(TextDecoration.LineThrough, span.item.textDecoration)
    }

    @Test fun `space-flanked bold markers stay literal - not emphasis`() {
        // CommonMark flanking (cmark + remark-gfm): "a ** b ** c" has a
        // space-led opener and space-led closer, so neither "**" opens/closes.
        // Android used to bold " b "; iOS + web render it literal.
        val a = inline("a ** b ** c")
        assertEquals("a ** b ** c", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `bold closer preceded by a space does not close`() {
        // "**bold **": the closing "**" is preceded by a space, so it's not
        // right-flanking — no later closer either, so the whole thing is literal.
        val a = inline("**bold ** rest")
        assertEquals("**bold ** rest", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `bold opener followed by a space does not open but a real pair still resolves`() {
        // Left half "** not" can't open (space after "**"); the real "**yes**"
        // later on the line must still bold — findDelim retries past the stray.
        val a = inline("x ** not **yes** end")
        assertEquals("x ** not yes end", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        assertEquals("yes", a.text.substring(span.start, span.end))
    }

    @Test fun `space-flanked strike markers stay literal`() {
        // Same flanking rule for "~~": "a ~~ b ~~ c" is literal on iOS + web.
        val a = inline("a ~~ b ~~ c")
        assertEquals("a ~~ b ~~ c", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `strike closer preceded by a space does not close`() {
        val a = inline("~~gone ~~ rest")
        assertEquals("~~gone ~~ rest", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `link keeps label text and carries the url`() {
        val a = inline("see [the docs](https://tiny.technology) ok")
        assertEquals("see the docs ok", a.text)
        val link = a.getLinkAnnotations(0, a.text.length).single()
        assertEquals("https://tiny.technology", (link.item as LinkAnnotation.Url).url)
        assertEquals("the docs", a.text.substring(link.start, link.end))
    }

    @Test fun `mixed markers on one line all resolve`() {
        val a = inline("**b** and *i* and `c`")
        assertEquals("b and i and c", a.text)
        assertEquals(3, a.spanStyles.size)
    }

    // ── inline markdown inside a link label (web remark-gfm + iOS parity) ─────

    @Test fun `bold inside a link label styles the label, not literal markers`() {
        val a = inline("[**Download**](https://x.dev)")
        assertEquals("Download", a.text) // markers stripped, not "**Download**"
        val link = a.getLinkAnnotations(0, a.text.length).single()
        assertEquals("https://x.dev", (link.item as LinkAnnotation.Url).url)
        assertEquals("Download", a.text.substring(link.start, link.end))
        // The label's bold survives the recursion.
        assertEquals(FontWeight.Bold, a.spanStyles.single().item.fontWeight)
    }

    @Test fun `mixed emphasis and code inside a link label all resolve`() {
        val a = inline("[get *the* `cli` now](https://x.dev)")
        assertEquals("get the cli now", a.text)
        val link = a.getLinkAnnotations(0, a.text.length).single()
        assertEquals("get the cli now", a.text.substring(link.start, link.end))
        // italic span + code span both nested under the one link.
        assertTrue(a.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
    }

    @Test fun `plain link label still works after label recursion`() {
        val a = inline("see [the docs](https://tiny.technology) ok")
        assertEquals("see the docs ok", a.text)
        val link = a.getLinkAnnotations(0, a.text.length).single()
        assertEquals("the docs", a.text.substring(link.start, link.end))
    }

    // ── inline: malformed input must fall through as literal, never crash ────

    @Test fun `unclosed bold stays literal`() {
        val a = inline("a ** dangling")
        assertEquals("a ** dangling", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `arithmetic asterisks are not emphasis`() {
        // CommonMark flanking: "3 * 4 * 5" has space-adjacent stars — no italics.
        val a = inline("3 * 4 * 5")
        assertEquals("3 * 4 * 5", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `snake_case stays literal - underscore emphasis unsupported by design`() {
        val a = inline("use send_message and via_tiny")
        assertEquals("use send_message and via_tiny", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `stray opener does not hide a later real pair`() {
        val a = inline("[not a link] but [real](https://x.dev)")
        assertEquals("[not a link] but real", a.text)
        val link = a.getLinkAnnotations(0, a.text.length).single()
        assertEquals("https://x.dev", (link.item as LinkAnnotation.Url).url)
    }

    @Test fun `single tick with no closer stays literal`() {
        val a = inline("a ` alone")
        assertEquals("a ` alone", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `bold-italic nesting resolves bold first without crashing`() {
        // "***x***": exact nesting semantics are unspecified in this renderer;
        // the contract is only no crash + markers consumed + x present.
        val a = inline("***x***")
        assertTrue(a.text.contains("x"))
    }

    // ── entity unescape (web remark parity; seen raw on device) ─────────────

    @Test fun `entities decode in prose`() {
        val a = inline("tiny.technology/&lt;name&gt; &amp; more")
        assertEquals("tiny.technology/<name> & more", a.text)
    }

    @Test fun `entities decode inside bold and link labels`() {
        assertEquals("a > b", inline("**a &gt; b**").text)
        assertEquals("Q&A", inline("[Q&amp;A](https://x.dev?a=1&amp;b=2)").text)
    }

    @Test fun `entities stay literal inside inline code`() {
        // CommonMark: no character references in code spans.
        val a = inline("run `a &lt; b` now")
        assertEquals("run a &lt; b now", a.text)
    }

    @Test fun `double-escaped ampersand decodes exactly one level`() {
        assertEquals("&lt;", unescapeEntities("&amp;lt;"))
    }

    @Test fun `nbsp decodes to a NON-breaking space, not a plain space`() {
        // The CommonMark entity table maps &nbsp; to U+00A0. Both real engines
        // agree: web micromark (remark-gfm) and iOS cmark (AttributedString)
        // both emit U+00A0, so "10&nbsp;MB" must not wrap on Android either. A
        // "cleanup" to a plain space is a silent 2-vs-1; this pins U+00A0.
        assertEquals("10\u00A0MB", unescapeEntities("10&nbsp;MB"))
        val decoded = unescapeEntities("a&nbsp;b")
        assertEquals('\u00A0', decoded[1])          // exactly U+00A0
        assertNotEquals('\u0020', decoded[1])       // NOT a plain space
    }

    @Test fun `quot and apos decode to plain ASCII quotes`() {
        // &quot; -> " and &#39; -> ' are plain ASCII on every engine (verified
        // vs micromark). These branches were unguarded until now.
        assertEquals("\"q\" and 's", unescapeEntities("&quot;q&quot; and &#39;s"))
    }

    @Test fun `no-ampersand fast path returns same string`() {
        assertEquals("plain", unescapeEntities("plain"))
    }

    // ── backslash escapes (CommonMark §6.1; web remark + iOS cmark parity) ────
    // Ground-truth pinned against web's ACTUAL pipeline (remark-parse +
    // remark-math + remark-gfm): a backslash before ASCII punctuation yields the
    // literal punctuation and — critically — the delimiter no longer styles.

    @Test fun `escaped asterisks render literal, not italic`() {
        // "\*not italic\*" → web+iOS show "*not italic*" (no emphasis). Android
        // used to italicize "not italic" AND show the backslashes — double wrong.
        val a = inline("\\*not italic\\*")
        assertEquals("*not italic*", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `escaped double-asterisk renders literal, not bold`() {
        val a = inline("\\*\\*not bold\\*\\*")
        assertEquals("**not bold**", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `escaped tildes render literal, not strikethrough`() {
        val a = inline("\\~\\~not struck\\~\\~")
        assertEquals("~~not struck~~", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `escaped backtick renders literal, not code`() {
        val a = inline("\\`not code\\`")
        assertEquals("`not code`", a.text)
        assertEquals(0, a.spanStyles.size)
    }

    @Test fun `escaped bracket does not open a link`() {
        // "\[x\](y)" → literal "[x](y)", no link annotation.
        val a = inline("\\[x\\](y)")
        assertEquals("[x](y)", a.text)
        assertEquals(0, a.getLinkAnnotations(0, a.text.length).size)
    }

    @Test fun `escaped closer inside a live italic stays literal`() {
        // "*a\*b*" → web renders italic "a*b" (the escaped * is a literal, the
        // outer *…* still emphasize). The inner \* must NOT close the span.
        val a = inline("*a\\*b*")
        assertEquals("a*b", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontStyle.Italic, span.item.fontStyle)
        assertEquals("a*b", a.text.substring(span.start, span.end))
    }

    @Test fun `double backslash is a literal backslash then a LIVE delimiter`() {
        // "a\\*bold*" → web: literal "a\" then italic "bold". Even backslash
        // count means the * is NOT escaped.
        val a = inline("a\\\\*bold*")
        assertEquals("a\\bold", a.text)
        val span = a.spanStyles.single()
        assertEquals(FontStyle.Italic, span.item.fontStyle)
        assertEquals("bold", a.text.substring(span.start, span.end))
    }

    @Test fun `backslash before a non-punctuation char is kept literal`() {
        // "C:\Users" and "back\slash" — web+iOS preserve the backslash (only
        // ASCII punctuation is escapable). Also a trailing lone backslash.
        assertEquals("C:\\Users", unescapeEntities("C:\\Users"))
        assertEquals("back\\slash", unescapeEntities("back\\slash"))
        assertEquals("ends\\", unescapeEntities("ends\\"))
    }

    @Test fun `escaped punctuation decodes to the bare char`() {
        assertEquals("100% and $5", unescapeEntities("100\\% and \\$5"))
        assertEquals("# not heading", unescapeEntities("\\# not heading"))
    }

    @Test fun `backslash-escaped ampersand is NOT read as an entity start`() {
        // "\&lt;" → literal "&lt;": the backslash escapes the &, so the entity
        // scan never fires (single left-to-right pass, web+iOS parity).
        assertEquals("&lt; literal", unescapeEntities("\\&lt; literal"))
    }

    @Test fun `backslashes stay verbatim inside a code span`() {
        // CommonMark: no backslash processing in code spans. "`a \* b`" keeps \*.
        val a = inline("run `a \\* b` now")
        assertEquals("run a \\* b now", a.text)
    }


    // ── imageLineMatch (standalone `![alt](url)` → real pixels) ────────────────

    @Test fun `image line yields alt and https url, no link`() {
        val m = imageLineMatch("![a cat](https://plugin.tiny.technology/media/x.jpg)")
        assertEquals(Triple("a cat", "https://plugin.tiny.technology/media/x.jpg", null), m)
    }

    @Test fun `image line tolerates surrounding whitespace and empty alt`() {
        val m = imageLineMatch("   ![](https://x.io/y.png)  ")
        assertEquals(Triple("", "https://x.io/y.png", null), m)
    }

    @Test fun `linked image carries both the image url and the href`() {
        val m = imageLineMatch("[![thumb](https://x.io/t.jpg)](https://x.io/full.jpg)")
        assertEquals(Triple("thumb", "https://x.io/t.jpg", "https://x.io/full.jpg"), m)
    }

    @Test fun `non-https image sources are rejected (falls back to text)`() {
        assertNull(imageLineMatch("![local](cat.png)"))
        assertNull(imageLineMatch("![data](data:image/png;base64,AAA)"))
    }

    @Test fun `an image mid-sentence is not a standalone image line`() {
        assertNull(imageLineMatch("look ![x](https://x.io/y.png) here"))
    }

    @Test fun `a plain link is not an image`() {
        assertNull(imageLineMatch("[text](https://x.io)"))
    }
}
