/**
 * /model spec parser — pure grammar tests.
 *
 * The whole reason this parser exists as a separate file: ollama model ids
 * contain colons ('llama3:8b'), so 'split on :' is ambiguous and the rules
 * (first segment = provider, last = max_tokens only if purely numeric positive
 * int, middle rejoined = model id) need pinning down where a TTY isn't.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { parseModelSpec, closestProvider, MODEL_PROVIDERS } = await import(
  '../dist/agent/model-spec.js'
)

test('simple provider:model_id', () => {
  assert.deepEqual(parseModelSpec('bedrock:us.anthropic.claude-opus-5'), {
    provider: 'bedrock',
    modelId: 'us.anthropic.claude-opus-5',
  })
})

test('colon-in-id: ollama:llama3:8b keeps the colon in the model id', () => {
  assert.deepEqual(parseModelSpec('ollama:llama3:8b'), {
    provider: 'ollama',
    modelId: 'llama3:8b',
  })
})

test('colon-in-id + numeric last segment = max_tokens', () => {
  assert.deepEqual(parseModelSpec('ollama:llama3:8b:4096'), {
    provider: 'ollama',
    modelId: 'llama3:8b',
    maxTokens: 4096,
  })
})

test('two segments never yield max_tokens: ollama:4096 is a model id', () => {
  assert.deepEqual(parseModelSpec('ollama:4096'), {
    provider: 'ollama',
    modelId: '4096',
  })
})

test('non-numeric last segment stays in the id', () => {
  assert.deepEqual(parseModelSpec('openai:gpt-5-mini:latest'), {
    provider: 'openai',
    modelId: 'gpt-5-mini:latest',
  })
})

test('zero max_tokens is refused loudly, not folded into the id', () => {
  assert.throws(() => parseModelSpec('ollama:llama3:8b:0'), /positive integer/)
})

test('negative max_tokens is refused loudly', () => {
  assert.throws(() => parseModelSpec('bedrock:some-model:-5'), /positive integer/)
})

test('float max_tokens is refused loudly (numeric-looking but not an int)', () => {
  assert.throws(() => parseModelSpec('bedrock:some-model:1.5'), /positive integer/)
})

test('provider typo gets a closest-match suggestion', () => {
  assert.throws(() => parseModelSpec('bedrok:us.anthropic.claude-opus-5'), /did you mean 'bedrock'/)
  assert.throws(() => parseModelSpec('olama:llama3:8b'), /did you mean 'ollama'/)
  assert.throws(() => parseModelSpec('openia:gpt-5-mini'), /did you mean 'openai'/)
})

test('provider is case-insensitive', () => {
  assert.equal(parseModelSpec('Bedrock:m').provider, 'bedrock')
})

test('bare / empty spec throws usage', () => {
  assert.throws(() => parseModelSpec(''), /usage/)
  assert.throws(() => parseModelSpec('   '), /usage/)
})

test('provider alone (no model id) throws the shape error', () => {
  assert.throws(() => parseModelSpec('bedrock'), /expected provider:model_id/)
  assert.throws(() => parseModelSpec('bedrock:'), /expected provider:model_id/)
})

test('whitespace around the spec is tolerated', () => {
  assert.deepEqual(parseModelSpec('  ollama:llama3:8b:4096  '), {
    provider: 'ollama',
    modelId: 'llama3:8b',
    maxTokens: 4096,
  })
})

test('closestProvider covers every registered provider exactly', () => {
  for (const p of MODEL_PROVIDERS) assert.equal(closestProvider(p), p)
})

// ─── the factory + swap seam ─────────────────────────────────────────────────
//
// Same technique as test/model.test.mjs: read the config off the REAL
// constructed model object, never trust a label — a label can claim a cap the
// request will not carry.

const { createModelFromSpec } = await import('../dist/agent/model.js')
const { TinyAgent } = await import('../dist/agent/agent.js')
const { Agent } = await import('@strands-agents/sdk')

const cfg = (m) => {
  try { if (typeof m?.getConfig === 'function') return m.getConfig() } catch { /* fall through */ }
  return m?.config ?? m?.modelConfig ?? m?._config ?? {}
}

async function withEnv(vars, fn) {
  const touched = [
    'TINY_MODEL_PROVIDER', 'TINY_MODEL_ID', 'TINY_MODEL_API_KEY', 'TINY_MODEL_BASE_URL',
    'TINY_MAX_TOKENS', 'STRANDS_MAX_TOKENS',
    'TINY_ADDITIONAL_REQUEST_FIELDS', 'STRANDS_ADDITIONAL_REQUEST_FIELDS',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  ]
  const saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]))
  for (const k of touched) delete process.env[k]
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('createModelFromSpec: spec maxTokens BEATS the env cap, env request fields stay in force', async () => {
  const { model, label } = await withEnv({
    AWS_BEARER_TOKEN_BEDROCK: 'test-token',
    STRANDS_MAX_TOKENS: '120000',
    STRANDS_ADDITIONAL_REQUEST_FIELDS: '{"anthropic_beta":["context-1m-2025-08-07"]}',
  }, () => createModelFromSpec({ provider: 'bedrock', modelId: 'us.anthropic.claude-opus-5', maxTokens: 8192 }))
  const c = cfg(model)
  assert.equal(c.modelId, 'us.anthropic.claude-opus-5')
  assert.equal(c.maxTokens, 8192, 'the spec cap wins over the env cap')
  assert.deepEqual(c.additionalRequestFields, { anthropic_beta: ['context-1m-2025-08-07'] },
    'env request fields survive a swap — same factory behavior as launch')
  assert.equal(label, 'bedrock:us.anthropic.claude-opus-5')
})

test('createModelFromSpec: no spec cap falls back to the env cap', async () => {
  const { model } = await withEnv(
    { AWS_BEARER_TOKEN_BEDROCK: 'test-token', TINY_MAX_TOKENS: '4096' },
    () => createModelFromSpec({ provider: 'bedrock', modelId: 'm' }),
  )
  assert.equal(cfg(model).maxTokens, 4096)
})

test('createModelFromSpec: openai without any key throws instead of returning null', async () => {
  await assert.rejects(
    withEnv({}, () => createModelFromSpec({ provider: 'openai', modelId: 'gpt-5-mini' })),
    /OPENAI_API_KEY/,
  )
})

test('createModelFromSpec: ollama rides the OpenAI-compat chat api', async () => {
  const { model, label } = await withEnv({}, () =>
    createModelFromSpec({ provider: 'ollama', modelId: 'llama3:8b', maxTokens: 4096 }))
  const c = cfg(model)
  assert.equal(c.modelId, 'llama3:8b')
  assert.equal(c.maxTokens, 4096)
  assert.equal(label, 'ollama:llama3:8b (offline)')
})

/** A TinyAgent wired the way init() leaves it, minus the network. */
async function seededTinyAgent() {
  const { model } = await withEnv(
    { AWS_BEARER_TOKEN_BEDROCK: 'test-token' },
    () => createModelFromSpec({ provider: 'bedrock', modelId: 'us.anthropic.claude-opus-5' }),
  )
  const ta = new TinyAgent({ api: {} })
  ta.model = model
  ta.modelLabel = 'bedrock:us.anthropic.claude-opus-5'
  ta.serverMode = false
  ta.agent = new Agent({ model, systemPrompt: 'test', tools: [], printer: 'silent' })
  ta.agent.messages.push(
    { role: 'user', content: [{ text: 'hello' }] },
    { role: 'assistant', content: [{ text: 'hi' }] },
  )
  return ta
}

test('swapModel: real agent swaps, config read off the NEW model, history preserved', async () => {
  const ta = await seededTinyAgent()
  const before = ta.agent.messages.length
  const line = await withEnv(
    { AWS_BEARER_TOKEN_BEDROCK: 'test-token' },
    () => ta.swapModel('bedrock:global.anthropic.claude-fable-5:8192'),
  )
  assert.equal(line, 'bedrock:us.anthropic.claude-opus-5 → bedrock:global.anthropic.claude-fable-5 (maxTokens 8192)')
  const c = cfg(ta.agent.model)
  assert.equal(c.modelId, 'global.anthropic.claude-fable-5', 'the AGENT holds the new model')
  assert.equal(c.maxTokens, 8192)
  assert.equal(ta.agent.messages.length, before, 'conversation history survives the swap')
  assert.equal(ta.agent.messages[0].content[0].text, 'hello')
  assert.equal(ta.modelLabel, 'bedrock:global.anthropic.claude-fable-5')
  assert.equal(ta.model, ta.agent.model, 'TinyAgent.model and Agent.model stay the same object')
})

test('swapModel: bad spec keeps the OLD model — never modelless', async () => {
  const ta = await seededTinyAgent()
  const oldModel = ta.agent.model
  await assert.rejects(() => ta.swapModel('bedrok:some-model'), /did you mean 'bedrock'/)
  await assert.rejects(() => ta.swapModel('bedrock:m:0'), /positive integer/)
  await assert.rejects(() => withEnv({}, () => ta.swapModel('openai:gpt-5-mini')), /OPENAI_API_KEY/)
  assert.equal(ta.agent.model, oldModel, 'same object identity — nothing was torn down')
  assert.equal(ta.modelLabel, 'bedrock:us.anthropic.claude-opus-5')
})

test('swapModel: server mode refuses with a restart hint', async () => {
  const ta = new TinyAgent({ api: {} })
  ta.serverMode = true
  await assert.rejects(() => ta.swapModel('bedrock:m'), /server mode/)
})

test('modelInfo reads the cap off the real model object', async () => {
  const ta = await seededTinyAgent()
  await withEnv(
    { AWS_BEARER_TOKEN_BEDROCK: 'test-token' },
    () => ta.swapModel('bedrock:us.anthropic.claude-opus-5:9999'),
  )
  assert.match(ta.modelInfo(), /maxTokens 9999/)
})
