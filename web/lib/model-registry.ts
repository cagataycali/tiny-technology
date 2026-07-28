/**
 * model-registry — fetch available model IDs from each provider's API.
 *
 * Ported from cagataycali/careless. Cached in localStorage (TTL 1h) to
 * avoid refetching on every render. Falls back to a hardcoded list if the
 * API call fails (missing key, CORS, network error).
 *
 * Called from ModelSettings.tsx when the user picks a provider → we load
 * the live list of models for that provider's API key.
 */

export type ModelSource = 'api' | 'cache' | 'fallback' | 'loading'

/** Hardcoded fallbacks for when the API is unreachable or no key is set. */
export const FALLBACKS: Record<string, string[]> = {
  // On-device (WebLLM) — fixed catalog, no API to query
  webllm: [
    'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  ],
  openai: [
    'gpt-5-mini-2025-08-07', 'gpt-5-2025-08-07', 'gpt-4.1', 'gpt-4o',
    'gpt-4o-mini', 'o4-mini', 'o1-mini',
  ],
  // Verified against the model catalog 2026-07: claude-opus-4-20250514
  // dropped (deprecated, retirement date passed — offering it 404s);
  // fable-5 added (current flagship; note it needs 30-day data retention).
  anthropic: [
    'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5',
    'claude-haiku-4-5', 'claude-sonnet-4-5',
  ],
  bedrock: [
    'global.anthropic.claude-sonnet-4-6',
    'global.anthropic.claude-opus-4-8',
    'us.anthropic.claude-haiku-4-5-v1:0',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'amazon.nova-pro-v1:0', 'amazon.nova-lite-v1:0', 'amazon.nova-micro-v1:0',
    'meta.llama3-3-70b-instruct-v1:0',
  ],
  openrouter: [
    'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.5',
    'openai/gpt-5', 'openai/gpt-5-mini',
    'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-large',
    'deepseek/deepseek-chat', 'x-ai/grok-2', 'perplexity/sonar-pro',
  ],
  groq: [
    'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
    'deepseek-r1-distill-llama-70b', 'gemma2-9b-it',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: [
    'mistral-large-latest', 'mistral-small-latest',
    'pixtral-large-latest', 'codestral-latest', 'ministral-8b-latest',
  ],
  xai: ['grok-2-latest', 'grok-2-1212', 'grok-2-vision-1212', 'grok-beta'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'],
  gemini: [
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash',
    'gemini-1.5-pro-latest', 'gemini-1.5-flash-latest',
  ],
  custom: [],
  default: [],
}

interface CacheEntry {
  models: string[]
  fetchedAt: number
}

const CACHE_KEY = 'tiny_model_cache'
const TTL_MS = 60 * 60 * 1000 // 1h

async function hashKey(key: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(key)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hash)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return String(key.length)
  }
}

function readCache(): Record<string, CacheEntry> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    if (!raw || typeof raw !== 'object') return {}
    // Drop any valid-JSON-but-wrong-shape entry: a `models` that isn't an array
    // (or a non-numeric `fetchedAt`) would otherwise pass the `fresh` check and
    // be returned as entry.models, then crash the settings dropdown on
    // list.map(). Same hardening as getRing()/continuity's read<T>().
    const clean: Record<string, CacheEntry> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as Partial<CacheEntry>
      if (e && Array.isArray(e.models) && typeof e.fetchedAt === 'number') {
        clean[k] = { models: e.models.filter((m): m is string => typeof m === 'string'), fetchedAt: e.fetchedAt }
      }
    }
    return clean
  } catch { return {} }
}

function writeCache(cache: Record<string, CacheEntry>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch {}
}

// ─────────────────── Provider fetchers ───────────────────

// Every provider /models fetch is time-boxed. Without this, a slow or
// unresponsive endpoint — most likely a user's CUSTOM base URL pointing at
// an arbitrary host — hangs forever: listModels() never throws, so the
// catch → cache/fallback path never runs and the settings model dropdown
// spins indefinitely. On timeout the fetch rejects and we fall back cleanly.
const MODELS_FETCH_TIMEOUT_MS = 10_000

/** Generic OpenAI-compatible GET /models (openai, openrouter, groq, deepseek, mistral, xai, custom). */
async function fetchOpenAICompatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const data = await res.json()
  return (data.data || [])
    .map((m: any) => String(m.id || ''))
    .filter(Boolean)
    .sort((a: string, b: string) => b.localeCompare(a))
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Anthropic /models ${res.status}`)
  const data = await res.json()
  return (data.data || [])
    .map((m: any) => m.id)
    .sort((a: string, b: string) => b.localeCompare(a))
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Google /models ${res.status}`)
  const data = await res.json()
  return (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort((a: string, b: string) => b.localeCompare(a))
}

async function fetchBedrockModels(apiKey: string, region = 'us-west-2'): Promise<string[]> {
  const res = await fetch(`https://bedrock.${region}.amazonaws.com/foundation-models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Bedrock /foundation-models ${res.status}`)
  const data = await res.json()
  return (data.modelSummaries || [])
    .filter((m: any) => m.modelLifecycle?.status === 'ACTIVE')
    .filter((m: any) => (m.inputModalities || []).includes('TEXT'))
    .filter((m: any) => (m.outputModalities || []).includes('TEXT'))
    .filter((m: any) => (m.inferenceTypesSupported || []).some((t: string) => t === 'ON_DEMAND' || t === 'INFERENCE_PROFILE'))
    .map((m: any) => m.modelId as string)
    .sort((a: string, b: string) => b.localeCompare(a))
}

// Providers that expose an OpenAI-compatible /models endpoint
const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
}

// ─────────────────── Public API ───────────────────

export async function listModels(
  provider: string,
  apiKey: string | undefined,
  opts: { region?: string; baseUrl?: string; force?: boolean } = {},
): Promise<{ models: string[]; source: 'api' | 'cache' | 'fallback' }> {
  if (!apiKey) {
    return { models: FALLBACKS[provider] || [], source: 'fallback' }
  }

  const cache = readCache()
  const keyHash = await hashKey(apiKey)
  // baseUrl is part of the identity for custom providers: the model list is
  // fetched FROM it, so two base URLs under the same key are different lists.
  // Omitting it here served provider A's models after the user repointed to B.
  const cacheKey =
    `${provider}:${keyHash}` +
    `${opts.region ? `:${opts.region}` : ''}` +
    `${opts.baseUrl ? `:${opts.baseUrl}` : ''}`
  const entry = cache[cacheKey]
  const fresh = entry && Date.now() - entry.fetchedAt < TTL_MS

  if (fresh && !opts.force) {
    return { models: entry.models, source: 'cache' }
  }

  try {
    let models: string[] = []
    switch (provider) {
      case 'anthropic': models = await fetchAnthropicModels(apiKey); break
      case 'gemini':    models = await fetchGeminiModels(apiKey); break
      case 'bedrock':   models = await fetchBedrockModels(apiKey, opts.region); break
      case 'custom': {
        if (!opts.baseUrl) throw new Error('custom provider needs a base URL')
        models = await fetchOpenAICompatModels(opts.baseUrl, apiKey)
        break
      }
      default: {
        const base = OPENAI_COMPAT_BASE[provider]
        if (!base) return { models: FALLBACKS[provider] || [], source: 'fallback' }
        models = await fetchOpenAICompatModels(base, apiKey)
      }
    }
    if (!models.length) throw new Error('empty model list')

    models = Array.from(new Set(models))
    cache[cacheKey] = { models, fetchedAt: Date.now() }
    writeCache(cache)
    return { models, source: 'api' }
  } catch (err) {
    console.warn(`[model-registry] ${provider} fetch failed:`, err)
    if (entry) return { models: entry.models, source: 'cache' }
    return { models: FALLBACKS[provider] || [], source: 'fallback' }
  }
}
