/**
 * use_openapi — any HTTP API on earth, from the spec that describes it.
 *
 * The use_npm / use_pypi / use_google idea applied to the rest of the internet:
 * instead of a hand-written wrapper per service, ONE tool that reads an
 * OpenAPI 3.x or Swagger 2.0 document and can then call every endpoint in it
 * with real parameter names, real auth, and real validation. Point it at
 * Stripe, Twilio, OpenAI, your company's internal service, a Raspberry Pi in
 * the garage — if it has a spec, it's a tool.
 *
 * Ported from devduck's tools/openapi.py. The port fixes the four things that
 * make the original unusable on exactly the big APIs it exists for:
 *
 *  1. LOAD DUMPED EVERY OPERATION INTO THE CONTEXT. devduck prints one line per
 *     operation on `load`, and `list` prints them all again for every loaded
 *     spec. Stripe has ~450 operations, the GitHub spec ~900: that's tens of
 *     thousands of tokens before the model has asked anything, and it happens
 *     on every `list`. Here `load` returns a SHAPE — title, base URL, counts,
 *     auth schemes, tag groups — and `search` finds the two operations that
 *     matter. Discovery is a query, not a dump.
 *  2. IT COULDN'T TELL YOU WHAT TO SEND. `$ref` is resolved for parameters only,
 *     so a POST's body came back as `{"$ref": "#/components/schemas/Pet"}` and
 *     the model had to guess the field names. `describe` resolves refs
 *     (cycle-safe) and prints the body's actual fields, required ones marked.
 *  3. IT GUESSED AT PARAMETERS. Anything not matching a declared parameter was
 *     silently appended as a query string — so a typo'd `limt=10` became a real
 *     request that 400s for a reason the model can't see, and a missing
 *     required query param was never mentioned (only path params were checked).
 *     Here a call that can't be built is REFUSED before the request, naming
 *     what's missing and suggesting the closest real name.
 *  4. IT SENT YOUR TOKEN WHEREVER THE SPEC SAID. A spec is untrusted input —
 *     you loaded it from a URL someone gave you — and `servers[0].url` decides
 *     where the bearer token in ~/.tiny/openapi goes. A credential here records
 *     the host it was issued for and is refused for any other host, and never
 *     goes over plaintext http to a non-loopback address.
 *
 * Plus: YAML specs work with no dependency to install (see yaml.ts — devduck
 * tells you to `pip install pyyaml` from inside the tool call), server-variable
 * substitution ({region} in Azure/AWS specs), form-encoded request bodies
 * (Twilio), and everything is async — a spec fetch under a blocking read would
 * freeze every conversation streaming beside it.
 *
 * Errors return as text, never throw — the model adapts (device-tools rule).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseJsonOrYaml } from './yaml.js'

/** One HTTP call's leash. Spec fetches get the same — some specs are 10 MB. */
export const OPENAPI_TIMEOUT_MS = Number(process.env.TINY_OPENAPI_TIMEOUT_MS || 30_000)
/** Response clamp: this text enters the context window (see NPM_OUTPUT_MAX). */
export const OPENAPI_OUTPUT_MAX = Number(process.env.TINY_OPENAPI_OUTPUT_MAX || 20_000)
/** A spec bigger than this is a mistake or an attack, not an API description. */
export const OPENAPI_SPEC_MAX_BYTES = 20 * 1024 * 1024
/** How many operations a search may answer with. */
export const SEARCH_LIMIT = 25
/** How deep `describe` walks a schema before it says "…". */
export const SCHEMA_DEPTH = 3

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']
/**
 * Method names a search query may use as a filter. `head`, `options` and
 * `trace` are left out on purpose — they read as ordinary English ("list the
 * options"), and filtering on them would hide the endpoint the user meant.
 */
const METHOD_WORDS = new Set(['get', 'post', 'put', 'delete', 'patch'])
/** Words a search query spends on grammar rather than on what it wants. */
const STOPWORDS = new Set(['a', 'an', 'the', 'for', 'of', 'to', 'in', 'on', 'my', 'all', 'and', 'from', 'with', 'by', 'me', 'new'])

/** Off with TINY_OPENAPI=0; otherwise always available (it needs no binary). */
export function hasOpenapi(): boolean {
  return process.env.TINY_OPENAPI !== '0'
}

/** Where specs and credentials live — sibling of ~/.tiny/npm, same reasoning. */
export function openapiDir(): string {
  if (process.env.TINY_OPENAPI_DIR) return process.env.TINY_OPENAPI_DIR
  return join(process.env.TINY_HOME || join(homedir(), '.tiny'), 'openapi')
}

function ensureDir(): string {
  const dir = openapiDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// ── fetching a spec ─────────────────────────────────────────────────────────

/**
 * A GitHub *blob* URL serves an HTML page, not the spec. Everyone pastes them
 * anyway, so convert instead of failing with "could not parse".
 */
export function specUrlToRaw(url: string): string {
  if (/^https?:\/\/(www\.)?github\.com\/.+\/blob\//.test(url)) {
    return url.replace(/^https?:\/\/(www\.)?github\.com/, 'https://raw.githubusercontent.com').replace('/blob/', '/')
  }
  return url
}

/** Fetch (or read) and parse a spec. Local paths are allowed and common. */
export async function fetchSpec(source: string): Promise<unknown> {
  if (!/^https?:\/\//.test(source)) {
    const path = source.startsWith('~') ? join(homedir(), source.slice(1)) : source
    if (!fs.existsSync(path)) throw new Error(`no such spec file: ${path}`)
    return parseJsonOrYaml(fs.readFileSync(path, 'utf-8'), path)
  }
  const url = specUrlToRaw(source)
  const res = await fetch(url, {
    headers: {
      accept: 'application/json, application/yaml, application/x-yaml, text/yaml, text/plain, */*',
      'user-agent': 'tiny-tech/openapi',
    },
    signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > OPENAPI_SPEC_MAX_BYTES) throw new Error(`spec is ${(len / 1e6).toFixed(1)} MB — too large`)
  const text = await res.text()
  if (text.length > OPENAPI_SPEC_MAX_BYTES) throw new Error(`spec is ${(text.length / 1e6).toFixed(1)} MB — too large`)
  return parseJsonOrYaml(text, url)
}

// ── reading the spec ────────────────────────────────────────────────────────

/**
 * Resolve a `$ref`, JSON Pointer rules and all.
 *
 * devduck does `ref.lstrip("#/")` and indexes blindly: a missing ref throws
 * KeyError, `~1`/`~0` are handled but percent-escapes aren't, and nothing
 * guards against a ref that points at itself — which is most of Kubernetes.
 * Returns null for anything it can't reach (external files included), so the
 * caller can say so instead of crashing.
 */
export function resolveRef(spec: any, ref: string, seen = new Set<string>()): any {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return null   // external document
  if (seen.has(ref)) return null                                     // cycle
  seen.add(ref)
  let node: any = spec
  for (const rawPart of ref.slice(1).split('/')) {
    if (rawPart === '') continue
    const part = decodeURIComponent(rawPart).replace(/~1/g, '/').replace(/~0/g, '~')
    if (node == null || typeof node !== 'object' || !(part in node)) return null
    node = node[part]
  }
  return node
}

/** Follow `$ref` chains until the value is a real node (or unreachable). */
function deref(spec: any, node: any, seen = new Set<string>()): any {
  let cur = node
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    const next = resolveRef(spec, cur.$ref, seen)
    if (next == null) return { ...cur, __unresolved: cur.$ref }
    cur = next
  }
  return cur
}

export interface Operation {
  id: string
  method: string
  path: string
  summary: string
  description: string
  tags: string[]
  deprecated: boolean
  parameters: any[]
  requestBody: any
  responses: any
  security: any[] | null
}

/**
 * The base URL to call, including server-variable defaults.
 *
 * devduck takes `servers[0].url` verbatim, so an Azure-style
 * `https://{region}.api.example.com` is requested with a literal `{region}` in
 * the host and fails at DNS. Variables have declared defaults; use them.
 */
export function baseUrlFor(spec: any, specUrl = ''): string {
  const origin = () => { try { return new URL(specUrl).origin } catch { return '' } }
  const servers = Array.isArray(spec?.servers) ? spec.servers : []
  if (servers.length && typeof servers[0]?.url === 'string') {
    let url: string = servers[0].url
    const vars = servers[0].variables || {}
    url = url.replace(/\{([^}]+)\}/g, (m, name) => {
      const v = vars[name]
      const fallback = v?.default ?? (Array.isArray(v?.enum) ? v.enum[0] : undefined)
      return fallback === undefined ? m : String(fallback)
    })
    if (url.startsWith('//')) url = `https:${url}`
    else if (!/^https?:\/\//.test(url)) url = `${origin()}${url.startsWith('/') ? '' : '/'}${url}`
    return url.replace(/\/+$/, '')
  }
  // Swagger 2.0
  if (typeof spec?.host === 'string' && spec.host) {
    const scheme = (Array.isArray(spec.schemes) && spec.schemes[0]) || 'https'
    return `${scheme}://${spec.host}${spec.basePath || ''}`.replace(/\/+$/, '')
  }
  return origin()
}

/** Every operation in the spec, keyed by operationId (synthesised if absent). */
export function extractOperations(spec: any): Map<string, Operation> {
  const out = new Map<string, Operation>()
  const paths = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {}
  for (const [path, itemRaw] of Object.entries<any>(paths)) {
    const item = deref(spec, itemRaw)
    if (!item || typeof item !== 'object') continue
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (!op || typeof op !== 'object') continue
      const id = typeof op.operationId === 'string' && op.operationId
        ? op.operationId
        : `${method}_${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => deref(spec, p))
        .filter((p) => p && typeof p === 'object')
      // Later declarations win, per the spec's path/operation override rule.
      const byKey = new Map<string, any>()
      for (const p of params) byKey.set(`${p.in}:${p.name}`, p)
      out.set(id, {
        id,
        method: method.toUpperCase(),
        path,
        summary: String(op.summary || ''),
        description: String(op.description || ''),
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        deprecated: op.deprecated === true,
        parameters: [...byKey.values()],
        requestBody: deref(spec, op.requestBody),
        responses: op.responses || {},
        // `null` means "the operation didn't say" → fall back to the spec's
        // root security. `[]` means the operation explicitly needs none.
        security: Array.isArray(op.security) ? op.security : null,
      })
    }
  }
  return out
}

/** Security schemes, OpenAPI 3 and Swagger 2. */
export function securitySchemes(spec: any): Record<string, any> {
  return spec?.components?.securitySchemes || spec?.securityDefinitions || {}
}

/** Which security requirements apply to an operation. */
export function securityFor(spec: any, op: Operation): any[] {
  if (op.security) return op.security
  return Array.isArray(spec?.security) ? spec.security : []
}

// ── search: how a 900-operation API stays usable ────────────────────────────

/**
 * Rank operations against a free-text query.
 *
 * This is the whole reason the tool is usable on a real API. The model knows
 * what it wants ("create a charge", "list repo issues") and not the
 * operationId, and printing all 900 ids so it can pick one costs more context
 * than the entire rest of the task.
 */
export function searchOperations(ops: Map<string, Operation>, query: string, limit = SEARCH_LIMIT): Operation[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...ops.values()].slice(0, limit)
  const words = q.split(/\s+/).filter(Boolean)

  const rank = (pool: Operation[], terms: string[], base = 0): Operation[] => {
    const scored: Array<{ op: Operation; score: number }> = []
    for (const op of pool) {
      const id = op.id.toLowerCase()
      const path = op.path.toLowerCase()
      const text = `${op.summary} ${op.description}`.toLowerCase()
      const tags = op.tags.join(' ').toLowerCase()
      let score = base
      if (id === q) score += 100
      if (id.includes(q)) score += 40
      if (path.includes(q)) score += 30
      if (text.includes(q)) score += 20
      // The resource a path ENDS in is what the operation is about:
      // `/repos/{owner}/{repo}/issues` is the issues endpoint, and
      // `/repos/{owner}/{repo}/labels` is not, however much prose they share.
      const leaf = path.replace(/\/+$/, '').split('/').filter((s) => !s.startsWith('{')).pop() || ''
      for (const w of terms) {
        if (id.includes(w)) score += 8
        if (path.includes(w)) score += 6
        if (leaf.includes(w)) score += 10
        if (tags.includes(w)) score += 4
        if (text.includes(w)) score += 2
      }
      // Deprecated demotes but never eliminates: it may be the only operation
      // that does what was asked, and "no matches" would be a lie.
      const matched = score > base || (terms.length === 0 && base > 0)
      if (op.deprecated) score = Math.max(1, score - 15)
      if (matched && score > 0) scored.push({ op, score })
    }
    scored.sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id))
    return scored.slice(0, limit).map((s) => s.op)
  }

  // A method in the query is a FILTER, not a few points: "delete a webhook"
  // means the DELETE, and scoring alone lets a better-worded GET outrank it.
  // Falls back to scoring everything if the filter finds nothing.
  const methods = [...new Set(words.filter((w) => METHOD_WORDS.has(w)).map((w) => w.toUpperCase()))]
  // A query is a sentence ("list issues for a repo"), and `for`/`a`/`the` match
  // every operation in the spec — enough noise to float the wrong endpoint to
  // the top. Only drop them if something is left to search with.
  const content = words.filter((w) => !STOPWORDS.has(w) && w.length > 2)
  const terms = (content.length ? content : words).filter((w) => !METHOD_WORDS.has(w))
  if (methods.length) {
    const pool = [...ops.values()].filter((o) => methods.includes(o.method))
    // base 1 so `search 'DELETE'` alone lists the deletes instead of nothing.
    const hits = rank(pool, terms, 1)
    if (hits.length) return hits
  }
  return rank([...ops.values()], terms.length ? terms : words)
}

/** Tag → operation count, the cheap map of an API's shape. */
export function tagGroups(ops: Map<string, Operation>): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const op of ops.values()) {
    for (const t of op.tags.length ? op.tags : ['(untagged)']) counts.set(t, (counts.get(t) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

// ── building the call ───────────────────────────────────────────────────────

/** Levenshtein, capped — only for "did you mean". */
function distance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 4) return 99
  const row = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = row[0]++
    for (let j = 1; j <= n; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[n]
}

/** The closest real parameter name to a typo, or null if nothing is close. */
export function closest(name: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestD = 3
  const lower = name.toLowerCase()
  for (const c of candidates) {
    const d = distance(lower, c.toLowerCase())
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

export interface BuiltCall {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  contentType?: string
  /** Required parameters the caller didn't supply. */
  missing: string[]
  /** Supplied names that the spec doesn't declare (and can't be body fields). */
  unknown: Array<{ name: string; didYouMean: string | null }>
}

/** Which media type to send a body as — JSON when offered, else what's there. */
export function bodyContentType(requestBody: any): string {
  const content = requestBody?.content
  if (!content || typeof content !== 'object') return 'application/json'
  const types = Object.keys(content)
  const json = types.find((t) => /json/.test(t))
  if (json) return json
  return types[0] || 'application/json'
}

/**
 * Turn (operation, params, body) into an actual HTTP request — or into a
 * refusal that names what's wrong.
 *
 * Pure, so the part that decides where a call goes and what it carries is unit
 * tested without the network. Nothing here throws: `missing`/`unknown` are
 * returned and the caller decides, because a model reading "required parameter
 * `owner` missing" fixes it in one turn, and a 400 from the server is a
 * mystery it can only guess at.
 */
export function buildCall(
  spec: any,
  base: string,
  op: Operation,
  params: Record<string, unknown> = {},
  explicitBody?: unknown,
): BuiltCall {
  const rest: Record<string, unknown> = { ...params }
  const headers: Record<string, string> = {}
  const query = new URLSearchParams()
  const missing: string[] = []
  const declared = op.parameters.map((p) => String(p.name))

  let path = op.path
  for (const p of op.parameters) {
    const name = String(p.name || '')
    if (!name) continue
    const where = String(p.in || 'query')
    const has = name in rest && rest[name] !== undefined && rest[name] !== null
    const value = rest[name]
    delete rest[name]
    if (!has) {
      if (p.required === true) missing.push(`${name} (${where})`)
      continue
    }
    const asString = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v))
    if (where === 'path') path = path.replace(`{${name}}`, encodeURIComponent(asString(value)))
    else if (where === 'query') {
      // A repeated query parameter is an array here, exploded by default —
      // which is what `style: form, explode: true` means, i.e. the default.
      if (Array.isArray(value) && p.explode !== false) for (const v of value) query.append(name, asString(v))
      else query.set(name, Array.isArray(value) ? value.map(asString).join(',') : asString(value))
    } else if (where === 'header') headers[name] = asString(value)
    else if (where === 'cookie') headers.cookie = `${headers.cookie ? `${headers.cookie}; ` : ''}${name}=${asString(value)}`
  }

  // Anything left over: body fields for a method that takes a body, otherwise a
  // mistake. devduck made them all query parameters, which turns a typo into a
  // silent 400 — or worse, a successful call that ignored what you asked for.
  const takesBody = !!op.requestBody || ['POST', 'PUT', 'PATCH'].includes(op.method)
  const unknown: Array<{ name: string; didYouMean: string | null }> = []
  let bodyValue: unknown = explicitBody
  if (bodyValue === undefined && takesBody && Object.keys(rest).length) bodyValue = rest
  else for (const name of Object.keys(rest)) unknown.push({ name, didYouMean: closest(name, declared) })

  // A path template the spec never declared a parameter for — refuse rather
  // than request a URL with a literal `{id}` in it.
  for (const m of path.match(/\{[^}]+\}/g) || []) {
    const name = m.slice(1, -1)
    if (name in params) path = path.replace(m, encodeURIComponent(String(params[name])))
    else if (!missing.some((x) => x.startsWith(`${name} `))) missing.push(`${name} (path, undeclared in spec)`)
  }

  const qs = query.toString()
  const url = `${base}${path.startsWith('/') || !path ? '' : '/'}${path}${qs ? `?${qs}` : ''}`

  let body: string | undefined
  let contentType: string | undefined
  if (bodyValue !== undefined && bodyValue !== null) {
    contentType = bodyContentType(op.requestBody)
    if (/x-www-form-urlencoded/.test(contentType)) {
      // Twilio, most OAuth-flavoured APIs, and every PHP backend ever.
      const form = new URLSearchParams()
      for (const [k, v] of Object.entries(bodyValue as Record<string, unknown>)) {
        if (v === undefined || v === null) continue
        if (Array.isArray(v)) for (const item of v) form.append(k, String(item))
        else form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      body = form.toString()
    } else if (typeof bodyValue === 'string') body = bodyValue
    else body = JSON.stringify(bodyValue)
  }

  return { method: op.method, url, headers, body, contentType, missing, unknown }
}

// ── credentials ─────────────────────────────────────────────────────────────

export interface Credential {
  type: 'api_key' | 'bearer' | 'basic' | 'oauth2'
  /** Hosts this credential may be sent to — see applyAuth. */
  hosts: string[]
  api_key?: string
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_at?: number
  username?: string
  password?: string
  /** For refreshing without asking the user again. */
  token_url?: string
  client_id?: string
  client_secret?: string
  scope?: string
  flow?: string
}

const credPath = (alias: string) => join(openapiDir(), `cred_${alias.replace(/[^\w.-]/g, '_')}.json`)

export function saveCred(alias: string, cred: Credential): void {
  ensureDir()
  const file = credPath(alias)
  fs.writeFileSync(file, JSON.stringify(cred, null, 2), { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort on odd filesystems */ }
}

export function loadCred(alias: string): Credential | null {
  try { return JSON.parse(fs.readFileSync(credPath(alias), 'utf-8')) as Credential } catch { return null }
}

export function forgetCred(alias: string): boolean {
  try { fs.unlinkSync(credPath(alias)); return true } catch { return false }
}

export function listCreds(): Array<{ alias: string; cred: Credential }> {
  try {
    return fs.readdirSync(openapiDir())
      .filter((f) => f.startsWith('cred_') && f.endsWith('.json'))
      .map((f) => ({ alias: f.slice(5, -5), cred: JSON.parse(fs.readFileSync(join(openapiDir(), f), 'utf-8')) }))
  } catch { return [] }
}

/** Never print a secret back — an agent transcript is not a vault. */
export function redact(value?: string): string {
  if (!value) return '(none)'
  return value.length <= 12 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}

export function isExpired(cred: Credential, nowMs = Date.now()): boolean {
  if (!cred.expires_at) return false
  return nowMs > cred.expires_at - 60_000     // 60s of slack, like devduck
}

/**
 * Attach the credential to a request — or refuse.
 *
 * ⚠️ THE REFUSALS ARE THE POINT. A spec is untrusted input: you fetched it from
 * a URL, and `servers[0].url` in it decides where this token goes. devduck
 * sends the stored token to whatever host the spec names, which makes
 * "load this spec" enough to walk off with a Stripe key. So a credential
 * carries the hosts it was authorised for, and anything else is refused with
 * the exact way to allow it — a decision the user makes, not the spec.
 *
 * The plaintext rule is the same shape: a bearer token over http:// to a
 * non-loopback host is readable by every hop in between.
 */
export function applyAuth(
  spec: any,
  op: Operation | null,
  url: string,
  headers: Record<string, string>,
  cred: Credential | null,
): { headers: Record<string, string>; url: string; refusal?: string; applied: string } {
  if (!cred) return { headers, url, applied: 'none' }
  let host: string
  let protocol: string
  try { const u = new URL(url); host = u.host; protocol = u.protocol } catch { return { headers, url, applied: 'none', refusal: `not a valid URL: ${url}` } }

  if (cred.hosts?.length && !cred.hosts.includes(host)) {
    return {
      headers, url, applied: 'none',
      refusal: `credential is authorised for ${cred.hosts.join(', ')} but this call goes to ${host}. `
        + `A spec chooses its own server URL, so the credential is not sent. If ${host} is genuinely the same API, `
        + `run action='auth' again with allow_host='${host}'.`,
    }
  }
  if (protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
    return { headers, url, applied: 'none', refusal: `refusing to send a credential over plaintext http:// to ${host}` }
  }

  // An operation that explicitly says `security: []` wants no credential — a
  // login or token endpoint can fail outright if one arrives.
  if (op?.security && op.security.length === 0) return { headers, url, applied: 'none (operation declares no auth)' }

  const out = { ...headers }
  const schemes = securitySchemes(spec)
  const declared = securityFor(spec, op ?? ({} as Operation))
  // Nothing required here (a `raw` call, or a spec that documents its schemes
  // without attaching them): try every scheme the spec DID declare before
  // falling back to a blind bearer, or an apiKey API gets the wrong header.
  const reqs = declared.length ? declared : Object.keys(schemes).map((n) => ({ [n]: [] }))
  const target = new URL(url)

  // Answer the first requirement we hold a credential shaped for. An apiKey
  // scheme names its own header/query parameter, and getting that wrong is a
  // 401 with no explanation.
  for (const req of reqs) {
    if (!req || typeof req !== 'object') continue
    for (const schemeName of Object.keys(req)) {
      const scheme = deref(spec, schemes[schemeName]) || {}
      const type = String(scheme.type || '').toLowerCase()
      if (type === 'apikey' && cred.api_key) {
        const where = String(scheme.in || 'header')
        const name = String(scheme.name || 'X-API-Key')
        if (where === 'query') { target.searchParams.set(name, cred.api_key); return { headers: out, url: target.toString(), applied: `apiKey ${name} (query)` } }
        if (where === 'cookie') { out.cookie = `${out.cookie ? `${out.cookie}; ` : ''}${name}=${cred.api_key}`; return { headers: out, url, applied: `apiKey ${name} (cookie)` } }
        out[name] = cred.api_key
        return { headers: out, url, applied: `apiKey ${name} (header)` }
      }
      if (type === 'http') {
        const s = String(scheme.scheme || 'bearer').toLowerCase()
        if (s === 'basic' && cred.username !== undefined) {
          out.authorization = `Basic ${Buffer.from(`${cred.username}:${cred.password || ''}`).toString('base64')}`
          return { headers: out, url, applied: 'basic' }
        }
        const token = cred.access_token || cred.api_key
        if (token) { out.authorization = `${cred.token_type || 'Bearer'} ${token}`; return { headers: out, url, applied: `http ${s}` } }
      }
      if ((type === 'oauth2' || type === 'openidconnect') && cred.access_token) {
        out.authorization = `${cred.token_type || 'Bearer'} ${cred.access_token}`
        return { headers: out, url, applied: 'oauth2' }
      }
    }
  }

  // The spec declared nothing usable (or nothing at all) — fall back to the
  // credential's own shape, which is what the user explicitly stored.
  if (cred.type === 'basic' && cred.username !== undefined) {
    out.authorization = `Basic ${Buffer.from(`${cred.username}:${cred.password || ''}`).toString('base64')}`
    return { headers: out, url, applied: 'basic (spec declared none)' }
  }
  const token = cred.access_token || cred.api_key
  if (token) {
    out.authorization = `${cred.token_type || 'Bearer'} ${token}`
    return { headers: out, url, applied: 'bearer (spec declared none)' }
  }
  return { headers: out, url, applied: 'none' }
}

// ── OAuth2 ──────────────────────────────────────────────────────────────────

/** The oauth2 scheme in a spec, and its flows. */
export function oauthFlows(spec: any): Record<string, any> {
  for (const scheme of Object.values<any>(securitySchemes(spec))) {
    const s = deref(spec, scheme)
    if (String(s?.type || '').toLowerCase() === 'oauth2') return s.flows || {}
  }
  return {}
}

export function buildAuthorizeUrl(
  authUrl: string,
  opts: { clientId: string; redirectUri: string; scopes?: string[]; state: string; challenge?: string; extra?: Record<string, string> },
): string {
  const u = new URL(authUrl)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', opts.clientId)
  u.searchParams.set('redirect_uri', opts.redirectUri)
  if (opts.scopes?.length) u.searchParams.set('scope', opts.scopes.join(' '))
  u.searchParams.set('state', opts.state)
  if (opts.challenge) {
    u.searchParams.set('code_challenge', opts.challenge)
    u.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [k, v] of Object.entries(opts.extra || {})) u.searchParams.set(k, v)
  return u.toString()
}

function openBrowser(url: string): void {
  // Same rule as auth.ts: on CI, or when asked not to, the printed URL is it.
  if (process.env.TINY_NO_BROWSER || process.env.CI) return
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
  } catch { /* the URL is printed too */ }
}

/**
 * Loopback OAuth: open a browser, catch the redirect on 127.0.0.1, hand back
 * the code. Same shape as googleLogin — one request, then the server closes.
 */
export async function loopbackAuthorize(
  authUrl: string,
  opts: { clientId: string; scopes?: string[]; port?: number; timeoutMs?: number; pkce?: boolean; onUrl?: (u: string) => void },
): Promise<{ code: string; redirectUri: string; verifier?: string }> {
  const state = randomBytes(16).toString('hex')
  const verifier = opts.pkce ? randomBytes(32).toString('base64url') : undefined
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error_description') || u.searchParams.get('error')
      const ok = code && u.searchParams.get('state') === state
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h1>${ok ? '✅ Authorised' : '❌ ' + (err || 'state mismatch')}</h1>
        <p>${ok ? 'You can close this tab and go back to tiny-tech.' : 'Nothing was stored.'}</p></body></html>`)
      server.close()
      clearTimeout(timer)
      if (ok) resolve({ code: code!, redirectUri, verifier })
      // A state mismatch is not a hiccup: someone else's callback arrived at
      // our port, and exchanging that code would bind their account to us.
      else reject(new Error(err || 'state mismatch on the OAuth callback — nothing stored'))
    })
    let redirectUri = ''
    const timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for the browser redirect')) }, opts.timeoutMs ?? 300_000)
    server.on('error', (e) => { clearTimeout(timer); reject(e) })
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      redirectUri = `http://127.0.0.1:${port}/callback`
      const url = buildAuthorizeUrl(authUrl, { clientId: opts.clientId, redirectUri, scopes: opts.scopes, state, challenge })
      opts.onUrl?.(url)
      openBrowser(url)
    })
  })
}

/** POST a token endpoint, form-encoded, with Basic auth when we have a secret. */
export async function tokenRequest(
  tokenUrl: string,
  form: Record<string, string>,
  clientId?: string,
  clientSecret?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  const body = new URLSearchParams(form)
  // Both styles exist in the wild: Basic for Spotify and most RFC-following
  // servers, credentials-in-body for GitHub. Try Basic, fall back to body.
  if (clientId && clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  else if (clientId) body.set('client_id', clientId)

  const once = async (h: Record<string, string>, b: URLSearchParams) => {
    const res = await fetch(tokenUrl, { method: 'POST', headers: h, body: b.toString(), signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS) })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = Object.fromEntries(new URLSearchParams(text)) }
    return { ok: res.ok && !json?.error, status: res.status, json, text }
  }
  let r = await once(headers, body)
  if (!r.ok && clientId && clientSecret) {
    const b2 = new URLSearchParams(form)
    b2.set('client_id', clientId)
    b2.set('client_secret', clientSecret)
    r = await once({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, b2)
  }
  if (!r.ok) throw new Error(`token endpoint ${tokenUrl} → ${r.status} ${r.json?.error_description || r.json?.error || r.text.slice(0, 300)}`)
  return r.json
}

/** Token response → stored credential. */
export function credFromTokenResponse(json: any, hosts: string[], extra: Partial<Credential> = {}): Credential {
  return {
    type: 'oauth2',
    hosts,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type || 'Bearer',
    expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    ...extra,
  }
}

/** Refresh in place when we can; silence when we can't (the call will 401). */
async function maybeRefresh(alias: string, cred: Credential): Promise<Credential> {
  if (!isExpired(cred) || !cred.refresh_token || !cred.token_url) return cred
  try {
    const json = await tokenRequest(cred.token_url, { grant_type: 'refresh_token', refresh_token: cred.refresh_token }, cred.client_id, cred.client_secret)
    const next = credFromTokenResponse(json, cred.hosts, {
      refresh_token: json.refresh_token || cred.refresh_token,
      token_url: cred.token_url, client_id: cred.client_id, client_secret: cred.client_secret, flow: cred.flow,
    })
    saveCred(alias, next)
    return next
  } catch { return cred }
}

// ── the spec store ──────────────────────────────────────────────────────────

interface Loaded { alias: string; specUrl: string; base: string; spec: any }

const loaded = new Map<string, Loaded>()

/** Name a spec after itself: `Stripe API` → `stripe_api`. */
export function aliasFor(spec: any, override?: string, specUrl = ''): string {
  const raw = override || spec?.info?.title || (() => { try { return new URL(specUrl).hostname } catch { return 'api' } })()
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32)
  return clean || 'api'
}

function specCachePath(alias: string): string {
  return join(openapiDir(), `spec_${alias.replace(/[^\w.-]/g, '_')}.json`)
}

function cacheSpec(entry: Loaded): void {
  try {
    ensureDir()
    fs.writeFileSync(specCachePath(entry.alias), JSON.stringify({ specUrl: entry.specUrl, base: entry.base, spec: entry.spec }))
  } catch { /* the cache is an optimisation, not a requirement */ }
}

/**
 * Every spec this machine knows: memory first, then disk.
 *
 * devduck reads the disk cache only when NOTHING is loaded in memory, so
 * loading one spec hides every spec from a previous session — `list` shows one
 * API and the model concludes the others were never loaded.
 */
export function allSpecs(): Map<string, Loaded> {
  const out = new Map(loaded)
  try {
    for (const f of fs.readdirSync(openapiDir())) {
      if (!f.startsWith('spec_') || !f.endsWith('.json')) continue
      const alias = f.slice(5, -5)
      if (out.has(alias)) continue
      const c = JSON.parse(fs.readFileSync(join(openapiDir(), f), 'utf-8'))
      out.set(alias, { alias, specUrl: c.specUrl || '', base: c.base || '', spec: c.spec })
    }
  } catch { /* no store yet */ }
  return out
}

/** Test seam and session reset — drops the in-memory half only. */
export function resetSpecs(): void { loaded.clear() }

// ── formatting ──────────────────────────────────────────────────────────────

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

export function formatOperationLine(op: Operation): string {
  const tail = op.summary ? `  — ${op.summary.split('\n')[0].slice(0, 90)}` : ''
  return `  ${pad(op.method, 6)} ${pad(op.path, 44)} ${op.id}${op.deprecated ? ' ⚠️deprecated' : ''}${tail}`
}

/** One schema, flattened to the lines a caller needs to build a body. */
export function summarizeSchema(spec: any, schemaRaw: any, depth = SCHEMA_DEPTH, indent = '    '): string[] {
  const schema = deref(spec, schemaRaw)
  if (!schema || typeof schema !== 'object') return []
  if (schema.__unresolved) return [`${indent}(unresolved $ref ${schema.__unresolved} — external file?)`]
  const out: string[] = []
  const oneOf = schema.oneOf || schema.anyOf || schema.allOf
  if (Array.isArray(oneOf)) {
    if (schema.allOf) {
      // allOf is a merge, so flatten the parts as if they were one object.
      for (const part of oneOf) out.push(...summarizeSchema(spec, part, depth, indent))
      return out
    }
    out.push(`${indent}one of ${oneOf.length} variants:`)
    for (const v of oneOf.slice(0, 3)) out.push(...summarizeSchema(spec, v, depth - 1, `${indent}  `))
    return out
  }
  if (schema.type === 'array') {
    out.push(`${indent}[array of]`)
    if (depth > 0) out.push(...summarizeSchema(spec, schema.items, depth - 1, `${indent}  `))
    return out
  }
  const props = schema.properties
  if (!props || typeof props !== 'object') {
    const t = schema.type || (schema.enum ? 'enum' : 'any')
    return [`${indent}${t}${schema.enum ? ` = ${schema.enum.slice(0, 8).join(' | ')}` : ''}`]
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required.map(String) : []
  for (const [name, propRaw] of Object.entries<any>(props)) {
    const prop = deref(spec, propRaw)
    const type = prop?.type || (prop?.$ref ? 'object' : prop?.enum ? 'enum' : 'any')
    const bits = [
      required.includes(name) ? 'required' : '',
      prop?.enum ? `one of ${prop.enum.slice(0, 6).map(String).join(' | ')}` : '',
      prop?.default !== undefined ? `default ${JSON.stringify(prop.default)}` : '',
      prop?.description ? String(prop.description).split('\n')[0].slice(0, 70) : '',
    ].filter(Boolean)
    out.push(`${indent}${name}: ${type}${bits.length ? `  (${bits.join('; ')})` : ''}`)
    if (depth > 1 && (type === 'object' || type === 'array')) out.push(...summarizeSchema(spec, prop, depth - 1, `${indent}  `))
  }
  return out
}

/** Everything a caller needs to make one operation work. */
export function describeOperation(spec: any, entry: { alias: string; base: string }, op: Operation): string {
  const lines: string[] = [
    `${op.method} ${entry.base}${op.path}`,
    `operationId: ${op.id}${op.deprecated ? '   ⚠️ deprecated' : ''}`,
  ]
  if (op.summary) lines.push(op.summary)
  if (op.description && op.description !== op.summary) lines.push(op.description.split('\n').slice(0, 4).join(' ').slice(0, 400))
  const sec = securityFor(spec, op)
  const schemes = securitySchemes(spec)
  if (sec.length) {
    const names = sec.flatMap((r: any) => Object.keys(r || {}))
    lines.push(`auth: ${names.map((n) => `${n} (${deref(spec, schemes[n])?.type || '?'})`).join(' or ') || 'required'}`)
  }
  if (op.parameters.length) {
    lines.push('', 'parameters:')
    for (const p of op.parameters) {
      const schema = deref(spec, p.schema) || {}
      const bits = [
        p.in,
        p.required ? 'REQUIRED' : '',
        schema.type || (schema.$ref ? 'object' : ''),
        Array.isArray(schema.enum) ? `one of ${schema.enum.slice(0, 8).map(String).join(' | ')}` : '',
        schema.default !== undefined ? `default ${JSON.stringify(schema.default)}` : '',
      ].filter(Boolean)
      lines.push(`  ${p.name}: ${bits.join(', ')}`)
      const d = p.description ? String(p.description).split('\n')[0].slice(0, 100) : ''
      if (d) lines.push(`      ${d}`)
    }
  } else lines.push('', 'parameters: none')

  if (op.requestBody) {
    const ct = bodyContentType(op.requestBody)
    lines.push('', `body (${ct}${op.requestBody.required ? ', required' : ''}):`)
    const schema = op.requestBody.content?.[ct]?.schema
    const body = summarizeSchema(spec, schema)
    lines.push(...(body.length ? body : ['    (no schema in the spec — send what the docs say)']))
  }

  const codes = Object.keys(op.responses || {})
  if (codes.length) {
    lines.push('', `responses: ${codes.slice(0, 12).join(', ')}`)
    const okCode = codes.find((c) => /^2/.test(c)) || codes[0]
    const okResp = deref(spec, op.responses[okCode])
    const okSchema = okResp?.content?.[Object.keys(okResp.content || {})[0]]?.schema || okResp?.schema
    if (okSchema) {
      lines.push(`  ${okCode} returns:`)
      lines.push(...summarizeSchema(spec, okSchema, 2, '    '))
    }
  }
  lines.push('', `call it: action='call', alias='${entry.alias}', operation='${op.id}', params='{…}'`)
  return lines.join('\n')
}

/** Clamp a response for the context window, honestly. */
export function clampBody(text: string, max = OPENAPI_OUTPUT_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} of ${text.length} characters]`
}

// ── the tool ────────────────────────────────────────────────────────────────

const DESCRIPTION = `Any HTTP API described by an OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) — Stripe, GitHub, Twilio, OpenAI, Kubernetes, your own service. Load the spec once, then call operations by name with real parameter validation and stored auth.

Actions:
- load (spec_url, alias?) — read a spec from a URL, local path, or GitHub blob URL. Returns the API's shape (base URL, operation count, auth schemes, tag groups) — NOT every operation, because big specs have hundreds.
- search (query, alias?, limit?) — find operations by intent: 'create charge', 'list issues', 'GET /pets'. Start here.
- describe (operation, alias?) — one operation in full: every parameter with location/required/type/enum, the request body's actual fields (with $refs resolved), response shape. Read this before calling something new.
- call (operation, alias?, params?, body?) — make the call. params is a JSON object of parameter names; path/query/header/cookie placement comes from the spec. Missing required parameters or unknown names are refused BEFORE the request, with the closest real name.
- raw (method, path, alias?, params?, body?) — an endpoint the spec doesn't describe (or no spec at all: pass a full URL as path).
- auth (alias, …) — store credentials: api_key='…' | token='…' | username+password | auth_flow='authorization_code'|'client_credentials' with client_id/client_secret (opens a browser for the first). Credentials are bound to the API's host and refused elsewhere.
- tokens / forget (alias) — what's stored (redacted) / delete it.
- schemas (alias, name?) — the spec's models.
- list — which specs this machine has loaded.`

export function makeOpenapiTool() {
  return tool({
    name: 'use_openapi',
    description: DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(['load', 'list', 'search', 'describe', 'call', 'raw', 'auth', 'tokens', 'forget', 'schemas', 'help']),
      spec_url: z.string().optional().describe('URL, local path, or GitHub blob URL of the spec (load)'),
      alias: z.string().optional().describe('which loaded API — defaults to the only one, or searches all'),
      operation: z.string().optional().describe('operationId (call, describe)'),
      query: z.string().optional().describe('free text (search)'),
      params: z.string().optional().describe('JSON object of parameters'),
      body: z.string().optional().describe('JSON request body (overrides params-as-body)'),
      method: z.string().optional().describe('HTTP method (raw)'),
      path: z.string().optional().describe('path, or full URL (raw)'),
      name: z.string().optional().describe('schema name (schemas)'),
      limit: z.number().optional(),
      api_key: z.string().optional(),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      scopes: z.string().optional().describe('comma-separated OAuth2 scopes'),
      auth_flow: z.enum(['authorization_code', 'client_credentials']).optional(),
      allow_host: z.string().optional().describe('additionally authorise this host for the credential'),
    }),
    callback: async (a) => {
      try {
        let params: Record<string, unknown> = {}
        if (a.params) {
          try {
            const p = JSON.parse(a.params)
            if (!p || typeof p !== 'object' || Array.isArray(p)) return `params must be a JSON object, got ${a.params.slice(0, 80)}`
            params = p
          } catch (e: any) { return `params is not valid JSON: ${e.message}` }
        }
        let body: unknown
        if (a.body) {
          try { body = JSON.parse(a.body) } catch { body = a.body }   // a string body is legal
        }
        const specs = allSpecs()

        /** The spec to work with: the named one, the only one, or a hint. */
        const pick = (): Loaded | string => {
          if (a.alias) {
            const e = specs.get(a.alias)
            return e || `no spec loaded as '${a.alias}'. Loaded: ${[...specs.keys()].join(', ') || '(none)'}`
          }
          if (specs.size === 1) return [...specs.values()][0]
          if (!specs.size) return `no specs loaded — action='load', spec_url='https://…/openapi.json' first`
          return `several specs loaded (${[...specs.keys()].join(', ')}) — say which with alias=`
        }

        switch (a.action) {
          case 'help':
            return DESCRIPTION

          case 'load': {
            if (!a.spec_url) return 'spec_url is required'
            const spec: any = await fetchSpec(a.spec_url)
            if (!spec || typeof spec !== 'object') return `that spec parsed to ${typeof spec}, not an object`
            const version = spec.openapi || spec.swagger
            const ops = extractOperations(spec)
            if (!ops.size) {
              return `parsed ${a.spec_url} but found no operations. `
                + `${version ? `It says openapi/swagger ${version}; ` : 'It has no openapi/swagger version field; '}`
                + `is this really an API spec? Top-level keys: ${Object.keys(spec).slice(0, 12).join(', ')}`
            }
            const alias = aliasFor(spec, a.alias, a.spec_url)
            const base = baseUrlFor(spec, /^https?:/.test(a.spec_url) ? a.spec_url : '')
            const entry: Loaded = { alias, specUrl: a.spec_url, base, spec }
            loaded.set(alias, entry)
            cacheSpec(entry)
            const schemes = securitySchemes(spec)
            const cred = loadCred(alias)
            const groups = tagGroups(ops)
            const lines = [
              `✅ ${spec.info?.title || alias}${spec.info?.version ? ` v${spec.info.version}` : ''} loaded as '${alias}' (openapi ${version || '?'})`,
              `   base URL: ${base || '(none in spec — pass full URLs to raw)'}`,
              `   ${ops.size} operations across ${groups.length} tag group(s)`,
              `   auth: ${Object.keys(schemes).length ? Object.entries(schemes).map(([n, s]: any) => `${n} (${deref(spec, s)?.type})`).join(', ') : 'none declared'}`
                + `${cred ? ` — credential stored (${cred.type})` : ''}`,
              '',
              // The tag groups ARE the map: ~20 lines instead of 900.
              ...groups.slice(0, 30).map(([t, n]) => `   ${pad(t, 28)} ${n}`),
              groups.length > 30 ? `   …and ${groups.length - 30} more groups` : '',
              '',
              `Next: action='search', query='what you want to do' — or action='describe', operation='<operationId>'.`,
            ].filter(Boolean)
            return lines.join('\n')
          }

          case 'list': {
            if (!specs.size) return `no specs loaded — action='load', spec_url='https://…/openapi.json'`
            const lines = ['Loaded APIs:']
            for (const e of specs.values()) {
              const ops = extractOperations(e.spec)
              const cred = loadCred(e.alias)
              lines.push(`  ${pad(e.alias, 20)} ${ops.size} ops  ${e.base}  ${cred ? `🔑 ${cred.type}${isExpired(cred) ? ' (expired)' : ''}` : 'no credential'}`)
              if (e.specUrl) lines.push(`   ${' '.repeat(20)} from ${e.specUrl}`)
            }
            return lines.join('\n')
          }

          case 'search': {
            const scope = a.alias ? [specs.get(a.alias)].filter(Boolean) as Loaded[] : [...specs.values()]
            if (!scope.length) return a.alias ? `no spec loaded as '${a.alias}'` : `no specs loaded — action='load' first`
            const limit = Math.max(1, Math.min(a.limit || SEARCH_LIMIT, 100))
            const out: string[] = []
            for (const e of scope) {
              const hits = searchOperations(extractOperations(e.spec), a.query || '', limit)
              if (!hits.length) continue
              out.push(`${e.alias}: ${hits.length} match(es)`)
              for (const op of hits) out.push(formatOperationLine(op))
            }
            if (!out.length) {
              const groups = tagGroups(extractOperations(scope[0].spec)).slice(0, 20)
              return `nothing matched ${JSON.stringify(a.query || '')}. Tag groups to try: ${groups.map(([t]) => t).join(', ')}`
            }
            out.push('', `Then: action='describe', operation='<operationId>' for parameters and body.`)
            return out.join('\n')
          }

          case 'describe': {
            if (!a.operation) return `operation (operationId) is required — find one with action='search'`
            for (const e of a.alias ? [specs.get(a.alias)].filter(Boolean) as Loaded[] : [...specs.values()]) {
              const ops = extractOperations(e.spec)
              const op = ops.get(a.operation)
              if (op) return describeOperation(e.spec, e, op)
            }
            const near = [...specs.values()].flatMap((e) => searchOperations(extractOperations(e.spec), a.operation!, 5))
            return `no operation '${a.operation}'.${near.length ? `\nClosest:\n${near.map(formatOperationLine).join('\n')}` : ` Try action='search'.`}`
          }

          case 'call': {
            if (!a.operation) return `operation is required — find one with action='search'`
            let found: { entry: Loaded; op: Operation } | null = null
            for (const e of a.alias ? [specs.get(a.alias)].filter(Boolean) as Loaded[] : [...specs.values()]) {
              const op = extractOperations(e.spec).get(a.operation)
              if (op) { found = { entry: e, op }; break }
            }
            if (!found) {
              const near = [...specs.values()].flatMap((e) => searchOperations(extractOperations(e.spec), a.operation!, 5))
              return `no operation '${a.operation}'.${near.length ? `\nClosest:\n${near.map(formatOperationLine).join('\n')}` : ''}`
            }
            const { entry, op } = found
            if (!entry.base) return `the spec has no server URL — use action='raw' with a full URL`
            const built = buildCall(entry.spec, entry.base, op, params, body)
            if (built.missing.length || built.unknown.length) {
              const lines = [`not sending this call — the spec says it wouldn't work:`]
              if (built.missing.length) lines.push(`  missing required: ${built.missing.join(', ')}`)
              for (const u of built.unknown) lines.push(`  unknown parameter '${u.name}'${u.didYouMean ? ` — did you mean '${u.didYouMean}'?` : ''}`)
              lines.push('', `action='describe', operation='${op.id}' lists every parameter.`)
              return lines.join('\n')
            }
            let cred = loadCred(entry.alias)
            if (cred) cred = await maybeRefresh(entry.alias, cred)
            const auth = applyAuth(entry.spec, op, built.url, built.headers, cred)
            const needsAuth = securityFor(entry.spec, op).length > 0
            if (auth.refusal) return `refused: ${auth.refusal}`
            if (needsAuth && auth.applied === 'none') {
              const names = securityFor(entry.spec, op).flatMap((r: any) => Object.keys(r || {}))
              return `this operation needs auth (${names.join(' or ')}) and nothing is stored for '${entry.alias}'.\n`
                + `Store it: action='auth', alias='${entry.alias}', api_key='…' (or token=, username+password, auth_flow=)`
            }
            return await execute(built.method, auth.url, auth.headers, built.body, built.contentType, `${op.method} ${op.path}`, auth.applied)
          }

          case 'raw': {
            if (!a.method || !a.path) return 'method and path are required'
            let url: string
            let entry: Loaded | null = null
            if (/^https?:\/\//.test(a.path)) {
              url = a.path
              entry = a.alias ? specs.get(a.alias) || null : null
            } else {
              const e = pick()
              if (typeof e === 'string') return `${e} — or pass a full URL as path`
              entry = e
              url = `${e.base}${a.path.startsWith('/') ? '' : '/'}${a.path}`
            }
            const u = new URL(url)
            for (const [k, v] of Object.entries(params)) {
              if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item))
              else if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
            }
            let headers: Record<string, string> = {}
            let applied = 'none'
            if (entry) {
              let cred = loadCred(entry.alias)
              if (cred) cred = await maybeRefresh(entry.alias, cred)
              const auth = applyAuth(entry.spec, null, u.toString(), headers, cred)
              if (auth.refusal) return `refused: ${auth.refusal}`
              headers = auth.headers
              applied = auth.applied
              url = auth.url
            } else url = u.toString()
            const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
            return await execute(a.method.toUpperCase(), url, headers, payload, payload ? 'application/json' : undefined, `${a.method.toUpperCase()} ${a.path}`, applied)
          }

          case 'auth': {
            const alias = a.alias || (specs.size === 1 ? [...specs.keys()][0] : '')
            if (!alias) return `alias is required — which API? Loaded: ${[...specs.keys()].join(', ') || '(none)'}`
            const entry = specs.get(alias)
            // The host binding comes from the SPEC's base URL, which is why a
            // credential can't be re-pointed by a later spec edit.
            const hosts = new Set<string>()
            if (entry?.base) { try { hosts.add(new URL(entry.base).host) } catch { /* no host to bind */ } }
            const existing = loadCred(alias)
            for (const h of existing?.hosts || []) hosts.add(h)
            if (a.allow_host) hosts.add(a.allow_host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
            const hostList = [...hosts]
            if (!hostList.length) return `load the spec first (action='load') so the credential can be bound to its host`

            if (a.api_key) { saveCred(alias, { type: 'api_key', hosts: hostList, api_key: a.api_key }); return `stored an API key for '${alias}', usable on ${hostList.join(', ')}` }
            if (a.token) { saveCred(alias, { type: 'bearer', hosts: hostList, access_token: a.token, token_type: 'Bearer' }); return `stored a bearer token for '${alias}', usable on ${hostList.join(', ')}` }
            if (a.username !== undefined && a.password !== undefined) { saveCred(alias, { type: 'basic', hosts: hostList, username: a.username, password: a.password }); return `stored basic auth for '${alias}', usable on ${hostList.join(', ')}` }
            if (a.allow_host && existing) { saveCred(alias, { ...existing, hosts: hostList }); return `'${alias}' credential is now usable on ${hostList.join(', ')}` }

            if (!a.auth_flow) return `provide one of: api_key, token, username+password, or auth_flow='authorization_code'|'client_credentials' with client_id`
            if (!entry) return `load the spec first — the OAuth2 endpoints come from it`
            const flows = oauthFlows(entry.spec)
            const clientId = a.client_id || process.env[`${alias.toUpperCase()}_CLIENT_ID`] || ''
            const clientSecret = a.client_secret || process.env[`${alias.toUpperCase()}_CLIENT_SECRET`] || ''
            if (!clientId) return `client_id required (or $${alias.toUpperCase()}_CLIENT_ID)`
            const scopes = a.scopes ? a.scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined

            if (a.auth_flow === 'client_credentials') {
              const flow = flows.clientCredentials || flows.client_credentials
              const tokenUrl = flow?.tokenUrl || flows.authorizationCode?.tokenUrl
              if (!tokenUrl) return `the spec declares no clientCredentials tokenUrl`
              const json = await tokenRequest(tokenUrl, { grant_type: 'client_credentials', ...(scopes ? { scope: scopes.join(' ') } : {}) }, clientId, clientSecret)
              saveCred(alias, credFromTokenResponse(json, hostList, { token_url: tokenUrl, client_id: clientId, client_secret: clientSecret, flow: 'client_credentials' }))
              return `OAuth2 client_credentials token stored for '${alias}'${json.expires_in ? `, expires in ${json.expires_in}s` : ''}`
            }

            const flow = flows.authorizationCode || flows.authorization_code
            if (!flow?.authorizationUrl || !flow?.tokenUrl) return `the spec declares no authorizationCode flow (authorizationUrl + tokenUrl)`
            const wanted = scopes || Object.keys(flow.scopes || {})
            const { code, redirectUri, verifier } = await loopbackAuthorize(flow.authorizationUrl, {
              clientId, scopes: wanted, pkce: !clientSecret,
              onUrl: (u) => process.stderr.write(`🔐 open this to authorise '${alias}':\n${u}\n`),
            })
            const json = await tokenRequest(flow.tokenUrl, {
              grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}),
            }, clientId, clientSecret)
            saveCred(alias, credFromTokenResponse(json, hostList, { token_url: flow.tokenUrl, client_id: clientId, client_secret: clientSecret, flow: 'authorization_code' }))
            return `OAuth2 token stored for '${alias}' (scopes: ${json.scope || wanted.join(' ') || 'default'})`
          }

          case 'tokens': {
            const creds = listCreds()
            if (!creds.length) return 'no credentials stored'
            return creds.map(({ alias, cred }) => [
              `${alias}: ${cred.type}${isExpired(cred) ? ' (EXPIRED)' : ''}`,
              `  hosts: ${cred.hosts?.join(', ') || '(unbound — legacy)'}`,
              cred.api_key ? `  api_key: ${redact(cred.api_key)}` : '',
              cred.access_token ? `  access_token: ${redact(cred.access_token)}` : '',
              cred.refresh_token ? `  refresh_token: (stored)` : '',
              cred.username !== undefined ? `  username: ${cred.username}` : '',
              cred.expires_at ? `  expires: ${new Date(cred.expires_at).toISOString()}` : '',
              cred.scope ? `  scope: ${cred.scope}` : '',
            ].filter(Boolean).join('\n')).join('\n')
          }

          case 'forget': {
            if (!a.alias) return 'alias is required'
            return forgetCred(a.alias) ? `deleted the credential for '${a.alias}'` : `no credential stored for '${a.alias}'`
          }

          case 'schemas': {
            const e = pick()
            if (typeof e === 'string') return e
            const schemas = e.spec?.components?.schemas || e.spec?.definitions || {}
            const names = Object.keys(schemas)
            if (!names.length) return `'${e.alias}' declares no schemas`
            if (a.name) {
              const schema = schemas[a.name]
              if (!schema) {
                const lower = a.name.toLowerCase()
                const near = [
                  closest(a.name, names),
                  ...names.filter((n) => { const l = n.toLowerCase(); return l.includes(lower) || lower.includes(l) }),
                ].filter(Boolean).slice(0, 20)
                const unique = [...new Set(near)]
                return `no schema '${a.name}'.${unique.length ? ` Close: ${unique.join(', ')}` : ` ${names.length} available.`}`
              }
              return [`${a.name}:`, ...summarizeSchema(e.spec, schema, SCHEMA_DEPTH, '  ')].join('\n')
            }
            return [`${names.length} schemas in '${e.alias}':`, ...names.slice(0, 200).map((n) => `  ${n}`),
              names.length > 200 ? `  …and ${names.length - 200} more` : '',
              '', `action='schemas', name='<Name>' for its fields.`].filter(Boolean).join('\n')
          }
        }
        return `unknown action: ${a.action}`
      } catch (e: any) {
        if (e?.name === 'TimeoutError' || /aborted/i.test(String(e?.message))) return `timed out after ${OPENAPI_TIMEOUT_MS}ms`
        return `error: ${String(e?.message || e).slice(0, 800)}`
      }
    },
  })
}

/** Do the request and format the answer the way a model can act on. */
async function execute(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  contentType: string | undefined,
  label: string,
  authApplied: string,
): Promise<string> {
  const h: Record<string, string> = { accept: 'application/json, */*', 'user-agent': 'tiny-tech/openapi', ...headers }
  if (body !== undefined && contentType) h['content-type'] = contentType
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS) })
  } catch (e: any) {
    return `${label} → request failed: ${String(e?.message || e).slice(0, 300)}\n  ${method} ${url}`
  }
  const text = await res.text()
  const ms = Date.now() - started
  let pretty = text
  const type = res.headers.get('content-type') || ''
  if (/json/.test(type) || /^[[{]/.test(text.trim())) {
    try {
      const parsed = JSON.parse(text)
      pretty = JSON.stringify(parsed, null, 2)
      if (Array.isArray(parsed)) pretty = `(${parsed.length} items)\n${pretty}`
    } catch { /* not actually JSON; show it raw */ }
  }
  const head = `${label} → ${res.status} ${res.statusText} (${ms}ms, ${text.length} bytes, auth: ${authApplied})`
  // A 4xx body is the most useful text in this whole tool — never swallow it.
  return `${head}\n${clampBody(pretty) || '(empty body)'}`
}
