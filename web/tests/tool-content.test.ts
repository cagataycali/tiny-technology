// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { unwrapToolContent } from '../lib/chat/tool-content'

/**
 * The SSE decode boundary for tool results. A tool return lands on the wire as a
 * Strands ToolResultBlock content array — an object as `[{json:{...}}]`, a string
 * as `[{text:"..."}]`. Web reads structured fields off `tool.result` as a FLAT
 * object (PayReceipt `.requires_confirmation`/`.ok`, TaskTree `.results`), so a
 * missing unwrap silently reads those off the ARRAY → undefined. The most visible
 * failure: a valid pay_x402 quote (`ok:true, requires_confirmation:true, quote`)
 * renders the DANGER "Payment not sent" card and the Approve gate never appears.
 * These pin the unwrap the native clients already do (iOS firstToolJson / Android).
 */
describe('unwrapToolContent — flatten a Strands tool-result content array', () => {
  it('unwraps a pay_x402 quote json block so the Approve gate renders (the HIGH bug)', () => {
    const wire = [{ json: { ok: true, requires_confirmation: true, quote: 'q', price_micro: 1000 } }]
    const r: any = unwrapToolContent(wire)
    // Read exactly as PayReceipt does: isQuote = requires_confirmation && quote.
    expect(r.requires_confirmation).toBe(true)
    expect(r.quote).toBe('q')
    expect(r.ok).toBe(true)
    // Pre-fix, `wire.requires_confirmation` was undefined → toolFailed=true → wrong card.
    expect(Boolean((wire as any).requires_confirmation && (wire as any).quote)).toBe(false)
  })

  it('unwraps a spawn_agents json block so TaskTree sees results', () => {
    const wire = [{ json: { ok: true, completed: 2, results: [{ task: 1, ok: true }] } }]
    const r: any = unwrapToolContent(wire)
    expect(r.results).toHaveLength(1)
    expect(r.completed).toBe(2)
  })

  it('parses a text block that carries a JSON string', () => {
    const wire = [{ text: JSON.stringify({ ok: false, error: 'boom' }) }]
    const r: any = unwrapToolContent(wire)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('boom')
  })

  it('returns the plain string when a text block is not JSON', () => {
    expect(unwrapToolContent([{ text: 'just words' }])).toBe('just words')
  })

  it('prefers the first json/text block and ignores trailing media blocks', () => {
    const wire = [{ json: { ok: true } }, { image: { bytes: 'x' } }]
    expect((unwrapToolContent(wire) as any).ok).toBe(true)
  })

  it('falls back to raw content when there is no json/text block (media-only)', () => {
    const wire = [{ image: { format: 'png', bytes: 'x' } }]
    expect(unwrapToolContent(wire)).toBe(wire)
  })

  it('passes non-array content through untouched', () => {
    expect(unwrapToolContent(null)).toBeNull()
    expect(unwrapToolContent(undefined)).toBeUndefined()
    const obj = { ok: true }
    expect(unwrapToolContent(obj)).toBe(obj)
  })
})
