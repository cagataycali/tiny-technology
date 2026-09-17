// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  planDmUpload, dmSizeRefusal, dmAttachmentRoom, encodeWav, wavDurationMs,
  DM_UPLOAD_MAX_BYTES, DM_VOICE_MAX_MS, DM_VOICE_SAMPLE_RATE,
} from '../lib/chat/dm-media-upload'
import { DM_ATTACHMENT_TYPES, DM_MAX_ATTACHMENTS } from '../lib/chat/dm-attachments'

/**
 * The browser-side rules for getting a picked file into the media store.
 *
 * Everything asserted here is a decision that has to be made BEFORE any bytes
 * move, because the failure mode on the other side of it is an attachment the
 * user watched themselves attach that never arrives.
 */

const f = (name: string, type = '', size = 1000) => ({ name, type, size })

describe('what the web can attach, and what it says when it cannot', () => {
  it('a normal photo is re-encoded to jpeg', () => {
    const p = planDmUpload(f('cat.jpg', 'image/jpeg', 4_000_000))
    expect(p).toEqual({ ok: true, kind: 'image', contentType: 'image/jpeg', recompress: true })
  })

  it('🔴 an iPhone HEIC pick is CONVERTED, not refused', () => {
    // The store's allowlist has no image/heic, and this is what Safari's picker
    // hands over — refusing it would make the commonest photo on the commonest
    // phone unsendable. Canvas re-encodes anything the browser can display.
    for (const file of [f('IMG_1.HEIC', 'image/heic'), f('IMG_2.heif', ''), f('shot.avif', 'image/avif')]) {
      const p = planDmUpload(file)
      expect(p.ok, file.name).toBe(true)
      if (!p.ok) continue
      expect(p.contentType).toBe('image/jpeg')
      expect(DM_ATTACHMENT_TYPES[p.contentType]).toBe('image')
    }
  })

  it('🔴 a GIF is NOT recompressed (canvas would flatten the animation)', () => {
    const p = planDmUpload(f('reaction.gif', 'image/gif'))
    expect(p).toEqual({ ok: true, kind: 'image', contentType: 'image/gif', recompress: false })
  })

  it('mp4 video passes; other containers are refused BY NAME', () => {
    expect(planDmUpload(f('clip.mp4', 'video/mp4'))).toEqual(
      { ok: true, kind: 'video', contentType: 'video/mp4', recompress: false },
    )
    const mov = planDmUpload(f('IMG_3.mov', 'video/quicktime'))
    expect(mov.ok).toBe(false)
    if (mov.ok) throw new Error('expected refusal')
    // The refusal has to name the cause AND a way forward, since there is no
    // transcoder in the browser to fix it for them.
    expect(mov.error).toContain('.mp4')
    expect(mov.error).toContain('.mov')
    expect(mov.error).toMatch(/app|convert/)
    expect(planDmUpload(f('clip.webm', 'video/webm')).ok).toBe(false)
  })

  it('🔴 never plans an upload the media store would reject', () => {
    // The whole point of the plan step: if this ever yields a contentType
    // outside the allowlist, the upload 400s after the user waited for it.
    const files = [
      f('a.jpg', 'image/jpeg'), f('b.png', 'image/png'), f('c.webp', 'image/webp'),
      f('d.gif', 'image/gif'), f('e.HEIC', 'image/heic'), f('f.avif', 'image/avif'),
      f('g.mp4', 'video/mp4'), f('h.m4a', 'audio/mp4'), f('i.mp3', 'audio/mpeg'),
      f('j.wav', 'audio/wav'), f('k.ogg', 'audio/ogg'), f('l.bmp', 'image/bmp'),
    ]
    for (const file of files) {
      const p = planDmUpload(file)
      expect(p.ok, file.name).toBe(true)
      if (!p.ok) continue
      expect(DM_ATTACHMENT_TYPES[p.contentType], `${file.name} → ${p.contentType}`).toBe(p.kind)
    }
  })

  it('audio files outside the allowlist are refused with the list', () => {
    const r = planDmUpload(f('note.opus', 'audio/opus'))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error).toContain('m4a')
    expect(r.error).toMatch(/record/)   // the actual way to make one here
  })

  it('a document is refused as what it is, not as "invalid"', () => {
    const r = planDmUpload(f('taxes.pdf', 'application/pdf'))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error).toMatch(/photos/)
    expect(r.error).toMatch(/voice notes?/)
  })

  it('falls back to the extension when the browser reports no type', () => {
    // Safari does this for some picks; treating a typeless file as "not media"
    // would refuse a perfectly good photo.
    expect(planDmUpload(f('photo.png', '')).ok).toBe(true)
    expect(planDmUpload(f('clip.mp4', '')).ok).toBe(true)
    expect(planDmUpload(f('song.mp3', '')).ok).toBe(false) // typeless audio: can't know the codec
    expect(planDmUpload(f('notes', '')).ok).toBe(false)
  })
})

describe('the size refusal names both numbers', () => {
  it('is silent when it fits', () => {
    expect(dmSizeRefusal(DM_UPLOAD_MAX_BYTES)).toBeNull()
    expect(dmSizeRefusal(0)).toBeNull()
  })

  it('🔴 one byte over refuses, and says how big and how big is allowed', () => {
    const r = dmSizeRefusal(DM_UPLOAD_MAX_BYTES + 1, '“clip.mp4”')!
    expect(r).toContain('clip.mp4')
    expect(r).toContain('2.5MB')          // the cap, in the unit a person reads
    expect(r).toMatch(/nothing was sent/) // same promise the text rule makes
  })

  it('the cap actually fits the edge request budget it exists for', () => {
    // base64 is 4/3×; the route it posts to is a Vercel edge function (~4.5MB).
    expect(Math.ceil(DM_UPLOAD_MAX_BYTES * 4 / 3)).toBeLessThan(4_000_000)
  })
})

describe('the attachment-count rule refuses rather than keeps the first four', () => {
  it('allows up to the cap', () => {
    expect(dmAttachmentRoom(0, DM_MAX_ATTACHMENTS, DM_MAX_ATTACHMENTS)).toBeNull()
    expect(dmAttachmentRoom(3, 1, DM_MAX_ATTACHMENTS)).toBeNull()
  })

  it('🔴 refuses the overflow with the arithmetic shown', () => {
    const r = dmAttachmentRoom(3, 3, DM_MAX_ATTACHMENTS)!
    expect(r).toContain(String(DM_MAX_ATTACHMENTS))
    expect(r).toContain('3')
    // Not "only 4 were kept" — the user must know their pick did not go.
    expect(r).not.toMatch(/kept|ignored/i)
  })
})

describe('🎤 the voice-note WAV encoder', () => {
  const samples = (n: number, v = 0) => {
    const a = new Float32Array(n)
    a.fill(v)
    return a
  }

  it('writes a valid RIFF/WAVE header for 16-bit mono PCM', () => {
    const bytes = encodeWav(samples(100), 16_000)
    const td = new TextDecoder()
    expect(td.decode(bytes.subarray(0, 4))).toBe('RIFF')
    expect(td.decode(bytes.subarray(8, 12))).toBe('WAVE')
    expect(td.decode(bytes.subarray(12, 16))).toBe('fmt ')
    expect(td.decode(bytes.subarray(36, 40))).toBe('data')
    const v = new DataView(bytes.buffer)
    expect(v.getUint32(4, true)).toBe(bytes.length - 8)  // RIFF size
    expect(v.getUint16(20, true)).toBe(1)                // PCM
    expect(v.getUint16(22, true)).toBe(1)                // mono
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint32(28, true)).toBe(32_000)           // byte rate
    expect(v.getUint16(34, true)).toBe(16)               // bits
    expect(v.getUint32(40, true)).toBe(200)              // data size
    expect(bytes.length).toBe(44 + 200)
  })

  it('🔴 clamps out-of-range samples instead of letting them wrap', () => {
    // Resampling rings slightly past ±1. Int16 wraparound turns that into a
    // full-scale sign flip — an audible click on every peak.
    const bytes = encodeWav(new Float32Array([1.4, -1.4, 1, -1, 0]), 16_000)
    const v = new DataView(bytes.buffer)
    expect(v.getInt16(44, true)).toBe(32767)
    expect(v.getInt16(46, true)).toBe(-32768)
    expect(v.getInt16(48, true)).toBe(32767)
    expect(v.getInt16(50, true)).toBe(-32768)
    expect(v.getInt16(52, true)).toBe(0)
  })

  it('reports its own duration from the header', () => {
    expect(wavDurationMs(encodeWav(samples(16_000), 16_000))).toBe(1000)
    expect(wavDurationMs(encodeWav(samples(8_000), 16_000))).toBe(500)
    expect(wavDurationMs(new Uint8Array(10))).toBe(0)   // truncated, not a throw
  })

  it('🔴 the recording cap is derived from the upload cap, not picked', () => {
    // If these ever drift, a user talks for the full allowed minute and THEN
    // gets told the result is too big to send.
    const maxBytes = 44 + (DM_VOICE_MAX_MS / 1000) * DM_VOICE_SAMPLE_RATE * 2
    expect(maxBytes).toBeLessThanOrEqual(DM_UPLOAD_MAX_BYTES)
    expect(dmSizeRefusal(maxBytes)).toBeNull()
  })
})
