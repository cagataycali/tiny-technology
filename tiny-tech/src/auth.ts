/**
 * Auth for the tiny-tech CLI — loopback browser flow + credential store.
 *
 * Flow (RFC 8252 style):
 *   1. listen on a random 127.0.0.1 port
 *   2. open https://tiny.technology/auth/cli?port=<port>&state=<nonce>
 *   3. user approves on the consent page → 302 to us with ?code&state
 *   4. exchange code at POST /api/auth/cli/token → 90-day bearer JWT
 *   5. store at ~/.tiny/credentials.json (0600)
 *
 * All human-facing output goes to stderr — stdout belongs to MCP stdio.
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_API_URL = 'https://tiny.technology'

export interface Credentials {
  version: 1
  apiUrl: string
  token: string
  user: { id: string; login: string; name?: string; avatar?: string }
  expires: number // unix seconds
}

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

function credsPath(): string {
  return join(tinyHome(), 'credentials.json')
}

export function loadCredentials(): Credentials | null {
  // Env override for CI/headless
  if (process.env.TINY_TOKEN) {
    return {
      version: 1,
      apiUrl: process.env.TINY_API_URL || DEFAULT_API_URL,
      token: process.env.TINY_TOKEN,
      user: { id: 'env', login: 'env' },
      expires: Number.MAX_SAFE_INTEGER,
    }
  }
  try {
    const raw = readFileSync(credsPath(), 'utf8')
    const creds = JSON.parse(raw) as Credentials
    if (!creds?.token) return null
    return creds
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  writeFileSync(credsPath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(credsPath(), 0o600) } catch {}
}

export function clearCredentials(): boolean {
  try {
    if (existsSync(credsPath())) {
      unlinkSync(credsPath())
      return true
    }
  } catch {}
  return false
}

export function credentialsValid(creds: Credentials | null): creds is Credentials {
  if (!creds) return false
  return creds.expires > Math.floor(Date.now() / 1000)
}

function openBrowser(url: string): void {
  // Headless / CI / SSH escape hatch — and the guard that keeps the test
  // suite from spawning real browser tabs (auth.test.mjs drives login()
  // against tiny.invalid; without this it opens a tab per run). The printed
  // URL is always the fallback, so suppressing the launch loses nothing.
  if (process.env.TINY_NO_BROWSER || process.env.CI) return
  const platform = process.platform
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
    : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {}) // fall through to the printed URL
    child.unref()
  } catch {}
}

/**
 * Pull the one-time code out of what a user pasted back from a remote-device
 * login: either the whole callback URL they were redirected to
 * (http://127.0.0.1:PORT/callback?code=…&state=…) or the bare code alone.
 * When the paste carries a state, it must match — a mismatched state is
 * rejected (null) exactly like the loopback server rejects it.
 */
export function extractCode(input: string, expectedState: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Full URL paste → parse code + state out of the query
  const q = trimmed.indexOf('?')
  if (/^https?:\/\//i.test(trimmed) || q !== -1) {
    try {
      const url = new URL(trimmed, 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code) return null
      if (state && state !== expectedState) return null
      return code
    } catch { /* not a URL after all — fall through to bare-code */ }
  }
  // Bare code paste — no state to check against, trust the code as typed
  return trimmed
}

const CALLBACK_HTML = (ok: boolean, message: string) => `<!doctype html>
<html><head><title>tiny-tech</title><style>
body{background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center}h1{color:${ok ? '#00FF88' : '#ff6b6b'}}p{color:#888}
</style></head><body><div><h1>${ok ? '✓ Authorized' : '✗ Failed'}</h1><p>${message}</p></div></body></html>`

/**
 * Run the full browser login flow. Resolves with stored credentials.
 */
export async function login(
  apiUrl: string = DEFAULT_API_URL,
  timeoutMs = 5 * 60 * 1000,
  onAuthUrl?: (url: string) => void
): Promise<Credentials> {
  const state = randomBytes(24).toString('base64url')

  const { code } = await new Promise<{ code: string }>((resolve, reject) => {
    let authUrl = ''
    // Interactive paste fallback for remote-device auth: when the CLI runs on
    // a box you reached over SSH, the browser is on your LOCAL machine, so the
    // 127.0.0.1:<port>/callback redirect dead-ends where nothing is listening.
    // The code is right there in the address bar though — so offer to accept
    // the pasted URL (or bare code) and finish. Only when stdin is a real TTY:
    // inside the MCP `serve` process stdin is the JSON-RPC pipe (server.ts),
    // and the test suite isn't a TTY either — both keep the pure loopback path.
    let rl: ReturnType<typeof createInterface> | null = null
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rl?.close() } catch {}
      // Give any in-flight callback response a beat to flush before teardown
      setTimeout(() => { try { server.close() } catch {} }, 100)
      fn()
    }

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const gotCode = url.searchParams.get('code') || ''
        const gotState = url.searchParams.get('state') || ''
        if (!gotCode || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(CALLBACK_HTML(false, 'State mismatch — re-run npx tiny-tech login'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(CALLBACK_HTML(true, 'You can close this tab and return to your terminal.'))
        finish(() => resolve({ code: gotCode }))
      } catch {
        // Never let a malformed request crash the host process (this runs
        // inside the long-lived MCP server when invoked via tiny_login)
        try { res.writeHead(400).end() } catch {}
      }
    })

    const timer = setTimeout(() => {
      // Include the URL — an agent relaying this error lets the user finish
      // by hand in environments where the browser never opened (SSH, etc.)
      finish(() => reject(new Error(`Login timed out — no authorization within ${Math.round(timeoutMs / 60000)} minutes. To finish manually, visit: ${authUrl}`)))
    }, timeoutMs)
    timer.unref()

    server.on('error', (e) => { finish(() => reject(e)) })
    // Port 0 → OS assigns a free ephemeral port; loopback only
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      authUrl = `${apiUrl}/auth/cli?port=${port}&state=${encodeURIComponent(state)}`
      process.stderr.write(`\nOpening browser to authorize tiny-tech...\n`)
      process.stderr.write(`If it doesn't open, visit:\n  ${authUrl}\n\n`)
      onAuthUrl?.(authUrl)
      openBrowser(authUrl)

      // Remote device? Paste the URL you land on (or just the code) here.
      if (process.stdin.isTTY) {
        process.stderr.write(`Authing a remote/SSH machine? The browser can't reach this box —\npaste the callback URL (or the code) from your browser here, then Enter:\n`)
        rl = createInterface({ input: process.stdin, output: process.stderr })
        rl.on('line', (line) => {
          const pasted = extractCode(line, state)
          if (!pasted) {
            process.stderr.write(`Couldn't read a code from that — paste the full callback URL or the code alone.\n`)
            return
          }
          finish(() => resolve({ code: pasted }))
        })
        // A closed stdin (^D) shouldn't reject — the loopback/timeout still stand
        rl.on('error', () => {})
      }
    })
  })

  // Exchange the one-time code for a bearer token
  const res = await fetch(`${apiUrl}/api/auth/cli/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!data.ok || !data.token) {
    throw new Error(`Token exchange failed: ${data.error || res.status}`)
  }

  const creds: Credentials = {
    version: 1,
    apiUrl,
    token: data.token,
    user: data.user,
    expires: data.expires,
  }
  saveCredentials(creds)
  process.stderr.write(`✓ Logged in as @${creds.user.login} (token valid ~${Math.round((creds.expires - Date.now() / 1000) / 86400)} days)\n`)
  return creds
}
