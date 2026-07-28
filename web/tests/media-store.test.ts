// @vitest-environment node
// Media store + result-returning client tools (on-device genAI —
// docs/on-device-genai-research-2026-07.md): the worker's base64 gate and
// the SSE wire slimming that keeps generated-image bytes off the stream.
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { normalizeAgentEvent } from '../lib/chat/events'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('media-store')

let decodeBase64Capped: (b64: string, maxBytes: number) => Uint8Array | null

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('media.ts') /* @vite-ignore */)
  decodeBase64Capped = mod.decodeBase64Capped
})

describe('decodeBase64Capped — upload size/validity gate', () => {
  it.skipIf(!present)('decodes valid base64 within the cap', () => {
    const bytes = decodeBase64Capped(Buffer.from('hello tiny').toString('base64'), 1024)
    expect(bytes).not.toBeNull()
    expect(Buffer.from(bytes!).toString()).toBe('hello tiny')
  })

  it.skipIf(!present)('rejects oversized payloads BEFORE decoding (length pre-gate)', () => {
    // 4/3 expansion: 2000 raw bytes ≈ 2668 base64 chars > cap for 1000 bytes
    const big = Buffer.alloc(2000, 7).toString('base64')
    expect(decodeBase64Capped(big, 1000)).toBeNull()
  })

  it.skipIf(!present)('rejects payloads that decode past the cap despite passing the pre-gate', () => {
    // Exactly cap+1 decoded bytes sneaks under the +4 padding slack
    const edge = Buffer.alloc(101, 1).toString('base64')
    expect(decodeBase64Capped(edge, 100)).toBeNull()
  })

  it.skipIf(!present)('rejects garbage, empty, and non-string inputs', () => {
    expect(decodeBase64Capped('not base64!!!', 1024)).toBeNull()
    expect(decodeBase64Capped('', 1024)).toBeNull()
    expect(decodeBase64Capped(undefined as any, 1024)).toBeNull()
  })
})

describe('afterToolCallEvent — media bytes are elided on the wire', () => {
  const MODEL = 'test-model-id'
  const after = (content: any[]) => normalizeAgentEvent({
    type: 'afterToolCallEvent',
    toolUse: { name: 'generate_image', toolUseId: 'tu1' },
    result: { status: 'success', content },
  }, MODEL)

  it('strips base64 image bytes but keeps format and marks elision', () => {
    const out = after([
      { image: { format: 'jpeg', source: { bytes: 'A'.repeat(500_000) } } },
      { text: 'Hosted at: https://plugin.tiny.technology/media/x.jpg' },
    ])
    const [img, txt] = out!.toolResult.content
    expect(img.image.source.bytes).toBe('')
    expect(img.image.elided).toBe(true)
    expect(img.image.format).toBe('jpeg')
    // The URL text block — what clients actually render from — is untouched
    expect(txt.text).toContain('/media/x.jpg')
  })

  it('leaves non-image content and non-array content alone', () => {
    const out = after([{ text: 'plain' }, { json: { ok: true } }])
    expect(out!.toolResult.content).toEqual([{ text: 'plain' }, { json: { ok: true } }])
    const scalar = normalizeAgentEvent({
      type: 'afterToolCallEvent',
      toolUse: { name: 'http', toolUseId: 't2' },
      result: { status: 'success', content: undefined },
    }, MODEL)
    expect(scalar!.toolResult.content).toBeUndefined()
  })
})
