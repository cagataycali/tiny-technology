"use client";

/**
 * WebLLM on-device inference (COMPARISON.md §2.16, the last roadmap item) —
 * opt-in provider that runs a small LLM entirely in the browser via WebGPU.
 * Private (nothing leaves the device), free, works offline once the model
 * is cached.
 *
 * The @mlc-ai/web-llm library (~4MB) loads lazily from CDN on first use —
 * `webpackIgnore` keeps it out of the app bundle entirely. Model weights
 * download once into the browser Cache API.
 *
 * Any model in the library's prebuiltAppConfig catalog (~160 in 0.2.84 —
 * Qwen3/3.5, Gemma 3, Llama 3.2, Phi-4, DeepSeek-R1 distills, SmolLM2…)
 * runs without custom wasm; WEBLLM_MODELS is just the curated quick-pick.
 * The full catalog is browsable via loadWebllmCatalog + HF stats
 * (fetchHFStats) so users can pick by downloads/likes themselves.
 *
 * Trade-offs vs cloud providers (surfaced in the UI): no tools, no RAG,
 * no sub-agents — plain chat with the tiny's personality only.
 */

// Keep in sync with the catalog snapshot below: model ids must exist in
// this version's prebuiltAppConfig or CreateMLCEngine rejects them.
export const WEBLLM_VERSION = "0.2.84";

export const WEBLLM_MODELS: { id: string; label: string; size: string }[] = [
  { id: "gemma3-1b-it-q4f16_1-MLC", label: "Gemma 3 1B (fastest)", size: "0.7GB" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", size: "0.9GB" },
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B", size: "2.0GB" },
  { id: "Qwen3.5-2B-q4f16_1-MLC", label: "Qwen3.5 2B (newest)", size: "2.2GB" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", size: "2.3GB" },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen3 4B (best quality)", size: "3.4GB" },
];

/** Onboarding defaults: modest devices get the fastest model, 8GB+ the
 *  newest mid-size — by id, so reordering the list can't silently change
 *  what new users download. */
export const WEBLLM_DEFAULT_FAST = "gemma3-1b-it-q4f16_1-MLC";
export const WEBLLM_DEFAULT_QUALITY = "Qwen3.5-2B-q4f16_1-MLC";

export function webgpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

let modPromise: Promise<any> | null = null;

/** The web-llm module itself, loaded once from CDN (browser-only). */
function loadWebllmModule(): Promise<any> {
  if (modPromise) return modPromise;
  // Specifier via variable: keeps tsc from resolving the URL module and
  // webpack from bundling it (loads from CDN at runtime, browser-only)
  const specifier = `https://esm.run/@mlc-ai/web-llm@${WEBLLM_VERSION}`;
  modPromise = import(/* webpackIgnore: true */ specifier).catch((e) => {
    modPromise = null; // failed CDN load must not poison the singleton
    throw e;
  });
  return modPromise;
}

// ── Full catalog + HuggingFace popularity ─────────────────────────────────

export type CatalogModel = {
  id: string;
  vramMB: number;
  lowResource: boolean;
  downloads: number;
  likes: number;
};

/** Runnable models = this version's prebuiltAppConfig. */
export async function loadWebllmCatalog(): Promise<{ id: string; vramMB: number; lowResource: boolean }[]> {
  const mod = await loadWebllmModule();
  const list = mod.prebuiltAppConfig?.model_list || [];
  return list.map((m: any) => ({
    id: String(m.model_id),
    vramMB: Math.round(Number(m.vram_required_MB) || 0),
    lowResource: Boolean(m.low_resource_required),
  }));
}

/** Popularity stats for mlc-ai's HF models (downloads, likes), keyed by
 *  model id without the author prefix. One fetch, module-cached. */
let hfStatsPromise: Promise<Map<string, { downloads: number; likes: number }>> | null = null;
export function fetchHFStats(): Promise<Map<string, { downloads: number; likes: number }>> {
  if (hfStatsPromise) return hfStatsPromise;
  hfStatsPromise = fetch("https://huggingface.co/api/models?author=mlc-ai&limit=1000")
    .then((r) => r.json())
    .then((rows: any[]) => {
      const map = new Map<string, { downloads: number; likes: number }>();
      for (const r of rows || []) {
        const id = String(r.id || "").replace(/^mlc-ai\//, "");
        map.set(id, { downloads: Number(r.downloads) || 0, likes: Number(r.likes) || 0 });
      }
      return map;
    })
    .catch(() => {
      hfStatsPromise = null; // retry next open
      return new Map();
    });
  return hfStatsPromise;
}

/** Join the runnable catalog with HF stats (pure — unit-tested). */
export function joinCatalogStats(
  catalog: { id: string; vramMB: number; lowResource: boolean }[],
  stats: Map<string, { downloads: number; likes: number }>,
): CatalogModel[] {
  return catalog.map((c) => ({
    ...c,
    downloads: stats.get(c.id)?.downloads ?? 0,
    likes: stats.get(c.id)?.likes ?? 0,
  }));
}

export type CatalogSort = "downloads" | "likes" | "size";

/** Filter + rank the joined catalog for the picker (pure — unit-tested).
 *  Search terms all match (AND) against the id, case-insensitive. */
export function filterCatalog(models: CatalogModel[], query: string, sort: CatalogSort): CatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = models.filter((m) => {
    const id = m.id.toLowerCase();
    return terms.every((t) => id.includes(t));
  });
  return hit.sort((a, b) =>
    sort === "downloads" ? b.downloads - a.downloads
    : sort === "likes" ? b.likes - a.likes
    : a.vramMB - b.vramMB
  );
}

/** Browsable picker feed: runnable catalog ranked by HF popularity. */
export async function searchWebllmModels(query: string, sort: CatalogSort): Promise<CatalogModel[]> {
  const [catalog, stats] = await Promise.all([loadWebllmCatalog(), fetchHFStats()]);
  return filterCatalog(joinCatalogStats(catalog, stats), query, sort);
}

// ── Engine + streaming ─────────────────────────────────────────────────────

let enginePromise: Promise<any> | null = null;
let engineModelId: string | null = null;

/** Lazy singleton engine; re-created when the model changes. */
async function getEngine(modelId: string, onProgress: (text: string) => void): Promise<any> {
  if (enginePromise && engineModelId === modelId) return enginePromise;
  engineModelId = modelId;
  enginePromise = (async () => {
    const mod = await loadWebllmModule();
    return mod.CreateMLCEngine(modelId, {
      initProgressCallback: (p: { text?: string; progress?: number }) => {
        onProgress(p.text || `Loading model… ${Math.round((p.progress || 0) * 100)}%`);
      },
    });
  })();
  try {
    return await enginePromise;
  } catch (e) {
    // Failed init must not poison the singleton — allow retry
    enginePromise = null;
    engineModelId = null;
    throw e;
  }
}

/**
 * Stream a local completion. onDelta receives text fragments; resolves with
 * the full text. Throws with a friendly message when WebGPU is missing.
 */
export async function webllmStream(
  modelId: string,
  messages: ChatMsg[],
  onDelta: (text: string) => void,
  onStatus: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!webgpuSupported()) {
    throw new Error("This browser has no WebGPU — on-device models need Chrome/Edge 113+ or Safari 18+.");
  }
  const engine = await getEngine(modelId, onStatus);
  onStatus(""); // clear loading status once ready

  const chunks = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.8,
    max_tokens: 1024,
    // Qwen3+ default to emitting <think> blocks — raw tags in a chat UI.
    // Off for plain chat; other models ignore the flag.
    ...(modelId.startsWith("Qwen3") ? { extra_body: { enable_thinking: false } } : {}),
  });

  let full = "";
  for await (const chunk of chunks) {
    if (signal?.aborted) {
      try { await engine.interruptGenerate(); } catch { }
      break;
    }
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}
