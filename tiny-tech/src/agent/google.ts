/**
 * use_google — every Google API, from the discovery documents.
 *
 * strands_google's use_google.py ported to TypeScript. Python leaned on
 * google-api-python-client + google-auth; both are pip-only, and tiny-tech
 * must stay `npx`-installable with no build step. So this does what those
 * libraries do, over `fetch` and `node:crypto`:
 *
 *   discovery  GET /discovery/v1/apis/{service}/{version}/rest describes every
 *              resource, method, path template and parameter location, so ONE
 *              tool covers Gmail/Drive/Calendar/Sheets/YouTube/… with no
 *              hand-written per-API surface and nothing to keep in sync.
 *   oauth      refresh_token grant, refreshed lazily and written back
 *   service    RS256 JWT-bearer assertion signed with crypto.sign — the whole
 *   account    of google-auth's service-account flow is 20 lines without it
 *   api key    ?key= for public APIs
 *
 * The request builders are pure and unit-tested; only auth and fetch touch the
 * network, which is why CI can cover the part that decides where a call goes.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { createHash, randomBytes, sign as cryptoSign } from 'node:crypto'
import { createServer } from 'node:http'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis'

/** Methods that change something on Google's side — gated behind `confirm`. */
export const MUTATIVE_METHODS = [
  'create', 'insert', 'update', 'patch', 'delete', 'trash', 'untrash', 'remove',
  'send', 'modify', 'batchmodify', 'batchdelete', 'batchupdate', 'import',
  'copy', 'move', 'stop', 'clear', 'append', 'add', 'set', 'rename',
]

/** Does this method name change state? Compared on the leaf name only. */
export function isMutative(method: string): boolean {
  const leaf = method.split('.').pop()!.toLowerCase()
  return MUTATIVE_METHODS.includes(leaf)
}

export function discoveryUrl(service: string, version: string): string {
  return `${DISCOVERY}/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`
}

// ── discovery documents ─────────────────────────────────────────────────────

export interface MethodSpec {
  id?: string
  path: string
  httpMethod: string
  parameters?: Record<string, { location?: string; required?: boolean; type?: string }>
  request?: unknown
  description?: string
}

export interface DiscoveryDoc {
  baseUrl?: string
  rootUrl?: string
  servicePath?: string
  resources?: Record<string, DiscoveryResource>
  methods?: Record<string, MethodSpec>
}

interface DiscoveryResource {
  resources?: Record<string, DiscoveryResource>
  methods?: Record<string, MethodSpec>
}

/**
 * Walk a dotted resource path ('users.messages') and pull one method off it.
 * A bad name is the most common caller mistake, so the error carries the names
 * that DO exist at the level that failed — one round trip instead of guessing.
 */
export function resolveMethod(doc: DiscoveryDoc, resource: string, method: string): MethodSpec {
  let node: DiscoveryResource = doc
  const walked: string[] = []
  for (const part of resource.split('.').filter(Boolean)) {
    const next = node.resources?.[part]
    if (!next) {
      const available = Object.keys(node.resources || {}).sort().join(', ')
      const where = walked.length ? `'${walked.join('.')}'` : 'this API'
      throw new Error(`no resource '${part}' on ${where}. Available: ${available || '(none)'}`)
    }
    node = next
    walked.push(part)
  }
  const spec = node.methods?.[method]
  if (!spec) {
    const available = Object.keys(node.methods || {}).sort().join(', ')
    throw new Error(`no method '${method}' on '${resource}'. Available: ${available || '(none)'}`)
  }
  return spec
}

export interface BuiltRequest {
  url: string
  httpMethod: string
  body?: unknown
}

/**
 * Turn (doc, method, params) into an actual HTTP request.
 *
 * Discovery declares where each parameter belongs — `location: 'path'` gets
 * substituted into the template, everything else is a query parameter. Getting
 * this wrong is silent: a path param sent as a query param yields a 404 on a
 * URL that looks almost right, so the placement is data-driven, never guessed.
 *
 * `{+name}` (Drive, Cloud Storage) is a reserved-expansion template: the value
 * may contain slashes that must stay slashes, so it skips segment encoding.
 */
export function buildRequest(
  doc: DiscoveryDoc,
  spec: MethodSpec,
  params: Record<string, unknown> = {},
): BuiltRequest {
  const base = doc.baseUrl || `${doc.rootUrl || 'https://www.googleapis.com/'}${doc.servicePath || ''}`
  const rest = { ...params }
  const body = 'body' in rest ? rest.body : undefined
  delete rest.body

  const missing: string[] = []
  const path = spec.path.replace(/\{\+?([^}]+)\}/g, (_m, rawName: string) => {
    const reserved = _m.startsWith('{+')
    const name = rawName
    if (!(name in rest)) { missing.push(name); return '' }
    const value = String(rest[name])
    delete rest[name]
    return reserved ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value)
  })
  if (missing.length) throw new Error(`missing required path parameter(s): ${missing.join(', ')}`)

  const url = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`)
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue
    // Repeated query params (labelIds, fields on some APIs) arrive as arrays
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item))
    else url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }

  return { url: url.toString(), httpMethod: spec.httpMethod || 'GET', body }
}

const docCache = new Map<string, DiscoveryDoc>()

function cacheDir(): string {
  return join(process.env.TINY_HOME || join(homedir(), '.tiny'), 'google-cache')
}

/** Discovery docs are big (Gmail is ~200KB) and change rarely — cache on disk. */
async function getDiscoveryDoc(service: string, version: string): Promise<DiscoveryDoc> {
  const key = `${service}-${version}`
  const cached = docCache.get(key)
  if (cached) return cached

  const file = join(cacheDir(), `${key}.json`)
  try {
    const stat = fs.statSync(file)
    if (Date.now() - stat.mtimeMs < 7 * 24 * 3600 * 1000) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as DiscoveryDoc
      docCache.set(key, doc)
      return doc
    }
  } catch { /* no cache yet, or unreadable — fetch it */ }

  const res = await fetch(discoveryUrl(service, version))
  if (!res.ok) {
    throw new Error(
      `unknown API '${service}/${version}' (discovery returned ${res.status}). ` +
      `Check the name/version at https://developers.google.com/apis-explorer`,
    )
  }
  const doc = (await res.json()) as DiscoveryDoc
  docCache.set(key, doc)
  try {
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(doc))
  } catch { /* cache is an optimization, not a requirement */ }
  return doc
}

// ── credentials ─────────────────────────────────────────────────────────────

export interface OAuthCreds {
  token?: string
  access_token?: string
  refresh_token: string
  token_uri?: string
  client_id: string
  client_secret: string
  scopes?: string[]
  expiry?: string
}

const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const AUTH_URI = 'https://accounts.google.com/o/oauth2/auth'

/** Where tiny-tech keeps its own Google token (0600, like credentials.json). */
export function googleTokenPath(): string {
  return join(process.env.TINY_HOME || join(homedir(), '.tiny'), 'google-token.json')
}

/**
 * OAuth credentials, ours first then the strands_google/devduck file, so a
 * machine already logged in through Python doesn't have to log in again.
 */
export function oauthCredsPath(): string | null {
  const ours = googleTokenPath()
  if (fs.existsSync(ours)) return ours
  const shared = process.env.GOOGLE_OAUTH_CREDENTIALS
  if (shared && fs.existsSync(shared)) return shared
  return null
}

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, 'utf-8')) as T
}

/** Scopes a fresh login asks for — GOOGLE_API_SCOPES overrides. */
export function defaultScopes(): string[] {
  const env = process.env.GOOGLE_API_SCOPES
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean)
  return [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/photoslibrary',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'openid',
  ]
}

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

/**
 * Sign a JWT-bearer assertion for the service-account flow (RFC 7523).
 * Pure and deterministic given `nowSec`, so a test can verify the segments
 * without a network call.
 */
export function buildServiceAccountAssertion(
  sa: ServiceAccountKey,
  scopes: string[],
  nowSec: number,
  subject?: string,
): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const claims: Record<string, unknown> = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: sa.token_uri || TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  }
  if (subject) claims.sub = subject // domain-wide delegation
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`
  const signature = cryptoSign('RSA-SHA256', Buffer.from(input), sa.private_key).toString('base64url')
  return `${input}.${signature}`
}

/** Which credential this machine would use — reported by the `auth` action. */
export function credentialSource(): 'oauth' | 'service_account' | 'api_key' | null {
  if (oauthCredsPath()) return 'oauth'
  const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (sa && fs.existsSync(sa)) return 'service_account'
  if (process.env.GOOGLE_API_KEY) return 'api_key'
  return null
}

/** Any Google credential at all — the tool's registration gate. */
export function hasGoogle(): boolean {
  return credentialSource() !== null
}

let cachedToken: { token: string; expiresAt: number } | null = null
/** Which credential actually produced the live token (may differ from the
 *  preferred one when OAuth is dead and a service account took over). */
let activeSource: 'oauth' | 'service_account' | 'api_key' | null = null

async function refreshOAuth(creds: OAuthCreds, path: string): Promise<string> {
  const res = await fetch(creds.token_uri || TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!data.access_token) {
    // invalid_grant means the refresh token itself is dead (revoked, expired,
    // or the project's consent was reset) — no retry helps, only a new login.
    const why = data.error === 'invalid_grant'
      ? 'refresh token is no longer valid (revoked or expired)'
      : `${data.error || res.status}: ${data.error_description || ''}`
    throw new Error(`Google token refresh failed — ${why}. Run use_google action='login' to re-authorize.`)
  }
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
  cachedToken = { token: data.access_token, expiresAt }
  activeSource = 'oauth'
  // Persist so sibling processes (and the next run) skip the refresh round trip
  try {
    const updated = { ...creds, token: data.access_token, expiry: new Date(expiresAt).toISOString() }
    fs.writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 })
  } catch { /* a read-only creds file still works, just re-refreshes */ }
  return data.access_token
}

/** An access token, or null when the call should ride an API key instead. */
async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token

  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  const haveServiceAccount = !!saPath && fs.existsSync(saPath)

  const oauthPath = oauthCredsPath()
  if (oauthPath) {
    const creds = readJson<OAuthCreds>(oauthPath)
    const stored = creds.token || creds.access_token
    // Trust a stored expiry only with a full minute of headroom left
    if (stored && creds.expiry && Date.parse(creds.expiry) - Date.now() > 60_000) {
      cachedToken = { token: stored, expiresAt: Date.parse(creds.expiry) }
      activeSource = 'oauth'
      return stored
    }
    if (creds.refresh_token) {
      try {
        return await refreshOAuth(creds, oauthPath)
      } catch (e) {
        // A dead refresh token shouldn't strand a machine that also has a
        // working service account — fall through to it and let the caller
        // find out from action='auth' which identity actually answered.
        if (!haveServiceAccount) throw e
      }
    } else if (stored) {
      activeSource = 'oauth'
      return stored
    }
  }

  if (haveServiceAccount) {
    const sa = readJson<ServiceAccountKey>(saPath)
    const assertion = buildServiceAccountAssertion(
      sa,
      defaultScopes().filter((s) => s !== 'openid'),
      Math.floor(Date.now() / 1000),
      process.env.GOOGLE_IMPERSONATE_SUBJECT,
    )
    const res = await fetch(sa.token_uri || TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!data.access_token) {
      throw new Error(`service-account token failed: ${data.error || res.status} ${data.error_description || ''}`)
    }
    cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
    activeSource = 'service_account'
    return data.access_token
  }

  if (process.env.GOOGLE_API_KEY) { activeSource = 'api_key'; return null }
  throw new Error(
    'no Google credentials. Either run use_google action=\'login\', or set ' +
    'GOOGLE_APPLICATION_CREDENTIALS (service account) / GOOGLE_API_KEY (public APIs).',
  )
}

// ── login (loopback OAuth, same shape as tiny-tech's own) ───────────────────

/**
 * Client id/secret for the installed-app flow. GOOGLE_OAUTH_CLIENT points at a
 * client_secret_*.json, GOOGLE_OAUTH_CLIENT_ID/_SECRET carry the pair directly
 * (what `tiny-tech connect` stores); failing both, an existing token file
 * carries the same pair, so a dead refresh token can still bootstrap a login.
 */
function installedAppClient(): { client_id: string; client_secret: string } {
  const explicit = process.env.GOOGLE_OAUTH_CLIENT
  if (explicit && fs.existsSync(explicit)) {
    const raw = readJson<any>(explicit)
    const c = raw.installed || raw.web || raw
    if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret }
  }
  // The pair on its own — what `tiny-tech connect` stores when the user pasted
  // the id and secret rather than pointing at the downloaded JSON.
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    }
  }
  for (const p of [googleTokenPath(), process.env.GOOGLE_OAUTH_CREDENTIALS].filter(Boolean) as string[]) {
    try {
      const c = readJson<any>(p)
      if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret }
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    'no OAuth client. Run `npx tiny-tech connect google`, or create a Desktop-app client at ' +
    'https://console.cloud.google.com/apis/credentials and set GOOGLE_OAUTH_CLIENT to its JSON path.',
  )
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFileSync(cmd, [url], { stdio: 'ignore' })
  } catch { /* headless — the URL is printed for the user to open by hand */ }
}

const DONE_HTML = (ok: boolean, msg: string) => `<!doctype html>
<html><head><title>tiny-tech · Google</title><style>
body{background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center}h1{color:${ok ? '#00FF88' : '#ff6b6b'}}p{color:#888}
</style></head><body><div><h1>${ok ? '✓ Google connected' : '✗ Failed'}</h1><p>${msg}</p></div></body></html>`

/**
 * Loopback OAuth for a Desktop client, with PKCE. Google allows any loopback
 * port for installed apps, so port 0 works and nothing needs pre-registering.
 */
export async function googleLogin(scopes: string[], timeoutMs = 5 * 60 * 1000): Promise<string> {
  const client = installedAppClient()
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setTimeout(() => { try { server.close() } catch {} }, 100)
      fn()
    }
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const gotCode = url.searchParams.get('code') || ''
        if (!gotCode || url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(DONE_HTML(false, url.searchParams.get('error') || 'state mismatch — retry the login'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(DONE_HTML(true, 'You can close this tab and return to your terminal.'))
        const port = (server.address() as { port: number }).port
        finish(() => resolve({ code: gotCode, redirectUri: `http://127.0.0.1:${port}` }))
      } catch {
        try { res.writeHead(400).end() } catch {}
      }
    })
    const timer = setTimeout(() => finish(() => reject(new Error('Google login timed out'))), timeoutMs)
    timer.unref()
    server.on('error', (e) => finish(() => reject(e)))
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      const authUrl = `${AUTH_URI}?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent', // force a refresh_token even on a re-authorization
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`
      process.stderr.write(`\nAuthorize tiny-tech for Google:\n  ${authUrl}\n\n`)
      openBrowser(authUrl)
    })
  })

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!data.refresh_token) {
    throw new Error(`Google token exchange failed: ${data.error || res.status} ${data.error_description || ''}`)
  }
  const creds: OAuthCreds = {
    token: data.access_token,
    refresh_token: data.refresh_token,
    token_uri: TOKEN_URI,
    client_id: client.client_id,
    client_secret: client.client_secret,
    scopes,
    expiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  }
  const path = googleTokenPath()
  fs.mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  cachedToken = { token: data.access_token, expiresAt: Date.parse(creds.expiry!) }
  activeSource = 'oauth'
  return path
}

// ── the call ────────────────────────────────────────────────────────────────

/** Gmail bodies are base64url; a raw RFC-2822 message is easier to write. */
export function encodeRawEmail(to: string, subject: string, body: string, from?: string): string {
  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : '',
    // Non-ASCII subjects must be encoded-word wrapped or Gmail mangles them
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean)
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${Buffer.from(body, 'utf-8').toString('base64')}`)
    .toString('base64url')
}

async function callGoogle(
  service: string,
  version: string,
  resource: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<string> {
  const doc = await getDiscoveryDoc(service, version)
  const spec = resolveMethod(doc, resource, method)
  const req = buildRequest(doc, spec, params)

  const token = await getAccessToken()
  const url = new URL(req.url)
  if (!token && process.env.GOOGLE_API_KEY) url.searchParams.set('key', process.env.GOOGLE_API_KEY)

  const res = await fetch(url.toString(), {
    method: req.httpMethod,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  })

  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 800)
    try { detail = JSON.stringify(JSON.parse(text).error ?? JSON.parse(text)).slice(0, 800) } catch {}
    return `Google API error ${res.status} on ${spec.id || `${resource}.${method}`}: ${detail}`
  }
  if (!text) return `✓ ${spec.id || `${resource}.${method}`} — ${res.status} (empty response)`
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

export function makeGoogleTool() {
  return tool({
    name: 'use_google',
    description: `Any Google API, driven by its discovery document — Gmail, Calendar, Drive, Sheets, Docs, Slides, Tasks, People, YouTube, Cloud, 200+ more.

Call shape: service + version + resource + method + parameters (exactly as Google's API reference lists them).
- list gmail: service='gmail' version='v1' resource='users.messages' method='list' parameters={userId:'me', maxResults:10, q:'is:unread'}
- read one: resource='users.messages' method='get' parameters={userId:'me', id:'<id>', format:'full'}
- calendar: service='calendar' version='v3' resource='events' method='list' parameters={calendarId:'primary', timeMin:'2026-07-25T00:00:00Z', maxResults:10}
- drive: service='drive' version='v3' resource='files' method='list' parameters={q:"name contains 'report'", pageSize:10}
- sheets: service='sheets' version='v4' resource='spreadsheets.values' method='get' parameters={spreadsheetId:'…', range:'Sheet1!A1:C10'}
Request bodies go in parameters.body (POST/PUT/PATCH).

Helper actions instead of a raw call:
- action='auth' — which credential is in use, and its identity
- action='login' — browser OAuth (needs a Desktop client via GOOGLE_OAUTH_CLIENT)
- action='discover' service+version [+resource] — list the resources/methods an API actually has
- action='send_email' to+subject+body — Gmail send without hand-rolling base64url MIME

Mutative methods (send, insert, update, delete, patch, …) require confirm=true. Ask the user first — this is their real mailbox, calendar and drive.`,
    inputSchema: z.object({
      action: z.string().optional().describe("'call' (default), 'auth', 'login', 'discover', 'send_email'"),
      service: z.string().optional().describe("API name, e.g. 'gmail', 'calendar', 'drive', 'sheets'"),
      version: z.string().optional().describe("API version, e.g. 'v1', 'v3'"),
      resource: z.string().optional().describe("dotted resource path, e.g. 'users.messages'"),
      method: z.string().optional().describe("method on that resource, e.g. 'list', 'get', 'send'"),
      parameters: z.record(z.string(), z.any()).optional().describe('exactly the parameters Google documents; request body under `body`'),
      headers: z.record(z.string(), z.string()).optional().describe('extra HTTP headers, e.g. X-Goog-FieldMask'),
      confirm: z.boolean().optional().describe('required for mutative methods'),
      to: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      scopes: z.array(z.string()).optional().describe("OAuth scopes for action='login'"),
    }),
    callback: async (a) => {
      const action = a.action || 'call'
      try {
        switch (action) {
          case 'auth': {
            const source = credentialSource()
            if (!source) return "no Google credentials — run use_google action='login', or set GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_API_KEY"
            if (source === 'api_key') return 'credential: GOOGLE_API_KEY (public APIs only — no user data)'
            const token = await getAccessToken()
            // credentialSource() is the PREFERRED credential; activeSource is the
            // one that actually produced this token. They diverge when OAuth is
            // dead and a service account took over — reporting the preference
            // there would name an identity that answered nothing.
            const live = activeSource || source
            const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { authorization: `Bearer ${token}` },
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any
            const scopeInfo = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`)
              .then((r) => (r.ok ? r.json() : null)).catch(() => null) as any
            return [
              live === source
                ? `credential: ${live}`
                : `credential: ${live} (preferred ${source} is unusable — its refresh token is dead; run action='login' to restore it)`,
              who?.email ? `identity: ${who.email}${who.name ? ` (${who.name})` : ''}` : null,
              scopeInfo?.scope ? `scopes: ${String(scopeInfo.scope).split(' ').length} granted` : null,
              live === 'oauth' ? `token file: ${oauthCredsPath()}` : null,
              live === 'service_account' ? `key file: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}` : null,
            ].filter(Boolean).join('\n')
          }
          case 'login': {
            const path = await googleLogin(a.scopes?.length ? a.scopes : defaultScopes())
            return `✓ Google authorized — refresh token saved to ${path}`
          }
          case 'discover': {
            if (!a.service || !a.version) return "need service + version, e.g. service='gmail' version='v1'"
            const doc = await getDiscoveryDoc(a.service, a.version)
            let node: DiscoveryResource = doc
            if (a.resource) node = resolveMethodParent(doc, a.resource)
            const resources = Object.keys(node.resources || {}).sort()
            const methods = Object.entries(node.methods || {}).map(([name, spec]) => {
              const required = Object.entries(spec.parameters || {})
                .filter(([, p]) => p.required).map(([k]) => k)
              return `  ${name}(${required.join(', ')})${spec.request ? ' +body' : ''} — ${spec.httpMethod} ${spec.path}`
            }).sort()
            return [
              `${a.service}/${a.version}${a.resource ? ` · ${a.resource}` : ''}`,
              resources.length ? `resources: ${resources.join(', ')}` : null,
              methods.length ? `methods:\n${methods.join('\n')}` : null,
            ].filter(Boolean).join('\n')
          }
          case 'send_email': {
            if (!a.to || !a.subject) return 'need to + subject (+ body)'
            if (!a.confirm) return `⚠️ this sends a real email to ${a.to}. Confirm with the user, then retry with confirm=true`
            // `await`, not a bare `return` of the promise: returning it from
            // inside try lets a rejection skip this function's catch entirely.
            return await callGoogle('gmail', 'v1', 'users.messages', 'send',
              { userId: 'me', body: { raw: encodeRawEmail(a.to, a.subject, a.body || '') } }, a.headers || {})
          }
          case 'call': {
            if (!a.service || !a.version || !a.resource || !a.method) {
              return "need service + version + resource + method (try action='discover' first)"
            }
            if (isMutative(a.method) && !a.confirm) {
              return `⚠️ ${a.service}.${a.resource}.${a.method} changes the user's real Google data. Tell them what it will do, then retry with confirm=true`
            }
            return await callGoogle(a.service, a.version, a.resource, a.method, a.parameters || {}, a.headers || {})
          }
          default:
            return `unknown action: ${action} (call, auth, login, discover, send_email)`
        }
      } catch (e: any) {
        return `error: ${String(e?.message || e).slice(0, 800)}`
      }
    },
  })
}

/** Walk to a resource node without requiring a method — for `discover`. */
function resolveMethodParent(doc: DiscoveryDoc, resource: string): DiscoveryResource {
  let node: DiscoveryResource = doc
  const walked: string[] = []
  for (const part of resource.split('.').filter(Boolean)) {
    const next = node.resources?.[part]
    if (!next) {
      const available = Object.keys(node.resources || {}).sort().join(', ')
      throw new Error(`no resource '${part}'${walked.length ? ` on '${walked.join('.')}'` : ''}. Available: ${available || '(none)'}`)
    }
    node = next
    walked.push(part)
  }
  return node
}
