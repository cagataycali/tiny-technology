// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  buildContentBlocks,
  persistableAttachments,
  attachmentsPayloadBytes,
  base64Bytes,
  ingestFiles,
  type Attachment,
} from '../lib/file-attachments'

const img = (over: Partial<Attachment> = {}): Attachment => ({
  type: 'image', base64: 'QUJDRA==', format: 'jpeg', name: 'photo.jpg', thumb: 'data:image/jpeg;base64,dGh1bWI=', ...over,
})

describe('buildContentBlocks', () => {
  it('text-only message → single text block', () => {
    expect(buildContentBlocks('hello')).toEqual([{ text: 'hello' }])
  })

  it('empty text with attachments gets a default prompt', () => {
    const blocks = buildContentBlocks('   ', [img()])
    expect(blocks[0]).toEqual({ text: 'Have a look.' })
    expect(blocks[1].image.source.bytes).toBe('QUJDRA==')
  })

  it('sanitizes document names for Anthropic (odd chars, extension, length)', () => {
    const blocks = buildContentBlocks('doc', [{
      type: 'document', base64: 'eA==', format: 'pdf',
      name: 'Q3 REPORT — final (v2) <checked>!!.pdf',
    }])
    const name = blocks[1].document.name
    expect(name).not.toMatch(/[<>—!]/)
    expect(name).not.toMatch(/\.pdf$/)
    expect(blocks[1].document.format).toBe('pdf')
  })

  it('degrades to text for text-ish files and expired attachments', () => {
    const blocks = buildContentBlocks('look', [
      { type: 'file', text: 'line1', name: 'notes.txt' },
      { type: 'image', name: 'gone.jpg', thumb: 'x' }, // base64 stripped on persist
    ])
    expect(blocks[1].text).toContain('Attached file: notes.txt')
    expect(blocks[2].text).toContain('no longer available')
  })

  it('document with text but no base64 falls back to inline text', () => {
    const blocks = buildContentBlocks('x', [{ type: 'document', text: 'csv,data', name: 'd.csv' }])
    expect(blocks[1].text).toContain('csv,data')
  })

  it('skips null/garbage attachment entries instead of throwing', () => {
    // A corrupt localStorage message / malformed archive could carry a null
    // entry — buildContentBlocks must not throw on att.type of null.
    const blocks = buildContentBlocks('hi', [null as any, undefined as any, 'nope' as any, { type: 'image', base64: 'AAAA' } as any])
    expect(blocks[0]).toEqual({ text: 'hi' })
    // only the one valid image survives
    expect(blocks.filter((b) => b.image)).toHaveLength(1)
  })
})

describe('persistableAttachments', () => {
  it('strips base64 + dataUrl, keeps thumb + metadata', () => {
    const out = persistableAttachments([img({ dataUrl: 'data:image/jpeg;base64,QUJDRA==', size: 4 })])!
    expect(out[0].base64).toBeUndefined()
    expect(out[0].dataUrl).toBeUndefined()
    expect(out[0].thumb).toBeTruthy()
    expect(out[0].name).toBe('photo.jpg')
    expect(out[0].size).toBe(4)
  })

  it('empty/undefined passes through as undefined', () => {
    expect(persistableAttachments(undefined)).toBeUndefined()
    expect(persistableAttachments([])).toBeUndefined()
  })

  it('keeps small text intact', () => {
    const out = persistableAttachments([{ type: 'file', text: 'small note', name: 'n.txt' }])!
    expect(out[0].text).toBe('small note')
  })

  it('caps large extracted text so many attachments cannot overflow the quota', () => {
    const huge = 'x'.repeat(50_000)
    const out = persistableAttachments([{ type: 'document', text: huge, name: 'big.csv', base64: 'AAAA' } as any])!
    expect(out[0].base64).toBeUndefined()       // heavy binary still dropped
    expect(out[0].text!.length).toBeLessThan(5000)
    expect(out[0].text).toContain('[truncated in saved history]')
  })
})

describe('ingestFiles failure isolation', () => {
  // .py/.ts take the text-ish path (file.text(), node-safe); .txt/.md are
  // DOCUMENT formats and would need FileReader, absent in this env
  it('one oversized document does not drop the sibling files in the batch', async () => {
    const good = new File(['hello world'], 'notes.py', { type: 'text/x-python' })
    const huge = new File(['a'.repeat(3_100_000)], 'big.pdf', { type: 'application/pdf' })
    const { attachments, errors } = await ingestFiles([good, huge])
    expect(attachments).toHaveLength(1)
    expect(attachments[0].name).toBe('notes.py')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('big.pdf')
  })

  it('all-good batch → no errors', async () => {
    const a = new File(['x'], 'a.py', { type: 'text/x-python' })
    const b = new File(['y'], 'b.ts', { type: '' })
    const { attachments, errors } = await ingestFiles([a, b])
    expect(attachments).toHaveLength(2)
    expect(errors).toHaveLength(0)
  })
})

describe('payload accounting', () => {
  it('base64Bytes approximates decoded size', () => {
    // 'QUJDRA==' is 'ABCD' → 4 bytes (8 chars × .75 = 6, close over never under-4/3)
    expect(base64Bytes('QUJDRA==')).toBe(6)
    expect(base64Bytes('')).toBe(0)
  })

  it('sums base64 and inline text across attachments', () => {
    const total = attachmentsPayloadBytes([
      img(), // 6
      { type: 'file', text: '12345', name: 't.txt' }, // 5
    ])
    expect(total).toBe(11)
  })
})
