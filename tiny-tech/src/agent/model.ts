/**
 * Local model factory — DevDuck's _select_model() in TS, tiny-shaped.
 *
 * BYO via TINY_MODEL_* env (same vocabulary as the web app's
 * x-tiny-model-* headers):
 *   TINY_MODEL_PROVIDER   openai | anthropic | bedrock | openrouter | groq |
 *                         deepseek | mistral | xai | ollama/local | custom
 *                         (default: auto)
 *   TINY_MODEL_API_KEY    provider key (bedrock: bearer token)
 *   TINY_MODEL_ID         model id override
 *   TINY_MODEL_BASE_URL   custom OpenAI-compat endpoint
 *   TINY_MAX_TOKENS       output token cap (falls back to STRANDS_MAX_TOKENS)
 *   TINY_ADDITIONAL_REQUEST_FIELDS
 *                         JSON passed to the provider verbatim — anthropic
 *                         betas, thinking budgets (falls back to
 *                         STRANDS_ADDITIONAL_REQUEST_FIELDS). Bedrock only.
 *
 * Auto-detect order (devduck pattern): bedrock (AWS creds/bearer) →
 * openai (OPENAI_API_KEY) → anthropic-compat (ANTHROPIC_API_KEY) →
 * ollama (local server running — offline models, node's WebLLM analog) →
 * null (null = fall back to server-side /api/chat proxy — zero-config works).
 *
 * Offline/local (the web UI's WebLLM equivalent for the CLI):
 *   TINY_MODEL_PROVIDER=ollama TINY_MODEL_ID=qwen3:1.7b tiny-tech repl
 *   Ollama serves OpenAI-compat /v1 — rides OpenAIModel with api:'chat'.
 *   OLLAMA_HOST overrides http://localhost:11434.
 */
import type { Model } from '@strands-agents/sdk'

// OpenAI-compat base URLs (mirror of lib/chat/model.ts presets)
const COMPAT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  perplexity: 'https://api.perplexity.ai',
}

const DEFAULT_IDS: Record<string, string> = {
  openai: 'gpt-5-mini-2025-08-07',
  ollama: 'qwen3:1.7b',
  // Mirror Claude's settings.json: ANTHROPIC_DEFAULT_OPUS_MODEL / us-east-1 Bedrock
  bedrock: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-5',
  anthropic: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-5',
  openrouter: 'anthropic/claude-opus-5',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  xai: 'grok-4',
}

export interface LocalModelResult {
  model: Model | null
  label: string
}

function ollamaBaseUrl(): string {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434'
  return host.replace(/\/$/, '') + '/v1'
}

/** Is a local ollama server answering? (fast probe, auto-detect only) */
async function ollamaRunning(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 800)
    const res = await fetch(ollamaBaseUrl().replace(/\/v1$/, '') + '/api/tags', { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}

/**
 * Output token cap. TINY_MAX_TOKENS wins; STRANDS_MAX_TOKENS is honoured so a
 * shell already configured for devduck/strands (e.g. 120000) needs no second
 * export. Garbage is refused loudly — a silently dropped cap looks like the
 * model ignoring you.
 */
function envMaxTokens(): number | undefined {
  const raw = (process.env.TINY_MAX_TOKENS || process.env.STRANDS_MAX_TOKENS || '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid max tokens ${JSON.stringify(raw)} — set TINY_MAX_TOKENS/STRANDS_MAX_TOKENS to a positive integer`)
  }
  return n
}

/**
 * Provider-specific request fields — the channel for anthropic betas
 * (context-1m), reasoning/thinking budgets, anything Converse passes through
 * verbatim. Same env name devduck/strands uses, so one export serves both.
 */
function envAdditionalRequestFields(): Record<string, unknown> | undefined {
  const raw = (process.env.TINY_ADDITIONAL_REQUEST_FIELDS || process.env.STRANDS_ADDITIONAL_REQUEST_FIELDS || '').trim()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`STRANDS_ADDITIONAL_REQUEST_FIELDS is not valid JSON: ${(e as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('STRANDS_ADDITIONAL_REQUEST_FIELDS must be a JSON object, e.g. {"anthropic_beta":["context-1m-2025-08-07"]}')
  }
  return parsed as Record<string, unknown>
}

function hasAwsCreds(): boolean {
  return Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE
  )
}

export async function createLocalModel(): Promise<LocalModelResult> {
  let provider = (process.env.TINY_MODEL_PROVIDER || '').toLowerCase()
  const apiKey = process.env.TINY_MODEL_API_KEY
  const modelId = process.env.TINY_MODEL_ID
  const baseUrl = process.env.TINY_MODEL_BASE_URL

  // Auto-detect (devduck _select_model order)
  if (!provider) {
    if (hasAwsCreds()) provider = 'bedrock'
    else if (process.env.OPENAI_API_KEY) provider = 'openai'
    else if (process.env.ANTHROPIC_API_KEY) provider = 'anthropic'
    else if (await ollamaRunning()) provider = 'ollama'
    else return { model: null, label: `server (${apiHost()} /api/chat)` }
  }
  if (provider === 'gemini') provider = 'google'
  if (provider === 'local' || provider === 'webllm') provider = 'ollama'

  if (provider === 'ollama') {
    // Offline local models — node's WebLLM analog. OpenAI-compat /v1.
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
    const id = modelId || process.env.OLLAMA_MODEL_ID || DEFAULT_IDS.ollama
    const maxTokens = envMaxTokens()
    return {
      model: new OpenAIModel({
        api: 'chat' as const,
        modelId: id,
        apiKey: 'ollama', // ollama ignores the key, openai client requires one
        ...(maxTokens ? { maxTokens } : {}),
        clientConfig: { baseURL: baseUrl || ollamaBaseUrl() },
      } as any),
      label: `ollama:${id} (offline)`,
    }
  }

  if (provider === 'bedrock') {
    // @aws-sdk/client-bedrock-runtime is a hard dep of the SDK — always works
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock')
    const id = modelId || process.env.BEDROCK_MODEL_ID || process.env.STRANDS_MODEL_ID || DEFAULT_IDS.bedrock
    const extra = envAdditionalRequestFields()
    const maxTokens = envMaxTokens()
    return {
      model: new BedrockModel({
        modelId: id,
        region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1',
        // The SDK reads AWS_BEARER_TOKEN_BEDROCK itself — passing apiKey on
        // top duplicates the authorization header ("must only have a single
        // value"). Only pass explicit TINY_MODEL_API_KEY when the env token
        // is absent.
        ...(apiKey && !process.env.AWS_BEARER_TOKEN_BEDROCK ? { apiKey } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        // Betas (context-1m), thinking budgets — the SDK strips whatever the
        // current stream options forbid (_getAdditionalRequestFields).
        ...(extra ? { additionalRequestFields: extra } : {}),
      } as any),
      label: `bedrock:${id}`,
    }
  }

  if (provider === 'google') {
    // @google/genai is an optional peer — surface a clear error if absent
    try {
      const { GoogleModel } = await import('@strands-agents/sdk/models/google')
      const id = modelId || 'gemini-2.5-flash'
      return {
        model: new GoogleModel({
          apiKey: apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          modelId: id,
        }),
        label: `google:${id}`,
      }
    } catch {
      throw new Error("google provider needs: npm i -g @google/genai (or use an OpenAI-compat provider)")
    }
  }

  // Everything else rides OpenAIModel. Non-openai providers are
  // OpenAI-COMPAT: they serve /chat/completions, NOT /v1/responses —
  // api:'chat' is mandatory (AGENTS.md gotcha #5).
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  const resolvedBase = baseUrl || COMPAT_BASE_URLS[provider]
  const key =
    apiKey ||
    (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined) ||
    (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined)
  if (!key) return { model: null, label: `server (${apiHost()} /api/chat)` }

  const id = modelId || DEFAULT_IDS[provider] || DEFAULT_IDS.openai
  const maxTokens = envMaxTokens()
  return {
    model: new OpenAIModel({
      ...(provider !== 'openai' || resolvedBase ? { api: 'chat' as const } : {}),
      modelId: id,
      apiKey: key,
      ...(maxTokens ? { maxTokens } : {}),
      ...(resolvedBase ? { clientConfig: { baseURL: resolvedBase } } : {}),
    } as any),
    label: `${provider}:${id}`,
  }
}

// ─── /model runtime swap ─────────────────────────────────────────────────────

import { parseModelSpec, type ModelSpec } from './model-spec.js'
import { apiHost } from '../config.js'

/**
 * Build a model from a PARSED /model spec — the runtime-swap twin of
 * createLocalModel. Same constructors, same env plumbing (bedrock still reads
 * TINY/STRANDS_ADDITIONAL_REQUEST_FIELDS and the bearer-token rule; the env
 * output cap still applies when the spec doesn't override it), so a swapped
 * session behaves exactly like one launched with those env vars. The ONLY
 * differences from the env path: provider/model id come from the spec, and a
 * spec maxTokens beats the env cap.
 *
 * Throws instead of returning null — the caller keeps the OLD model on any
 * failure, so a typo can never leave the session modelless.
 */
export async function createModelFromSpec(spec: ModelSpec): Promise<{ model: Model; label: string }> {
  const maxTokens = spec.maxTokens ?? envMaxTokens()
  const apiKey = process.env.TINY_MODEL_API_KEY
  const baseUrl = process.env.TINY_MODEL_BASE_URL

  if (spec.provider === 'ollama') {
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
    return {
      model: new OpenAIModel({
        api: 'chat' as const,
        modelId: spec.modelId,
        apiKey: 'ollama',
        ...(maxTokens ? { maxTokens } : {}),
        clientConfig: { baseURL: baseUrl || ollamaBaseUrl() },
      } as any),
      label: `ollama:${spec.modelId} (offline)`,
    }
  }

  if (spec.provider === 'bedrock') {
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock')
    const extra = envAdditionalRequestFields()
    return {
      model: new BedrockModel({
        modelId: spec.modelId,
        region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1',
        // Same rule as createLocalModel: the SDK reads AWS_BEARER_TOKEN_BEDROCK
        // itself — passing apiKey on top duplicates the authorization header.
        ...(apiKey && !process.env.AWS_BEARER_TOKEN_BEDROCK ? { apiKey } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(extra ? { additionalRequestFields: extra } : {}),
      } as any),
      label: `bedrock:${spec.modelId}`,
    }
  }

  // openai — a real key is mandatory here; unlike auto-detect there is no
  // server-proxy fallback mid-session.
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  const key = apiKey || process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('openai needs OPENAI_API_KEY (or TINY_MODEL_API_KEY) — keeping the current model')
  }
  return {
    model: new OpenAIModel({
      ...(baseUrl ? { api: 'chat' as const } : {}),
      modelId: spec.modelId,
      apiKey: key,
      ...(maxTokens ? { maxTokens } : {}),
      ...(baseUrl ? { clientConfig: { baseURL: baseUrl } } : {}),
    } as any),
    label: `openai:${spec.modelId}`,
  }
}

export { parseModelSpec }
