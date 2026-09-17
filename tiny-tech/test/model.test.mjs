/**
 * 🧠 createLocalModel — the env → provider-config contract.
 *
 * These assertions exist because tiny shipped for months building a Bedrock
 * model from three fields (modelId, region, apiKey) while the user's shell
 * exported STRANDS_MAX_TOKENS=120000 and STRANDS_ADDITIONAL_REQUEST_FIELDS
 * (the anthropic 1M-context beta). Nothing errored — the settings were simply
 * never passed, which is the worst possible failure mode: a cap you believe is
 * in force and isn't, indistinguishable from the model ignoring you.
 *
 * So the test reads the config off the REAL constructed model object rather
 * than trusting the factory's return label. If a future refactor drops a
 * spread, this fails.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createLocalModel } = await import('../dist/agent/model.js')

/** The provider config as the SDK actually stored it. */
const cfg = (m) => m?.config ?? m?.modelConfig ?? m?._config ?? {}

/** Run the factory with a controlled env, always restoring the real one. */
async function withEnv(vars, fn) {
  const touched = [
    'TINY_MODEL_PROVIDER', 'TINY_MODEL_ID', 'TINY_MODEL_API_KEY', 'TINY_MODEL_BASE_URL',
    'TINY_MAX_TOKENS', 'STRANDS_MAX_TOKENS',
    'TINY_ADDITIONAL_REQUEST_FIELDS', 'STRANDS_ADDITIONAL_REQUEST_FIELDS',
    'STRANDS_MODEL_ID', 'BEDROCK_MODEL_ID', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
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

const bedrockEnv = { TINY_MODEL_PROVIDER: 'bedrock', AWS_BEARER_TOKEN_BEDROCK: 'test-token' }

test('bedrock carries STRANDS_MAX_TOKENS and STRANDS_ADDITIONAL_REQUEST_FIELDS through to the model', async () => {
  const { model, label } = await withEnv({
    ...bedrockEnv,
    STRANDS_MODEL_ID: 'global.anthropic.claude-fable-5',
    STRANDS_MAX_TOKENS: '120000',
    STRANDS_ADDITIONAL_REQUEST_FIELDS: '{"anthropic_beta": ["context-1m-2025-08-07"]}',
  }, createLocalModel)

  const c = cfg(model)
  assert.equal(c.modelId, 'global.anthropic.claude-fable-5', 'STRANDS_MODEL_ID is honoured as a fallback')
  assert.equal(label, 'bedrock:global.anthropic.claude-fable-5')
  assert.equal(c.maxTokens, 120000, 'the cap reached the provider, not just the env')
  assert.deepEqual(c.additionalRequestFields, { anthropic_beta: ['context-1m-2025-08-07'] })
})

test('TINY_ names win over the STRANDS_ fallbacks', async () => {
  const { model } = await withEnv({
    ...bedrockEnv,
    TINY_MODEL_ID: 'us.anthropic.claude-opus-5',
    STRANDS_MODEL_ID: 'global.anthropic.claude-fable-5',
    TINY_MAX_TOKENS: '4096',
    STRANDS_MAX_TOKENS: '120000',
    TINY_ADDITIONAL_REQUEST_FIELDS: '{"reasoning_effort":"high"}',
    STRANDS_ADDITIONAL_REQUEST_FIELDS: '{"anthropic_beta":["context-1m-2025-08-07"]}',
  }, createLocalModel)

  const c = cfg(model)
  assert.equal(c.modelId, 'us.anthropic.claude-opus-5')
  assert.equal(c.maxTokens, 4096)
  assert.deepEqual(c.additionalRequestFields, { reasoning_effort: 'high' })
})

test('with neither set, nothing is invented — provider defaults stand', async () => {
  const { model } = await withEnv(bedrockEnv, createLocalModel)
  const c = cfg(model)
  assert.equal(c.maxTokens, undefined, 'no phantom cap')
  assert.equal(c.additionalRequestFields, undefined, 'no phantom fields')
  assert.equal(c.modelId, 'us.anthropic.claude-opus-5', 'documented default')
})

test('a malformed cap is refused loudly instead of silently dropped', async () => {
  await assert.rejects(
    () => withEnv({ ...bedrockEnv, STRANDS_MAX_TOKENS: 'lots' }, createLocalModel),
    /invalid max tokens/,
  )
  for (const bad of ['0', '-5', '1.5']) {
    await assert.rejects(
      () => withEnv({ ...bedrockEnv, TINY_MAX_TOKENS: bad }, createLocalModel),
      /invalid max tokens/,
      `max tokens ${bad} must be rejected`,
    )
  }
})

test('malformed additional request fields are refused loudly', async () => {
  await assert.rejects(
    () => withEnv({ ...bedrockEnv, STRANDS_ADDITIONAL_REQUEST_FIELDS: '{oops' }, createLocalModel),
    /not valid JSON/,
  )
  // A JSON array parses fine but is not a fields object — Converse needs a map.
  await assert.rejects(
    () => withEnv({ ...bedrockEnv, STRANDS_ADDITIONAL_REQUEST_FIELDS: '["context-1m"]' }, createLocalModel),
    /must be a JSON object/,
  )
})

test('an empty value is treated as unset, not as an error', async () => {
  const { model } = await withEnv({ ...bedrockEnv, STRANDS_MAX_TOKENS: '  ', STRANDS_ADDITIONAL_REQUEST_FIELDS: '' }, createLocalModel)
  const c = cfg(model)
  assert.equal(c.maxTokens, undefined)
  assert.equal(c.additionalRequestFields, undefined)
})

test('the OpenAI-compat path takes the same cap', async () => {
  const { model, label } = await withEnv({
    TINY_MODEL_PROVIDER: 'openrouter',
    TINY_MODEL_API_KEY: 'test-key',
    STRANDS_MAX_TOKENS: '120000',
  }, createLocalModel)
  assert.equal(cfg(model).maxTokens, 120000, 'the cap is not a bedrock-only feature')
  assert.match(label, /^openrouter:/)
})
