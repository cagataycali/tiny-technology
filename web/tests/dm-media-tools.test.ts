// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { makeSendMessageTool, makeReadMessagesTool } from '../lib/chat/tools/messages'

/**
 * The agent half of DM media (migration 0031).
 *
 * The ask this pins: "when we read the messages our agent should be able to read
 * the images too." A URL in a JSON blob does not achieve that — the model has to
 * receive PIXELS, or it describes a photo it never looked at. So these tests
 * assert on the returned content BLOCKS, not on prose.
 *
 * The other half is the sink-level fetch guard. `read_messages` is the one place
 * in the stack that takes a stored URL, fetches the bytes and hands them to a
 * model as trusted content, so the tests check what it will and will not GET.
 */

const KEY = '0f9b1c2d-3e4f-4a5b-8c7d-9e0f1a2b3c4d'
const MEDIA = 'https://plugin.tiny.technology/media'
const SESSION = { sub: 'u1' }

// A 1x1 JPEG's worth of bytes — content is irrelevant, only that it arrives.
const PIXELS = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

type Fetched = { url: string }

/** Stub global fetch: the worker JSON (thread read or send ack), then media GETs. */
function stubFetch(thread: any, opts: { mediaOk?: boolean } = {}) {
  const seen: Fetched[] = []
  const spy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (input: any) => {
    const url = String(input?.url || input)
    seen.push({ url })
    // The worker's own endpoints answer JSON; anything else is a media GET.
    if (url.includes('/messages?') || url.endsWith('/message')) {
      return { ok: true, json: async () => thread } as any
    }
    if (opts.mediaOk === false) return { ok: false, arrayBuffer: async () => PIXELS.buffer } as any
    return { ok: true, arrayBuffer: async () => PIXELS.buffer } as any
  })
  return { seen, spy }
}

const msg = (over: Record<string, unknown> = {}) => ({
  id: 1, direction: 'received', body: '', attachments: [], read: false, created: 1, ...over,
})
const att = (over: Record<string, unknown> = {}) => ({
  kind: 'image', url: `${MEDIA}/${KEY}.jpg`, contentType: 'image/jpeg', ...over,
})

afterEach(() => vi.restoreAllMocks())

const readTool = () => makeReadMessagesTool(SESSION) as any
const sendTool = () => makeSendMessageTool(SESSION, 'tiny') as any

describe('🔴 reading a thread with a photo returns pixels, not a link', () => {
  it('returns a real image block for a photo in the conversation', async () => {
    const { seen } = stubFetch({ peer: { login: 'bob' }, messages: [msg({ attachments: [att()] })] })
    const out = await readTool().invoke({ with: 'bob' }, {})

    // Content blocks, not a bare object: the pixels ride the tool result.
    expect(Array.isArray(out)).toBe(true)
    const image = out.find((b: any) => b?.image || b?.constructor?.name === 'ImageBlock')
    expect(image, 'an ImageBlock should be present').toBeTruthy()
    // ...and it actually fetched the bytes rather than passing a URL along.
    expect(seen.some(s => s.url === `${MEDIA}/${KEY}.jpg`)).toBe(true)
  })

  it('keeps the whole thread JSON alongside the pixels', async () => {
    // The model still needs the conversation: who said what, when, and which
    // url is which picture.
    stubFetch({ peer: { login: 'bob' }, messages: [msg({ body: 'look at this', attachments: [att()] })] })
    const out = await readTool().invoke({ with: 'bob' }, {})
    const text = out.map((b: any) => b?.text || '').join('')
    expect(text).toContain('look at this')
    expect(text).toContain(`${MEDIA}/${KEY}.jpg`)
    expect(text).toContain('[photo]')
  })

  it('🔴 a failed image GET degrades to the thread, never loses it', async () => {
    // The conversation the user asked for must not disappear because one GET
    // failed — and the media must still be DESCRIBED, or a broken fetch looks
    // identical to a message with no photo in it.
    stubFetch({ peer: { login: 'bob' }, messages: [msg({ body: 'hi', attachments: [att()] })] }, { mediaOk: false })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(Array.isArray(out)).toBe(false)
    expect(out.messages[0].media[0]).toContain('[photo]')
    expect(out.messages[0].body).toBe('hi')
  })

  it('newest photos win when a thread has more than the budget', async () => {
    const many = Array.from({ length: 9 }, (_, i) => msg({
      id: i + 1, attachments: [att({ url: `${MEDIA}/${String(i).repeat(8)}-3e4f-4a5b-8c7d-9e0f1a2b3c4d.jpg` })],
    }))
    const { seen } = stubFetch({ peer: { login: 'bob' }, messages: many })
    await readTool().invoke({ with: 'bob' }, {})
    const fetched = seen.filter(s => s.url.includes('/media/'))
    // Bounded — every image spends context and a round-trip.
    expect(fetched.length).toBeLessThanOrEqual(4)
    // ...and it is the LAST message's photo that made the cut, not the first.
    expect(fetched[0].url).toContain('8'.repeat(8))
  })
})

describe('🔴 what read_messages refuses to fetch', () => {
  it('never GETs a non-media-store URL, even one already in storage', async () => {
    // Defence at the sink. The URL was validated on the way in by the app AND the
    // worker, but this is where bytes become trusted model content, so a row that
    // somehow holds a foreign host (older data, a direct D1 write) must not turn
    // this tool into an SSRF fetcher.
    const { seen } = stubFetch({
      peer: { login: 'bob' },
      messages: [msg({ attachments: [
        att({ url: 'https://evil.example/media/x.jpg' }),
        att({ url: 'http://plugin.tiny.technology/media/x.jpg' }),
        att({ url: 'file:///etc/passwd' }),
      ] })],
    })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(seen.some(s => s.url.includes('evil.example'))).toBe(false)
    expect(seen.some(s => s.url.startsWith('file:'))).toBe(false)
    expect(seen.filter(s => !s.url.includes('/messages?'))).toHaveLength(0)
    // No pixels to send, so it stays plain JSON — with the media still described.
    expect(Array.isArray(out)).toBe(false)
  })

  it('does not try to make pixels out of a video', async () => {
    // There is no video understanding on this path.
    const { seen } = stubFetch({
      peer: { login: 'bob' },
      messages: [msg({ attachments: [att({ kind: 'video', contentType: 'video/mp4', url: `${MEDIA}/${KEY}.mp4`, durationMs: 14000 })] })],
    })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(seen.filter(s => s.url.includes('.mp4'))).toHaveLength(0)
    expect(Array.isArray(out)).toBe(false)
    // and it says so, so the model cannot describe a clip it never saw
    expect(out.messages[0].media[0]).toContain('not viewable')
  })

  it('does not send a GIF as a vision format', async () => {
    // jpeg/png/webp are the vision formats; labelling a gif as jpeg produces a
    // decode error that fails the entire turn.
    const { seen } = stubFetch({
      peer: { login: 'bob' },
      messages: [msg({ attachments: [att({ contentType: 'image/gif', url: `${MEDIA}/${KEY}.gif` })] })],
    })
    await readTool().invoke({ with: 'bob' }, {})
    expect(seen.filter(s => s.url.includes('.gif'))).toHaveLength(0)
  })
})

describe('🎤 a voice note reaches the agent as words', () => {
  it('surfaces the on-device transcript', async () => {
    stubFetch({
      peer: { login: 'bob' },
      messages: [msg({ attachments: [att({
        kind: 'audio', contentType: 'audio/mp4', url: `${MEDIA}/${KEY}.m4a`,
        transcript: 'running late, ten minutes', durationMs: 4000,
      })] })],
    })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(out.messages[0].media[0]).toContain('running late, ten minutes')
    expect(out.messages[0].media[0]).toContain('0:04')
  })

  it('🔴 admits when there is no transcript instead of implying silence', async () => {
    stubFetch({
      peer: { login: 'bob' },
      messages: [msg({ attachments: [att({ kind: 'audio', contentType: 'audio/mp4', url: `${MEDIA}/${KEY}.m4a` })] })],
    })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(out.messages[0].media[0]).toMatch(/no transcript/)
  })
})

describe('read_messages leaves everything else exactly as it was', () => {
  it('passes the inbox overview straight through', async () => {
    stubFetch({ threads: [{ login: 'bob', unread: 2, lastBody: '📷 Photo' }] })
    const out = await readTool().invoke({}, {})
    expect(out.threads[0].lastBody).toBe('📷 Photo')
  })

  it('passes an error straight through (no masked-empty thread)', async () => {
    stubFetch({ error: 'messages unavailable' })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(out.error).toBe('messages unavailable')
  })

  it('adds no media field to a text-only message', async () => {
    stubFetch({ peer: { login: 'bob' }, messages: [msg({ body: 'plain' })] })
    const out = await readTool().invoke({ with: 'bob' }, {})
    expect(out.messages[0].media).toBeUndefined()
    expect(out.messages[0].body).toBe('plain')
  })
})

describe('send_message can attach media', () => {
  const okSend = () => stubFetch({ ok: true, id: 7, to: { name: 'Bob' }, delivered: { telegram: true, push: 1 } })
  /** What was actually POSTed to the worker. */
  const sent = () => JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as any).body)

  it('forwards a validated attachment and says so', async () => {
    okSend()
    const out = await sendTool().invoke({ to: 'bob', message: 'here you go', attachments: [att()] }, {})
    expect(out.ok).toBe(true)
    expect(out.note).toContain('1 attachment')
    const body = sent()
    expect(body.body).toBe('here you go')
    expect(body.attachments).toEqual([{ kind: 'image', url: `${MEDIA}/${KEY}.jpg`, contentType: 'image/jpeg' }])
  })

  it('🔴 sends a caption-less photo (empty message is legal WITH media)', async () => {
    okSend()
    const out = await sendTool().invoke({ to: 'bob', message: '', attachments: [att()] }, {})
    expect(out.ok).toBe(true)
    const body = sent()
    expect(body.body).toBe('')
    expect(body.attachments).toHaveLength(1)
  })

  it('🔴 still refuses a blank TEXT-only DM', async () => {
    okSend()
    const out = await sendTool().invoke({ to: 'bob', message: '' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/blank/)
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it('🔴 refuses a foreign attachment URL WITHOUT sending anything', async () => {
    // The agent will be handed URLs by users and web pages. Sending the text and
    // dropping the photo would be the truncation defect again.
    okSend()
    const out = await sendTool().invoke(
      { to: 'bob', message: 'look', attachments: [{ url: 'https://evil.example/x.jpg', contentType: 'image/jpeg' }] }, {},
    )
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('media-store URL')
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it('🔴 refuses an over-long caption even with a photo attached', async () => {
    okSend()
    const out = await sendTool().invoke({ to: 'bob', message: 'a'.repeat(2001), attachments: [att()] }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('2001')
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it('advertises attachments in the schema the model plans against', () => {
    const t = sendTool()
    expect(t._inputSchema.safeParse({ to: 'bob', message: '', attachments: [att()] }).success).toBe(true)
    expect(t.toolSpec.description).toMatch(/media-store|attachments|photos/i)
  })
})
