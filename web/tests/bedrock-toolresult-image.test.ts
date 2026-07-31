// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { toConverseContent } from '@/lib/bedrock-edge'

/**
 * 📸 Tool-result IMAGE blocks must survive the edge-Bedrock bridge.
 *
 * The round-trip device tools (meta_take_photo, screenshot, generate_image,
 * use_device) return [ImageBlock, TextBlock] so the model SEES the pixels.
 * toConverseContent's toolResult mapper only knew json|text — an image fell
 * through to JSON.stringify, i.e. the photo arrived as a screenful of
 * '{"0":137,…}' bytes-as-text. Every image round-trip on the DEFAULT model
 * was silently blind (found via glasses QA, 2026-07-28: "the agent never
 * actually sees the image").
 */

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const toolResultMsg = (content: any[]) => [{
  toolResult: { toolUseId: 'tu_1', status: 'success', content },
}]

describe('toolResult content through toConverseContent', () => {
  it('an image block stays an IMAGE block (base64 bytes, format kept)', () => {
    const out = toConverseContent(toolResultMsg([
      { image: { format: 'jpeg', source: { bytes: jpeg } } },
      { text: 'hosted at https://…' },
    ]))
    const content = out[0].toolResult.content
    expect(content).toHaveLength(2)
    expect(content[0].image).toBeTruthy()
    expect(content[0].image.format).toBe('jpeg')
    // Converse wants base64 over the wire; raw bytes would 400.
    expect(typeof content[0].image.source.bytes).toBe('string')
    expect(content[0].image.source.bytes).toBe(Buffer.from(jpeg).toString('base64'))
    // And under NO circumstances the stringified-bytes regression:
    expect(JSON.stringify(content[0])).not.toContain('"0":')
    expect(content[1]).toEqual({ text: 'hosted at https://…' })
  })

  it('json and text tool results are unchanged', () => {
    const out = toConverseContent(toolResultMsg([
      { json: { ok: true } },
      { text: 'plain' },
    ]))
    expect(out[0].toolResult.content).toEqual([{ json: { ok: true } }, { text: 'plain' }])
  })

  it('an unknown block shape still degrades to text, not a crash', () => {
    const out = toConverseContent(toolResultMsg([{ mystery: 1 }]))
    expect(out[0].toolResult.content).toEqual([{ text: '{"mystery":1}' }])
  })
})
