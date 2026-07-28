// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTinyTool, listTinyTool, makeRetrieveTool } from '../lib/chat/tools/universe'

// Drive each tool via the SDK's invoke(); stub global fetch so no network runs.
const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

describe('universe tools — fetch happy path', () => {
  it('get_tiny encodes the name and returns the parsed body', async () => {
    const spy = vi.fn(async () => new Response('{"name":"strands"}', {
      headers: { 'content-type': 'application/json' },
    }))
    global.fetch = spy as any
    const out = await (getTinyTool as any).invoke({ name: 'my tiny/../x' })
    expect(out).toEqual({ name: 'strands' })
    // name must be percent-encoded into the query (no raw space or slash)
    const url = String((spy.mock.calls[0] as any[])[0])
    expect(url).toContain('name=my%20tiny')
    expect(url).not.toContain('name=my tiny')
  })

  it('list_tiny builds a querystring from provided params only', async () => {
    const spy = vi.fn(async () => new Response('{"keys":[]}', {
      headers: { 'content-type': 'application/json' },
    }))
    global.fetch = spy as any
    await (listTinyTool as any).invoke({ prefix: 'a', limit: 5 })
    const url = String((spy.mock.calls[0] as any[])[0])
    expect(url).toContain('prefix=a')
    expect(url).toContain('limit=5')
    expect(url).not.toContain('cursor=')
  })
})

describe('universe tools — worker failure degrades to a model-readable error', () => {
  it('get_tiny returns {ok:false,error} instead of rejecting when fetch throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
    const out = await (getTinyTool as any).invoke({ name: 'x' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/network down/)
  })

  it('list_tiny degrades on non-JSON body (res.json throws)', async () => {
    global.fetch = vi.fn(async () => new Response('<html>502</html>', {
      headers: { 'content-type': 'text/html' },
    })) as any
    const out = await (listTinyTool as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/couldn't reach the universe/i)
  })

  it('retrieve degrades gracefully when the worker is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('timeout') }) as any
    const out = await (makeRetrieveTool('t', 'k') as any).invoke({ text: 'hello' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/timeout/)
  })
})
