// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 🖼️ PICTURES COME BACK FROM A DEVICE (loop item d-d).
 *
 * A Mac running the daemon can see its own screen — use_computer's screenshot
 * returns a real image block to the LOCAL agent. But the reply that travels back
 * through the relay was string-only end to end, so asking from the web ("read
 * the error on my laptop's screen") returned the daemon's DESCRIPTION of an
 * image, which is the one thing a vision model doesn't need. Now the device
 * uploads what it made to the media store and lists the URLs in its reply; this
 * side fetches those bytes and hands the model actual pixels.
 *
 * The URL check is the security half: the reply arrives over a device-token
 * channel, so an unrestricted `url` would let a device (or a stolen token) make
 * this server fetch anything and feed it to the model as trusted content.
 */
import { makeUseDeviceTool, deviceReplyBlocks, isDeviceMediaUrl } from '../lib/chat/tools/platform'

const MEDIA = 'https://plugin.tiny.technology/media/abc123.png'

describe('isDeviceMediaUrl — only the media store, over https', () => {
  it('accepts a worker media key', () => {
    expect(isDeviceMediaUrl(MEDIA)).toBe(true)
    expect(isDeviceMediaUrl('https://plugin.tiny.technology/media/f1e2-d3.jpg')).toBe(true)
  })

  it('refuses other origins, other paths, and other schemes', () => {
    for (const bad of [
      'https://evil.example/media/a.png',              // attacker-controlled host
      'https://plugin.tiny.technology/tiny/tiny',      // right host, wrong surface
      'https://plugin.tiny.technology/media/../secret', // traversal in the key
      'http://plugin.tiny.technology/media/a.png',     // plaintext
      'file:///etc/passwd',
      'https://plugin.tiny.technology/media/',
      'https://169.254.169.254/media/a.png',           // metadata service
      '', null, undefined, 42, {},
    ]) {
      expect(isDeviceMediaUrl(bad as any)).toBe(false)
    }
  })
})

describe('deviceReplyBlocks — hosted urls become image blocks', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

  it('returns image blocks first, then the text plus the urls', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]).buffer, { status: 200 })) as any
    const out = await deviceReplyBlocks('the build failed on line 12', [{ url: MEDIA, format: 'png' }])
    expect(out).not.toBeNull()
    expect(out![0]?.constructor?.name).toMatch(/ImageBlock/)
    // The text block carries the answer AND the shareable link.
    expect(out![1].text).toContain('the build failed on line 12')
    expect(out![1].text).toContain(MEDIA)
  })

  it('a reply with no images stays a plain result (null → caller keeps its object)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('no fetch expected') }) as any
    expect(await deviceReplyBlocks('42% full', undefined)).toBeNull()
    expect(await deviceReplyBlocks('42% full', [])).toBeNull()
    expect(await deviceReplyBlocks('42% full', 'nonsense' as any)).toBeNull()
  })

  it('an unfetchable image degrades to text — the answer is not lost with it', async () => {
    // The device did the work; a 404 on the still must not delete its report.
    global.fetch = vi.fn(async () => new Response('gone', { status: 404 })) as any
    expect(await deviceReplyBlocks('done', [{ url: MEDIA, format: 'png' }])).toBeNull()
  })

  it('a foreign url is never fetched at all (SSRF, not just a bad picture)', async () => {
    const spy = vi.fn(async () => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    global.fetch = spy as any
    const out = await deviceReplyBlocks('ok', [{ url: 'https://evil.example/media/a.png', format: 'png' }])
    expect(out).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('caps how many images ride one reply (vision tokens are per image)', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([1]).buffer, { status: 200 })) as any
    const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://plugin.tiny.technology/media/${i}.png`, format: 'png' }))
    const out = await deviceReplyBlocks('five shots', many)
    expect(out!.filter(b => b.constructor.name.match(/ImageBlock/))).toHaveLength(2)
  })
})

describe('use_device — a screenshot from the laptop reaches the model', () => {
  let responder: (url: string) => any
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const out = responder(String(url))
      if (out instanceof Response) return out
      return { json: async () => out } as Response
    }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const invoke = (input: any) => (makeUseDeviceTool('user_1') as any).invoke(input, { toolUse: {} })
  const settled = async (p: Promise<any>): Promise<any> => { await vi.advanceTimersByTimeAsync(45_500); return p }

  it('an invoke reply carrying images returns blocks, not a result string', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_1' }
      if (url.includes('/device/relay/recv')) {
        return { reply: { payload: JSON.stringify({ result: 'Xcode shows "no such module"', images: [{ url: MEDIA, format: 'png' }] }) } }
      }
      if (url === MEDIA) return new Response(new Uint8Array([137, 80]).buffer, { status: 200 })
      throw new Error(`unexpected ${url}`)
    }
    const out = await settled(invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'what does my screen say?' }))
    expect(Array.isArray(out)).toBe(true)
    expect(out[0].constructor.name).toMatch(/ImageBlock/)
    expect(out[1].text).toContain('no such module')
  })

  it("action:'result' redeems a LATE reply's images too", async () => {
    // The async contract (d-a/d-b) means a slow screenshot is claimed later —
    // it must not lose its pixels on the way through the second path.
    responder = (url) => {
      if (url.includes('/device/relay/recv')) {
        return { reply: { payload: JSON.stringify({ result: 'here', images: [{ url: MEDIA, format: 'png' }] }) } }
      }
      if (url === MEDIA) return new Response(new Uint8Array([1, 2]).buffer, { status: 200 })
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'result', envelope_id: 'env_1' })
    expect(Array.isArray(out)).toBe(true)
    expect(out[0].constructor.name).toMatch(/ImageBlock/)
  })

  it('a text-only device (every daemon before this change) is byte-identical', async () => {
    // The images key is optional and older daemons never send it; the old shape
    // must survive verbatim or every enrolled device regresses on deploy.
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_2' }
      if (url.includes('/device/relay/recv')) return { reply: { payload: JSON.stringify({ result: 'df says 42%' }) } }
      throw new Error(`unexpected ${url}`)
    }
    const out = await settled(invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'disk?' }))
    expect(out).toEqual({ ok: true, device_id: 'dev_1', envelope_id: 'env_2', result: 'df says 42%' })
  })

  it('a device claiming an off-store image url still returns its text result', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/send')) return { id: 'env_3' }
      if (url.includes('/device/relay/recv')) {
        return { reply: { payload: JSON.stringify({ result: 'text answer', images: [{ url: 'https://evil.example/x.png' }] }) } }
      }
      throw new Error(`unexpected ${url}`)
    }
    const out = await settled(invoke({ action: 'invoke', device_id: 'dev_1', prompt: 'x' }))
    expect(out).toEqual({ ok: true, device_id: 'dev_1', envelope_id: 'env_3', result: 'text answer' })
  })

  it('a non-string result (structured payload) is never treated as blocks', async () => {
    responder = (url) => {
      if (url.includes('/device/relay/recv')) return { reply: { payload: JSON.stringify({ result: { rows: 3 } }) } }
      throw new Error(`unexpected ${url}`)
    }
    const out = await invoke({ action: 'result', envelope_id: 'env_4' })
    expect(out).toEqual({ ok: true, envelope_id: 'env_4', result: { rows: 3 } })
  })
})
