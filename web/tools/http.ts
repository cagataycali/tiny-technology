/**
 * Universal HTTP tool for Strands Agents (TypeScript)
 * 
 * A flexible HTTP client that supports GET, POST, PUT, PATCH, DELETE, and other HTTP methods
 * with full support for headers, query parameters, and request bodies.
 */

import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { validatePublicUrl, readClippedText } from '@/lib/utils'

// Cap the response body the tool ingests — a huge URL must not OOM the
// edge function (or a spawn_agents sub-agent that mounts this tool).
const MAX_HTTP_BODY = 200_000

/**
 * Universal HTTP tool
 * 
 * Make HTTP requests to any endpoint with full control over method, headers, parameters, and body.
 * 
 * Examples:
 * 
 * GET request with query parameters:
 * ```typescript
 * {
 *   method: 'GET',
 *   url: 'https://api.example.com/users',
 *   params: { page: '1', limit: '10' }
 * }
 * ```
 * 
 * POST request with JSON body:
 * ```typescript
 * {
 *   method: 'POST',
 *   url: 'https://api.example.com/users',
 *   body: { name: 'John Doe', email: 'john@example.com' },
 *   headers: { 'Authorization': 'Bearer token123' }
 * }
 * ```
 */
export const http = tool({
  name: 'http',
  description: 'Make HTTP requests to any public https endpoint - supports GET, POST, PUT, PATCH, DELETE with headers, query params, and request bodies. (http://, IPs, and internal hostnames are rejected.)',
  inputSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).describe('HTTP method'),
    url: z.string().describe('Target URL'),
    headers: z.record(z.string(), z.string()).optional().describe('Optional HTTP headers'),
    params: z.record(z.string(), z.string()).optional().describe('Optional query parameters'),
    body: z.any().optional().describe('Optional request body (will be JSON stringified)'),
    timeout: z.number().optional().describe('Request timeout in milliseconds (default: 30000)'),
  }),
  callback: async (input): Promise<Record<string, any>> => {
    const { method, url, headers = {}, params = {}, body } = input
    // Clamp the model-supplied timeout: a non-finite/0/negative value would
    // make setTimeout fire ~immediately and abort EVERY request ("timeout
    // after 0ms"); an absurdly large one is pointless on edge (wall-clock
    // limit caps it anyway). Bound to 1s–60s, default 30s.
    const rawTimeout = Number(input.timeout)
    const timeout = Number.isFinite(rawTimeout) ? Math.min(Math.max(rawTimeout, 1000), 60000) : 30000

    try {
      // SSRF guard — the URL is model-authored (user prompts steer it):
      // https + public hostnames only, same rules as every other server-side
      // fetch of untrusted URLs (lib/utils.ts)
      const checked = validatePublicUrl(url)
      if ('error' in checked) {
        return { error: `URL rejected: ${checked.error}`, status: 0, ok: false, success: false }
      }

      // Build URL with query parameters
      const targetUrl = checked.url
      Object.entries(params).forEach(([key, value]) => {
        targetUrl.searchParams.append(key, String(value))
      })

      // Default headers
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Strands-Agent-HTTP-Tool/1.0',
        ...headers,
      }

      // Build fetch options
      const fetchOptions: RequestInit = {
        method,
        headers: requestHeaders,
      }

      // Add body for non-GET/HEAD requests
      if (body && !['GET', 'HEAD'].includes(method)) {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
      }

      console.log(`\n🌐 HTTP ${method} ${targetUrl.toString()}`)
      if (Object.keys(params).length > 0) {
        console.log(`Query Params: ${JSON.stringify(params)}`)
      }
      if (body) {
        console.log(`Body: ${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`)
      }

      // Create abort controller for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      try {
        // Make the request — redirects re-validated per hop (a public URL
        // 302ing to an internal host is the classic SSRF-guard bypass)
        let response = await fetch(targetUrl.toString(), {
          ...fetchOptions,
          redirect: 'manual',
          signal: controller.signal,
        })
        for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop++) {
          const loc = response.headers.get('location')
          if (!loc) break
          const nextUrl = new URL(loc, response.url || targetUrl)
          const hopCheck = validatePublicUrl(nextUrl.toString())
          if ('error' in hopCheck) {
            clearTimeout(timeoutId)
            return { error: `Redirect rejected: ${hopCheck.error} (${nextUrl.hostname})`, status: 0, ok: false, success: false }
          }
          response = await fetch(hopCheck.url.toString(), {
            ...fetchOptions,
            // Redirected requests downgrade to GET semantics like browsers do
            ...(response.status === 303 ? { method: 'GET', body: undefined } : {}),
            redirect: 'manual',
            signal: controller.signal,
          })
        }

        clearTimeout(timeoutId)

        // Get response body — size-bounded (streamed clip, never buffers
        // the whole thing). JSON is parsed from the clipped text; a body
        // clipped mid-JSON falls back to the raw (truncated) text.
        const contentType = response.headers.get('content-type') || ''
        let responseBody: any

        if (contentType.includes('application/json') || contentType.includes('text/')) {
          const { text, truncated } = await readClippedText(response, MAX_HTTP_BODY)
          if (contentType.includes('application/json') && !truncated) {
            try { responseBody = JSON.parse(text) } catch { responseBody = text }
          } else {
            responseBody = truncated ? text + '…[truncated]' : text
          }
        } else {
          // Binary/unknown: report size without buffering into a string
          const len = Number(response.headers.get('content-length') || 0)
          try { await response.body?.cancel() } catch { }
          responseBody = `<Binary data${len ? `: ${len} bytes` : ''}>`
        }

        // Prepare response headers
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })

        const result = {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: responseHeaders,
          body: responseBody,
          url: response.url,
        }

        console.log(`✅ Response: ${response.status} ${response.statusText}`)

        return result

      } catch (fetchError: any) {
        clearTimeout(timeoutId)
        
        if (fetchError.name === 'AbortError') {
          return {
            error: `Request timeout after ${timeout}ms`,
            status: 0,
            ok: false,
            details: 'Request exceeded timeout limit'
          }
        }
        throw fetchError
      }

    } catch (error: any) {
      console.error('HTTP Request Error:', error)

      // Parse URL errors
      if (error.message?.includes('Invalid URL')) {
        return {
          error: `Invalid URL: ${url}`,
          details: error.message,
          success: false
        }
      }

      // Network errors
      if (error.message?.includes('fetch failed') || error.code === 'ENOTFOUND') {
        return {
          error: `Network error: Unable to reach ${url}`,
          details: error.message,
          success: false
        }
      }

      return {
        error: `HTTP request failed: ${error.message}`,
        details: error.toString(),
        url,
        success: false
      }
    }
  },
})
