/**
 * use_render — pure rendering path (renderComponents → ANSI string).
 * No TTY needed: these run the same code the TUI/REPL/headless surfaces share.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderComponents } from '../dist/agent/render.js'

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('table renders headers, rows and box-drawing borders', () => {
  const out = strip(renderComponents([
    { type: 'table', headers: ['name', 'state'], rows: [['mesh', 'on'], ['tui', 'off']] },
  ]))
  assert.match(out, /name/)
  assert.match(out, /mesh/)
  assert.match(out, /╭/)
  assert.match(out, /┼/) // header separator means the header row registered
})

test('table survives ragged rows (fewer cells than headers)', () => {
  const out = strip(renderComponents([
    { type: 'table', headers: ['a', 'b', 'c'], rows: [['1'], ['1', '2', '3']] },
  ]))
  assert.match(out, /│ 1 +│ +│ +│/)
})

test('tree renders nested branches', () => {
  const out = strip(renderComponents([
    { type: 'tree', label: 'root', items: ['a', { label: 'b', items: ['c'] }] },
  ]))
  assert.match(out, /├── a/)
  assert.match(out, /└── b/)
  assert.match(out, /└── c/) // nested under b, indented
})

test('keyvalue aligns keys', () => {
  const out = strip(renderComponents([
    { type: 'keyvalue', data: { x: 1, longer: 2 } },
  ]))
  const lines = out.split('\n')
  // both values start at the same column because keys are padded
  const col = (l) => l.search(/\d/)
  assert.equal(col(lines[0]), col(lines[1]))
})

test('progress computes percent and never overflows total', () => {
  const out = strip(renderComponents([
    { type: 'progress', description: 'x', total: 10, completed: 25 },
  ]))
  assert.match(out, /100%/)
  assert.match(out, /\(10\/10\)/)
})

test('panel wraps content and closes its borders', () => {
  const out = strip(renderComponents([
    { type: 'panel', title: 'T', content: 'hello' },
  ]))
  assert.match(out, /╭─ T /)
  assert.match(out, /hello/)
  assert.match(out, /╰/)
})

test('a broken component degrades to an inline note, not a throw', () => {
  const out = strip(renderComponents([
    { type: 'table', rows: null }, // renderers coerce; if one ever throws, the catch keeps siblings
    { type: 'text', content: 'still here' },
  ]))
  assert.match(out, /still here/)
})

test('rule centers its title', () => {
  const out = strip(renderComponents([{ type: 'rule', title: 'MID' }]))
  assert.match(out, /─+ MID ─+/)
})
