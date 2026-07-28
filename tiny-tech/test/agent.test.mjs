/**
 * Agent module tests — model factory auto-detect + tiny tool surface.
 * No network, no real model calls: pure wiring checks.
 */
import { test } from 'node:test'
import assert from 'node:assert'

const ENV_KEYS = [
  'TINY_MODEL_PROVIDER', 'TINY_MODEL_API_KEY', 'TINY_MODEL_ID', 'TINY_MODEL_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'BEDROCK_MODEL_ID', 'BEDROCK_REGION', 'AWS_REGION', 'OLLAMA_HOST', 'OLLAMA_MODEL_ID',
]

function withEnv(overrides, fn) {
  const saved = {}
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, overrides)
  return fn().finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

test('model factory: no credentials → server fallback (null model)', () =>
  withEnv({ OLLAMA_HOST: 'http://127.0.0.1:1' }, async () => {  // dead port — a real local ollama must not hijack this test
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.strictEqual(r.model, null)
    assert.match(r.label, /server/)
  }))

test('model factory: TINY_MODEL_PROVIDER=ollama → offline local model (WebLLM analog)', () =>
  withEnv({ TINY_MODEL_PROVIDER: 'ollama' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.ok(r.model, 'model instance expected')
    assert.match(r.label, /^ollama:qwen3:1.7b \(offline\)$/)
  }))

test('model factory: provider alias local → ollama', () =>
  withEnv({ TINY_MODEL_PROVIDER: 'local', TINY_MODEL_ID: 'qwen3:0.6b' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.ok(r.model)
    assert.match(r.label, /^ollama:qwen3:0.6b/)
  }))

test('model factory: OPENAI_API_KEY auto-detects openai', () =>
  withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.ok(r.model, 'model instance expected')
    assert.match(r.label, /^openai:/)
  }))

test('model factory: bedrock bearer token wins auto-detect', () =>
  withEnv({ AWS_BEARER_TOKEN_BEDROCK: 'x', OPENAI_API_KEY: 'sk-test' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.match(r.label, /^bedrock:/)
  }))

test('model factory: explicit compat provider without key → server fallback, not throw', () =>
  withEnv({ TINY_MODEL_PROVIDER: 'groq' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.strictEqual(r.model, null)
  }))

test('model factory: TINY_MODEL_ID override lands in the label', () =>
  withEnv({ OPENAI_API_KEY: 'sk-test', TINY_MODEL_ID: 'gpt-x' }, async () => {
    const { createLocalModel } = await import('../dist/agent/model.js')
    const r = await createLocalModel()
    assert.strictEqual(r.label, 'openai:gpt-x')
  }))

test('tiny tools: static surface names are unique and prefixed', async () => {
  const { makeTinyTools } = await import('../dist/agent/tiny-tools.js')
  const { TinyApi } = await import('../dist/api.js')
  const t = makeTinyTools(new TinyApi(null))
  const names = t.static.map((x) => x.name)
  assert.strictEqual(new Set(names).size, names.length, 'duplicate tool names')
  for (const n of names) {
    assert.ok(n.startsWith('tiny_') || n === 'ask_tiny', `unexpected name: ${n}`)
  }
  // The core surface the REPL promises
  for (const required of ['tiny_whoami', 'tiny_learn', 'tiny_recall', 'ask_tiny', 'tiny_schedule', 'tiny_events']) {
    assert.ok(names.includes(required), `missing ${required}`)
  }
})

test('tiny tools: forged fetch failure (logged out) → empty list, no throw', async () => {
  const { makeTinyTools } = await import('../dist/agent/tiny-tools.js')
  const { TinyApi } = await import('../dist/api.js')
  // TinyApi(null) falls back to loadCredentials() — feed EXPIRED creds so
  // the api is deterministically unauthenticated regardless of ~/.tiny
  const expired = { token: 'x', expires: 1, apiUrl: 'https://tiny.technology', user: { id: '0', login: 'ghost' } }
  const t = makeTinyTools(new TinyApi(expired))
  const forged = await t.makeForgedTools()
  assert.deepStrictEqual(forged, [])
})

test('local agent payment posture: quote yes, execute NEVER', async () => {
  const { makeTinyTools } = await import('../dist/agent/tiny-tools.js')
  const { TinyApi } = await import('../dist/api.js')
  const { static: tools } = makeTinyTools(new TinyApi(null))
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('tiny_wallet'), 'wallet (read-only) present')
  assert.ok(names.includes('tiny_pay_quote'), 'quote present')
  // The autonomous local agent must not be able to move money: no confirm
  // tool, and the wallet enum stays read-only (no set_price/claim).
  assert.ok(!names.includes('tiny_pay_confirm'), 'confirm must NOT be mounted locally')
})
