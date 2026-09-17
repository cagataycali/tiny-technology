/**
 * /model argument parser — pure, parse-or-throw (the Bedrock env-fix design
 * rule: a silently mangled spec looks like the model ignoring you).
 *
 * Shape: provider:model_id[:max_tokens]
 *
 * The awkward part is that ollama model ids CONTAIN colons ('llama3:8b'), so
 * the grammar is anchored at both ends instead of split naively:
 *   - FIRST segment  = provider (bedrock | ollama | openai; closest-match
 *     suggestion on a typo)
 *   - LAST segment   = max_tokens ONLY IF it is a purely numeric positive
 *     integer AND there are at least three segments. A numeric-LOOKING last
 *     segment that is not a positive int ('0', '-5', '1.5') is refused loudly
 *     rather than silently folded into the model id.
 *   - everything between, rejoined with ':' = model_id
 *
 * 'ollama:llama3:8b:4096' → { ollama, 'llama3:8b', 4096 }
 * 'ollama:llama3:8b'      → { ollama, 'llama3:8b' } ('8b' has letters → id)
 */

export const MODEL_PROVIDERS = ['bedrock', 'ollama', 'openai'] as const
export type ModelProvider = (typeof MODEL_PROVIDERS)[number]

export interface ModelSpec {
  provider: ModelProvider
  modelId: string
  maxTokens?: number
}

/** Levenshtein distance — small strings only, plain DP. */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]
}

/** Closest known provider to a typo — for the error message. */
export function closestProvider(input: string): ModelProvider {
  let best: ModelProvider = MODEL_PROVIDERS[0]
  let bestD = Infinity
  for (const p of MODEL_PROVIDERS) {
    const d = editDistance(input.toLowerCase(), p)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/** Numeric-LOOKING: a max_tokens candidate even when invalid, so '0' errors. */
const NUMERIC_ISH = /^[+-]?\d+(\.\d+)?$/
/** Purely numeric positive integer — the only accepted max_tokens shape. */
const POSITIVE_INT = /^\d+$/

export function parseModelSpec(raw: string): ModelSpec {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    throw new Error('usage: /model provider:model_id[:max_tokens] — e.g. /model ollama:llama3:8b:4096')
  }
  const segments = trimmed.split(':')
  if (segments.length < 2 || !segments[1]?.trim()) {
    throw new Error(
      `expected provider:model_id[:max_tokens], got ${JSON.stringify(trimmed)} — e.g. /model bedrock:us.anthropic.claude-opus-5`,
    )
  }

  const providerRaw = segments[0].trim().toLowerCase()
  if (!(MODEL_PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw new Error(
      `unknown provider ${JSON.stringify(segments[0].trim())} — did you mean '${closestProvider(providerRaw)}'? (one of: ${MODEL_PROVIDERS.join(', ')})`,
    )
  }
  const provider = providerRaw as ModelProvider

  let rest = segments.slice(1)
  let maxTokens: number | undefined

  // max_tokens needs ≥3 total segments: 'ollama:4096' means model id '4096'.
  const last = rest[rest.length - 1].trim()
  if (rest.length >= 2 && NUMERIC_ISH.test(last)) {
    if (!POSITIVE_INT.test(last) || Number(last) <= 0) {
      throw new Error(`invalid max_tokens ${JSON.stringify(last)} — must be a positive integer`)
    }
    maxTokens = Number(last)
    if (!Number.isSafeInteger(maxTokens)) {
      throw new Error(`invalid max_tokens ${JSON.stringify(last)} — too large`)
    }
    rest = rest.slice(0, -1)
  }

  const modelId = rest.join(':').trim()
  if (!modelId) {
    throw new Error(`missing model id in ${JSON.stringify(trimmed)} — expected provider:model_id[:max_tokens]`)
  }

  return { provider, modelId, ...(maxTokens !== undefined ? { maxTokens } : {}) }
}
