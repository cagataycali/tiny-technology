// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { modelConfigHeaders } from '../components/chat/ModelSettings'

// The BYOK key becomes request headers to /api/chat. The one wrong-origin
// hazard: a `custom` provider has no preset base URL, and without one the
// server falls back to OpenAI's endpoint — transmitting the user's key to
// api.openai.com. modelConfigHeaders must NOT emit the key in that case.
const cfg = (over: any) => ({
  provider: 'default', apiKey: '', modelId: '', baseUrl: '', maxTokens: '', region: '', ...over,
})

describe('modelConfigHeaders', () => {
  it('default provider emits nothing (free tier)', () => {
    expect(modelConfigHeaders(cfg({ provider: 'default', apiKey: 'sk-x' }))).toEqual({})
  })

  it('a known preset provider carries key + its preset base URL', () => {
    const h = modelConfigHeaders(cfg({ provider: 'anthropic', apiKey: 'sk-ant-x' }))
    expect(h['x-tiny-model-api-key']).toBe('sk-ant-x')
    expect(h['x-tiny-model-provider']).toBe('anthropic')
    expect(h['x-tiny-model-base-url']).toContain('api.anthropic.com')
  })

  it('CUSTOM provider with NO base URL emits NO key (would leak to OpenAI)', () => {
    const h = modelConfigHeaders(cfg({ provider: 'custom', apiKey: 'sk-secret', baseUrl: '' }))
    // nothing at all — the key must not ride to the default OpenAI endpoint
    expect(h['x-tiny-model-api-key']).toBeUndefined()
    expect(h).toEqual({})
  })

  it('CUSTOM provider WITH a base URL carries key + that url', () => {
    const h = modelConfigHeaders(cfg({ provider: 'custom', apiKey: 'sk-secret', baseUrl: 'https://api.example.com/v1' }))
    expect(h['x-tiny-model-api-key']).toBe('sk-secret')
    expect(h['x-tiny-model-base-url']).toBe('https://api.example.com/v1')
  })

  it('bedrock carries region when set', () => {
    const h = modelConfigHeaders(cfg({ provider: 'bedrock', apiKey: 'k', region: 'us-west-2' }))
    expect(h['x-tiny-model-region']).toBe('us-west-2')
  })
})
