// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hero-logo CLS guard (backlog v3 item 14): the logo slot must reserve its
 * height BEFORE the media loads — the record already says a logo exists, so
 * a dimensionless <img> shoves the hero title down when the bytes land on
 * the page's marquee moment.
 */
describe('hero logo layout stability', () => {
  const chat = readFileSync(join(__dirname, '../components/chat/Chat.tsx'), 'utf8')
  const start = chat.indexOf('{logoUrl && (')
  const block = chat.slice(start, chat.indexOf('{/* Presentational', start))

  it('the logo renders inside a fixed-height slot', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain('h-24') // reserved 96px — matches the old maxHeight
    // media fills the slot instead of sizing it
    expect(block).toContain('max-h-full')
    expect(block).not.toContain('maxHeight: 96')
  })

  it('the image decodes off the main thread', () => {
    expect(block).toContain('decoding="async"')
  })
})
