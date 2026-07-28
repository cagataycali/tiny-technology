// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  addMapMarkerTool,
  flyToLocationTool,
  clearMapMarkersTool,
  removeMapMarkerTool,
  flyToMarkerTool,
  tourMarkersTool,
} from '../lib/chat/tools/client-side'

/**
 * 🗺️ Agent map controls (agi-diy add_map_marker/fly_to port) — the server
 * half is a no-op ack like speak/vibrate, but the SCHEMAS are the contract
 * the model plans against: coordinate ranges must reject junk before the
 * browser bridge ever sees it.
 */

// strands tool() keeps the zod schema on _inputSchema (spec exposes only
// the derived JSON Schema)
const schema = (t: any) => t._inputSchema

import { gradeTintCss } from '../components/MapBackground'

describe('ambient grade tint (iOS ambientGradeTint parity)', () => {
  it('leans the base gray toward the accent', () => {
    expect(gradeTintCss('0, 255, 136')).toBe('rgb(139,216,180)')
    expect(gradeTintCss('255, 0, 0')).toBe('rgb(216,139,139)')
  })
  it('falls back to the default accent on junk', () => {
    expect(gradeTintCss(null)).toBe('rgb(139,216,180)')
    expect(gradeTintCss('')).toBe('rgb(139,216,180)')
    expect(gradeTintCss('tomato')).toBe('rgb(139,216,180)')
    expect(gradeTintCss('300,0,0')).toBe('rgb(139,216,180)')
  })
})

describe('map tool schemas', () => {
  it('add_map_marker accepts a labeled pin and rejects out-of-range coords', () => {
    expect(
      schema(addMapMarkerTool).safeParse({ lat: 37.7749, lng: -122.4194, label: 'coffee' }).success,
    ).toBe(true)
    expect(schema(addMapMarkerTool).safeParse({ lat: 91, lng: 0 }).success).toBe(false)
    expect(schema(addMapMarkerTool).safeParse({ lat: 0, lng: -181 }).success).toBe(false)
    expect(schema(addMapMarkerTool).safeParse({ lng: -122.4 }).success).toBe(false)
  })

  it('fly_to_location bounds zoom to map levels', () => {
    expect(schema(flyToLocationTool).safeParse({ lat: 41.0082, lng: 28.9784, zoom: 12 }).success).toBe(true)
    expect(schema(flyToLocationTool).safeParse({ lat: 41.0082, lng: 28.9784 }).success).toBe(true)
    expect(schema(flyToLocationTool).safeParse({ lat: 41, lng: 29, zoom: 0 }).success).toBe(false)
    expect(schema(flyToLocationTool).safeParse({ lat: 41, lng: 29, zoom: 21 }).success).toBe(false)
  })

  it('clear_map_markers requires the literal confirm', () => {
    expect(schema(clearMapMarkersTool).safeParse({ confirm: true }).success).toBe(true)
    expect(schema(clearMapMarkersTool).safeParse({ confirm: false }).success).toBe(false)
    expect(schema(clearMapMarkersTool).safeParse({}).success).toBe(false)
  })

  it('add_map_marker takes an optional agent-chosen id, bounded to 32 chars', () => {
    expect(schema(addMapMarkerTool).safeParse({ lat: 1, lng: 2, id: 'stop-1' }).success).toBe(true)
    expect(schema(addMapMarkerTool).safeParse({ lat: 1, lng: 2, id: 'x'.repeat(33) }).success).toBe(false)
  })

  it('remove_map_marker requires the id', () => {
    expect(schema(removeMapMarkerTool).safeParse({ id: 'stop-1' }).success).toBe(true)
    expect(schema(removeMapMarkerTool).safeParse({}).success).toBe(false)
  })

  it('fly_to_marker bounds zoom like fly_to_location', () => {
    expect(schema(flyToMarkerTool).safeParse({ id: 'stop-1', zoom: 15 }).success).toBe(true)
    expect(schema(flyToMarkerTool).safeParse({ id: 'stop-1' }).success).toBe(true)
    expect(schema(flyToMarkerTool).safeParse({ id: 'stop-1', zoom: 0 }).success).toBe(false)
    expect(schema(flyToMarkerTool).safeParse({ zoom: 15 }).success).toBe(false)
  })

  it('tour_markers wants 2-12 stops and a sane pause', () => {
    expect(schema(tourMarkersTool).safeParse({ ids: ['a', 'b'] }).success).toBe(true)
    expect(schema(tourMarkersTool).safeParse({ ids: ['a', 'b'], pause_ms: 2000 }).success).toBe(true)
    expect(schema(tourMarkersTool).safeParse({ ids: ['a'] }).success).toBe(false)
    expect(schema(tourMarkersTool).safeParse({ ids: Array.from({ length: 13 }, (_, i) => `p${i}`) }).success).toBe(false)
    expect(schema(tourMarkersTool).safeParse({ ids: ['a', 'b'], pause_ms: 100 }).success).toBe(false)
  })

  it('server callbacks are honest no-op acks (client executes)', async () => {
    const a = await (addMapMarkerTool as any).invoke({ lat: 1, lng: 2 }, {})
    expect(a.ok).toBe(true)
    const c = await (clearMapMarkersTool as any).invoke({ confirm: true }, {})
    expect(c.ok).toBe(true)
    const r = await (removeMapMarkerTool as any).invoke({ id: 'stop-1' }, {})
    expect(r.ok).toBe(true)
    const t = await (tourMarkersTool as any).invoke({ ids: ['a', 'b'] }, {})
    expect(t.ok).toBe(true)
  })
})
