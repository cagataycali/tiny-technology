/**
 * use_render TUI path — the spec generates REAL Ink elements (components.tsx),
 * rendered here through actual Ink into a capture stream. This is the proof
 * of "proper generation": the same JSON spec that the ANSI fallback paints
 * becomes a live React tree, and both say the same thing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink'
import { EventEmitter } from 'node:events'
import stringWidth from 'string-width'
import { RenderBlock } from '../dist/tui/components.js'

/** Minimal fake TTY stream Ink can render into. */
function makeStdout(columns = 100) {
  const out = new EventEmitter()
  out.columns = columns
  out.rows = 40
  out.isTTY = true
  out.frames = []
  out.write = (s) => { out.frames.push(s); return true }
  return out
}

/**
 * Render a block, unmount, return the last frame with ANSI stripped.
 *
 * `columns` matters: several of these components read useWindowSize and size
 * themselves to the terminal, so 100 and 44 are genuinely different renders.
 */
async function inkRender(element, columns = 100) {
  const stdout = makeStdout(columns)
  const { unmount } = render(element, { stdout, patchConsole: false, exitOnCtrlC: false })
  await new Promise((r) => setTimeout(r, 30)) // one tick for Ink's layout pass
  unmount()
  const joined = stdout.frames.join('')
  return joined.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Rows of a frame that carry table/box verticals — what a squareness check measures. */
const ruled = (out) => out.split('\n').filter((l) => /[│╭╰├]/.test(l))

test('table spec generates an Ink table with headers and aligned cells', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'table', headers: ['name', 'state'], rows: [['mesh', 'on'], ['tui', 'off']] }],
  }))
  assert.match(out, /name/)
  assert.match(out, /│ mesh/)
  assert.match(out, /╭/)
  assert.match(out, /┼/)
})

test('panel spec generates a real Ink border (borderStyle), not painted ANSI', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'panel', title: 'Note', content: 'hello world' }],
  }))
  assert.match(out, /Note/)
  assert.match(out, /hello world/)
  // Ink's round borderStyle glyphs — drawn by Ink from props, proof the
  // border came from the component tree.
  assert.match(out, /╭/)
  assert.match(out, /╰/)
})

test('tree spec nests children with branch glyphs', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'tree', label: 'src', items: ['a', { label: 'b', items: ['c'] }] }],
  }))
  assert.match(out, /src/)
  assert.match(out, /├── a/)
  assert.match(out, /└── c/)
})

test('progress + keyvalue + rule all mount side by side', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    title: 'Report',
    components: [
      { type: 'rule', title: 'STATUS' },
      { type: 'keyvalue', data: { peers: 5, mesh: 'on' } },
      { type: 'progress', description: 'sync', total: 4, completed: 2 },
    ],
  }))
  assert.match(out, /Report/)
  assert.match(out, /STATUS/)
  assert.match(out, /peers.*5/)
  assert.match(out, /50%/)
})

test('a table of emoji cells is still square — columns, not code units', async () => {
  // padEnd counts code units; an emoji is one or two of those and two COLUMNS,
  // so a table padded by `.length` drew its verticals a column off on exactly
  // the rows a user is most likely to paste in.
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{
      type: 'table',
      headers: ['device', 'state'],
      rows: [['🌱 seedling', 'on'], ['plain text', 'off'], ['🎙️ mic', 'on']],
    }],
  }))
  const lines = ruled(out)
  assert.ok(lines.length >= 6, 'the table rendered')
  const widths = new Set(lines.map((l) => stringWidth(l.trimEnd())))
  assert.equal(widths.size, 1, `ragged table — rows measured ${[...widths].join(', ')} columns`)
})

test('a table wider than the terminal clips instead of shredding into wrapped rows', async () => {
  // Wrapping turns one row into two, which desynchronises the rows from the
  // rules between them: what arrives is not a narrower table, it is confetti.
  const wide = Array.from({ length: 8 }, (_, i) => `column-${i}`)
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'table', headers: wide, rows: [wide.map((c) => `${c}-value`)] }],
  }), 44)
  const lines = ruled(out)
  for (const l of lines) {
    assert.ok(stringWidth(l.trimEnd()) <= 44, `row overflowed the terminal: ${JSON.stringify(l)}`)
  }
  assert.equal(lines.length, 5, 'three rules, a header and one body row — nothing wrapped in half')
})

test('a rule spans the terminal it is drawn in, whatever width that is', async () => {
  // The fixed 8 + 40 dashes this replaced were a rule for one terminal: short of
  // the right edge on a wide one, and wrapped onto two lines under 50 columns —
  // the one thing a divider must never do.
  for (const columns of [44, 100]) {
    const out = await inkRender(React.createElement(RenderBlock, {
      components: [{ type: 'rule', title: 'STATUS' }],
    }), columns)
    const line = out.split('\n').find((l) => l.includes('STATUS'))
    assert.ok(line, `no rule at ${columns} columns`)
    assert.equal(stringWidth(line.trimEnd()), columns, `rule is not ${columns} wide`)
  }
})

test('a progress bar keeps its numbers on one row on a narrow terminal', async () => {
  // A fixed 30-column bar plus label plus counts is 60-odd columns, so the row
  // used to wrap and the bar arrived in two pieces. The bar shrinks; the numbers
  // are the information and cannot.
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'progress', description: 'syncing the mesh registry', total: 10, completed: 7 }],
  }), 44)
  const line = out.split('\n').find((l) => l.includes('70%'))
  assert.ok(line, 'the percentage stayed on the same row as the bar')
  assert.match(line, /syncing the mesh registry/)
  assert.match(line, /\(7\/10\)/)
  assert.ok(stringWidth(line.trimEnd()) <= 44, 'and the row fits the terminal')
  assert.match(line, /█+░+/, 'the bar is still a bar, just a shorter one')
})

test('a long keyvalue value truncates instead of breaking the key column', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [{ type: 'keyvalue', data: { peers: 5, note: 'x'.repeat(200), mesh: 'on' } }],
  }), 44)
  const lines = out.split('\n').filter((l) => l.trim())
  assert.ok(lines.some((l) => /peers/.test(l)), 'the pairs rendered')
  assert.equal(lines.filter((l) => l.includes('x')).length, 1, 'the long value took one row')
  for (const l of lines) assert.ok(stringWidth(l.trimEnd()) <= 44, `overflowed: ${JSON.stringify(l)}`)
})

test('unknown component type degrades inline without losing siblings', async () => {
  const out = await inkRender(React.createElement(RenderBlock, {
    components: [
      { type: 'wat' },
      { type: 'text', content: 'still here' },
    ],
  }))
  assert.match(out, /unknown component/)
  assert.match(out, /still here/)
})
