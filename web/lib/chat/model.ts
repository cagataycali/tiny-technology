/**
 * Model provider factory (extracted from app/api/chat/route.ts) — maps the
 * client's BYOK selection (x-tiny-model-* headers) to a Strands Model.
 *
 * Provider routing: openai/bedrock/google/vercel are native; everything
 * else (anthropic, openrouter, groq, deepseek, mistral, xai, perplexity,
 * custom) is OpenAI-compatible and rides OpenAIModel with a base URL.
 */
import { type Model } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { GoogleModel } from '@strands-agents/sdk/models/google'
import { VercelModel } from '@strands-agents/sdk/models/vercel'
import { createGateway } from '@ai-sdk/gateway'
import { BedrockEdgeModel } from '@/lib/bedrock-edge'

type ProviderName = 'openai' | 'bedrock' | 'google' | 'vercel'

export interface ModelSelection {
  provider?: string
  apiKey?: string
  modelId?: string
  baseUrl?: string
  maxTokens?: number
  region?: string
  /**
   * Provider-specific request fields, passed through verbatim (from the
   * x-tiny-model-additional-fields header, JSON). Bedrock: Converse
   * `additionalModelRequestFields` (e.g. `{"anthropic_beta":
   * ["context-1m-2025-08-07"]}` for 1M context). OpenAI/compat + Google:
   * merged into the request body (`params`).
   */
  additionalFields?: Record<string, unknown>
}

/**
 * Parse the x-tiny-model-additional-fields header (client) falling back to
 * STRANDS_ADDITIONAL_REQUEST_FIELDS (server env — same shape the Strands
 * CLI uses). Malformed JSON or a non-object → undefined, never a throw.
 */
export function parseAdditionalFields(raw?: string): Record<string, unknown> | undefined {
  const src = raw || process.env.STRANDS_ADDITIONAL_REQUEST_FIELDS
  if (!src) return undefined
  try {
    const parsed = JSON.parse(src)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) {
      return parsed as Record<string, unknown>
    }
  } catch { /* malformed header — ignore */ }
  return undefined
}

export const DEFAULT_MODEL_IDS: Record<ProviderName, string> = {
  // Free-tier default (keyless requests resolve here via normalizeProvider →
  // 'openai'). Overridable per-deployment with OPENAI_MODEL_ID.
  openai: 'gpt-5.6-luna',
  bedrock: 'global.anthropic.claude-sonnet-5',
  google: 'gemini-2.5-flash',
  vercel: 'openai/gpt-5-mini',
}

// Client provider ids (ModelSettings presets) → server model routing.
export function normalizeProvider(p?: string): string {
  const name = (p || process.env.TINY_MODEL_PROVIDER || 'openai').toLowerCase()
  if (name === 'gemini') return 'google'
  return name
}

export function createModel(sel: ModelSelection): Model {
  const provider = normalizeProvider(sel.provider) as ProviderName
  const maxTokens = sel.maxTokens
  const extra = sel.additionalFields

  switch (provider) {
    case 'bedrock': {
      // Edge-safe Bedrock: direct fetch() to ConverseStream + bearer token.
      // (Claude models are NOT on Bedrock's /openai/v1 compat endpoint,
      //  and BedrockModel needs @aws-sdk -> node:http which breaks edge.)
      return new BedrockEdgeModel({
        modelId: sel.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_IDS.bedrock,
        region: sel.region || process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-west-2',
        apiKey: sel.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        temperature: 1,
        ...(maxTokens ? { maxTokens } : {}),
        // e.g. {"anthropic_beta": ["context-1m-2025-08-07"]} → 1M context
        ...(extra ? { additionalModelRequestFields: extra } : {}),
      })
    }

    case 'google':
      return new GoogleModel({
        apiKey: sel.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        modelId: sel.modelId || process.env.GEMINI_MODEL_ID || DEFAULT_MODEL_IDS.google,
        params: {
          temperature: 1,
          ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
          ...(extra ?? {}),
        },
      })

    case 'vercel': {
      // Vercel AI Gateway — any LanguageModelV3-compatible model via VercelModel adapter
      const gateway = createGateway({
        apiKey: sel.apiKey || process.env.AI_GATEWAY_API_KEY,
        ...(sel.baseUrl ? { baseURL: sel.baseUrl } : {}),
      })
      return new VercelModel({
        provider: gateway(sel.modelId || process.env.AI_GATEWAY_MODEL_ID || DEFAULT_MODEL_IDS.vercel),
        temperature: 1,
        ...(maxTokens ? { maxTokens } : {}),
      })
    }

    case 'openai':
    default:
      return new OpenAIModel({
        apiKey: sel.apiKey || process.env.OPENAI_API_KEY,
        modelId: sel.modelId || process.env.OPENAI_MODEL_ID || DEFAULT_MODEL_IDS.openai,
        temperature: 1,
        ...(maxTokens ? { maxTokens } : {}),
        // Extra body params (SDK `params` pass-through) — e.g. Anthropic-
        // compat betas, OpenRouter routing prefs, reasoning_effort…
        ...(extra ? { params: extra } : {}),
        ...(sel.baseUrl ? { clientConfig: { baseURL: sel.baseUrl } } : {}),
        // Strands defaults to OpenAI's Responses API (/v1/responses), which
        // ONLY api.openai.com serves. OpenAI-compatible providers (anthropic,
        // openrouter, groq, deepseek, ...) implement /v1/chat/completions —
        // use the chat API whenever a custom base URL is set.
        ...(sel.baseUrl ? { api: 'chat' as const } : {}),
      })
  }
}

// Preflight: verify the selected provider has a usable API key before we
// build the whole agent — returns an error string or null.
export function preflightModelCheck(sel: ModelSelection): string | null {
  const provider = normalizeProvider(sel.provider)
  const key =
    sel.apiKey ||
    (provider === 'bedrock' ? process.env.AWS_BEARER_TOKEN_BEDROCK
      : provider === 'google' ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      : provider === 'vercel' ? process.env.AI_GATEWAY_API_KEY
      : process.env.OPENAI_API_KEY)
  if (!key) return `No API key configured for provider '${provider}'. Bring your own key via model settings or configure the server.`
  return null
}
