/**
 * Authenticated HTTP client for tiny.technology /api/* routes.
 *
 * Wraps fetch with the Bearer token, JSON handling, friendly 401s, and an
 * SSE reader for /api/chat streams.
 */
import { loadCredentials, credentialsValid, type Credentials } from './auth.js'
import { loadDevice } from './device.js'

// Ring/session id must be distinct per client install — a constant per-user
// value made every MCP host on every machine share ONE server-side ring
// context (cross-machine context bleed, audit 2026-07-23). The enrolled
// device id is stable per machine; unenrolled installs get a per-process
// nonce (a fresh ring per run beats a shared one).
const SESSION_SUFFIX: string =
  loadDevice()?.deviceId?.slice(0, 8) || Math.random().toString(36).slice(2, 10)

export class AuthRequiredError extends Error {
  constructor(msg = 'Not logged in — run `npx tiny-tech login` or call the tiny_login tool') {
    super(msg)
    this.name = 'AuthRequiredError'
  }
}

export class TinyApi {
  private creds: Credentials | null

  constructor(creds?: Credentials | null) {
    this.creds = creds ?? loadCredentials()
  }

  /** Re-read credentials (after tiny_login refreshes them) */
  reload(): void {
    this.creds = loadCredentials()
  }

  get authenticated(): boolean {
    return credentialsValid(this.creds)
  }

  get user() {
    return this.creds?.user ?? null
  }

  get baseUrl(): string {
    // Env override wins over the stored apiUrl — otherwise pointing the CLI
    // at a staging server silently keeps talking to the creds' origin
    return process.env.TINY_API_URL || this.creds?.apiUrl || 'https://tiny.technology'
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    if (!credentialsValid(this.creds)) throw new AuthRequiredError()
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.creds!.token}`,
      ...extra,
    }
  }

  async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() })
    return this.parse(res)
  }

  async post(path: string, body: any, extraHeaders?: Record<string, string>): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      body: JSON.stringify(body),
    })
    return this.parse(res)
  }

  /**
   * POST that keeps the HTTP STATUS alongside the parsed body.
   *
   * `post()` throws away the status, which is fine where the route encodes
   * everything in the body — but the faucet's "this deployment has no faucet" is
   * a bare 424 with no flag, so a caller that only sees the body cannot tell it
   * from a generic failure and will retell it as "faucet failed". A refusal an
   * agent can't classify is a refusal it will retry.
   */
  async postStatus(path: string, body: any): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    const status = res.status
    return { status, body: await this.parse(res) }
  }

  async put(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    return this.parse(res)
  }

  async delete(path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return this.parse(res)
  }

  /** Public (unauthenticated) GET — used for universe browsing */
  async getPublic(url: string): Promise<any> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    return this.parse(res)
  }

  private async parse(res: Response): Promise<any> {
    if (res.status === 401) throw new AuthRequiredError('Token rejected (expired?) — run `npx tiny-tech login` or call tiny_login')
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      if (!res.ok) {
        // Gateway errors arrive as HTML pages — don't dump markup into
        // tool errors the agent has to wade through
        const isHtml = /^\s*</.test(text)
        throw new Error(`HTTP ${res.status}${isHtml ? ' (transient gateway error — retry)' : `: ${text.slice(0, 300)}`}`)
      }
      return { raw: text }
    }
  }

  /**
   * Chat with a tiny via the streaming /api/chat route. Consumes the whole
   * SSE stream and returns final text + tool-call trace — MCP tools are
   * request/response, so we buffer rather than stream through.
   */
  async chat(opts: {
    tiny: string
    message: string
    systemContext?: string
    /** Extra content blocks (image/document/text) appended after the message text */
    attachmentBlocks?: any[]
    timeoutMs?: number
    /** Live SSE event tap — lets callers (TUI) stream instead of buffering */
    onEvent?: (event: any) => void
  }): Promise<{ text: string; reasoning: string; toolCalls: { name: string; input?: any; error?: string }[]; error?: string }> {
    const messages: any[] = []
    if (opts.systemContext) {
      messages.push({ role: 'system', content: [{ text: opts.systemContext }] })
    }
    messages.push({
      role: 'user',
      content: [{ text: opts.message }, ...(opts.attachmentBlocks || [])],
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers({
          'x-tiny-name': opts.tiny,
          'x-tiny-session': `tiny-tech-cli-${this.creds?.user.id ?? 'anon'}-${SESSION_SUFFIX}`,
          'x-tiny-metadata': JSON.stringify({ source: 'tiny-tech-mcp' }),
          ...modelEnvHeaders(),
        }),
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      })
    } catch (e: any) {
      clearTimeout(timer)
      if (e?.name === 'AbortError') return { text: '', reasoning: '', toolCalls: [], error: 'chat timed out' }
      throw e
    }

    if (res.status === 401) {
      clearTimeout(timer)
      throw new AuthRequiredError()
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer)
      const body = await res.text().catch(() => '')
      return { text: '', reasoning: '', toolCalls: [], error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }

    let text = ''
    let reasoning = ''
    let error: string | undefined
    const toolCalls: { name: string; input?: any; error?: string }[] = []

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          ({ done, value } = await reader.read())
        } catch (e: any) {
          // Timeout fired mid-stream — return what we have instead of
          // leaking a raw AbortError through the tool
          if (e?.name === 'AbortError') {
            error = error || `chat timed out after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s — partial response returned`
            break
          }
          throw e
        }
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() || ''
        for (const chunk of chunks) {
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            let event: any
            try { event = JSON.parse(data) } catch { continue }
            try { opts.onEvent?.(event) } catch { /* observer must not break the stream */ }
            if (event.type === 'modelContentBlockDeltaEvent' && event.textDelta) text += event.textDelta
            else if (event.type === 'modelContentBlockDeltaEvent' && event.reasoningDelta) reasoning += event.reasoningDelta
            else if (event.type === 'beforeToolCallEvent' && event.toolCall) {
              toolCalls.push({ name: event.toolCall.name, input: event.toolCall.input })
            } else if (event.type === 'afterToolCallEvent' && event.toolResult?.error) {
              const tc = toolCalls[toolCalls.length - 1]
              if (tc) tc.error = event.toolResult.error
            } else if (event.type === 'error') {
              error = event.error
            }
          }
        }
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }

    return { text, reasoning, toolCalls, error }
  }
}

/** BYO model config via env — mirrors the web app's x-tiny-model-* headers */
function modelEnvHeaders(): Record<string, string> {
  const h: Record<string, string> = {}
  if (process.env.TINY_MODEL_PROVIDER) h['x-tiny-model-provider'] = process.env.TINY_MODEL_PROVIDER
  if (process.env.TINY_MODEL_API_KEY) h['x-tiny-model-api-key'] = process.env.TINY_MODEL_API_KEY
  if (process.env.TINY_MODEL_ID) h['x-tiny-model-id'] = process.env.TINY_MODEL_ID
  if (process.env.TINY_MODEL_BASE_URL) h['x-tiny-model-base-url'] = process.env.TINY_MODEL_BASE_URL
  return h
}
