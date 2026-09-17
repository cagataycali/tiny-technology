/**
 * use_github — repos, issues, PRs, CI and code on github.com, with no SDK.
 *
 * Ported from devduck's `use_github.py` (438 lines), which unlike its apple_*
 * tools is genuinely registered — `devduck/tools/__init__.py` exports it and
 * `default_tools` mounts it — so it is a real baseline to beat rather than dead
 * code. tiny-tech had nothing for GitHub at all before this file.
 *
 * devduck's tool is one function: hand it a GraphQL document and it POSTs it to
 * /graphql. Everything below was measured against this machine's real token
 * (12 scopes, 5000/hr core) before it was written down.
 *
 * 1. ITS OWN DOCUMENTED EXAMPLE ASKS FOR PERMISSION AND CANNOT GET IT.
 *    `is_mutation_query` is a substring scan over MUTATIVE_KEYWORDS — which
 *    contains "create", "update", "request", "close" and "merge". GitHub's own
 *    field names are `createdAt`, `updatedAt`, `pullRequests`, `mergedAt`, and
 *    its enum for a shut issue is `CLOSED`. So the read-only query in
 *    use_github.py's own docstring (it selects `pullRequests(states: OPEN)`)
 *    classifies as a mutation, and every read that wants a timestamp does too.
 *    A classified call then goes to `get_user_input`, which needs a TTY that an
 *    agent loop does not have. Here the test is on the OPERATION — is `mutation`
 *    a top-level keyword in the document, is the REST verb something other than
 *    GET — so reads are never blocked and writes are never missed.
 *
 * 2. ONE TOKEN SOURCE, ON A MACHINE AUTHENTICATED THREE WAYS.
 *    `os.environ.get("GITHUB_TOKEN", "")` and nothing else: no GH_TOKEN, no gh
 *    CLI, no keychain. Measured here: `gh auth token` answers in 29 ms with a
 *    token carrying repo/workflow/notifications scopes, and `git credential
 *    fill` returns a github.com credential from osxkeychain. Without the env
 *    var devduck says "GITHUB_TOKEN not found" on a machine where three other
 *    doors are open. This reads all four, in that order, and every error names
 *    which one the rejected token came from.
 *
 * 3. THE RATE LIMIT DISPLAY IS DEAD CODE.
 *    `format_github_response` prints its "Rate Limit Info" block from
 *    `response["extensions"]["cost"]`. Measured against api.github.com/graphql:
 *    the response has exactly one top-level key, `data`. There is no
 *    `extensions` — that block has never printed once. Meanwhile every REST
 *    response carries `x-ratelimit-remaining`, `x-ratelimit-reset` and
 *    `x-oauth-scopes`, which devduck never sees because it never makes a REST
 *    call. Here the reset time turns a 403 into "resets in 41m" and the scope
 *    list turns a 404 into "or this token cannot see it".
 *
 * 4. raise_for_status() THROWS GITHUB'S ANSWER AWAY.
 *    `execute_github_graphql` calls `response.raise_for_status()` before
 *    `.json()`, so for every HTTP-level failure the body is discarded. A 422
 *    surfaces as `HTTP Error: 422 Client Error: Unprocessable Entity for url:
 *    …` — GitHub's per-field `errors[]` array, which says exactly which input
 *    was wrong, is gone. 401 and 403 are special-cased into two fixed
 *    sentences; the 403 sentence guesses "may not have sufficient permissions"
 *    even when the real cause is the rate limit, which the headers state
 *    outright. GraphQL-level errors keep `locations` (line and column in the
 *    query) but drop `path` and `type`, so NOT_FOUND on one field of a large
 *    query does not say which field.
 *
 * 5. EVERY ANSWER IS json.dumps(indent=2), WITH ANSI CODES IN IT.
 *    Measured on strands-agents/sdk-python: 10 open PRs with the minimum useful
 *    field set is 4677 bytes of pretty-printed JSON from devduck; the same 10
 *    PRs render here in 1717 bytes — 2.7× smaller, and carrying labels, draft
 *    state and review decision that devduck's query never asked for. The dump
 *    also arrives wrapped in colorama escapes (`Fore.GREEN` + "Data:") —
 *    terminal bytes pasted into a model's context.
 *
 * 6. THE MODEL HAS TO KNOW THE GRAPHQL SCHEMA, AND THE NODE IDs.
 *    There are no actions — only "write GraphQL". Creating an issue needs
 *    `createIssue(input: {repositoryId: …})`, and a repositoryId is an opaque
 *    base64 node id, so devduck's cheapest path to "file an issue on owner/name"
 *    is two round trips plus schema knowledge. Here it is one call with
 *    owner/name. The 15 named actions cover what gets asked; `graphql` and
 *    `rest` stay as escape hatches so nothing devduck could do is lost.
 *
 * 7. NOTHING RESOLVES A URL. devduck's every call needs owner and name split
 *    apart by hand. People paste links, so repo= takes a bare name, owner/name,
 *    owner/name#12, a git@ remote, or any github.com URL — and a pasted
 *    /pull/12 link fills in number= as well.
 *
 * Knobs: TINY_GITHUB=0 unmounts the tool; TINY_GITHUB_TIMEOUT_MS bounds one
 * HTTP request (default 30 s, the same as devduck's requests timeout).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseYaml } from './yaml.js'

export const API = 'https://api.github.com'
/** GitHub pins REST behaviour to a dated version; unset means "whatever ships". */
export const API_VERSION = '2022-11-28'
export const USER_AGENT = 'tiny-tech'

export const PER_PAGE = 30
/** GitHub's own ceiling for per_page on every list endpoint. */
export const MAX_PER_PAGE = 100
export const LIST_SHOW = 60
export const FILE_MAX = 60_000
export const BODY_MAX = 4_000
export const COMMENT_MAX = 1_200
export const COMMENTS_SHOW = 20
export const JSON_MAX = 30_000
export const REQUEST_TIMEOUT_MS = 30_000
/** A spawn of `gh`/`git` is 29 ms measured; this is only for a wedged one. */
export const SUBPROCESS_TIMEOUT_MS = 5_000
/** Long enough that a conversation never re-spawns gh, short enough that
 *  `gh auth login` in another terminal takes effect without restarting tiny. */
export const TOKEN_TTL_MS = 300_000

export function requestTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TINY_GITHUB_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : REQUEST_TIMEOUT_MS
}

// ── the token ───────────────────────────────────────────────────────────────

export interface Token {
  token: string
  /** Where it came from, verbatim, because a 401 is about one specific door. */
  source: string
}

/** `command -v` without a shell. */
export function resolveBin(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    try {
      const p = join(dir, cmd)
      if (existsSync(p)) return p
    } catch { /* an unreadable PATH entry is not an error */ }
  }
  return null
}

/**
 * GH_TOKEN is read as well as GITHUB_TOKEN because that is the pair gh itself
 * honours, and a shell that has one very often does not have the other.
 */
export function envToken(env: NodeJS.ProcessEnv = process.env): Token | undefined {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ACCESS_TOKEN']) {
    const v = env[name]?.trim()
    if (v) return { token: v, source: name }
  }
  return undefined
}

export function ghConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'gh')
  return join(dir, 'hosts.yml')
}

/**
 * hosts.yml keeps the token either on the host or under the active user, and
 * with `secure_storage` on it keeps neither — that is what the gh CLI branch is
 * for. Parsing is in-house (yaml.ts) rather than a dependency, and a corrupt
 * file must fall through to the next source instead of failing the tool.
 */
export function tokenFromHostsYml(text: string, host = 'github.com'): string | undefined {
  let parsed: any
  try {
    parsed = parseYaml(text)
  } catch { return undefined }
  const h = parsed?.[host]
  if (!h || typeof h !== 'object') return undefined
  const direct = typeof h.oauth_token === 'string' ? h.oauth_token.trim() : ''
  if (direct) return direct
  const user = typeof h.user === 'string' ? h.user : ''
  const users = h.users && typeof h.users === 'object' ? h.users : undefined
  const entry = users ? (users[user] ?? Object.values(users)[0]) : undefined
  const nested = typeof (entry as any)?.oauth_token === 'string' ? (entry as any).oauth_token.trim() : ''
  return nested || undefined
}

export function hostsYmlToken(env: NodeJS.ProcessEnv = process.env, home = homedir()): Token | undefined {
  const path = ghConfigPath(env, home)
  try {
    if (!existsSync(path)) return undefined
    const t = tokenFromHostsYml(readFileSync(path, 'utf8'))
    return t ? { token: t, source: '~/.config/gh/hosts.yml' } : undefined
  } catch { return undefined }
}

/**
 * `gh auth token` is authoritative — it knows about keyring storage, enterprise
 * hosts and its own env precedence — and costs 29 ms on this machine, so it is
 * worth a spawn once every TOKEN_TTL_MS. Not logged in prints to stderr and
 * exits non-zero, which lands in the catch.
 */
export function ghCliToken(env: NodeJS.ProcessEnv = process.env, timeoutMs = SUBPROCESS_TIMEOUT_MS): Token | undefined {
  const bin = resolveBin('gh', env)
  if (!bin) return undefined
  try {
    const out = execFileSync(bin, ['auth', 'token'], {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const t = String(out).trim()
    // A token never contains whitespace; anything that does is gh talking.
    return t && !/\s/.test(t) ? { token: t, source: '`gh auth token`' } : undefined
  } catch { return undefined }
}

/**
 * The keychain, last. GIT_TERMINAL_PROMPT=0 is not optional: without a helper
 * that already has the credential, `git credential fill` asks for a username on
 * the terminal — which inside an Ink TUI means a hidden prompt behind the
 * rendered frame, and a tool call that hangs until the timeout. With it, git
 * fails immediately instead of asking.
 */
export function gitCredentialToken(env: NodeJS.ProcessEnv = process.env, timeoutMs = SUBPROCESS_TIMEOUT_MS): Token | undefined {
  const bin = resolveBin('git', env)
  if (!bin) return undefined
  try {
    const out = execFileSync(bin, ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv,
    })
    const m = /^password=(.+)$/m.exec(String(out))
    const t = m?.[1]?.trim()
    return t ? { token: t, source: 'git credential helper (keychain)' } : undefined
  } catch { return undefined }
}

let tokenCache: { at: number; token?: Token } | null = null

export function resolveToken(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Token | undefined {
  if (tokenCache && now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.token
  const found = envToken(env) || ghCliToken(env) || hostsYmlToken(env) || gitCredentialToken(env)
  tokenCache = { at: now, token: found }
  return found
}

export function resetGithubToken(): void {
  tokenCache = null
}

/**
 * The gate. Deliberately spawns nothing: an env var, one existsSync for
 * hosts.yml, and a PATH walk for `gh`. A machine with gh installed but logged
 * out mounts the tool and then explains itself on the first call, which is the
 * right trade — the alternative is 29 ms of spawn on every single tiny start.
 */
export function hasGithub(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (env.TINY_GITHUB === '0') return false
  if (envToken(env)) return true
  try {
    if (existsSync(ghConfigPath(env, home))) return true
  } catch { /* unreadable config dir */ }
  return !!resolveBin('gh', env)
}

/** ghp_ classic, github_pat_ fine-grained, gho_ from gh, ghs_ an app install. */
export function tokenKind(token: string): string {
  if (token.startsWith('github_pat_')) return 'fine-grained PAT'
  if (token.startsWith('ghp_')) return 'classic PAT'
  if (token.startsWith('gho_')) return 'OAuth (gh CLI)'
  if (token.startsWith('ghs_')) return 'app installation'
  if (token.startsWith('ghu_')) return 'app user-to-server'
  return 'unrecognised prefix'
}

// ── one request ─────────────────────────────────────────────────────────────

export interface GhResult {
  status: number
  ok: boolean
  json: any
  text: string
  headers: Record<string, string>
}

export function headersToMap(h: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (typeof (h as Headers).forEach === 'function') {
    ;(h as Headers).forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v)
  return out
}

export function apiUrl(pathOrUrl: string): string {
  const p = String(pathOrUrl || '').trim()
  if (/^https?:\/\//i.test(p)) return p
  return `${API}${p.startsWith('/') ? '' : '/'}${p}`
}

export async function request(pathOrUrl: string, opts: {
  method?: string
  body?: unknown
  token?: Token
  accept?: string
} = {}): Promise<GhResult> {
  const t = opts.token ?? resolveToken()
  const res = await fetch(apiUrl(pathOrUrl), {
    method: opts.method || 'GET',
    headers: {
      Accept: opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(t ? { Authorization: `Bearer ${t.token}` } : {}),
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(requestTimeout()),
  })
  const text = await res.text()
  let json: any
  try { json = text ? JSON.parse(text) : undefined } catch { /* HTML error page, or empty 204 */ }
  return { status: res.status, ok: res.ok, json, text, headers: headersToMap(res.headers) }
}

// ── errors, decoded into the action that fixes them ─────────────────────────

export function firstLine(s: string, max = 200): string {
  const line = String(s || '').split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "in 41m" from x-ratelimit-reset, which is epoch SECONDS, not millis. */
export function resetIn(headers: Record<string, string>, now = Date.now()): string {
  const at = Number(headers['x-ratelimit-reset'])
  if (!Number.isFinite(at) || at <= 0) return 'shortly'
  const secs = Math.round(at * 1000 - now) / 1000
  if (secs <= 0) return 'now'
  if (secs < 90) return `in ${Math.round(secs)}s`
  return `in ${Math.round(secs / 60)}m`
}

export function scopeList(headers: Record<string, string>): string {
  const raw = headers['x-oauth-scopes']
  if (raw === undefined) return 'not reported (fine-grained tokens have per-repo permissions instead of scopes)'
  const scopes = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return scopes.length ? scopes.join(', ') : 'none at all'
}

/** A budget line, printed only when it starts to matter. */
export function rateLimitNote(headers: Record<string, string>, now = Date.now()): string {
  const left = Number(headers['x-ratelimit-remaining'])
  const limit = Number(headers['x-ratelimit-limit'])
  if (!Number.isFinite(left) || !Number.isFinite(limit) || limit <= 0) return ''
  if (left > limit * 0.1) return ''
  return `\n⚠️ ${left} of ${limit} API calls left this window (resets ${resetIn(headers, now)})`
}

export function formatValidationErrors(json: any): string {
  const errs = Array.isArray(json?.errors) ? json.errors : []
  const lines: string[] = []
  for (const e of errs) {
    if (typeof e === 'string') { lines.push(`   ${e}`); continue }
    const where = [e?.resource, e?.field].filter(Boolean).join('.')
    const why = e?.message || e?.code || 'invalid'
    lines.push(`   ${where ? `${where}: ` : ''}${why}`)
  }
  return lines.join('\n')
}

export function decodeError(r: GhResult, context: string, tokenSource = 'no token', now = Date.now()): string {
  const msg = String(r.json?.message || firstLine(r.text) || `HTTP ${r.status}`)
  const scopes = scopeList(r.headers)
  const left = Number(r.headers['x-ratelimit-remaining'])

  if (r.status === 401) {
    return `❌ ${context} → GitHub rejected the token from ${tokenSource} (401 ${msg}).`
      + `\n   Refresh it: \`gh auth login\`, or set GITHUB_TOKEN from https://github.com/settings/tokens`
  }
  if (r.status === 403 || r.status === 429) {
    if (left === 0) {
      return `❌ ${context} → rate limit reached (0 of ${r.headers['x-ratelimit-limit'] || '?'} left on the ${r.headers['x-ratelimit-resource'] || 'core'} bucket). Resets ${resetIn(r.headers, now)}.`
    }
    if (/secondary rate limit|abuse detection/i.test(msg)) {
      return `❌ ${context} → GitHub's secondary rate limit: too many calls in a burst, quota is fine. Wait ~60s and retry; do not loop.`
    }
    if (/not accessible by integration|resource not accessible/i.test(msg)) {
      return `❌ ${context} → this token is not allowed there (403 ${msg}). It has: ${scopes}.`
    }
    return `❌ ${context} → 403 ${msg}. Token scopes: ${scopes}.`
      + `\n   Writing needs "repo"; notifications need "notifications"; Actions need "workflow".`
  }
  if (r.status === 404) {
    return `❌ ${context} → 404. Either it does not exist (check the owner/name spelling and that the repo was not renamed) or this token cannot see it — a private repo needs the "repo" scope, and this one has: ${scopes}.`
  }
  if (r.status === 410) {
    return `❌ ${context} → 410 gone: issues are disabled on that repo, or the resource was deleted.`
  }
  if (r.status === 422) {
    const detail = formatValidationErrors(r.json)
    return `❌ ${context} → 422 ${msg}${detail ? `\n${detail}` : ''}`
      + (/no commit found|No commit found for the ref/i.test(msg) ? '\n   That usually means the branch or ref does not exist.' : '')
  }
  if (r.status === 451) {
    return `❌ ${context} → 451: unavailable for legal reasons (DMCA takedown).`
  }
  if (r.status >= 500) {
    return `❌ ${context} → GitHub itself failed (HTTP ${r.status} ${msg}). Retry; check https://www.githubstatus.com if it persists.`
  }
  return `❌ ${context} → HTTP ${r.status} ${msg}`
}

/**
 * GraphQL answers 200 with an `errors` array, and often with partial `data`
 * beside it. Keeping `path` and `type` is the difference between "NOT_FOUND"
 * and "NOT_FOUND at repository.pullRequest — that number does not exist".
 */
export function formatGraphqlErrors(json: any): string {
  const errs = Array.isArray(json?.errors) ? json.errors : []
  if (!errs.length) return ''
  const lines = errs.map((e: any) => {
    const path = Array.isArray(e?.path) ? ` at ${e.path.join('.')}` : ''
    const type = e?.type ? ` [${e.type}]` : ''
    const loc = !path && Array.isArray(e?.locations) && e.locations[0]
      ? ` (query line ${e.locations[0].line}, column ${e.locations[0].column})`
      : ''
    return `   ${e?.message || JSON.stringify(e)}${type}${path}${loc}`
  })
  const hint = errs.some((e: any) => e?.type === 'NOT_FOUND' || /Could not resolve/i.test(String(e?.message)))
    ? '\n   NOT_FOUND from GraphQL also means "invisible to this token" — a private repo needs the "repo" scope.'
    : ''
  return `GraphQL errors:\n${lines.join('\n')}${hint}`
}

// ── is this a write? ────────────────────────────────────────────────────────

/** Comments and string literals out, so a keyword test sees only structure. */
export function stripLiterals(query: string): string {
  const q = String(query || '')
  let out = ''
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    if (c === '#') {
      while (i < q.length && q[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '"') {
      if (q.slice(i, i + 3) === '"""') {
        const end = q.indexOf('"""', i + 3)
        i = end === -1 ? q.length : end + 2
        out += '""'
        continue
      }
      i++
      while (i < q.length && q[i] !== '"') {
        if (q[i] === '\\') i++
        i++
      }
      out += '""'
      continue
    }
    out += c
  }
  return out
}

/**
 * A document writes if and only if it declares a top-level `mutation`
 * operation. Depth-tracking is what makes this different from devduck's
 * substring scan: `updatedAt` inside a selection set is not an operation
 * keyword, and neither is a field called `mutationId`.
 */
export function isMutation(query: string): boolean {
  const s = stripLiterals(query)
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') { depth++; continue }
    if (c === '}') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0) continue
    if ((c === 'm' || c === 'M') && /^mutation\b/i.test(s.slice(i, i + 12))) {
      const before = i === 0 ? '' : s[i - 1]
      if (!/[A-Za-z0-9_$]/.test(before)) return true
    }
  }
  return false
}

export const READ_METHODS = ['GET', 'HEAD', 'OPTIONS']

export function normalizeMethod(m: string | undefined): string {
  return String(m || 'GET').trim().toUpperCase()
}

// ── owner/name, however it was written ──────────────────────────────────────

export interface Target { owner: string; name: string; number?: number }

/** GitHub's own rules: a login is alphanumerics with single inner hyphens. */
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
export const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * Accepts owner/name, a bare name (with the viewer as owner), owner/name#12,
 * a git@github.com: remote, and any github.com URL — /pull/12, /issues/12,
 * /blob/main/x.ts, /tree/main, with or without a trailing .git or slash.
 */
export function parseTarget(raw: string | undefined, defaultOwner?: string): Target | { error: string } {
  let s = String(raw ?? '').trim()
  if (!s) return { error: "repo is required — e.g. repo='owner/name', a bare name, or a pasted github.com link" }

  s = s.replace(/^git@github\.com:/i, '')
       .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
       .replace(/^(?:https?:\/\/)?api\.github\.com\/repos\//i, '')
       .replace(/^\/+/, '')

  let number: number | undefined
  const hash = /#(\d+)\s*$/.exec(s)
  if (hash) {
    number = Number(hash[1])
    s = s.slice(0, hash.index)
  }

  const parts = s.split('/').filter(Boolean)
  const nested = /^(pull|pulls|issues|discussions)$/i.exec(parts[2] || '')
  if (nested && /^\d+$/.test(parts[3] || '')) number = Number(parts[3])

  let owner: string, name: string
  if (parts.length === 1) {
    if (!defaultOwner) return { error: `"${parts[0]}" has no owner — write it as owner/${parts[0]}` }
    owner = defaultOwner
    name = parts[0]
  } else if (parts.length >= 2) {
    owner = parts[0]
    name = parts[1]
  } else {
    return { error: `cannot read "${raw}" as a repository` }
  }

  name = name.replace(/\.git$/i, '')
  // A login is alphanumerics and single hyphens — no dots, no underscores — and
  // a repo name may hold dots but can never BE dots. Without the second half,
  // "../../etc/passwd" parses as owner ".." and the request path collapses to
  // somewhere nobody asked about.
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || /^\.+$/.test(name)) {
    return { error: `"${raw}" is not a repository — expected owner/name` }
  }
  return { owner, name, ...(number ? { number } : {}) }
}

export function encodeQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function clampLimit(n: number | undefined, fallback = PER_PAGE): number {
  if (!Number.isFinite(n as number) || (n as number) <= 0) return fallback
  return Math.min(Math.floor(n as number), MAX_PER_PAGE)
}

/**
 * Whether GitHub says there is another page. The Link header is the only
 * honest answer for list endpoints, which carry no total count — and saying
 * "there are more" is what devduck's cursor-less GraphQL never does.
 */
export function hasMore(headers: Record<string, string>): boolean {
  return /rel="next"/.test(headers['link'] || '')
}

export function moreNote(headers: Record<string, string>, shown: number, what: string): string {
  return hasMore(headers) ? `\n… more ${what} exist beyond these ${shown} — raise limit= (max ${MAX_PER_PAGE}) or narrow the query` : ''
}

// ── rendering ───────────────────────────────────────────────────────────────

export function relTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const secs = Math.round((now.getTime() - then) / 1000)
  if (secs < 0) return 'in the future'
  if (secs < 90) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 45) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 18) return `${months}mo ago`
  return `${Math.round(days / 365)}y ago`
}

export function truncate(s: string, max = BODY_MAX): string {
  const t = String(s ?? '')
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n… truncated, ${t.length - max} more characters`
}

/** A body is markdown written for humans; collapse it, don't reflow it. */
export function oneLine(s: string | undefined, max = 100): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function labelNames(item: any): string {
  const labels = Array.isArray(item?.labels) ? item.labels : []
  const names = labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
  return names.length ? ` [${names.join(', ')}]` : ''
}

export function stateGlyph(item: any): string {
  if (item?.draft) return '📝'
  if (item?.merged_at || item?.pull_request?.merged_at) return '🟣'
  if (item?.state === 'closed') return '🔴'
  return '🟢'
}

export function formatRepos(repos: any[], now = new Date()): string {
  return repos.map((r) => {
    const bits = [
      r.private ? 'private' : '',
      r.fork ? 'fork' : '',
      r.archived ? 'archived' : '',
      r.language || '',
      r.stargazers_count ? `★${r.stargazers_count}` : '',
      r.open_issues_count ? `${r.open_issues_count} open` : '',
    ].filter(Boolean).join(' · ')
    return `${r.full_name || r.name}${bits ? `  ${bits}` : ''}  pushed ${relTime(r.pushed_at || r.updated_at, now)}`
      + (r.description ? `\n   ${oneLine(r.description, 110)}` : '')
  }).join('\n')
}

export function formatRepo(r: any, now = new Date()): string {
  const lines = [
    `${r.full_name}${r.private ? ' (private)' : ''}${r.archived ? ' (archived)' : ''}`,
    r.description ? `   ${oneLine(r.description, 160)}` : '',
    `   ${[
      r.language,
      `★${r.stargazers_count ?? 0}`,
      `${r.forks_count ?? 0} forks`,
      `${r.open_issues_count ?? 0} open issues+PRs`,
      `default branch ${r.default_branch}`,
    ].filter(Boolean).join(' · ')}`,
    `   pushed ${relTime(r.pushed_at, now)}, created ${relTime(r.created_at, now)}`,
    r.homepage ? `   ${r.homepage}` : '',
    r.parent?.full_name ? `   forked from ${r.parent.full_name}` : '',
    r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? `   ${r.license.spdx_id}` : '',
    `   ${r.html_url}`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** Issues and PRs render the same way, from list, search or detail endpoints. */
export function formatIssues(items: any[], now = new Date()): string {
  return items.map((i) => {
    const repo = i.repository?.full_name
      || (typeof i.repository_url === 'string' ? i.repository_url.split('/repos/')[1] : '')
    const kind = i.pull_request || i.head ? 'PR' : 'issue'
    const who = i.user?.login || i.author?.login || '?'
    const meta = [
      i.comments ? `${i.comments} comments` : '',
      i.draft ? 'draft' : '',
      reviewWord(i),
    ].filter(Boolean).join(' · ')
    return `${stateGlyph(i)} ${repo ? `${repo}#` : '#'}${i.number} ${oneLine(i.title, 100)}${labelNames(i)}`
      + `\n   ${kind} by ${who}, updated ${relTime(i.updated_at, now)}${meta ? ` · ${meta}` : ''}`
  }).join('\n')
}

export function reviewWord(pr: any): string {
  const d = pr?.review_decision || pr?.reviewDecision
  if (d === 'APPROVED') return 'approved'
  if (d === 'CHANGES_REQUESTED') return 'changes requested'
  if (d === 'REVIEW_REQUIRED') return 'review required'
  return ''
}

export function formatComments(comments: any[], now = new Date()): string {
  if (!comments.length) return ''
  const shown = comments.slice(-COMMENTS_SHOW)
  const head = comments.length > shown.length
    ? `\n\n${comments.length} comments (last ${shown.length}):`
    : `\n\n${comments.length} comment${comments.length === 1 ? '' : 's'}:`
  return head + shown.map((c) => `\n\n— ${c.user?.login || '?'}, ${relTime(c.created_at, now)}:\n${truncate(c.body || '(empty)', COMMENT_MAX)}`).join('')
}

export function formatIssueDetail(i: any, comments: any[], now = new Date()): string {
  const lines = [
    `${stateGlyph(i)} #${i.number} ${i.title}${labelNames(i)}`,
    `   ${i.state}${i.state_reason ? ` (${i.state_reason})` : ''} · opened by ${i.user?.login || '?'} ${relTime(i.created_at, now)} · updated ${relTime(i.updated_at, now)}`,
    i.assignees?.length ? `   assigned: ${i.assignees.map((a: any) => a.login).join(', ')}` : '',
    i.milestone?.title ? `   milestone: ${i.milestone.title}` : '',
    `   ${i.html_url}`,
    '',
    truncate(i.body || '(no description)'),
  ]
  return lines.filter((l) => l !== '').join('\n') + formatComments(comments, now)
}

export function formatChecks(checkRuns: any[]): string {
  if (!checkRuns.length) return ''
  const counts = new Map<string, number>()
  for (const c of checkRuns) {
    const key = c.status === 'completed' ? String(c.conclusion || 'unknown') : String(c.status)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const failed = checkRuns.filter((c) => ['failure', 'timed_out', 'action_required'].includes(String(c.conclusion)))
  const summary = [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ')
  return `\n   checks: ${summary}`
    + failed.slice(0, 5).map((c) => `\n     ❌ ${c.name}${c.html_url ? ` — ${c.html_url}` : ''}`).join('')
}

export function formatPrDetail(pr: any, comments: any[], reviews: any[], checkRuns: any[], now = new Date()): string {
  const merge = pr.merged
    ? `merged ${relTime(pr.merged_at, now)} by ${pr.merged_by?.login || '?'}`
    : pr.state === 'closed'
      ? `closed ${relTime(pr.closed_at, now)} without merging`
      : pr.mergeable === false
        ? `open, NOT mergeable (${pr.mergeable_state || 'conflict'})`
        : `open${pr.draft ? ', draft' : ''}${pr.mergeable_state && pr.mergeable_state !== 'clean' ? `, ${pr.mergeable_state}` : ''}`
  const reviewLines = reviews
    .filter((r) => r.state !== 'COMMENTED' || r.body)
    .slice(-8)
    .map((r) => `\n     ${r.user?.login || '?'}: ${String(r.state || '').toLowerCase()}${r.body ? ` — ${oneLine(r.body, 80)}` : ''}`)
    .join('')
  const lines = [
    `${stateGlyph(pr)} #${pr.number} ${pr.title}${labelNames(pr)}`,
    `   ${merge} · by ${pr.user?.login || '?'} ${relTime(pr.created_at, now)}`,
    `   ${pr.head?.label || pr.head?.ref} → ${pr.base?.ref}  +${pr.additions ?? '?'}/-${pr.deletions ?? '?'} across ${pr.changed_files ?? '?'} files, ${pr.commits ?? '?'} commits`,
    reviews.length ? `   reviews:${reviewLines}` : '',
    `   ${pr.html_url}`,
  ].filter(Boolean).join('\n')
  return lines + formatChecks(checkRuns) + '\n\n' + truncate(pr.body || '(no description)') + formatComments(comments, now)
}

export function formatNotifications(list: any[], now = new Date()): string {
  const byRepo = new Map<string, any[]>()
  for (const n of list) {
    const repo = n.repository?.full_name || '?'
    if (!byRepo.has(repo)) byRepo.set(repo, [])
    byRepo.get(repo)!.push(n)
  }
  const out: string[] = []
  for (const [repo, items] of byRepo) {
    out.push(`${repo} (${items.length})`)
    for (const n of items) {
      const url = String(n.subject?.url || '')
      const num = /\/(\d+)$/.exec(url)?.[1]
      out.push(`   ${n.unread ? '●' : '○'} ${n.reason.replace(/_/g, ' ')}: ${oneLine(n.subject?.title, 90)}`)
      out.push(`     ${n.subject?.type || ''}${num ? ` #${num}` : ''} · ${relTime(n.updated_at, now)}`)
    }
  }
  return out.join('\n')
}

export const RUN_GLYPH: Record<string, string> = {
  success: '✅',
  failure: '❌',
  cancelled: '⛔',
  skipped: '⏭️',
  neutral: '➖',
  timed_out: '⏱️',
  action_required: '⚠️',
  stale: '🕸️',
  startup_failure: '💥',
  in_progress: '⏳',
  queued: '⏸️',
  waiting: '⏸️',
  requested: '⏸️',
  pending: '⏸️',
}

export function runGlyph(run: any): string {
  const key = run?.status === 'completed' ? String(run?.conclusion || '') : String(run?.status || '')
  return RUN_GLYPH[key] || '·'
}

export function formatRuns(runs: any[], now = new Date()): string {
  return runs.map((r) => {
    const took = r.run_started_at && r.updated_at
      ? Math.max(0, Math.round((new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()) / 1000))
      : undefined
    return `${runGlyph(r)} ${r.name || r.display_title || 'workflow'} #${r.run_number}`
      + ` on ${r.head_branch} (${r.event}) — ${relTime(r.created_at, now)}${took !== undefined ? `, ${took}s` : ''}`
      + `\n   ${oneLine(r.display_title || r.head_commit?.message, 100)}`
      + (['failure', 'timed_out', 'startup_failure'].includes(String(r.conclusion)) ? `\n   ${r.html_url}` : '')
  }).join('\n')
}

export function formatCommits(commits: any[], now = new Date()): string {
  return commits.map((c) => {
    const who = c.author?.login || c.commit?.author?.name || '?'
    return `${String(c.sha || '').slice(0, 7)} ${oneLine(c.commit?.message, 90)}`
      + `\n   ${who}, ${relTime(c.commit?.author?.date, now)}`
  }).join('\n')
}

export function formatDir(entries: any[]): string {
  const dirs = entries.filter((e) => e.type === 'dir').map((e) => `${e.name}/`)
  const files = entries.filter((e) => e.type !== 'dir').map((e) => `${e.name}  ${e.size} bytes`)
  return [...dirs.sort(), ...files.sort()].join('\n')
}

/** The contents API wraps base64 at 60 columns; Node's decoder skips the breaks. */
export function decodeContent(json: any): string {
  if (json?.encoding !== 'base64') return String(json?.content ?? '')
  return Buffer.from(String(json.content || ''), 'base64').toString('utf8')
}

export function formatSearchRepos(items: any[], total: number, now = new Date()): string {
  return `${total} repositories match, showing ${items.length}:\n${formatRepos(items, now)}`
}

export function formatSearchUsers(items: any[], total: number): string {
  return `${total} users match, showing ${items.length}:\n`
    + items.map((u) => `${u.login}${u.type && u.type !== 'User' ? ` (${u.type})` : ''} — ${u.html_url}`).join('\n')
}

export function formatSearchCode(items: any[], total: number): string {
  return `${total} code matches, showing ${items.length}:\n`
    + items.map((c) => {
      const frag = (c.text_matches || []).map((m: any) => oneLine(m.fragment, 120)).slice(0, 2)
      return `${c.repository?.full_name}/${c.path}` + frag.map((f: string) => `\n   ${f}`).join('')
    }).join('\n')
}

export function formatSearchCommits(items: any[], total: number, now = new Date()): string {
  return `${total} commits match, showing ${items.length}:\n`
    + items.map((c) => `${String(c.sha).slice(0, 7)} ${c.repository?.full_name} — ${oneLine(c.commit?.message, 80)}\n   ${c.commit?.author?.name}, ${relTime(c.commit?.author?.date, now)}`).join('\n')
}

// ── the tool ────────────────────────────────────────────────────────────────

export const SEARCH_TYPES = ['repos', 'issues', 'code', 'users', 'commits'] as const

/** One list, so the schema and the help text cannot drift apart. */
export const GITHUB_ACTIONS = [
  'me', 'repos', 'repo', 'issues', 'issue', 'prs', 'pr', 'notifications',
  'runs', 'commits', 'file', 'search', 'create_issue', 'comment',
  'graphql', 'rest', 'help',
] as const

export const SEARCH_PATHS: Record<string, string> = {
  repos: '/search/repositories',
  issues: '/search/issues',
  code: '/search/code',
  users: '/search/users',
  commits: '/search/commits',
}

const DESCRIPTION = `🐙 use_github — repos, issues, PRs, CI and code on github.com.

  me                                   who this token is, its scopes, rate limit
  repos [owner=] [limit=]              most recently pushed first
  repo repo='owner/name'               stars, language, default branch, counts
  issues [repo=] [state=] [limit=]     no repo → open issues involving you
  issue repo= number=                  the description and the comments
  prs [repo=] [state=]                 no repo → yours + awaiting your review
  pr repo= number=                     body, reviews, checks, diffstat, comments
  notifications [all=true]             unread, grouped by repo, with the reason
  runs repo= [branch=]                 recent workflow runs, failures linked
  commits repo= [ref=] [path=]         recent history
  file repo= path= [ref=]              one file, or a directory listing
  search q='…' [type=repos|issues|code|users|commits]
  create_issue repo= title= [body=]
  comment repo= number= body='…'       on an issue OR a pull request
  graphql query='…' [variables='{…}']  the raw v4 API
  rest path='/…' [method=] [body='{…}']  the raw v3 API

repo= takes owner/name, a bare name (yours), owner/name#12, a git@ remote, or
any github.com URL — a pasted /pull/12 link fills in number= too.

Search syntax is GitHub's own: q='is:open author:@me', q='repo:foo/bar label:bug'.

⚠️ create_issue and comment are PUBLIC and immediate, and graphql/rest will
write whatever they are given. rest with method=DELETE requires confirm=<path>.`

export function makeGithubTool() {
  return tool({
    name: 'use_github',
    description: DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(GITHUB_ACTIONS),
      repo: z.string().optional().describe("owner/name, a bare name, or a github.com URL"),
      owner: z.string().optional().describe('a user or org, for action=repos'),
      number: z.number().optional().describe('issue or PR number'),
      title: z.string().optional(),
      body: z.string().optional().describe('markdown body, or a JSON object for action=rest'),
      q: z.string().optional().describe("GitHub search syntax, e.g. 'is:open label:bug'"),
      type: z.enum(SEARCH_TYPES).optional().describe('what to search (default repos)'),
      path: z.string().optional().describe('a file path in the repo, or the API path for action=rest'),
      ref: z.string().optional().describe('branch, tag or sha (default: the default branch)'),
      branch: z.string().optional().describe('filter workflow runs to one branch'),
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().optional().describe(`how many to return (max ${MAX_PER_PAGE})`),
      all: z.boolean().optional().describe('notifications: include already-read ones'),
      query: z.string().optional().describe('a GraphQL document, for action=graphql'),
      variables: z.string().optional().describe('JSON object of GraphQL variables'),
      method: z.string().optional().describe('HTTP method for action=rest (default GET)'),
      confirm: z.string().optional().describe('for a DELETE: repeat the path exactly'),
    }),
    callback: async (a) => {
      if (a.action === 'help') return DESCRIPTION

      const token = resolveToken()
      if (!token) {
        return 'use_github needs a GitHub token and found none. Easiest: `gh auth login`. '
          + 'Otherwise set GITHUB_TOKEN from https://github.com/settings/tokens with the "repo" scope '
          + '(add "notifications" to read notifications and "workflow" for Actions). '
          + 'A token in the macOS keychain (`git credential fill`) is picked up too.'
      }

      const limit = clampLimit(a.limit)

      /** The login this token is, cached for the life of one call chain. */
      let viewer: string | undefined
      const whoAmI = async (): Promise<string | undefined> => {
        if (viewer !== undefined) return viewer
        const r = await request('/user', { token })
        viewer = r.ok ? String(r.json?.login || '') : ''
        return viewer
      }

      /** owner/name for the actions that need one, with the viewer as default. */
      const target = async (): Promise<Target | { error: string }> => {
        const t = parseTarget(a.repo, undefined)
        if ('error' in t && a.repo && !a.repo.includes('/')) {
          const me = await whoAmI()
          if (me) return parseTarget(a.repo, me)
        }
        return t
      }

      const numberOf = (t: Target): number | undefined => a.number ?? t.number

      try {
        switch (a.action) {
          case 'me': {
            const r = await request('/user', { token })
            if (!r.ok) return decodeError(r, 'reading your account', token.source)
            const u = r.json
            const limits = [
              `${r.headers['x-ratelimit-remaining']}/${r.headers['x-ratelimit-limit']} core calls left`,
              `resets ${resetIn(r.headers)}`,
            ].join(', ')
            return [
              `${u.login}${u.name ? ` (${u.name})` : ''} — ${u.type?.toLowerCase() || 'user'}`,
              `   ${u.public_repos ?? 0} public repos, ${u.total_private_repos ?? u.owned_private_repos ?? 0} private, ${u.followers ?? 0} followers`,
              u.company || u.location ? `   ${[u.company, u.location].filter(Boolean).join(' · ')}` : '',
              `   token: ${token.source} (${tokenKind(token.token)})`,
              `   scopes: ${scopeList(r.headers)}`,
              `   ${limits}`,
            ].filter(Boolean).join('\n')
          }

          case 'repos': {
            const who = a.owner?.trim()
            const url = who
              ? `/users/${encodeURIComponent(who)}/repos${encodeQuery({ sort: 'pushed', per_page: limit })}`
              : `/user/repos${encodeQuery({ sort: 'pushed', per_page: limit, affiliation: 'owner,collaborator,organization_member' })}`
            const r = await request(url, { token })
            if (!r.ok) return decodeError(r, `listing repos of ${who || 'yours'}`, token.source)
            const repos = Array.isArray(r.json) ? r.json : []
            if (!repos.length) return `${who || 'you'} ha${who ? 's' : 've'} no repositories this token can see`
            return `${repos.length} repos, most recently pushed first:\n${formatRepos(repos)}`
              + moreNote(r.headers, repos.length, 'repos') + rateLimitNote(r.headers)
          }

          case 'repo': {
            const t = await target()
            if ('error' in t) return t.error
            const r = await request(`/repos/${t.owner}/${t.name}`, { token })
            if (!r.ok) return decodeError(r, `reading ${t.owner}/${t.name}`, token.source)
            // A renamed repo answers 301 and fetch follows it silently, so the
            // name that comes back is not always the one that was asked for.
            // Measured: strands-agents/sdk-python resolves to harness-sdk. Left
            // unsaid, the model reports a repo the user did not name.
            const asked = `${t.owner}/${t.name}`
            const actual = String(r.json?.full_name || '')
            const renamed = actual && actual.toLowerCase() !== asked.toLowerCase()
              ? `\n   ⚠️ ${asked} is a redirect — the repo is now ${actual}`
              : ''
            return formatRepo(r.json) + renamed + rateLimitNote(r.headers)
          }

          case 'issues':
          case 'prs': {
            const wantPrs = a.action === 'prs'
            const state = a.state || 'open'
            if (!a.repo) {
              const me = await whoAmI()
              if (!me) return 'could not work out who this token belongs to, so "your issues" has no meaning — pass repo='
              const q = a.q?.trim()
                || (wantPrs
                  ? `is:pr state:${state} involves:${me}`
                  : `is:issue state:${state} involves:${me}`)
              const r = await request(`/search/issues${encodeQuery({ q, sort: 'updated', per_page: limit })}`, { token })
              if (!r.ok) return decodeError(r, `searching for your ${wantPrs ? 'PRs' : 'issues'}`, token.source)
              const items = r.json?.items || []
              if (!items.length) return `nothing matches "${q}"`
              return `${r.json.total_count} match "${q}", showing ${items.length}:\n${formatIssues(items)}` + rateLimitNote(r.headers)
            }
            const t = await target()
            if ('error' in t) return t.error
            const path = wantPrs
              ? `/repos/${t.owner}/${t.name}/pulls${encodeQuery({ state, per_page: limit, sort: 'updated', direction: 'desc' })}`
              : `/repos/${t.owner}/${t.name}/issues${encodeQuery({ state, per_page: limit, sort: 'updated', direction: 'desc' })}`
            const r = await request(path, { token })
            if (!r.ok) return decodeError(r, `listing ${state} ${wantPrs ? 'PRs' : 'issues'} of ${t.owner}/${t.name}`, token.source)
            let items = Array.isArray(r.json) ? r.json : []
            // /issues returns pull requests too — GitHub treats a PR as an issue,
            // which is why asking for issues gets PRs unless they are filtered.
            const prsInIssues = wantPrs ? 0 : items.filter((i: any) => i.pull_request).length
            if (!wantPrs) items = items.filter((i: any) => !i.pull_request)
            if (!items.length) {
              return `no ${state === 'all' ? '' : `${state} `}${wantPrs ? 'PRs' : 'issues'} in ${t.owner}/${t.name}`
                + (prsInIssues ? ` (${prsInIssues} open PRs though — action='prs')` : '')
            }
            return `${t.owner}/${t.name}, ${items.length} ${state === 'all' ? '' : `${state} `}${wantPrs ? 'PRs' : 'issues'}:\n${formatIssues(items)}`
              + (prsInIssues ? `\n(${prsInIssues} pull requests filtered out — action='prs' for those)` : '')
              + moreNote(r.headers, items.length, wantPrs ? 'PRs' : 'issues') + rateLimitNote(r.headers)
          }

          case 'issue': {
            const t = await target()
            if ('error' in t) return t.error
            const n = numberOf(t)
            if (!n) return "need number — e.g. number=12, or paste the issue URL as repo="
            const [r, c] = await Promise.all([
              request(`/repos/${t.owner}/${t.name}/issues/${n}`, { token }),
              request(`/repos/${t.owner}/${t.name}/issues/${n}/comments${encodeQuery({ per_page: MAX_PER_PAGE })}`, { token }),
            ])
            if (!r.ok) return decodeError(r, `reading ${t.owner}/${t.name}#${n}`, token.source)
            if (r.json?.pull_request) {
              return formatIssueDetail(r.json, Array.isArray(c.json) ? c.json : [])
                + "\n\n(that number is a pull request — action='pr' adds its reviews, checks and diffstat)"
            }
            return formatIssueDetail(r.json, Array.isArray(c.json) ? c.json : []) + rateLimitNote(r.headers)
          }

          case 'pr': {
            const t = await target()
            if ('error' in t) return t.error
            const n = numberOf(t)
            if (!n) return "need number — e.g. number=12, or paste the PR URL as repo="
            const base = `/repos/${t.owner}/${t.name}`
            const r = await request(`${base}/pulls/${n}`, { token })
            if (!r.ok) {
              const asIssue = r.status === 404 ? await request(`${base}/issues/${n}`, { token }) : undefined
              if (asIssue?.ok) return `#${n} in ${t.owner}/${t.name} is an issue, not a PR — action='issue' reads it`
              return decodeError(r, `reading PR ${t.owner}/${t.name}#${n}`, token.source)
            }
            // Reviews, comments and checks are separate endpoints; any of them
            // may 403 on a token without the scope, and a partial answer beats
            // failing the whole read.
            const sha = r.json?.head?.sha
            const [comments, reviews, checks] = await Promise.all([
              request(`${base}/issues/${n}/comments${encodeQuery({ per_page: MAX_PER_PAGE })}`, { token }),
              request(`${base}/pulls/${n}/reviews${encodeQuery({ per_page: MAX_PER_PAGE })}`, { token }),
              sha ? request(`${base}/commits/${sha}/check-runs${encodeQuery({ per_page: MAX_PER_PAGE })}`, { token }) : Promise.resolve(undefined as any),
            ])
            return formatPrDetail(
              r.json,
              Array.isArray(comments.json) ? comments.json : [],
              Array.isArray(reviews.json) ? reviews.json : [],
              Array.isArray(checks?.json?.check_runs) ? checks.json.check_runs : [],
            ) + rateLimitNote(r.headers)
          }

          case 'notifications': {
            const r = await request(`/notifications${encodeQuery({ all: a.all ? 'true' : 'false', per_page: limit })}`, { token })
            if (!r.ok) return decodeError(r, 'reading notifications', token.source)
            const list = Array.isArray(r.json) ? r.json : []
            if (!list.length) return a.all ? 'no notifications at all' : 'no unread notifications (all=true includes read ones)'
            return `${list.length}${hasMore(r.headers) ? '+' : ''} ${a.all ? '' : 'unread '}notifications:\n${formatNotifications(list)}`
              + moreNote(r.headers, list.length, 'notifications') + rateLimitNote(r.headers)
          }

          case 'runs': {
            const t = await target()
            if ('error' in t) return t.error
            const r = await request(`/repos/${t.owner}/${t.name}/actions/runs${encodeQuery({ per_page: limit, branch: a.branch || a.ref })}`, { token })
            if (!r.ok) return decodeError(r, `reading workflow runs of ${t.owner}/${t.name}`, token.source)
            const runs = r.json?.workflow_runs || []
            if (!runs.length) {
              return `no workflow runs in ${t.owner}/${t.name}${a.branch || a.ref ? ` on ${a.branch || a.ref}` : ''}`
                + (r.json?.total_count === 0 ? ' — the repo may have no Actions at all' : '')
            }
            return `${t.owner}/${t.name}, ${runs.length} of ${r.json.total_count} runs:\n${formatRuns(runs)}` + rateLimitNote(r.headers)
          }

          case 'commits': {
            const t = await target()
            if ('error' in t) return t.error
            const r = await request(`/repos/${t.owner}/${t.name}/commits${encodeQuery({ per_page: limit, sha: a.ref, path: a.path })}`, { token })
            if (!r.ok) return decodeError(r, `reading commits of ${t.owner}/${t.name}`, token.source)
            const commits = Array.isArray(r.json) ? r.json : []
            if (!commits.length) return `no commits${a.path ? ` touching ${a.path}` : ''}${a.ref ? ` on ${a.ref}` : ''} in ${t.owner}/${t.name}`
            return `${t.owner}/${t.name}${a.ref ? `@${a.ref}` : ''}${a.path ? ` — ${a.path}` : ''}, ${commits.length} commits:\n${formatCommits(commits)}`
              + moreNote(r.headers, commits.length, 'commits') + rateLimitNote(r.headers)
          }

          case 'file': {
            const t = await target()
            if ('error' in t) return t.error
            if (!a.path) return "need path — e.g. path='README.md' (path='' with action='file' is not a directory listing; pass path='.' for the root)"
            const clean = a.path === '.' ? '' : a.path.replace(/^\/+/, '')
            const r = await request(`/repos/${t.owner}/${t.name}/contents/${clean.split('/').map(encodeURIComponent).join('/')}${encodeQuery({ ref: a.ref })}`, { token })
            if (!r.ok) return decodeError(r, `reading ${clean || '/'} in ${t.owner}/${t.name}${a.ref ? `@${a.ref}` : ''}`, token.source)
            if (Array.isArray(r.json)) {
              return `${t.owner}/${t.name}${a.ref ? `@${a.ref}` : ''} — ${clean || '/'} (${r.json.length} entries):\n${formatDir(r.json)}`
            }
            const j = r.json
            if (j?.type === 'submodule') return `${clean} is a submodule pointing at ${j.submodule_git_url} (sha ${String(j.sha).slice(0, 7)})`
            if (j?.type === 'symlink') return `${clean} is a symlink to ${j.target}`
            // Over a megabyte GitHub answers with metadata and no content at all.
            if (!j?.content && j?.download_url) {
              return `${clean} is ${j.size} bytes — too big for the contents API to inline. Fetch it directly: ${j.download_url}`
            }
            const text = decodeContent(j)
            return `${t.owner}/${t.name}${a.ref ? `@${a.ref}` : ''} — ${clean} (${j.size} bytes)\n\n${truncate(text, FILE_MAX)}`
          }

          case 'search': {
            const q = a.q?.trim() || a.query?.trim()
            if (!q) return "need q — GitHub search syntax, e.g. q='language:typescript stars:>1000' or q='repo:foo/bar is:open label:bug'"
            const kind = a.type || 'repos'
            const accept = kind === 'code' ? 'application/vnd.github.text-match+json' : undefined
            const r = await request(`${SEARCH_PATHS[kind]}${encodeQuery({ q, per_page: limit })}`, { token, accept })
            if (!r.ok) return decodeError(r, `searching ${kind} for "${q}"`, token.source)
            const items = r.json?.items || []
            const total = r.json?.total_count ?? items.length
            if (!items.length) return `nothing matches "${q}" in ${kind}`
            const body = kind === 'repos' ? formatSearchRepos(items, total)
              : kind === 'users' ? formatSearchUsers(items, total)
              : kind === 'code' ? formatSearchCode(items, total)
              : kind === 'commits' ? formatSearchCommits(items, total)
              : `${total} match "${q}", showing ${items.length}:\n${formatIssues(items)}`
            const incomplete = r.json?.incomplete_results ? '\n⚠️ GitHub timed out mid-search: these results are incomplete' : ''
            // Search has its own tiny bucket (30/min authenticated), not core's.
            return body + incomplete + rateLimitNote(r.headers)
          }

          case 'create_issue': {
            const t = await target()
            if ('error' in t) return t.error
            if (!a.title?.trim()) return "need title — create_issue repo='owner/name' title='…' [body='…']"
            const r = await request(`/repos/${t.owner}/${t.name}/issues`, {
              token,
              method: 'POST',
              body: { title: a.title, ...(a.body ? { body: a.body } : {}) },
            })
            if (!r.ok) return decodeError(r, `opening an issue on ${t.owner}/${t.name}`, token.source)
            return `✅ opened ${t.owner}/${t.name}#${r.json?.number}: ${r.json?.title}\n   ${r.json?.html_url}`
          }

          case 'comment': {
            const t = await target()
            if ('error' in t) return t.error
            const n = numberOf(t)
            if (!n) return 'need number — the issue or PR to comment on'
            if (!a.body?.trim()) return "need body — the comment text"
            const r = await request(`/repos/${t.owner}/${t.name}/issues/${n}/comments`, {
              token,
              method: 'POST',
              body: { body: a.body },
            })
            if (!r.ok) return decodeError(r, `commenting on ${t.owner}/${t.name}#${n}`, token.source)
            return `✅ commented on ${t.owner}/${t.name}#${n}\n   ${r.json?.html_url}`
          }

          case 'graphql': {
            const q = a.query?.trim() || a.q?.trim()
            if (!q) return "need query — a GraphQL document, e.g. query='{ viewer { login } }'"
            let variables: unknown
            if (a.variables) {
              try {
                variables = JSON.parse(a.variables)
              } catch (e: any) {
                return `variables is not JSON (${firstLine(String(e?.message || e))}) — pass a JSON object like {"owner":"foo"}`
              }
              if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
                return 'variables must be a JSON object, e.g. {"owner":"foo","name":"bar"}'
              }
            }
            const r = await request('/graphql', { token, method: 'POST', body: { query: q, variables: variables || {} } })
            // Unlike devduck, an HTTP-level failure keeps GitHub's own body.
            if (!r.ok) return decodeError(r, isMutation(q) ? 'a GraphQL mutation' : 'a GraphQL query', token.source)
            const errs = formatGraphqlErrors(r.json)
            const data = r.json?.data
            const hasData = data && Object.values(data).some((v) => v !== null && v !== undefined)
            const dump = hasData ? truncate(JSON.stringify(data, null, 2), JSON_MAX) : ''
            if (errs && !hasData) return `❌ ${errs}`
            if (errs) return `${dump}\n\n⚠️ partial answer — ${errs}`
            if (!hasData) return 'GitHub answered with no data and no errors, which usually means every field resolved to null'
            return dump + rateLimitNote(r.headers)
          }

          case 'rest': {
            const path = a.path?.trim()
            if (!path) return "need path — e.g. path='/repos/owner/name/releases' [method=POST] [body='{…}']"
            const method = normalizeMethod(a.method)
            let body: unknown
            if (a.body) {
              try {
                body = JSON.parse(a.body)
              } catch {
                // A plain string body is almost always a mistake here, but
                // GitHub does take raw text on a couple of endpoints.
                body = a.body
              }
            }
            if (method === 'DELETE' && a.confirm?.trim() !== path) {
              return `refusing to DELETE ${path} without confirmation — nothing on GitHub undoes a delete. Repeat the path: confirm='${path}'`
            }
            const r = await request(path, { token, method, body: READ_METHODS.includes(method) ? undefined : (body ?? {}) })
            if (!r.ok) return decodeError(r, `${method} ${path}`, token.source)
            if (r.status === 204 || !r.text) return `✅ ${method} ${path} → ${r.status}, no content (which is success for this endpoint)`
            return truncate(r.json === undefined ? r.text : JSON.stringify(r.json, null, 2), JSON_MAX) + rateLimitNote(r.headers)
          }
        }
        return `unknown action "${(a as any).action}"`
      } catch (e: any) {
        // The house contract: a device tool answers, it does not throw.
        if (e?.name === 'TimeoutError' || /aborted|timeout/i.test(String(e?.message))) {
          return `❌ github.com did not answer within ${Math.round(requestTimeout() / 1000)}s (TINY_GITHUB_TIMEOUT_MS raises that)`
        }
        if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(String(e?.message))) {
          return `❌ cannot reach api.github.com (${firstLine(String(e?.message))}) — check the network`
        }
        return `❌ use_github failed: ${firstLine(String(e?.message || e))}`
      }
    },
  })
}
