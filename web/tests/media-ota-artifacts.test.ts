// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 📦 The media store also holds a necklace's OVER-THE-AIR BUNDLE.
 *
 * A tiny is flashed once over USB and updated over the air after that: a handful
 * of MicroPython modules plus a manifest naming each one's sha256, fetched by the
 * board straight from /media/:key (strands-nicla firmware/tiny_ota.py). The bytes
 * live here because R2 already serves them publicly-but-unguessably and the board
 * already speaks this host.
 *
 * Two things that were true before this and are asserted here:
 *
 *   The allowlist decides what an upload may CLAIM to be, and the key regex in
 *   MediaGetCall decides what the store can later SERVE — `[a-z0-9]{2,4}` on the
 *   extension. Those are two lists in two functions, and an upload accepted under
 *   an extension the GET route rejects is a store that takes writes it can never
 *   read back: 200 on the way in, 404 forever after. So this round-trips through
 *   both real handlers rather than asserting either list in isolation.
 *
 *   `nosniff` is the whole reason text/x-python and application/json are safe to
 *   add. Without it a browser may sniff a stored document into a script context —
 *   a <script src> pointed at the JSON is the classic version — so the header is
 *   load-bearing for these two types in a way it was not for JPEGs, and a test
 *   that only checked the bytes would let it be dropped.
 */
let MediaUploadCall: any
let MediaGetCall: any
let EXT: Record<string, string>

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('media.ts') /* @vite-ignore */)
  MediaUploadCall = mod.MediaUploadCall
  MediaGetCall = mod.MediaGetCall
  EXT = mod.EXT
})

warnIfWorkerAbsent('media-ota-artifacts')

const KEY = 'x-internal-key'
const ENVKEY = 'test-internal-key'

/** A fake R2 that stores what it is given, so the GET half reads the PUT half. */
const makeBucket = () => {
  const objs = new Map<string, { bytes: Uint8Array; contentType: string }>()
  return {
    objs,
    async put(k: string, bytes: Uint8Array, opts?: any) {
      objs.set(k, { bytes, contentType: opts?.httpMetadata?.contentType || '' })
    },
    async head(k: string) {
      const o = objs.get(k)
      return o ? { size: o.bytes.length, httpMetadata: { contentType: o.contentType } } : null
    },
    async get(k: string, opts?: any) {
      const o = objs.get(k)
      if (!o) return null
      const r = opts?.range
      return { body: r ? o.bytes.subarray(r.offset, r.offset + r.length) : o.bytes }
    },
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

const upload = (bucket: any, body: any) =>
  new MediaUploadCall().handle(
    new Request('https://plugin.tiny.technology/media/upload', {
      method: 'POST', headers: { [KEY]: ENVKEY },
    }),
    { MEDIA: bucket, INTERNAL_API_KEY: ENVKEY }, {}, { body })

const serve = (bucket: any, key: string) =>
  new MediaGetCall().handle(
    new Request(`https://plugin.tiny.technology/media/${key}`),
    { MEDIA: bucket })

const MODULE = 'VERSION = "ota-1"\n\n\ndef hello():\n    return 1\n'
const MANIFEST = JSON.stringify({
  version: 'ota-4b0737ac881c',
  files: [{ name: 'tiny_node.py', sha256: 'a'.repeat(64), url: 'https://x/y.py' }],
}, null, 2)

describe.skipIf(!present)('OTA artifacts round-trip through the media store', () => {
  it('a MicroPython module uploads and comes back byte-identical', async () => {
    const bucket = makeBucket()
    const up = await upload(bucket, { userId: 'u1', data: b64(MODULE), contentType: 'text/x-python' })
    expect(up.status, await up.clone().text()).toBe(200)
    const { key, url } = await up.json()
    expect(key, 'the extension the GET route will have to match').toMatch(/\.py$/)
    expect(url).toBe(`https://plugin.tiny.technology/media/${key}`)

    // The half the board actually does, through the real GET handler.
    const res = await serve(bucket, key)
    expect(res.status, 'accepted on write, unreachable on read').toBe(200)
    expect(await res.text()).toBe(MODULE)
    expect(res.headers.get('Content-Type')).toBe('text/x-python')
    expect(res.headers.get('X-Content-Type-Options'),
      'nosniff is what makes serving a text type here safe').toBe('nosniff')
  })

  it('a manifest uploads and comes back byte-identical', async () => {
    const bucket = makeBucket()
    const up = await upload(bucket, { userId: 'u1', data: b64(MANIFEST), contentType: 'application/json' })
    expect(up.status, await up.clone().text()).toBe(200)
    const { key } = await up.json()
    // 4 characters, which is the upper bound of the GET route's extension window.
    expect(key).toMatch(/\.json$/)

    const res = await serve(bucket, key)
    expect(res.status).toBe(200)
    // Byte-identical matters more here than anywhere: the board checks this
    // document against a sha256 supplied out of band, so a store that reformats
    // JSON would make every push fail verification.
    expect(await res.text()).toBe(MANIFEST)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('every type the store accepts is one it can serve back', async () => {
    // The pairing, over the whole allowlist rather than the two types this change
    // added: a type whose extension falls outside MediaGetCall's window is a
    // silent write-only key family.
    for (const contentType of Object.keys(EXT)) {
      const bucket = makeBucket()
      const up = await upload(bucket, { userId: 'u1', data: b64('bytes'), contentType })
      expect(up.status, `${contentType} was refused on upload`).toBe(200)
      const { key } = await up.json()
      const res = await serve(bucket, key)
      expect(res.status, `${contentType} stored as ${key} and cannot be served`).toBe(200)
    }
  })

  it('still refuses a type that is not on the list', async () => {
    // Or every assertion above would also hold for a store that accepts anything.
    const bucket = makeBucket()
    for (const contentType of ['text/html', 'application/javascript', 'text/plain', '']) {
      const up = await upload(bucket, { userId: 'u1', data: b64('<b>hi</b>'), contentType })
      expect(up.status, `${contentType || '(empty)'} was accepted`).toBe(400)
      expect(await up.text()).toContain('contentType must be one of')
    }
    expect(bucket.objs.size, 'a refused upload still wrote to the bucket').toBe(0)
  })

  it('the two OTA types are on the list, and text/html is not', async () => {
    expect(EXT['text/x-python']).toBe('py')
    expect(EXT['application/json']).toBe('json')
    expect(EXT['text/html'], 'an HTML type here is a stored-XSS surface').toBeUndefined()
  })
})
