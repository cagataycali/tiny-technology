// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 🎧 GET /media/:key must be seekable, because it serves the necklace's AUDIO.
 *
 * The route answered every request with `new Response(obj.body)` — no
 * Content-Length, no Accept-Ranges, never a 206. That is fine for <img> and web
 * <audio>, and AVPlayer will not play it: it opens every remote asset with
 * `Range: bytes=0-1` and needs Accept-Ranges + Content-Length + a correct
 * 206/Content-Range to size and seek the file.
 *
 * This is the SAME bug /voice/recording already found and fixed ("iOS won't play
 * call recordings", tests/voice-recording-range). NiclaRecorder uploads its takes
 * to /media, so the necklace's recordings inherited the un-fixed copy of a bug
 * the worker had already learned about once — the fix went to the route where it
 * was noticed rather than to every route serving the same kind of bytes.
 *
 * The user-visible shape: "in ios app we will be able to listen all the speech".
 * A row whose local file was pruned (or that arrived from the server on a second
 * phone) plays from audioUrl alone, so for those rows this route IS the playback.
 */
let MediaGetCall: any

beforeAll(async () => {
  if (!present) return
  MediaGetCall = (await import(workerFile('media.ts') /* @vite-ignore */)).MediaGetCall
})

warnIfWorkerAbsent('media-range')

const KEY = '6f1b0c62-1f4e-4a1a-9c2f-2b3d4e5f6a7b.m4a'
const TOTAL = 4096

/** Fake R2 that RECORDS its reads — the point is not only what we answer but
 *  how much we had to fetch to answer it. */
const makeBucket = (size = TOTAL) => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  const reads: Array<{ range?: any; bytes: number }> = []
  return {
    reads,
    bytes,
    async head(k: string) {
      return k === KEY ? { size, httpMetadata: { contentType: 'audio/mp4' } } : null
    },
    async get(k: string, opts?: any) {
      if (k !== KEY) return null
      const r = opts?.range
      const slice = r ? bytes.subarray(r.offset, r.offset + r.length) : bytes
      reads.push({ range: r, bytes: slice.length })
      return { body: slice, size, httpMetadata: { contentType: 'audio/mp4' } }
    },
  }
}

const req = (range?: string, key = KEY) =>
  new Request(`https://plugin.tiny.technology/media/${key}`,
    range ? { headers: { Range: range } } : undefined)

const serve = (bucket: any, range?: string, key = KEY) =>
  new MediaGetCall().handle(req(range, key), { MEDIA: bucket })

describe.skipIf(!present)('GET /media/:key — the AVPlayer contract', () => {
  it("AVPlayer's opening probe gets a 206 that sizes the file", async () => {
    const bucket = makeBucket()
    const res = await serve(bucket, 'bytes=0-1')
    expect(res.status, 'a 200 to the 0-1 probe is the unplayable case').toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-1/${TOTAL}`)
    expect(res.headers.get('Content-Length')).toBe('2')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Type')).toBe('audio/mp4')
  })

  it('the probe reads 2 bytes from R2, not the whole clip', async () => {
    // If the handler buffered the object to slice it in JS, every open of a 6MB
    // memo would move 6MB to answer a 2-byte question — the reason to pass
    // `range` to R2 rather than slice after the fact.
    const bucket = makeBucket()
    await serve(bucket, 'bytes=0-1')
    expect(bucket.reads).toHaveLength(1)
    expect(bucket.reads[0].bytes, 'the whole object was read to serve 2 bytes').toBe(2)
    expect(bucket.reads[0].range).toEqual({ offset: 0, length: 2 })
  })

  it('a mid-file seek returns exactly that window, with the right bytes', async () => {
    const bucket = makeBucket()
    const res = await serve(bucket, 'bytes=1000-1099')
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 1000-1099/${TOTAL}`)
    const got = new Uint8Array(await res.arrayBuffer())
    expect(got).toHaveLength(100)
    // Content, not just length: an off-by-one in the R2 offset/length
    // translation still returns 100 plausible bytes.
    expect(got[0]).toBe(1000 % 251)
    expect(got[99]).toBe(1099 % 251)
  })

  it('an open-ended seek runs to EOF', async () => {
    const res = await serve(makeBucket(), 'bytes=4000-')
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 4000-${TOTAL - 1}/${TOTAL}`)
    expect(res.headers.get('Content-Length')).toBe('96')
  })

  it('the whole-body response still declares its length and seekability', async () => {
    // No Range header: a 200 is correct, but a 200 WITHOUT Content-Length is
    // chunked, and a player that cannot learn the length cannot scrub.
    const res = await serve(makeBucket())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(TOTAL))
    expect(res.headers.get('Accept-Ranges'),
      'a 200 without Accept-Ranges is treated as a non-seekable stream').toBe('bytes')
  })

  it('a seek past the end is 416 that says how long the asset is', async () => {
    // Answering the full body (or a bare 416) makes the player retry the same
    // bad window; `bytes *~/total` is what lets it correct itself.
    const res = await serve(makeBucket(), 'bytes=99999-')
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe(`bytes */${TOTAL}`)
  })

  it('caching and sniffing protections survive on every path', async () => {
    for (const range of [undefined, 'bytes=0-1', 'bytes=99999-']) {
      const res = await serve(makeBucket(), range)
      expect(res.headers.get('Cache-Control')).toContain('immutable')
      expect(res.headers.get('X-Content-Type-Options'), `range=${range}`).toBe('nosniff')
    }
  })

  it('a missing object is 404 on the ranged path too, not a 206 of nothing', async () => {
    const bucket = makeBucket()
    const res = await serve(bucket, 'bytes=0-1', '00000000-0000-4000-8000-000000000000.m4a')
    expect(res.status).toBe(404)
  })

  it('a non-UUID key is still refused before any bucket call', async () => {
    const bucket = makeBucket()
    const res = await serve(bucket, 'bytes=0-1', '../secret.m4a')
    expect(res.status).toBe(404)
    expect(bucket.reads, 'a traversal key reached the bucket').toHaveLength(0)
  })
})
