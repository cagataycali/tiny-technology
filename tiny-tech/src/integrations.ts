/**
 * App connections — the second, optional onboarding step.
 *
 * Step 1 (`tiny-tech login`) is identity: who you are on tiny.technology.
 * Step 2 (`tiny-tech connect`) is reach: Google, Spotify, Telegram, WhatsApp.
 * Everything here is SKIPPABLE. tiny works without any of it; each connection
 * just adds a tool, and the agent's toolset already mirrors what this machine
 * can actually do.
 *
 * Before this existed the device tools were reachable only by exporting env
 * vars in your shell — which meant they silently didn't exist for anyone who
 * never read the README. Now the answers live in ~/.tiny/integrations.json
 * (0600, same posture as credentials.json) and are applied to process.env at
 * startup, so a connection survives a new terminal.
 *
 * A real `export` always wins over the stored value: someone who sets
 * SPOTIFY_CLIENT_ID for one run is overriding on purpose, and a config file
 * that quietly beat their env would be the wrong kind of surprise.
 */
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ServiceKey = 'google' | 'spotify' | 'telegram' | 'whatsapp'

export interface IntegrationStore {
  version: 1
  /** Per-service env values, stored under their real env-var names. */
  services: Partial<Record<ServiceKey, Record<string, string>>>
}

export interface ServiceStatus {
  key: ServiceKey
  label: string
  /** ready = the tool will register; partial = configured but not authorized. */
  state: 'ready' | 'partial' | 'missing'
  detail: string
  /** What connecting unlocks — shown while deciding whether to bother. */
  unlocks: string
}

export const SERVICE_LABELS: Record<ServiceKey, string> = {
  google: 'Google',
  spotify: 'Spotify',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
}

const UNLOCKS: Record<ServiceKey, string> = {
  google: 'Gmail, Calendar, Drive, Sheets, Docs, YouTube — every Google API (use_google)',
  spotify: 'search, playback, queue, playlists, your library (use_spotify)',
  telegram: 'send messages and read updates as your bot (use_telegram)',
  whatsapp: 'your chats, search, media and sending (use_whatsapp)',
}

export const SERVICE_KEYS = Object.keys(SERVICE_LABELS) as ServiceKey[]

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

export function integrationsPath(): string {
  return join(tinyHome(), 'integrations.json')
}

export function loadIntegrations(): IntegrationStore {
  try {
    const raw = JSON.parse(readFileSync(integrationsPath(), 'utf-8'))
    if (raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object') {
      return { version: 1, services: raw.services }
    }
  } catch { /* absent or unreadable — nothing connected yet */ }
  return { version: 1, services: {} }
}

/** Merge values into one service's entry; empty values remove the key. */
export function saveIntegration(key: ServiceKey, values: Record<string, string>): void {
  const store = loadIntegrations()
  const merged = { ...(store.services[key] || {}) }
  for (const [k, v] of Object.entries(values)) {
    if (v) merged[k] = v
    else delete merged[k]
  }
  if (Object.keys(merged).length) store.services[key] = merged
  else delete store.services[key]

  mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  writeFileSync(integrationsPath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(integrationsPath(), 0o600) } catch { /* best effort on odd filesystems */ }
  applyStoredEnv() // so the current process sees it without a restart
}

export function forgetIntegration(key: ServiceKey): boolean {
  const store = loadIntegrations()
  if (!store.services[key]) return false
  delete store.services[key]
  if (Object.keys(store.services).length) {
    writeFileSync(integrationsPath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  } else {
    try { unlinkSync(integrationsPath()) } catch { /* already gone */ }
  }
  return true
}

/**
 * Put stored values into process.env for anything that reads env vars —
 * which is every tool module, deliberately, so they stay independent of this
 * file and keep working for people who only ever export shell variables.
 */
export function applyStoredEnv(): string[] {
  const applied: string[] = []
  for (const values of Object.values(loadIntegrations().services)) {
    for (const [k, v] of Object.entries(values || {})) {
      if (!process.env[k] && v) { process.env[k] = v; applied.push(k) }
    }
  }
  return applied
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * Where each service stands. Loaded lazily: the tool modules pull in the
 * Strands SDK, and `tiny-tech login` shouldn't pay for that.
 */
export async function serviceStatuses(): Promise<ServiceStatus[]> {
  applyStoredEnv()
  const [google, spotify, whatsapp] = await Promise.all([
    import('./agent/google.js'),
    import('./agent/spotify.js'),
    import('./agent/whatsapp.js'),
  ])

  const out: ServiceStatus[] = []

  // Google: a credential of any kind means the tool registers; a client id
  // with no token is the half-done state (`connect` finished, login didn't).
  const gsource = google.credentialSource()
  out.push({
    key: 'google', label: SERVICE_LABELS.google, unlocks: UNLOCKS.google,
    state: gsource ? 'ready' : (googleClientConfigured() ? 'partial' : 'missing'),
    // The path oauthCredsPath() picked, not ours — a shared DevDuck/
    // strands_google token is a legitimate source and naming the wrong file
    // sends someone editing a path that isn't in play.
    detail: gsource === 'oauth' ? `authorized (${google.oauthCredsPath()})`
      : gsource === 'service_account' ? 'service account'
      : gsource === 'api_key' ? 'API key only — public APIs, no personal data'
      : googleClientConfigured() ? "OAuth client set, not authorized yet — run `tiny-tech connect google`"
      : 'not connected',
  })

  out.push({
    key: 'spotify', label: SERVICE_LABELS.spotify, unlocks: UNLOCKS.spotify,
    state: spotify.hasSpotifyWebApi() ? 'ready' : (spotify.hasSpotify() ? 'partial' : 'missing'),
    detail: spotify.hasSpotifyWebApi() ? 'authorized — full account access'
      : spotify.hasSpotify() ? 'this Mac\'s Spotify app only — connect for your whole account'
      : 'not connected',
  })

  out.push({
    key: 'telegram', label: SERVICE_LABELS.telegram, unlocks: UNLOCKS.telegram,
    state: process.env.TELEGRAM_BOT_TOKEN ? 'ready' : 'missing',
    detail: process.env.TELEGRAM_BOT_TOKEN ? 'bot token set' : 'not connected',
  })

  const w = whatsapp.whatsappState()
  out.push({
    key: 'whatsapp', label: SERVICE_LABELS.whatsapp, unlocks: UNLOCKS.whatsapp,
    state: w === 'ready' ? 'ready' : w === 'missing' ? 'missing' : 'partial',
    detail: w === 'ready' ? 'linked and authorized'
      : w === 'unauthorized' ? 'wacli installed, device not linked — run `wacli auth`'
      : 'wacli not installed (https://github.com/steipete/wacli)',
  })

  return out
}

function googleClientConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT
    || (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET))
}

const MARK = { ready: '✓', partial: '◐', missing: '·' } as const

export function renderStatuses(statuses: ServiceStatus[]): string {
  const width = Math.max(...statuses.map((s) => s.label.length))
  return statuses
    .map((s) => `  ${MARK[s.state]} ${s.label.padEnd(width)}  ${s.detail}`)
    .join('\n')
}

// ── the wizard ──────────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `))
}

const say = (s: string) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`)

/**
 * Connect one service. Each returns a human line; nothing throws for "the user
 * changed their mind" — an empty answer at any prompt means skip, since this
 * whole step is optional and a half-answered wizard shouldn't leave junk in
 * the store.
 */
async function connectGoogle(): Promise<string> {
  const { credentialSource, defaultScopes, googleLogin } = await import('./agent/google.js')

  say('\nGoogle needs a Desktop-app OAuth client (yours, so your data never passes through us):')
  say('  1. https://console.cloud.google.com/apis/credentials')
  say('  2. Create credentials → OAuth client ID → Application type: Desktop app')
  say('  3. Download the JSON, or copy the client ID + secret')
  say('  Enable the APIs you want (Gmail, Calendar, Drive, …) for that project.\n')

  const first = await ask('Path to client_secret*.json (or paste the client ID, blank to skip): ')
  if (!first) return 'Google skipped'

  if (first.includes('/') || first.endsWith('.json')) {
    const path = first.replace(/^~(?=\/)/, homedir())
    if (!existsSync(path)) return `Google skipped — no file at ${path}`
    saveIntegration('google', { GOOGLE_OAUTH_CLIENT: path })
  } else {
    const secret = await ask('Client secret: ')
    if (!secret) return 'Google skipped — no client secret'
    saveIntegration('google', { GOOGLE_OAUTH_CLIENT_ID: first, GOOGLE_OAUTH_CLIENT_SECRET: secret })
  }

  if (!(await confirm('Authorize now in the browser?'))) {
    return 'Google client saved — run `tiny-tech connect google` when you want to authorize'
  }
  const path = await googleLogin(defaultScopes())
  return `Google connected (${credentialSource()}) — token at ${path}`
}

async function connectSpotify(): Promise<string> {
  say('\nSpotify needs an app of your own:')
  say('  1. https://developer.spotify.com/dashboard → Create app')
  say('  2. Redirect URI: http://127.0.0.1:8888/callback  (exactly this)')
  say('  3. Copy the Client ID and Client secret\n')

  const id = await ask('Client ID (blank to skip): ')
  if (!id) return 'Spotify skipped'
  const secret = await ask('Client secret: ')
  if (!secret) return 'Spotify skipped — no client secret'
  const redirect = await ask('Redirect URI [http://127.0.0.1:8888/callback]: ')
  saveIntegration('spotify', {
    SPOTIFY_CLIENT_ID: id,
    SPOTIFY_CLIENT_SECRET: secret,
    SPOTIFY_REDIRECT_URI: redirect || 'http://127.0.0.1:8888/callback',
  })

  if (!(await confirm('Authorize now in the browser?'))) {
    return 'Spotify app saved — run `tiny-tech connect spotify` when you want to authorize'
  }
  const { spotifyLogin } = await import('./agent/spotify.js')
  return `Spotify connected — token at ${await spotifyLogin()}`
}

async function connectTelegram(): Promise<string> {
  say('\nTelegram: message @BotFather → /newbot → it hands you a token.\n')
  const token = await ask('Bot token (blank to skip): ')
  if (!token) return 'Telegram skipped'

  // Verify before storing — a typo'd token otherwise fails much later, inside
  // a tool call, looking like a Telegram outage.
  const who: any = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    .then((r) => r.json()).catch(() => null)
  if (!who?.ok) return `Telegram rejected that token (${who?.description || 'no response'}) — not saved`
  saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: token })
  return `Telegram connected as @${who.result?.username}`
}

async function connectWhatsapp(): Promise<string> {
  const { whatsappState } = await import('./agent/whatsapp.js')
  const state = whatsappState()
  if (state === 'ready') return 'WhatsApp already linked'
  if (state === 'missing') {
    say('\nWhatsApp needs wacli — install it from https://github.com/steipete/wacli, then re-run this.\n')
    return 'WhatsApp skipped — wacli not installed'
  }

  say('\nWhatsApp links like WhatsApp Web: `wacli auth` shows a QR code you scan')
  say('with your phone (Settings → Linked devices). Everything stays on this machine.\n')
  if (!(await confirm('Run `wacli auth` now?'))) return 'WhatsApp skipped'

  // Hand our terminal over — the QR needs a real TTY, and capturing the output
  // would just render an unscannable grid of escape codes.
  const { spawnSync } = await import('node:child_process')
  const bin = process.env.WACLI_BINARY || 'wacli'
  const r = spawnSync(bin, ['auth'], { stdio: 'inherit' })
  if (r.error) return `WhatsApp: couldn't run ${bin} — ${r.error.message}`
  return whatsappState() === 'ready'
    ? 'WhatsApp connected'
    : 'WhatsApp not linked yet — re-run `wacli auth` and scan the QR'
}

const CONNECTORS: Record<ServiceKey, () => Promise<string>> = {
  google: connectGoogle,
  spotify: connectSpotify,
  telegram: connectTelegram,
  whatsapp: connectWhatsapp,
}

export function isServiceKey(value: string): value is ServiceKey {
  return (SERVICE_KEYS as string[]).includes(value)
}

/**
 * `tiny-tech connect [service]`. With no service, walks the ones that aren't
 * ready yet, asking before each — so it's a tour you can decline item by item
 * rather than an all-or-nothing gate.
 */
export async function runConnect(service?: string): Promise<void> {
  applyStoredEnv()

  if (service && !isServiceKey(service)) {
    say(`Unknown service: ${service} (${SERVICE_KEYS.join(', ')})`)
    process.exitCode = 1
    return
  }

  if (service) {
    say(await CONNECTORS[service as ServiceKey]())
    say(`\n${renderStatuses(await serviceStatuses())}`)
    return
  }

  const statuses = await serviceStatuses()
  say('Connect your apps — optional, and you can stop any time.\n')
  say(renderStatuses(statuses))

  const pending = statuses.filter((s) => s.state !== 'ready')
  if (!pending.length) {
    say('\nEverything is connected.')
    return
  }
  if (!process.stdin.isTTY) {
    say(`\nRun \`npx tiny-tech connect <${pending.map((s) => s.key).join('|')}>\` from a terminal to connect one.`)
    return
  }

  const results: string[] = []
  for (const s of pending) {
    say('')
    if (!(await confirm(`Connect ${s.label}? — ${s.unlocks}`))) {
      results.push(`${s.label} skipped`)
      continue
    }
    try {
      results.push(await CONNECTORS[s.key]())
    } catch (e: any) {
      // One service failing shouldn't abandon the rest of the tour.
      results.push(`${s.label} failed: ${String(e?.message || e).slice(0, 200)}`)
    }
  }

  say(`\n${results.map((r) => `  ${r}`).join('\n')}`)
  say(`\n${renderStatuses(await serviceStatuses())}`)
  say('\nChange any of it later with `npx tiny-tech connect <service>`.')
}

/** The nudge printed after `tiny-tech login` — one line, easy to ignore. */
export async function connectHint(): Promise<string> {
  const pending = (await serviceStatuses()).filter((s) => s.state !== 'ready')
  if (!pending.length) return ''
  return `Optional: connect ${pending.map((s) => s.label).join(', ')} with \`npx tiny-tech connect\``
}
