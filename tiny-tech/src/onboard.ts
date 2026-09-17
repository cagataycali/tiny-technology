/**
 * Onboarding — the Claude-Code-style first-run experience for tiny-tech.
 *
 * `tiny-tech login` gives identity; this gives the agent a BRAIN:
 *   1. provider selection ("pizza selection") — Bedrock first, then Anthropic,
 *      OpenAI, and the OpenAI-compat crowd. Multiple providers can be
 *      configured side by side; one is ACTIVE.
 *   2. voice — the live-call voice (same allowlist as the web/app settings).
 *   3. cloud sync — everything saved here is pushed to tiny's backend
 *      (/api/model-providers + /api/account-voice) and, on any device you're
 *      logged into, pulled back down. CLI config ⇄ cloud tiny stays in sync.
 *
 * Local store: ~/.tiny/model-config.json (0600 — real provider secrets live
 * here, same posture as credentials.json). Env vars ALWAYS win over the
 * stored config (TINY_MODEL_* / OPENAI_API_KEY / AWS_* etc.) — an explicit
 * export is an override on purpose, same rule as integrations.json.
 *
 * Sync semantics (last-writer-wins, per provider):
 *   push: local providers → POST /api/model-providers (one call per provider)
 *   pull: GET /api/model-providers?full=1 → merge into the local store
 *         (rows the cloud has and we don't appear; newer cloud rows replace
 *         older local ones by updatedAt)
 *   Both run opportunistically: after the wizard saves, and `tiny-tech sync`
 *   / `onboard --pull` on demand. Offline = local still works; sync is a
 *   convenience, never a gate.
 */
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { apiHost } from './config.js'
import { join } from 'node:path'
import type { TinyApi } from './api.js'

// ── local store ─────────────────────────────────────────────────────────────

export interface ProviderConfig {
  provider: string
  apiKey?: string
  modelId?: string
  baseUrl?: string
  region?: string
  maxTokens?: number
  additionalFields?: string
  updatedAt: number // unix seconds — sync conflict resolution
}

export interface ModelConfigStore {
  version: 1
  /** Which configured provider drives the agent. '' = server/free default. */
  active: string
  providers: Record<string, ProviderConfig>
  /** Live-call voice ('' = account/tiny default). */
  voice: string
  /** Set after the wizard ran once — the TUI/repl stop suggesting it. */
  onboarded?: boolean
  /** Last successful sync (unix seconds), 0 = never. */
  lastSync: number
}

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

export function modelConfigPath(): string {
  return join(tinyHome(), 'model-config.json')
}

export function loadModelConfig(): ModelConfigStore {
  try {
    const raw = JSON.parse(readFileSync(modelConfigPath(), 'utf8'))
    if (raw && typeof raw === 'object' && raw.providers) {
      return { version: 1, active: raw.active || '', providers: raw.providers, voice: raw.voice || '', onboarded: !!raw.onboarded, lastSync: raw.lastSync || 0 }
    }
  } catch { /* absent/corrupt — fresh store */ }
  return { version: 1, active: '', providers: {}, voice: '', lastSync: 0 }
}

export function saveModelConfig(store: ModelConfigStore): void {
  mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  writeFileSync(modelConfigPath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(modelConfigPath(), 0o600) } catch { /* best effort */ }
}

/**
 * Apply the ACTIVE stored provider to process.env as TINY_MODEL_* — the one
 * channel agent/model.ts already reads. Real exports win (never overwrite).
 * Called from cli.ts at startup, next to applyStoredEnv().
 */
export function applyModelEnv(): string | null {
  const store = loadModelConfig()
  const active = store.active && store.providers[store.active]
  if (!active) return null
  const setIf = (k: string, v?: string) => { if (v && !process.env[k]) process.env[k] = v }
  setIf('TINY_MODEL_PROVIDER', active.provider)
  setIf('TINY_MODEL_API_KEY', active.apiKey)
  setIf('TINY_MODEL_ID', active.modelId)
  setIf('TINY_MODEL_BASE_URL', active.baseUrl)
  if (active.region) setIf('BEDROCK_REGION', active.region)
  if (store.voice) setIf('TINY_VOICE', store.voice)
  return active.provider
}

// ── the menu ────────────────────────────────────────────────────────────────

/** Bedrock first — the ask; then the majors; compat providers ride the same
 *  OpenAI client with a base URL. Mirrors web Onboarding's KEY_PROVIDERS +
 *  agent/model.ts COMPAT_BASE_URLS so all three surfaces speak one list. */
export const PROVIDERS: { id: string; label: string; keyHint: string; extra?: 'region' | 'baseUrl' }[] = [
  { id: 'bedrock',    label: 'AWS Bedrock',        keyHint: 'Bedrock API key (bearer token) — or skip to use AWS credentials', extra: 'region' },
  { id: 'anthropic',  label: 'Anthropic',          keyHint: 'sk-ant-...' },
  { id: 'openai',     label: 'OpenAI',             keyHint: 'sk-...' },
  { id: 'google',     label: 'Google Gemini',      keyHint: 'AIza...' },
  { id: 'openrouter', label: 'OpenRouter',         keyHint: 'sk-or-...' },
  { id: 'groq',       label: 'Groq',               keyHint: 'gsk_...' },
  { id: 'deepseek',   label: 'DeepSeek',           keyHint: 'sk-...' },
  { id: 'mistral',    label: 'Mistral',            keyHint: 'API key' },
  { id: 'xai',        label: 'xAI Grok',           keyHint: 'xai-...' },
  { id: 'ollama',     label: 'Ollama (local, no key)', keyHint: '' },
  { id: 'custom',     label: 'Custom (OpenAI-compatible URL)', keyHint: 'API key', extra: 'baseUrl' },
]

/** Voices a live call accepts — mirror of the worker's ACCOUNT_VOICE_NAMES. */
export const VOICES = ['marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'cedar'] as const

// ONE line-queue for the whole wizard. Naive `rl.question()` per prompt LOSES
// lines: readline emits buffered lines the moment they arrive, and any line
// that lands between two question() registrations is dropped on the floor —
// piped answers (tests, heredocs) and fast pastes died mid-wizard. So a
// persistent 'line' listener queues EVERYTHING, and ask() consumes the queue
// or waits. EOF resolves pending/future asks with '' (Enter = done/default),
// so a short pipe finishes the wizard instead of hanging it.
let lineRl: ReturnType<typeof createInterface> | null = null
const lineQueue: string[] = []
let lineWaiter: ((s: string) => void) | null = null
let stdinClosed = false

function ensureReader() {
  if (lineRl || stdinClosed) return
  lineRl = createInterface({ input: process.stdin })
  lineRl.on('line', (l) => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l.trim()) }
    else lineQueue.push(l.trim())
  })
  lineRl.on('close', () => {
    stdinClosed = true
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w('') }
  })
}

function closePrompts() {
  lineRl?.close()
  lineRl = null
}

function ask(question: string): Promise<string> {
  process.stderr.write(question)
  ensureReader()
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!)
  if (stdinClosed) return Promise.resolve('')
  return new Promise((resolve) => { lineWaiter = resolve })
}

/** Masked key prompt — echoes * per char (keys get pasted on shared screens). */
function askSecret(question: string): Promise<string> {
  const { stdin, stderr } = process
  // Piped input (or anything already buffered) — plain queued read.
  if (!stdin.isTTY || lineQueue.length) return ask(question)
  // Raw-mode masked read. Pause the queue reader so both aren't consuming.
  lineRl?.pause()
  stderr.write(question)
  return new Promise((resolve) => {
    let buf = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.removeListener('data', onData)
        lineRl?.resume()
        stderr.write('\n'); resolve(buf.trim())
      } else if (ch === '\u0003') { // ^C
        stdin.setRawMode(false); stdin.pause(); stderr.write('\n'); process.exit(130)
      } else if (ch === '\u007f' || ch === '\b') {
        if (buf) { buf = buf.slice(0, -1); stderr.write('\b \b') }
      } else {
        buf += ch; stderr.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

// ── cloud sync ──────────────────────────────────────────────────────────────

/** Push every local provider + voice to the cloud. Quiet on failure —
 *  sync is a convenience, the local config is already saved. */
export async function pushToCloud(api: TinyApi, store: ModelConfigStore): Promise<{ pushed: number; error?: string }> {
  if (!api.authenticated) return { pushed: 0, error: 'not logged in' }
  let pushed = 0
  try {
    for (const p of Object.values(store.providers)) {
      const body: any = {
        provider: p.provider,
        modelId: p.modelId || '',
        baseUrl: p.baseUrl || '',
        region: p.region || '',
        maxTokens: p.maxTokens ? String(p.maxTokens) : '',
        additionalFields: p.additionalFields || '',
        isActive: store.active === p.provider,
      }
      if (p.apiKey !== undefined) body.apiKey = p.apiKey
      const r = await api.post('/api/model-providers', body)
      if (r?.ok === false) return { pushed, error: r.error || 'push failed' }
      pushed++
    }
    if (store.voice !== undefined) {
      await api.post('/api/account-voice', { voice: store.voice })
    }
    store.lastSync = Math.floor(Date.now() / 1000)
    saveModelConfig(store)
    return { pushed }
  } catch (e: any) {
    return { pushed, error: e?.message || String(e) }
  }
}

/** Pull cloud providers + voice and merge into the local store.
 *  Cloud rows win for providers we don't have; both sides keep working. */
export async function pullFromCloud(api: TinyApi, store: ModelConfigStore): Promise<{ pulled: number; error?: string }> {
  if (!api.authenticated) return { pulled: 0, error: 'not logged in' }
  try {
    const r = await api.get('/api/model-providers?full=1')
    if (r?.ok === false) return { pulled: 0, error: r.error || 'pull failed' }
    const now = Math.floor(Date.now() / 1000)
    let pulled = 0
    for (const p of (r.providers || [])) {
      const local = store.providers[p.provider]
      // cloud wins unless the local row was touched after our last sync
      if (local && local.updatedAt > store.lastSync) continue
      store.providers[p.provider] = {
        provider: p.provider,
        apiKey: p.apiKey || local?.apiKey || '',
        modelId: p.modelId || '',
        baseUrl: p.baseUrl || '',
        region: p.region || '',
        maxTokens: Number(p.maxTokens || 0) || undefined,
        additionalFields: p.additionalFields || '',
        updatedAt: now,
      }
      if (p.isActive) store.active = p.provider
      pulled++
    }
    try {
      const v = await api.get('/api/account-voice')
      if (v?.ok && typeof v.voice === 'string' && v.voice) store.voice = v.voice
    } catch { /* voice pull optional */ }
    store.lastSync = now
    saveModelConfig(store)
    return { pulled }
  } catch (e: any) {
    return { pulled: 0, error: e?.message || String(e) }
  }
}

// ── the wizard ──────────────────────────────────────────────────────────────

export interface OnboardOpts {
  /** pull-only / push-only shortcuts (`tiny-tech sync`) */
  mode?: 'wizard' | 'push' | 'pull' | 'status'
}

export async function runOnboard(api: TinyApi, opts: OnboardOpts = {}): Promise<void> {
  try {
    return await runOnboardInner(api, opts)
  } finally {
    closePrompts() // release stdin — a held readline keeps the process alive
  }
}

async function runOnboardInner(api: TinyApi, opts: OnboardOpts = {}): Promise<void> {
  const err = (s: string) => process.stderr.write(s)
  const store = loadModelConfig()
  const mode = opts.mode || 'wizard'

  if (mode === 'status') {
    const names = Object.keys(store.providers)
    err(`model config (${modelConfigPath()}):\n`)
    if (!names.length) err('  no providers configured — run `tiny-tech onboard`\n')
    for (const n of names) {
      const p = store.providers[n]
      const star = store.active === n ? '★' : '•'
      err(`  ${star} ${n}${p.modelId ? ` (${p.modelId})` : ''}${p.apiKey ? ' — key set' : ''}${p.region ? ` [${p.region}]` : ''}\n`)
    }
    err(`  voice: ${store.voice || '(default)'}\n`)
    err(`  last sync: ${store.lastSync ? new Date(store.lastSync * 1000).toISOString() : 'never'}\n`)
    return
  }

  if (mode === 'push') {
    const r = await pushToCloud(api, store)
    err(r.error ? `push failed: ${r.error}\n` : `✓ pushed ${r.pushed} provider(s) + voice to ${apiHost()}\n`)
    return
  }

  if (mode === 'pull') {
    const r = await pullFromCloud(api, store)
    err(r.error ? `pull failed: ${r.error}\n` : `✓ pulled ${r.pulled} provider(s) from ${apiHost()}\n`)
    if (!r.error) applyModelEnv()
    return
  }

  // ── wizard ──
  err('\n🍕 Model providers — pick as many as you like; one is active.\n')
  err('   (stored 0600 at ~/.tiny/model-config.json, synced to your tiny account)\n\n')

  // Cloud-first: if the account already has providers, offer to just pull.
  if (api.authenticated && !Object.keys(store.providers).length) {
    try {
      const r = await api.get('/api/model-providers')
      if (r?.ok && r.providers?.length) {
        err(`Found ${r.providers.length} provider(s) on your tiny account: ${r.providers.map((p: any) => p.provider).join(', ')}\n`)
        const yn = await ask('Pull them to this machine? [Y/n] ')
        if (!yn || /^y/i.test(yn)) {
          const pr = await pullFromCloud(api, store)
          err(pr.error ? `pull failed: ${pr.error}\n` : `✓ pulled ${pr.pulled} provider(s)\n`)
        }
      }
    } catch { /* offline — wizard continues */ }
  }

  // Provider loop — "add another?" until done.
  for (;;) {
    err('\nProviders:\n')
    PROVIDERS.forEach((p, i) => {
      const have = store.providers[p.id]
      const mark = store.active === p.id ? '★' : have ? '✓' : ' '
      err(`  ${String(i + 1).padStart(2)}. ${mark} ${p.label}\n`)
    })
    const pick = await ask('\nProvider number (Enter = done): ')
    if (!pick) break
    const idx = Number(pick) - 1
    const def = PROVIDERS[idx]
    if (!def) { err('  ?\n'); continue }

    const existing = store.providers[def.id]
    let apiKey = existing?.apiKey || ''
    if (def.id !== 'ollama') {
      const entered = await askSecret(`  ${def.label} API key${existing?.apiKey ? ' (Enter = keep current)' : def.keyHint ? ` (${def.keyHint})` : ''}: `)
      if (entered) apiKey = entered
    }
    let region = existing?.region || ''
    if (def.extra === 'region') {
      region = (await ask(`  region [${existing?.region || 'us-east-1'}]: `)) || existing?.region || 'us-east-1'
    }
    let baseUrl = existing?.baseUrl || ''
    if (def.extra === 'baseUrl') {
      baseUrl = (await ask(`  base URL${existing?.baseUrl ? ` [${existing.baseUrl}]` : ' (https://host/v1)'}: `)) || existing?.baseUrl || ''
    }
    const modelId = (await ask(`  model id (Enter = default): `)) || existing?.modelId || ''

    store.providers[def.id] = {
      provider: def.id,
      apiKey,
      modelId,
      baseUrl,
      region,
      updatedAt: Math.floor(Date.now() / 1000),
    }
    if (!store.active) store.active = def.id
    saveModelConfig(store)
    err(`  ✓ ${def.label} saved\n`)
  }

  // Active pick (only if there's a choice to make)
  const names = Object.keys(store.providers)
  if (names.length > 1) {
    err(`\nConfigured: ${names.map((n) => (n === store.active ? `★${n}` : n)).join(', ')}\n`)
    const a = await ask(`Active provider [${store.active}]: `)
    if (a && store.providers[a]) store.active = a
  }

  // Voice
  err(`\n🎙️  Voice for live calls: ${VOICES.join(', ')}\n`)
  const v = await ask(`Voice [${store.voice || 'marin'}]: `)
  if (v && (VOICES as readonly string[]).includes(v)) store.voice = v
  else if (!store.voice) store.voice = ''

  store.onboarded = true
  saveModelConfig(store)
  err(`\n✓ saved ${modelConfigPath()}\n`)

  // Sync up
  if (api.authenticated) {
    const r = await pushToCloud(api, store)
    err(r.error
      ? `⚠ cloud sync failed (${r.error}) — config is saved locally; run \`tiny-tech sync\` later\n`
      : `✓ synced to ${apiHost()} — your other devices will pick this up\n`)
  } else {
    err('· not logged in — run `tiny-tech login` then `tiny-tech sync` to sync across devices\n')
  }

  applyModelEnv()
  if (store.active) err(`\nActive: ${store.active}${store.providers[store.active]?.modelId ? `:${store.providers[store.active].modelId}` : ''} — try \`tiny-tech\`\n`)
}
