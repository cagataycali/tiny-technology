import { describe, it, expect } from 'vitest'
import {
  speedKmh,
  headingCardinal,
  locationContext,
  locationMetadata,
  mergeLocationMeta,
  type GeoFix,
} from '@/lib/geo'

/**
 * 📍 lib/geo — the pure half of the geolocation plumbing: unit conversion,
 * compass points, and the agent-facing `### Location` block (agi-diy's
 * context grammar, shared across web/iOS/Android).
 */

const fix = (over: Partial<GeoFix> = {}): GeoFix => ({
  lat: 37.7749,
  lng: -122.4194,
  accuracy: 12,
  altitude: 52.4,
  speed: 6.5,
  heading: 48,
  timestamp: 1753400000000,
  ...over,
})

describe('speedKmh', () => {
  it('converts m/s to km/h with one decimal', () => {
    expect(speedKmh(6.5)).toBe(23.4)
    expect(speedKmh(0)).toBe(0)
  })

  it('passes null through and rejects junk', () => {
    expect(speedKmh(null)).toBeNull()
    expect(speedKmh(NaN)).toBeNull()
    expect(speedKmh(-1)).toBeNull()
  })
})

describe('headingCardinal', () => {
  it('maps degrees to the eight compass points', () => {
    expect(headingCardinal(0)).toBe('N')
    expect(headingCardinal(48)).toBe('NE')
    expect(headingCardinal(90)).toBe('E')
    expect(headingCardinal(180)).toBe('S')
    expect(headingCardinal(270)).toBe('W')
    expect(headingCardinal(315)).toBe('NW')
    // seam: 337.5 sits exactly between NW and N — rounds toward N
    expect(headingCardinal(337.5)).toBe('N')
  })

  it('wraps: 359° is N again, negatives normalize', () => {
    expect(headingCardinal(359)).toBe('N')
    expect(headingCardinal(720 + 90)).toBe('E')
    expect(headingCardinal(-90)).toBe('W')
  })

  it('null/NaN → null (browser sends null when not moving)', () => {
    expect(headingCardinal(null)).toBeNull()
    expect(headingCardinal(NaN)).toBeNull()
  })
})

describe('locationContext', () => {
  it('renders the full agi-diy block for a moving fix', () => {
    expect(locationContext(fix())).toBe(
      [
        '### Location',
        '- **Coordinates**: 37.7749, -122.4194',
        '- **Accuracy**: ±12m',
        '- **Altitude**: 52m',
        '- **Speed**: 23.4 km/h',
        '- **Heading**: NE (48°)',
      ].join('\n'),
    )
  })

  it('omits speed/heading when stationary (browser nulls)', () => {
    const block = locationContext(fix({ speed: null, heading: null, altitude: null }))
    expect(block).toContain('- **Coordinates**: 37.7749, -122.4194')
    expect(block).not.toContain('Speed')
    expect(block).not.toContain('Heading')
    expect(block).not.toContain('Altitude')
  })

  it('omits a zero speed line — "0.0 km/h" is noise, absence means parked', () => {
    expect(locationContext(fix({ speed: 0 }))).not.toContain('Speed')
  })

  it('returns empty string for no/degenerate fix so callers append blindly', () => {
    expect(locationContext(null)).toBe('')
    expect(locationContext(fix({ lat: NaN }))).toBe('')
  })
})

describe('locationMetadata', () => {
  it('coarsens coords to 4 decimals and carries derived units', () => {
    expect(locationMetadata(fix({ lat: 37.77491234, lng: -122.41945678 }))).toEqual({
      lat: 37.7749,
      lng: -122.4195,
      accuracyM: 12,
      speedKmh: 23.4,
      heading: 'NE',
    })
  })

  it('drops absent fields instead of sending nulls', () => {
    expect(locationMetadata(fix({ accuracy: null, speed: null, heading: null }))).toEqual({
      lat: 37.7749,
      lng: -122.4194,
    })
  })

  it('null fix → null', () => {
    expect(locationMetadata(null)).toBeNull()
  })
})

describe('mergeLocationMeta', () => {
  const moving = fix()

  it('no fix → metadata passes through byte-identical (header unchanged)', () => {
    expect(mergeLocationMeta('.', null)).toBe('.')
    expect(mergeLocationMeta('', null)).toBe('')
    const weather = { tempC: 21 }
    expect(mergeLocationMeta(weather, null)).toBe(weather)
  })

  it('object metadata (404 weather) gains a location key', () => {
    const merged = mergeLocationMeta({ tempC: 21 }, moving) as any
    expect(merged.tempC).toBe(21)
    expect(merged.location).toEqual(locationMetadata(moving))
  })

  it("scalar metadata ('.' home tiny) wraps beside the location", () => {
    expect(mergeLocationMeta('.', moving)).toEqual({
      note: '.',
      location: locationMetadata(moving),
    })
  })

  it("empty metadata ('' slug pages) becomes just the location", () => {
    expect(mergeLocationMeta('', moving)).toEqual({ location: locationMetadata(moving) })
  })
})
