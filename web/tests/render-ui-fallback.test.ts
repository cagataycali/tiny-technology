/**
 * The render_ui card, across all three clients.
 *
 * 🏷️ THE DEFECT: iOS's `parseRenderUi` only kept an array-of-objects if
 * `chartPoints` succeeded — which needs ≥2 rows AND a column that is numeric in
 * every one of them. So an ordinary record list, `{"data":[{"name":"a","status":
 * "ok"},{"name":"b","status":"fail"}]}`, charted nothing, was skipped by the
 * key/value path (which drops container values), and landed on `.empty` — whose
 * card read "Interactive version on the web app" beside a safari glyph.
 *
 * Two claims in one sentence, neither the app's to make:
 *   1. that it could not draw the payload — it was holding the rows, and android
 *      had a fallback for exactly this case, with a comment saying "iOS drops it";
 *   2. that a richer version was waiting on the web. For a native session
 *      `renderUiNativeTool` makes props REQUIRED and documents componentCode as
 *      "Ignored on this client — omit it", and `RenderUiItem` carries only
 *      id/title/propsJson. The app never receives the React source, so it cannot
 *      know a web rendering of this payload exists — and when the model followed
 *      the contract, it does not.
 *
 * The same sentence was on the voice path, spoken aloud: `voiceRenderUi`
 * returned "the card is now visible in the chat — mention it briefly out loud"
 * for props that resolved to `.empty`, in the one mode where the user is
 * listening and cannot see that nothing arrived. (Web fixed its twin of this by
 * gating the same claim on its compiler — lib/chat/ui-code.ts.)
 *
 * Swift tests prove the parse truth table. What they CANNOT prove is that the
 * tool contract still says what this fix leans on, or that the two native
 * clients still agree — those are source-level, cross-language properties, and
 * this is where they live.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Source with comments stripped. Mandatory: both fixed files quote the old
 *  copy in their own prose to explain the history, so a naive grep for the
 *  sentence finds the explanation and calls the defect live. (Inc 24 learned
 *  this the hard way — a prose-grep test fails on its own documentation.) */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

/** The body of `name`'s brace-balanced block, from its declaration line. */
function braced(src: string, name: string): string {
  const at = src.indexOf(name)
  if (at < 0) throw new Error(`not found: ${name}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced: ${name}`)
}

const IOS = 'ios/Tiny/Sources/RenderUi.swift'
const VIEWS = 'ios/Tiny/Sources/Views.swift'
const KOTLIN = 'android/app/src/main/java/technology/tiny/app/ui/RenderUi.kt'
const TOOL = 'lib/chat/tools/client-side.ts'
const DECODER = 'ios/Tiny/Sources/ChatStreamDecoder.swift'

// ── the premise the whole fix rests on ────────────────────────────────────
// If the tool contract changes, the honest copy changes with it, and it is this
// block that must say so first.

describe('what the native clients are actually sent', () => {
  const tool = read(TOOL)

  it('the native tool requires props and tells the model to omit componentCode', () => {
    const native = tool.slice(tool.indexOf('renderUiNativeTool'))
    // props is REQUIRED (no .optional()) — the data has to arrive as data.
    expect(native).toMatch(/props: z\.record\(z\.any\(\), z\.any\(\)\)\.describe/)
    expect(native).toMatch(/componentCode: z\.string\(\)\.optional\(\)[\s\S]*?Ignored on this client/)
  })

  it('so a native card CANNOT have a web version to point at', () => {
    // The decoder builds the item from `props` alone, and RenderUiItem has no
    // field for the React source. Nothing downstream can check the claim,
    // which is the whole reason it must not be made.
    const item = braced(code(IOS), 'struct RenderUiItem')
    expect(item).not.toContain('componentCode')
    expect(item).toMatch(/let propsJson: String/)
    expect(code(DECODER)).toContain('propsJson: Self.jsonString(input?["props"])')
    expect(code(DECODER)).not.toContain('componentCode')
  })
})

// ── iOS: rows that don't chart are still rows ─────────────────────────────

describe('iOS draws the rows it is holding', () => {
  const src = code(IOS)

  it('a non-charting candidate falls back to a table, not to nothing', () => {
    const fn = braced(src, 'func parseRenderUi')
    expect(fn).toMatch(/if let rows = candidates\.first, let t = tableFromRows\(rows\) \{ return t \}/)
    // …and BEFORE the scalar key/value path, like android: the array is the
    // data, loose scalars beside it are usually the caption.
    expect(fn.indexOf('tableFromRows(rows)')).toBeLessThan(fn.indexOf('let kvs = dict.compactMap'))
  })

  it('the chart loop still runs first, so a chartable candidate wins', () => {
    const fn = braced(src, 'func parseRenderUi')
    expect(fn.indexOf('if let (points, series) = chartPoints(rows)'))
      .toBeLessThan(fn.indexOf('tableFromRows(rows)'))
  })

  it('the top-level array path gets the same fallback', () => {
    const fn = braced(src, 'func parseRenderUi')
    const tail = fn.slice(fn.indexOf('if let rows = obj as? [[String: Any]]'))
    expect(tail).toMatch(/if let t = tableFromRows\(rows\) \{ return t \}/)
  })

  it('columns are the sorted union of the rows keys, and capped like the table path', () => {
    const fn = braced(src, 'private func tableFromRows')
    expect(fn).toContain('keys.formUnion(row.keys)')
    // Sorted, because a Swift Dictionary has no order: unsorted, the same
    // payload would draw different columns from launch to launch.
    expect(fn).toMatch(/keys\.sorted\(\)\.prefix\(6\)/)
    expect(fn).toMatch(/rows\.prefix\(30\)/)
    // No key-name guessing anywhere in it — that is android's approach, and it
    // is the lossy one (see the parity test below).
    for (const guess of ['"label"', '"name"', '"value"', '"y"', '"count"']) {
      expect(fn).not.toContain(guess)
    }
  })

  it('one stringifier for both table paths, so cells cannot diverge', () => {
    expect(braced(src, 'private func cellString')).toMatch(/guard let cell, !\(cell is NSNull\) else \{ return "" \}/)
    expect(braced(src, 'private func parseTable')).toContain('cellString(')
    expect(braced(src, 'private func tableFromRows')).toContain('cellString(')
  })
})

// ── iOS: what the empty card says ─────────────────────────────────────────

describe('neither native client promises a web version it cannot see', () => {
  it('iOS says only what it knows, without a browser glyph', () => {
    const src = code(IOS)
    // 🏷️ THE COPY, byte for byte. It cannot come back without failing here.
    expect(src).not.toContain('Interactive version on the web app')
    expect(src).not.toContain('systemImage: "safari"')
    expect(src).toContain('Label("No data in this card", systemImage: "square.dashed")')
  })

  it('android says the same thing, since it is sent the same payload', () => {
    const k = code(KOTLIN)
    expect(k).not.toContain('Interactive version on the web app')
    expect(k).toContain('"No data in this card"')
    // The globe icon went with the sentence; an unchanged import would leave a
    // dead dependency pointing at the old claim.
    expect(k).not.toContain('Icons.Outlined.Public')
    expect(k).not.toContain('icons.outlined.Public')
  })
})

// ── iOS: what the voice tool is allowed to claim ──────────────────────────

describe('the spoken claim is gated on what actually drew', () => {
  const views = code(VIEWS)
  const fn = braced(views, 'func voiceRenderUi')

  it('an undrawable card is refused instead of announced', () => {
    expect(fn).toMatch(/let content = parseRenderUi\(propsJson\)/)
    expect(fn).toMatch(/if let refusal = renderUiRefusal\(content\) \{ return \["ok": false, "error": refusal\] \}/)
    // Gated BEFORE the append and before a bubble is started — a refused card
    // must leave no trace in the transcript.
    expect(fn.indexOf('renderUiRefusal')).toBeLessThan(fn.indexOf('voiceAssistantStarted'))
    expect(fn.indexOf('renderUiRefusal')).toBeLessThan(fn.indexOf('ui.append'))
  })

  it('the refusal tells the agent not to say a card is on screen', () => {
    // Without this the model apologises and moves on — or worse, describes the
    // card anyway. The user is listening; they cannot see that it never came.
    const refusal = braced(code(IOS), 'func renderUiRefusal')
    expect(refusal).toContain('No card was added')
    expect(refusal).toContain('do not say one is on screen')
    // …and it names the shapes that DO draw, so the retry has somewhere to go.
    expect(refusal).toMatch(/columns,rows/)
  })

  it('the success note names the shape that drew', () => {
    // "here's the chart" over a table is the same mistake one size smaller.
    expect(fn).toContain('"the \\(renderUiShapeName(content)) card is now visible in the chat')
    const names = braced(code(IOS), 'func renderUiShapeName')
    for (const w of ['"chart"', '"key/value"', '"list"', '"text"', '"table"', '"empty"']) {
      expect(names).toContain(w)
    }
  })
})

// ── the other clients ─────────────────────────────────────────────────────

describe('the three clients agree', () => {
  it('android keeps a non-charting candidate too — the parity iOS now has', () => {
    const k = code(KOTLIN)
    const fn = braced(k, 'internal fun classifyRenderUi')
    expect(fn).toContain('candidates.firstOrNull { chartPoints(it) != null }')
    expect(fn).toContain('candidates.firstOrNull()?.let { rows -> tableFromRows(rows)?.let { return it } }')
    expect(fn.indexOf('chartPoints(it) != null')).toBeLessThan(fn.indexOf('candidates.firstOrNull()?.let'))
  })

  it('android orders the row fallback ahead of the scalar key/value path, like iOS', () => {
    const fn = braced(code(KOTLIN), 'internal fun classifyRenderUi')
    expect(fn.indexOf('candidates.firstOrNull()?.let')).toBeLessThan(fn.indexOf('RenderContent.KeyValues(pairs)'))
  })

  it('android gets the same fallback on a top-level array', () => {
    const fn = braced(code(KOTLIN), 'internal fun classifyRenderUi')
    const tail = fn.slice(fn.indexOf('JSONArray(propsJson)'))
    expect(tail).toContain('if (chartPoints(rows) != null) return RenderContent.Chart(rows)')
    expect(tail).toContain('tableFromRows(rows)?.let { return it }')
    // …and still ahead of the string-list path, which can never match objects.
    expect(tail.indexOf('tableFromRows')).toBeLessThan(tail.indexOf('RenderContent.StringList'))
  })

  /**
   * WAS `it.fails`, FLAGGED BY THE iOS INCREMENT — now fixed on android, so the
   * marker is gone and this asserts the property directly.
   *
   * Android's DataRows fallback guessed the label key (label|name|x) and the
   * value key (value|y|count). For `{"name":"a","status":"ok"}` that drew "a"
   * with a BLANK second column — `status`, the only thing the row was about, was
   * silently dropped. For `{"foo":"bar"}` it drew a row of two empty strings: a
   * visible, contentless line. Both now go through tableFromRows.
   */
  it('android draws every column of a non-charting row — no key-name guessing', () => {
    const k = code(KOTLIN)
    // Everything EXCEPT the {items:[…]} path, whose alias chain is deliberate and
    // mirrors iOS's firstString(label/title/name/text). Excluded by name so the
    // check still spans the whole row path — a guess merely MOVED out of DataRows
    // into a helper the same rows flow through would still be caught.
    const items = braced(k, 'private fun ItemList')
    const rowPath = k.replace(items, '')
    // 🏷️ The guesses, byte for byte.
    for (const guess of ['"label"', '"name"', '"x"', '"value"', '"y"', '"count"']) {
      expect(rowPath, `a key-name guess is back in the row path: ${guess}`)
        .not.toContain(`optString(${guess})`)
    }
    for (const guess of ['"value"', '"y"', '"count"']) {
      expect(rowPath, `a value-key guess is back: ${guess}`).not.toContain(`e.opt(${guess})`)
    }
    // DataRows now only ever draws a chart: RenderContent.Chart is produced ONLY
    // when chartPoints already succeeded, so a non-charting branch here would be
    // unreachable code that could silently start guessing again.
    expect(braced(k, 'private fun DataRows')).toMatch(/chartPoints\(entries\) \?: return/)
    // And the rows reach a composable at all — a case with no arm draws nothing,
    // which is the blank card this whole commit is about.
    expect(braced(k, 'fun RenderUiCard')).toContain('is RenderContent.Rows -> KeyedTable(')
  })

  it('android heads the table with the rows own keys, sorted, unioned and capped', () => {
    const fn = braced(code(KOTLIN), 'private fun tableFromRows')
    // sortedSet = the sorted union in one step; org.json key order is a hash
    // order, so unsorted the same payload draws different columns per launch.
    expect(fn).toContain('sortedSetOf<String>()')
    expect(fn).toContain('row.keys().forEach { keys.add(it) }')
    expect(fn).toContain('keys.take(RENDER_TABLE_COLS)')
    expect(fn).toContain('rows.take(RENDER_TABLE_ROWS)')
    // Empty header → null, or a Rows with no columns renders a blank surface
    // dressed as a table.
    expect(fn).toContain('if (columns.isEmpty()) return null')
    const k = code(KOTLIN)
    expect(k).toMatch(/RENDER_TABLE_COLS = 6/)
    expect(k).toMatch(/RENDER_TABLE_ROWS = 30/)
  })

  it('the kotlin truth table asserts the CELLS, not just the shape', () => {
    // ⚠️ The Kotlin suite cannot police itself: weakening an assertion inside it
    // can never redden the gate that RUNS it. So this reads it as a surface.
    // (Measured: `assertEquals(listOf(listOf("a","ok"),…), c.rows)` → `assertEquals(2,
    // c.rows.size)` was the one mutant of 15 that survived until this test existed.)
    const t = code('android/app/src/test/java/technology/tiny/app/ui/RenderUiTest.kt')
    // 🏷️ The defect's own test. A `Rows` whose cells are all BLANK satisfies
    // `is RenderContent.Rows` and renders an empty table — which is the old bug
    // exactly, so the case alone proves nothing. The cells are the assertion.
    const defect = braced(t, 'a record list keeps EVERY column')
    expect(defect).toContain('assertEquals(listOf("name", "status"), c.columns)')
    expect(defect, 'the defect test stopped checking the cells')
      .toContain('assertEquals(listOf(listOf("a", "ok"), listOf("b", "fail")), c.rows)')
    // The two cell-level properties a header-only assertion would hide: a blank
    // for a missing key (not a left-shift under the wrong header), and a blank —
    // not "null" — for org.json's explicit-null sentinel.
    expect(braced(t, 'columns are the sorted UNION'))
      .toContain('assertEquals(listOf(listOf("", "1", ""), listOf("2", "", "3")), c.rows)')
    expect(braced(t, 'a JSON null cell is blank'))
      .toContain('assertEquals(listOf(listOf("a", "")), (c as RenderContent.Rows).rows)')
    // …and no Rows test anywhere settles for the case alone.
    for (const block of t.split('@Test fun ').slice(1)) {
      if (!block.includes('RenderContent.Rows')) continue
      const name = block.slice(0, block.indexOf('`(', 1) + 1)
      expect(block, `${name} asserts the Rows case but no columns or cells`)
        .toMatch(/assertEquals\(\s*(listOf|\d+, c\.(columns|rows))/)
    }
  })

  it('both native clients stringify a table cell in ONE place', () => {
    // Android's second table path used `cell?.toString().orEmpty()`, and org.json
    // hands back the JSONObject.NULL sentinel for an explicit null — whose
    // toString() is the word "null". iOS blanks it; android printed it.
    const k = code(KOTLIN)
    // ⚠️ NOT braced(): cellString has an expression body, so the first `{` after
    // its name belongs to the NEXT function — the pin would silently assert
    // against tableFromRows and pass or fail for the wrong reason.
    expect(k).toMatch(/fun cellString\(cell: Any\?\): String =\s*\n?\s*if \(cell == null \|\| cell == JSONObject\.NULL\) "" else cell\.toString\(\)/)
    expect(braced(k, 'private fun SimpleTable')).toContain('cellString(cell)')
    expect(braced(k, 'private fun tableFromRows')).toContain('cellString(row.opt(it))')
    expect(braced(k, 'private fun SimpleTable'), 'a raw toString() bypasses the null sentinel')
      .not.toContain('cell?.toString()')
  })

  it('web is unaffected: it still evaluates componentCode', () => {
    // The web client is the one that CAN run the React source, which is why the
    // sentence was written in the first place — it was just never true of a
    // native payload.
    expect(read('lib/chat/tools/client-side.ts')).toMatch(/componentCode: z\.string\(\)\.describe/)
  })
})
