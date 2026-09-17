/**
 * Backend configuration — the ONE place the CLI learns where its tiny lives.
 *
 * tiny-tech talks to two origins: the web app (every authenticated `/api/*`
 * call, the login page) and the app's worker (three public reads — /retrieve,
 * /list, /tools/browse — and the media-store allowlist). Both used to be
 * literals scattered over ~50 call sites, which made the published CLI usable
 * against exactly one deployment. Now there is one resolved setting, the app
 * URL, looked up in this order:
 *
 *   1. `--api <url>` (or `--api=<url>`) anywhere on the command line
 *   2. `TINY_API_URL` in the environment
 *   3. `~/.tiny/config.json` → `api` (written by `tiny-tech init <url>`)
 *   4. the origin an earlier `login` / device enrollment recorded
 *      (`credentials.json` / `device.json` → `apiUrl`)
 *   5. the public deployment, https://tiny.technology — so a fresh
 *      `npx tiny-tech login` keeps working with zero configuration.
 *
 * The worker origin is DERIVED: `TINY_WORKER_URL` → config.json `worker` →
 * the deployment's own answer at `GET <api>/api/health` (`workerUrl`, cached by
 * `init`) → a built-in entry for the public deployment. A self-hosted backend
 * (tiny-vercel) advertises its worker on /api/health, so `tiny-tech init
 * https://my-tiny.vercel.app` is the whole switch.
 *
 * All human-facing output goes to stderr — stdout belongs to MCP stdio.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** The public deployment — the default when nothing else names a backend. */
export const DEFAULT_API_URL = 'https://tiny.technology'

/**
 * Worker origins for deployments that do not (yet) publish `workerUrl` on
 * /api/health. Keyed by app origin.
 */
const KNOWN_WORKERS: Record<string, string> = {
  'https://tiny.technology': 'https://plugin.tiny.technology',
}

export interface DeploymentConfig {
  version: 1
  /** Origin of the web app, no trailing slash. */
  api: string
  /** Origin of the worker the app advertised (or the user pinned), no trailing slash. */
  worker?: string
  /** The deployment's display name (from /api/health `siteName`). */
  siteName?: string
  /** Unix seconds of the last write. */
  updatedAt: number
}

export type ConfigSource = 'flag' | 'env' | 'config' | 'credentials' | 'device' | 'default'

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

export function configPath(): string {
  return join(tinyHome(), 'config.json')
}

/** Trim whitespace and trailing slashes; add https:// when the scheme is missing. Throws on garbage. */
export function normalizeApiUrl(input: string): string {
  let s = String(input ?? '').trim()
  if (!s) throw new Error('empty URL')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  const u = new URL(s)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported scheme ${u.protocol}`)
  if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|.*\.local|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*)$/.test(u.hostname)) {
    throw new Error('plain http is only allowed for localhost / LAN hosts — your token would travel in the clear')
  }
  // Origin only: a pasted deep link (…/devices) must not become the API base.
  return u.origin
}

export function readConfig(): DeploymentConfig | null {
  try {
    const c = JSON.parse(readFileSync(configPath(), 'utf8')) as DeploymentConfig
    return c && typeof c.api === 'string' && c.api ? c : null
  } catch {
    return null
  }
}

export function writeConfig(partial: Omit<DeploymentConfig, 'version' | 'updatedAt'>): DeploymentConfig {
  const prev = readConfig()
  const next: DeploymentConfig = {
    version: 1,
    ...(prev || {}),
    ...partial,
    api: normalizeApiUrl(partial.api),
    updatedAt: Math.floor(Date.now() / 1000),
  }
  if (next.worker) next.worker = normalizeApiUrl(next.worker)
  else delete next.worker
  mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(configPath(), 0o600) } catch {}
  return next
}

/** `--api <url>` or `--api=<url>` anywhere in argv; the pair is removed so command parsing never sees it. */
export function takeApiFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--api') {
      const v = argv[i + 1]
      argv.splice(i, v === undefined ? 1 : 2)
      if (v === undefined) throw new Error('--api needs a URL, e.g. --api https://my-tiny.vercel.app')
      return v
    }
    if (a.startsWith('--api=')) {
      argv.splice(i, 1)
      return a.slice('--api='.length)
    }
  }
  return undefined
}

let flagValue: string | undefined
/** Called once by the CLI entry with the parsed `--api` value. Throws on a malformed URL. */
export function setApiFlag(value: string | undefined): void {
  flagValue = value ? normalizeApiUrl(value) : undefined
}

function readJsonField(file: string, key: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(tinyHome(), file), 'utf8'))?.[key]
    return typeof v === 'string' && v ? normalizeApiUrl(v) : null
  } catch {
    return null
  }
}

/** The app URL and where it came from. Never prompts, never throws. */
export function resolveApiUrl(): { api: string; source: ConfigSource } {
  if (flagValue) return { api: flagValue, source: 'flag' }
  const env = (process.env.TINY_API_URL || '').trim()
  if (env) {
    try { return { api: normalizeApiUrl(env), source: 'env' } } catch { /* fall through */ }
  }
  const cfg = readConfig()
  if (cfg) return { api: cfg.api, source: 'config' }
  const creds = readJsonField('credentials.json', 'apiUrl')
  if (creds) return { api: creds, source: 'credentials' }
  const dev = readJsonField('device.json', 'apiUrl')
  if (dev) return { api: dev, source: 'device' }
  return { api: DEFAULT_API_URL, source: 'default' }
}

/** The app URL — always defined (falls back to the public deployment). */
export function apiUrl(): string {
  return resolveApiUrl().api
}

/**
 * The app URL for a record (credentials / device identity) that already names
 * its origin: an explicit setting (flag, env, config.json) wins so a machine can
 * be repointed, otherwise the record's own origin — a token is only valid where
 * it was issued.
 */
export function apiUrlFor(recordUrl?: string | null): string {
  const r = resolveApiUrl()
  if (r.source === 'flag' || r.source === 'env' || r.source === 'config') return r.api
  if (recordUrl) { try { return normalizeApiUrl(recordUrl) } catch { /* fall through */ } }
  return r.api
}

/** Bare host of the configured app, for prose: "logged in to <host>". */
export function apiHost(): string {
  const { api } = resolveApiUrl()
  try { return new URL(api).host } catch { return api }
}

/** True when the CLI is pointed somewhere other than the public deployment. */
export function isCustomBackend(): boolean {
  return apiUrl() !== DEFAULT_API_URL
}

/**
 * The worker origin, or null when unknown. `TINY_WORKER_URL` wins; then the
 * value `init` cached; then the built-in table. Callers that can afford a
 * network round trip use `discoverWorker()` to fill a null.
 */
export function workerUrl(): string | null {
  const env = (process.env.TINY_WORKER_URL || '').trim()
  if (env) {
    try { return normalizeApiUrl(env) } catch { /* ignore a malformed override */ }
  }
  const api = apiUrl()
  const cfg = readConfig()
  // config.json's worker only applies to the api it was learned for — a stale
  // cache from an earlier deployment must not leak into `--api <other>`.
  if (cfg?.worker && cfg.api === api) return cfg.worker
  return KNOWN_WORKERS[api] || null
}

export interface HealthInfo {
  ok: boolean
  service?: string
  siteName?: string
  workerUrl?: string | null
}

/**
 * Ask the app who it is. `GET <api>/api/health` is unauthenticated on
 * tiny-vercel deployments and on tiny.technology; a non-JSON or non-`service:web`
 * answer means the URL is not a tiny backend (or not yet deployed).
 */
export async function probeDeployment(api: string, timeoutMs = 8000): Promise<HealthInfo> {
  const res = await fetch(`${api}/api/health`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'tiny-tech' },
  })
  if (!res.ok) throw new Error(`${api}/api/health answered ${res.status}`)
  const body: any = await res.json().catch(() => null)
  if (!body || body.ok !== true || body.service !== 'web') {
    throw new Error(`${api} does not look like a tiny backend (no ok:true/service:web from /api/health)`)
  }
  return {
    ok: true,
    service: body.service,
    siteName: typeof body.siteName === 'string' ? body.siteName : undefined,
    workerUrl: typeof body.workerUrl === 'string' && body.workerUrl ? body.workerUrl : null,
  }
}

/**
 * Fill in the worker origin from the app when nothing local knows it, and
 * remember it in config.json. Null when the deployment does not advertise one.
 */
export async function discoverWorker(): Promise<string | null> {
  const known = workerUrl()
  if (known) return known
  const { api, source } = resolveApiUrl()
  try {
    const info = await probeDeployment(api)
    // Remember it only when the api itself is the persistent one — a one-off
    // `--api <url>` or TINY_API_URL must not repoint every later run.
    if ((info.workerUrl || info.siteName) && (source === 'config' || source === 'default')) {
      writeConfig({ api, worker: info.workerUrl || undefined, siteName: info.siteName })
    }
    return info.workerUrl ? normalizeApiUrl(info.workerUrl) : null
  } catch {
    return null
  }
}

/** The worker origin for a public read; throws with the fix spelled out when there is none. */
export async function requireWorkerUrl(): Promise<string> {
  const w = await discoverWorker()
  if (w) return w
  throw new Error(
    `${apiHost()} does not advertise a worker URL (its /api/health has no workerUrl). ` +
    'Set TINY_WORKER_URL, or `tiny-tech init <api> --worker <url>`. Public reads like search/list/tools need it.',
  )
}

/**
 * `tiny-tech init [url] [--worker <url>]` — probe the deployment, then write
 * config.json with the app URL, the worker it advertises and its display name.
 * With no URL and a terminal, ask. `init` with no URL and no terminal points
 * the machine back at the public deployment.
 */
export async function init(urlArg?: string, opts: { worker?: string } = {}): Promise<DeploymentConfig> {
  const api = normalizeApiUrl(urlArg ?? await promptForApiUrl())
  const pinnedWorker = opts.worker ? normalizeApiUrl(opts.worker) : undefined
  process.stderr.write(`Checking ${api}/api/health …\n`)
  let info: HealthInfo | null = null
  try {
    info = await probeDeployment(api)
  } catch (e: any) {
    // The public deployment may predate /api/health; anything else must answer.
    if (!KNOWN_WORKERS[api]) throw e
    process.stderr.write(`  (${e.message} — using the built-in entry for ${new URL(api).host})\n`)
  }
  const worker = pinnedWorker || info?.workerUrl || KNOWN_WORKERS[api] || undefined
  const cfg = writeConfig({ api, worker, siteName: info?.siteName })
  process.stderr.write(`✓ ${cfg.siteName || new URL(cfg.api).host} at ${cfg.api}` +
    (cfg.worker ? ` · worker ${cfg.worker}` : ' · (no worker advertised — search/list will need TINY_WORKER_URL)') +
    `\n  saved to ${configPath()}\n`)
  return cfg
}

async function promptForApiUrl(): Promise<string> {
  if (!process.stdin.isTTY) return DEFAULT_API_URL
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (;;) {
      const answer: string = await new Promise((resolve) =>
        rl.question(`Where is your tiny? [${DEFAULT_API_URL}] `, resolve))
      try {
        return normalizeApiUrl(answer.trim() || DEFAULT_API_URL)
      } catch (e: any) {
        process.stderr.write(`  ${e.message} — try again\n`)
      }
    }
  } finally {
    rl.close()
  }
}

/** True when a config.json exists. */
export function isConfigured(): boolean {
  return existsSync(configPath()) && readConfig() !== null
}
