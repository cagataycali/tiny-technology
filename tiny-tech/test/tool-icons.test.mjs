/**
 * Tool chip glyphs — width safety.
 *
 * Ink computes layout with string-width; the terminal draws with its own font.
 * When those disagree by one column, every bordered panel containing that glyph
 * gets a crooked right edge — which is exactly what 🖥 🕸 ✉ ✈ did: all four are
 * Emoji_Presentation=No, so string-width counted 1 while terminals drew 2.
 *
 * The invariant that prevents it coming back: adding VS16 to an icon must not
 * change its measured width. If it does, the glyph is width-ambiguous and needs
 * either the selector baked in or a narrow replacement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'

const { toolIcon, ALL_ICONS } = await import('../dist/tui/tool-icons.js')

const VS16 = '️'

test('no icon is width-ambiguous — panel borders depend on it', () => {
  const bad = []
  for (const icon of ALL_ICONS) {
    const plain = stringWidth(icon)
    const forced = stringWidth(icon.endsWith(VS16) ? icon : icon + VS16)
    if (plain !== forced) {
      bad.push(`${JSON.stringify(icon)} measures ${plain} but ${forced} with VS16`)
    }
  }
  assert.deepEqual(bad, [], `width-ambiguous glyph(s):\n  ${bad.join('\n  ')}`)
})

test('every icon occupies one or two columns and never zero', () => {
  // A zero-width or triple-wide glyph would misalign chips even when consistent.
  for (const icon of ALL_ICONS) {
    const w = stringWidth(icon)
    assert.ok(w === 1 || w === 2, `${JSON.stringify(icon)} is ${w} columns wide`)
  }
})

test('the four glyphs that broke borders carry their selector', () => {
  for (const name of ['use_computer', 'mesh_send', 'use_google', 'use_telegram']) {
    const icon = toolIcon(name)
    assert.ok(icon.endsWith(VS16), `${name} → ${JSON.stringify(icon)} lost its VS16`)
    assert.equal(stringWidth(icon), 2)
  }
})

test('narrow glyphs stay narrow — a selector would be wrong there', () => {
  // ⌘ ✎ ↯ • render as text, not emoji; forcing emoji presentation would make
  // them inconsistent in the other direction.
  assert.equal(stringWidth(toolIcon('bash')), 1)
  assert.equal(stringWidth(toolIcon('fileEditor')), 1)
  assert.equal(stringWidth(toolIcon('httpRequest')), 1)
  assert.equal(stringWidth(toolIcon(undefined)), 1)
})

test('resolution still prefers the exact name over the prefix', () => {
  // use_spotify and use_apple both start with use_, whose prefix icon is the
  // monitor — if the exact table stopped winning they would both go generic.
  assert.equal(toolIcon('use_spotify'), '♫')
  assert.equal(toolIcon('use_apple'), '🍎')
  assert.notEqual(toolIcon('use_spotify'), toolIcon('use_something_else'))
  assert.equal(toolIcon('mesh_broadcast'), toolIcon('mesh_send'))
  assert.equal(toolIcon('my_thing'), '⚡')
  assert.equal(toolIcon(''), '•', 'empty name falls back instead of throwing')
})

test('no entry is blank — a falsy icon leaks to the prefix match', () => {
  // '' is not caught by the width rules and not caught by eyeballing the table;
  // it just quietly makes an exact entry behave as if it were not there.
  for (const icon of ALL_ICONS) {
    assert.notEqual(icon, '', 'blank icon in the table')
  }
})
