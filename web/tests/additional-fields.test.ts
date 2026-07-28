// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseAdditionalFields, createModel } from '../lib/chat/model'
import { modelConfigHeaders } from '../components/chat/ModelSettings'
import { BedrockEdgeModel } from '../lib/bedrock-edge'

const cfg = (over: any) => ({
  provider: 'default', apiKey: '', modelId: '', baseUrl: '', maxTokens: '', region: '', additionalFields: '', ...over,
})

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
  vi.restoreAllMocks()
  delete process.env.STRANDS_ADDITIONAL_REQUEST_FIELDS
})

describe('parseAdditionalFields — header/env → object', () => {
  it('parses a JSON object from the header', () => {
    expect(parseAdditionalFields('{"anthropic_beta":["context-1m-2025-08-07"]}'))
      .toEqual({ anthropic_beta: ['context-1m-2025-08-07'] })
  })

  it('rejects malformed JSON, arrays, and empty objects (no throw)', () => {
    expect(parseAdditionalFields('{oops')).toBeUndefined()
    expect(parseAdditionalFields('["a"]')).toBeUndefined()
    expect(parseAdditionalFields('{}')).toBeUndefined()
    expect(parseAdditionalFields('"str"')).toBeUndefined()
  })

  it('falls back to STRANDS_ADDITIONAL_REQUEST_FIELDS env (server default)', () => {
    process.env.STRANDS_ADDITIONAL_REQUEST_FIELDS = '{"anthropic_beta":["context-1m-2025-08-07"]}'
    expect(parseAdditionalFields(undefined)).toEqual({ anthropic_beta: ['context-1m-2025-08-07'] })
    // explicit header wins over env
    expect(parseAdditionalFields('{"x":1}')).toEqual({ x: 1 })
  })
})

describe('modelConfigHeaders — x-tiny-model-additional-fields emission', () => {
  it('emits normalized JSON for a BYOK provider', () => {
    const h = modelConfigHeaders(cfg({
      provider: 'bedrock', apiKey: 'k',
      additionalFields: ' {"anthropic_beta": ["context-1m-2025-08-07"]} ',
    }))
    expect(JSON.parse(h['x-tiny-model-additional-fields'])).toEqual({ anthropic_beta: ['context-1m-2025-08-07'] })
  })

  it('drops malformed / non-object / empty values (hand-edited localStorage)', () => {
    for (const bad of ['{oops', '[1]', '{}', '""']) {
      const h = modelConfigHeaders(cfg({ provider: 'bedrock', apiKey: 'k', additionalFields: bad }))
      expect(h['x-tiny-model-additional-fields']).toBeUndefined()
    }
  })

  it('emits nothing on the default (free) provider', () => {
    const h = modelConfigHeaders(cfg({ provider: 'default', additionalFields: '{"x":1}' }))
    expect(h).toEqual({})
  })
})

describe('createModel — additionalFields reach the provider config', () => {
  it('bedrock: stored as additionalModelRequestFields', () => {
    const m = createModel({
      provider: 'bedrock', apiKey: 'k', modelId: 'global.anthropic.claude-fable-5',
      additionalFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    })
    expect((m.getConfig() as any).additionalModelRequestFields)
      .toEqual({ anthropic_beta: ['context-1m-2025-08-07'] })
  })

  it('openai-compat: merged into params', () => {
    const m = createModel({
      provider: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1/',
      additionalFields: { reasoning_effort: 'high' },
    })
    expect((m.getConfig() as any).params).toMatchObject({ reasoning_effort: 'high' })
  })
})

describe('BedrockEdgeModel — additionalModelRequestFields lands in the request body', () => {
  it('sends the field verbatim to converse-stream', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      // minimal valid (empty) eventstream response
      return new Response(new ReadableStream({ start(c) { c.close() } }))
    }) as any

    const model = new BedrockEdgeModel({
      modelId: 'global.anthropic.claude-fable-5',
      apiKey: 'bearer-x',
      additionalModelRequestFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    })
    const events = model.stream([{ role: 'user', content: [{ text: 'hi' }] } as any])
    for await (const _ of events) { /* drain */ }

    expect(sentBody.additionalModelRequestFields).toEqual({ anthropic_beta: ['context-1m-2025-08-07'] })
  })

  it('omits the key entirely when not configured', async () => {
    let sentBody: any = null
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(new ReadableStream({ start(c) { c.close() } }))
    }) as any

    const model = new BedrockEdgeModel({ modelId: 'm', apiKey: 'k' })
    for await (const _ of model.stream([{ role: 'user', content: [{ text: 'hi' }] } as any])) { /* drain */ }
    expect('additionalModelRequestFields' in sentBody).toBe(false)
  })
})
