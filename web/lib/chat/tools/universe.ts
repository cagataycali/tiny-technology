/**
 * Universe discovery tools (extracted from the chat route) — read-only
 * lookups against the worker. get_tiny/list_tiny are stateless; retrieve
 * carries the caller's identity for private-memory access, so it's a
 * factory over (tinyName, tinyKey).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const getTinyTool = tool({
  name: 'get_tiny',
  description: 'Get information about a tiny AI by name',
  inputSchema: z.object({
    name: z.string().describe('The name of the tiny AI to retrieve'),
  }),
  callback: async (input) => {
    return fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(input.name)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }).then(res => res.json())
      // A worker hiccup must return a model-readable error, not reject the
      // tool callback (which faults the turn) — matches every sibling tool.
      .catch(e => ({ ok: false, error: `Couldn't reach the universe to look up '${input.name}': ${String(e?.message || e)}` }))
  },
})

export const listTinyTool = tool({
  name: 'list_tiny',
  description: 'List all tiny AI services with optional pagination and filtering',
  inputSchema: z.object({
    cursor: z.string().optional().describe('Cursor for next page'),
    limit: z.number().optional().describe('Limit for results per page'),
    prefix: z.string().optional().describe('Filter by name prefix'),
  }),
  callback: async (input) => {
    const params = new URLSearchParams()
    if (input.cursor) params.append('cursor', input.cursor)
    if (input.limit) params.append('limit', input.limit.toString())
    if (input.prefix) params.append('prefix', input.prefix)

    const queryString = params.toString()
    const url = `https://plugin.tiny.technology/list${queryString ? `?${queryString}` : ''}`

    return fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }).then(res => res.json())
      .catch(e => ({ ok: false, error: `Couldn't reach the universe to list tinys: ${String(e?.message || e)}` }))
  },
})

export const makeRetrieveTool = (tinyName: string | undefined, tinyKey: string | undefined) => tool({
  name: 'retrieve',
  description: 'Search and retrieve relevant context from the Tiny Universe knowledge base',
  inputSchema: z.object({
    text: z.string().describe('Search query text'),
  }),
  callback: async (input) => {
    return fetch(`https://plugin.tiny.technology/retrieve?text=${encodeURIComponent(input.text)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${tinyName}:${tinyKey}`,
        // Server-side caller — the internal key skips the worker's per-IP
        // cap on /retrieve (which guards the paid embeddings call against
        // keyless external loops)
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
    }).then(res => res.json())
      .catch(e => ({ ok: false, error: `Couldn't reach the universe knowledge base: ${String(e?.message || e)}` }))
  },
})
