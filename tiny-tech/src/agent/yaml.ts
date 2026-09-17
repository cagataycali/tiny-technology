/**
 * A YAML reader, because the specs that describe the world's APIs are YAML.
 *
 * `use_openapi` is worth nothing if it can only read JSON: Stripe, GitHub,
 * Kubernetes, Twilio and most hand-written specs ship `.yaml`. devduck reaches
 * for PyYAML and, when it isn't installed, tells you to `pip install pyyaml` —
 * a dead end inside a tool call. tiny-tech must stay `npx`-installable, and
 * Node has no YAML, so this does the reading itself.
 *
 * ⚠️ THIS IS A SUBSET, AND IT SAYS SO OUT LOUD. A half-right YAML parser is
 * worse than none: it hands back a spec that looks fine and is quietly missing
 * half an endpoint. So the rule here is that anything not understood THROWS
 * with a line number, rather than being skipped or guessed at. The subset is
 * everything OpenAPI specs actually contain:
 *
 *   · block mappings and sequences, nested by indentation
 *   · flow collections `[a, b]` / `{a: 1}`, including across lines (Stripe)
 *   · plain, 'single' and "double" quoted scalars (with \u escapes)
 *   · block scalars `|` `>` with chomping (`-`/`+`) and explicit indent
 *   · multi-line plain scalars — how `description:` wraps in real specs
 *   · anchors `&x`, aliases `*x`, and merge keys `<<:` (Kubernetes, Azure)
 *   · `---` documents (the first one; specs have exactly one)
 *   · YAML 1.2 core types: null/~, true/false, ints, floats, .inf/.nan
 *
 * Deliberately NOT supported, and each one throws: tab indentation (the single
 * most common way a YAML file is broken), explicit `? key` mappings, and
 * directives other than a bare `%YAML`. `yes`/`no`/`on`/`off` stay STRINGS —
 * that's YAML 1.2, and a description reading "no" must not become `false`.
 */

export class YamlError extends Error {
  constructor(message: string, public line: number) {
    super(`YAML line ${line + 1}: ${message}`)
    this.name = 'YamlError'
  }
}

interface Line {
  /** Columns before the first non-space character. */
  indent: number
  /** The line with its comment removed and trailing space trimmed. */
  content: string
  /** Untouched, because block scalars keep their own spacing. */
  raw: string
  /** 0-based, for error messages. */
  n: number
}

/**
 * Remove a `#` comment — but only a real one.
 *
 * `#` inside a quoted scalar is data (`description: "issue #42"`), and a `#`
 * glued to a word is data too (`color: '#fff'` unquoted as `#fff` would be a
 * comment, but `a#b` is the string `a#b`). YAML's rule: a comment starts at a
 * `#` that begins the line or follows whitespace, outside quotes.
 */
function stripComment(s: string): string {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue }
      if (c === quote) {
        // '' inside a single-quoted scalar is an escaped quote, not the end.
        if (quote === "'" && s[i + 1] === "'") { i++; continue }
        quote = null
      }
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

function scan(text: string): Line[] {
  const out: Line[] = []
  const raws = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let n = 0; n < raws.length; n++) {
    const raw = raws[n]
    const indent = raw.length - raw.replace(/^ +/, '').length
    // A tab in the indentation is illegal YAML and the reason for most
    // "why won't my spec load" — name it instead of parsing something else.
    if (/^ *\t/.test(raw)) throw new YamlError('tab indentation is not valid YAML', n)
    out.push({ indent, content: stripComment(raw).trimEnd().slice(indent), raw, n })
  }
  return out
}

const SEQ = /^-(\s|$)/

/** Strip a `!!str` / `!Custom` tag: we keep the value, not the type. */
function stripTag(s: string): string {
  return s.replace(/^!(?:!)?[^\s]*\s*/, '')
}

/**
 * Where a mapping key ends — the first `:` at flow level 0, outside quotes,
 * followed by a space or end of line. `{a: 1}` and `http://x` must not match,
 * and `"a: b": 1` has its colon inside the quotes.
 */
function splitKey(content: string): { key: string; rest: string } | null {
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue }
      if (c === quote) { if (quote === "'" && content[i + 1] === "'") { i++; continue } quote = null }
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') { depth++; continue }
    if (c === ']' || c === '}') { depth--; continue }
    if (c === ':' && depth === 0 && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      return { key: content.slice(0, i).trim(), rest: content.slice(i + 1).trim() }
    }
  }
  return null
}

const UNESCAPE: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', '/': '/', ' ': ' ', e: '\x1b',
}

function unquote(s: string, line: number): string {
  const body = s.slice(1, -1)
  if (s[0] === "'") return body.replace(/''/g, "'")
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue }
    const c = body[++i]
    if (c === 'u' || c === 'U' || c === 'x') {
      const len = c === 'x' ? 2 : c === 'u' ? 4 : 8
      const hex = body.slice(i + 1, i + 1 + len)
      if (hex.length < len || /[^0-9a-fA-F]/.test(hex)) throw new YamlError(`bad \\${c} escape`, line)
      out += String.fromCodePoint(parseInt(hex, 16))
      i += len
      continue
    }
    if (c === '\n') continue                     // escaped newline folds away
    if (c in UNESCAPE) { out += UNESCAPE[c]; continue }
    throw new YamlError(`unknown escape \\${c}`, line)
  }
  return out
}

/**
 * Where a quoted scalar closes, or -1 if the line leaves it open.
 *
 * A quoted scalar may run over several lines, and OpenAI's spec has ~200 of
 * them: `description: "Anchor timestamp…` wrapping onto the next line. Reading
 * only the first line leaves the rest looking like stray indentation.
 */
function quoteClose(s: string): number {
  const q = s[0]
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (q === '"' && c === '\\') { i++; continue }
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue }      // '' is one quote
      return i
    }
  }
  return -1
}

/** A line ending in an ODD number of backslashes — the last one escapes the break. */
const ESCAPED_BREAK = /(?:^|[^\\])(?:\\\\)*\\$/

/** Does this value START a quoted scalar that its own line doesn't finish? */
function opensQuote(s: string): boolean {
  return (s[0] === '"' || s[0] === "'") && quoteClose(s) < 0
}

/**
 * A plain scalar's type, YAML 1.2 core schema.
 *
 * Note what is NOT here: `yes`, `no`, `on`, `off`, `y`, `n`. YAML 1.1 made
 * those booleans, which is how `answer: no` becomes `false` and a spec's
 * description silently changes meaning. 1.2 dropped them; so do we.
 */
export function parseScalar(text: string, line = 0): unknown {
  const s = text.trim()
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if ((s[0] === '"' && s.endsWith('"') && s.length > 1) || (s[0] === "'" && s.endsWith("'") && s.length > 1)) {
    return unquote(s, line)
  }
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16)
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8)
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN
  return s
}

class Parser {
  i = 0
  /** Not private: readFlow needs it, because `[*base]` is an alias too. */
  anchors = new Map<string, unknown>()

  /** `finalNewline` decides whether a block scalar that runs to the end of the
   *  file ends in a line break — clip chomping keeps the source's newline, and
   *  a file that stops mid-line has none to keep. */
  constructor(private lines: Line[], private finalNewline = true) {}

  private get cur(): Line | undefined { return this.lines[this.i] }

  private skipBlank(): void {
    while (this.i < this.lines.length && this.lines[this.i].content === '') this.i++
  }

  /** `---` / `...` — we read the first document and stop. */
  private atDocBreak(): boolean {
    const c = this.cur?.content
    return c === '---' || c === '...' || !!c?.startsWith('--- ')
  }

  parse(): unknown {
    this.skipBlank()
    while (this.cur && /^%/.test(this.cur.content)) {
      if (!/^%YAML/.test(this.cur.content)) throw new YamlError(`unsupported directive ${this.cur.content}`, this.cur.n)
      this.i++
      this.skipBlank()
    }
    if (this.cur?.content === '---') { this.i++; this.skipBlank() }
    if (!this.cur) return null
    return this.node(this.cur.indent)
  }

  /** Any node at `indent`: sequence, mapping, or scalar. */
  private node(indent: number): unknown {
    this.skipBlank()
    const L = this.cur
    if (!L || L.indent < indent || this.atDocBreak()) return null
    if (SEQ.test(L.content)) return this.seq(indent)
    if (L.content.startsWith('? ')) throw new YamlError('explicit `? key` mappings are not supported', L.n)
    if (splitKey(L.content)) return this.map(indent)
    return this.value(L.content, indent, L.n)
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (;;) {
      this.skipBlank()
      const L = this.cur
      if (!L || L.indent < indent || this.atDocBreak() || SEQ.test(L.content)) break
      if (L.indent > indent) throw new YamlError('unexpected indentation inside a mapping', L.n)
      if (L.content.startsWith('? ')) throw new YamlError('explicit `? key` mappings are not supported', L.n)
      const kv = splitKey(L.content)
      if (!kv) throw new YamlError(`expected "key: value", got ${JSON.stringify(L.content)}`, L.n)
      const key = kv.key
      const value = this.value(kv.rest, indent, L.n)
      // `<<: *base` (or a list of them) merges another mapping in, with the
      // keys already written here winning — that's the spec's precedence.
      if (key === '<<') {
        for (const src of Array.isArray(value) ? value : [value]) {
          if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v
        }
        continue
      }
      out[String(parseScalar(key, L.n) ?? key)] = value
    }
    return out
  }

  private seq(indent: number): unknown[] {
    const out: unknown[] = []
    for (;;) {
      this.skipBlank()
      const L = this.cur
      if (!L || L.indent < indent || this.atDocBreak() || !SEQ.test(L.content)) break
      if (L.indent > indent) throw new YamlError('unexpected indentation inside a sequence', L.n)
      const after = L.content.slice(1)
      const rest = after.trim()
      if (rest === '') { this.i++; out.push(this.child(indent)); continue }
      // `- name: x` and `- - a` continue at the column the item's content
      // starts on, so the line is re-labelled with that indent and handed to
      // the normal map/seq parser — subsequent lines line up under it.
      const col = L.indent + 1 + (after.length - after.trimStart().length)
      this.lines[this.i] = { ...L, indent: col, content: rest }
      if (SEQ.test(rest)) out.push(this.seq(col))
      else if (splitKey(rest)) out.push(this.map(col))
      // A multi-line scalar's continuation is measured against the DASH's
      // column, not the item's: `- >-` with its text one space in is deeper
      // than the dash and NOT deeper than the item, so re-labelling would read
      // an empty scalar and then trip over the text as stray indentation.
      // (Stripe's spec does this ~200 times for long enum values; it was line
      // 23659 that said so.)
      else {
        const wraps = /^(?:&\S+\s+)?[|>]/.test(rest) || opensQuote(rest)
        out.push(this.value(rest, wraps ? L.indent : col, L.n))
      }
    }
    return out
  }

  /** The block that belongs to a key with nothing after its colon. */
  private child(parentIndent: number): unknown {
    this.skipBlank()
    const L = this.cur
    if (!L || this.atDocBreak()) return null
    if (L.indent > parentIndent) return this.node(L.indent)
    // A sequence may sit at the SAME column as its key — legal, and how most
    // specs write `tags:` / `servers:`.
    if (L.indent === parentIndent && SEQ.test(L.content)) return this.seq(L.indent)
    return null
  }

  /**
   * Everything that can follow `key:` on one line — consuming that line, and
   * whatever continuation lines the value owns.
   */
  private value(text: string, parentIndent: number, line: number): unknown {
    this.i++
    let rest = stripTag(text.trim())
    let anchor: string | undefined
    const am = /^&(\S+)\s*/.exec(rest)
    if (am) { anchor = am[1]; rest = stripTag(rest.slice(am[0].length).trim()) }

    let value: unknown
    if (rest === '') value = this.child(parentIndent)
    else if (rest[0] === '|' || rest[0] === '>') value = this.blockScalar(rest, parentIndent, line)
    else if (rest[0] === '*') {
      const name = rest.slice(1).trim()
      if (!this.anchors.has(name)) throw new YamlError(`unknown alias *${name}`, line)
      value = this.anchors.get(name)
    } else if (rest[0] === '[' || rest[0] === '{') value = this.flow(rest, line)
    else if (opensQuote(rest)) value = this.quoted(rest, parentIndent, line)
    else value = this.plain(rest, parentIndent, line)

    if (anchor) this.anchors.set(anchor, value)
    return value
  }

  /** `|`, `|-`, `>+`, `|2` … — the only place raw indentation matters. */
  private blockScalar(header: string, parentIndent: number, line: number): string {
    const m = /^([|>])([-+]?)(\d*)([-+]?)\s*$/.exec(header)
    if (!m) throw new YamlError(`bad block scalar header ${JSON.stringify(header)}`, line)
    const folded = m[1] === '>'
    const chomp = (m[2] || m[4] || '') as '' | '-' | '+'
    const explicit = m[3] ? Number(m[3]) : 0

    const body: string[] = []
    let blockIndent = explicit ? parentIndent + explicit : 0
    while (this.i < this.lines.length) {
      const L = this.lines[this.i]
      // A whitespace-only line is EMPTY only up to the block's indentation.
      // Anything past it is content — that's how a `>` code sample keeps the
      // blank line between two statements instead of closing the paragraph.
      // Before the first real line the indent is unknown, so it can only be empty.
      const blank = L.raw.trim() === '' && (!blockIndent || L.raw.length <= blockIndent)
      if (!blank) {
        if (L.indent <= parentIndent) break
        if (!blockIndent) blockIndent = L.indent      // first real line sets it
        if (L.indent < blockIndent) break
      }
      body.push(blank ? '' : L.raw.slice(blockIndent))
      this.i++
    }
    let trailingBlanks = 0
    while (body.length && body[body.length - 1] === '') { body.pop(); trailingBlanks++ }

    let text: string
    if (!folded) text = body.join('\n')
    else {
      // Folding, per line break rather than per line, because the two rules
      // interact: n blank lines contribute n newlines, and a break touching a
      // MORE-indented line is literal (that's how a code sample inside a `>`
      // survives) — so a blank line between two indented lines keeps BOTH
      // breaks. Reading `\n` for the pair is how OpenAI's JavaScript examples
      // came back with a line missing.
      let out = ''
      let prev: string | null = null
      let blanks = 0
      for (const l of body) {
        if (l === '') { blanks++; continue }
        if (prev === null) out += '\n'.repeat(blanks) + l
        else {
          const literal = /^\s/.test(l) || /^\s/.test(prev)
          out += blanks ? '\n'.repeat(blanks) + (literal ? '\n' : '') : (literal ? '\n' : ' ')
          out += l
        }
        prev = l
        blanks = 0
      }
      text = out
    }
    // At the end of the file, the last line's newline is the scan's phantom
    // blank — it's the source's line terminator, not a blank line in the text.
    const atEof = this.i >= this.lines.length
    if (atEof && this.finalNewline && trailingBlanks > 0) trailingBlanks--
    if (chomp === '-') return text                                     // strip: nothing
    // keep: the last line's own break plus every blank — but a block with no
    // content at all (`example: |+` over one empty line) has only the blanks.
    if (chomp === '+') return text + '\n'.repeat((text === '' ? 0 : 1) + trailingBlanks)
    if (text === '') return ''
    return atEof && !this.finalNewline ? text : text + '\n'            // clip: exactly one
  }

  /** A flow collection, which may run over several lines until it balances. */
  private flow(first: string, line: number): unknown {
    let text = first
    let depth = flowDepth(text)
    while (depth > 0 && this.i < this.lines.length) {
      const L = this.lines[this.i]
      this.i++
      text += ' ' + L.content
      depth += flowDepth(L.content)
    }
    if (depth !== 0) throw new YamlError('unterminated flow collection', line)
    const r = readFlow(text, 0, line, this.anchors)
    const tail = text.slice(r.next).trim()
    if (tail) throw new YamlError(`trailing content after flow collection: ${JSON.stringify(tail)}`, line)
    return r.value
  }

  /**
   * A plain scalar, folded over its continuation lines.
   *
   * This is how `summary:` wraps in a hand-written spec, and getting it wrong
   * means the rest of the sentence is parsed as YAML and usually explodes.
   */
  /**
   * A quoted scalar that wraps onto later lines.
   *
   * Continuation lines are read RAW, not from the comment-stripped content: a
   * `#` inside a quoted string is data, and the per-line comment stripper can't
   * know it's inside a quote that opened on an earlier line.
   */
  private quoted(first: string, parentIndent: number, line: number): string {
    const raws = [first]
    let joined = first
    let end = quoteClose(joined)
    while (end < 0) {
      const L = this.cur
      if (!L) throw new YamlError('unterminated quoted string', line)
      const blank = L.raw.trim() === ''
      // A blank line inside a quoted scalar is a paragraph break, not the end
      // of the value — but a LESS-indented non-blank line means the quote was
      // never closed, and guessing where it ended would corrupt the document.
      if (!blank && L.indent <= parentIndent) throw new YamlError('unterminated quoted string', line)
      raws.push(L.raw.trim())
      this.i++
      joined = raws.join('\n')
      end = quoteClose(joined)
    }
    const parts = joined.slice(0, end + 1).split('\n')
    // Same folding as a plain scalar: one break is a space, a blank line is a
    // break. Anything after the closing quote (a comment) is dropped with it.
    let folded = parts[0]
    for (let k = 1; k < parts.length; k++) {
      // In a DOUBLE-quoted scalar a trailing `\` escapes the line break: the
      // break and the next line's indentation both disappear. OpenAI's spec
      // wraps long `$ref` targets this way, and folding that break to a space
      // puts a space inside the identifier — a ref that resolves to nothing.
      if (first[0] === '"' && ESCAPED_BREAK.test(folded)) { folded = folded.slice(0, -1) + parts[k]; continue }
      folded += parts[k] === '' ? '\n' : (parts[k - 1] === '' ? '' : ' ') + parts[k]
    }
    return unquote(folded, line)
  }

  private plain(first: string, parentIndent: number, line: number): unknown {
    const parts = [first]
    for (;;) {
      const L = this.cur
      if (!L) break
      if (L.content === '') {
        // A blank line could end the scalar or be a paragraph break inside it.
        const after = this.lines[this.i + 1]
        if (!after || after.indent <= parentIndent || after.content === '') break
        parts.push('')
        this.i++
        continue
      }
      if (L.indent <= parentIndent || SEQ.test(L.content) || splitKey(L.content) || this.atDocBreak()) break
      parts.push(L.content)
      this.i++
    }
    if (parts.length === 1) return parseScalar(first, line)
    let text = parts[0]
    for (let k = 1; k < parts.length; k++) text += parts[k] === '' ? '\n' : (parts[k - 1] === '' ? '' : ' ') + parts[k]
    return text
  }
}

/** Net bracket depth of a chunk, ignoring brackets inside quotes. */
function flowDepth(s: string): number {
  let quote: string | null = null
  let d = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue }
      if (c === quote) { if (quote === "'" && s[i + 1] === "'") { i++; continue } quote = null }
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') d++
    else if (c === ']' || c === '}') d--
  }
  return d
}

/**
 * `[a, {b: 1}]` — JSON-shaped, but keys and values may be unquoted, and an
 * alias `*base` inside a flow collection is still an alias. `anchors` is the
 * document's table; without it `list: [*b]` came back as the string `"*b"`,
 * which is exactly the class of quiet wrongness this parser must not have.
 */
function readFlow(s: string, at: number, line: number, anchors?: Map<string, unknown>): { value: unknown; next: number } {
  let i = at
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  ws()
  // `&name` in front of anything in a flow collection anchors it.
  let anchor: string | undefined
  const am = /^&(\S+)\s*/.exec(s.slice(i))
  if (am) { anchor = am[1]; i += am[0].length }
  const remember = (v: unknown) => { if (anchor && anchors) anchors.set(anchor, v); return v }
  const open = s[i]
  if (open === '[' || open === '{') {
    const close = open === '[' ? ']' : '}'
    i++
    const arr: unknown[] = []
    const obj: Record<string, unknown> = {}
    for (;;) {
      ws()
      if (i >= s.length) throw new YamlError('unterminated flow collection', line)
      if (s[i] === close) { i++; break }
      if (s[i] === ',') { i++; continue }
      if (open === '[') {
        const r = readFlow(s, i, line, anchors)
        i = r.next
        arr.push(r.value)
      } else {
        // A key is a plain or quoted token up to the `:`.
        const start = i
        let quote: string | null = null
        while (i < s.length) {
          const c = s[i]
          if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = null; i++; continue }
          if (c === '"' || c === "'") { quote = c; i++; continue }
          if (c === ':' || c === ',' || c === close) break
          i++
        }
        const key = String(parseScalar(s.slice(start, i).trim(), line))
        if (s[i] !== ':') { obj[key] = null; continue }   // `{a, b}` — a set
        i++
        const r = readFlow(s, i, line, anchors)
        i = r.next
        obj[key] = r.value
      }
    }
    return { value: remember(open === '[' ? arr : obj), next: i }
  }
  // A scalar inside a flow collection: ends at `,` or the closing bracket.
  const start = i
  let quote: string | null = null
  while (i < s.length) {
    const c = s[i]
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = null; i++; continue }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c === ',' || c === ']' || c === '}') break
    i++
  }
  const token = s.slice(start, i).trim()
  if (token[0] === '*') {
    const name = token.slice(1)
    if (!anchors?.has(name)) throw new YamlError(`unknown alias *${name}`, line)
    return { value: anchors.get(name), next: i }
  }
  return { value: remember(parseScalar(token, line)), next: i }
}

/**
 * Parse a YAML document. Throws YamlError (with a line number) on anything the
 * subset doesn't cover — never returns a half-read document.
 */
export function parseYaml(text: string): unknown {
  return new Parser(scan(text), text.endsWith('\n')).parse()
}

/**
 * JSON first, then YAML — for content whose format we're told rather than
 * shown. Every OpenAPI spec is one or the other, and JSON *is* YAML, but the
 * JSON path is both faster and exactly right, so it goes first.
 */
export function parseJsonOrYaml(text: string, source = ''): unknown {
  try { return JSON.parse(text) } catch { /* not JSON, try YAML */ }
  try { return parseYaml(text) } catch (e: any) {
    throw new Error(`could not parse ${source || 'content'} as JSON or YAML — ${e?.message || e}`)
  }
}
