// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('voice-recording-gaps')

/**
 * 🕳️ A GAP IS NOT THE END OF THE CALL — and `break` cannot tell the difference.
 *
 * /voice/recording/:id stitches a call's PCM segments into one WAV by PROBING
 * `voice/<id>/<dir>-<i>.pcm` upward from 0. It used to stop at the first key
 * that wasn't there — which is correct for the end of a call and catastrophic
 * for a hole in the middle:
 *
 *   - `flushSegment` is deliberately fire-and-forget ("a dropped segment
 *     shouldn't stall the live relay"), and `inSeq`/`outSeq` are incremented
 *     BEFORE the put. A failed put therefore leaves a permanent hole.
 *   - teardown flushes the final tails WITHOUT awaiting, then awaits the D1
 *     update that flips status to "ended" — so the 409 "still in progress"
 *     guard can pass while the last puts are in flight.
 *   - the stitch was then cached to `recording.wav` with `Cache-Control:
 *     immutable`, and this worker has NO `MEDIA.delete` (media.ts
 *     MEDIA_KEY_FAMILIES). The truncation became that call's permanent answer.
 *
 * A two-hour call whose segment 3 was lost replayed as ninety seconds, with a
 * complete-looking scrubber and nothing anywhere saying a byte was missing.
 * `/calls` calls these "call recordings, replayable like podcast episodes".
 *
 * The fix consults something that already existed: `voice_sessions.segment_count`,
 * written by teardown as `inSeq + outSeq`. Every client that reads that column
 * (web `app/calls/page.tsx`, iOS `VoiceCall.swift`, Android `CallRecordingsSheet.kt`)
 * uses it ONLY as `> 0` — a boolean. It is the one number that can distinguish
 * the two cases, so these pins care that it is used AS a number.
 *
 * ⚠️ `segment_count` is the SUM of both directions, so probing it per-direction
 * always overshoots one of them. Those tail misses are the overshoot, NOT loss —
 * a miss is only a gap once a LATER hit proves the sequence continued past it.
 * Several pins below exist purely to keep that distinction from collapsing.
 */

let v: any
let voiceSrc = ''

beforeAll(async () => {
  if (!present) return
  v = await import(workerFile('voice.ts') /* @vite-ignore */)
  voiceSrc = readFileSync(workerFile('voice.ts'), 'utf8')
})

/** A minimal R2 stand-in: only get/put, exactly what voiceRecording uses. */
function fakeMedia(objects: Record<string, Uint8Array>) {
  const gets: string[] = []
  const puts: string[] = []
  return {
    gets,
    puts,
    store: objects,
    async get(key: string) {
      gets.push(key)
      const b = objects[key]
      if (!b) return null
      return {
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        text: async () => Buffer.from(b).toString('utf8'),
      }
    },
    async put(key: string, body: any) {
      puts.push(key)
      objects[key] = body instanceof Uint8Array ? body : new Uint8Array(body)
      return {}
    },
  }
}

/** D1 stand-in returning one row for the SELECT the route makes. */
function fakeDb(row: any | null, seen?: string[]) {
  return {
    prepare(sql: string) {
      seen?.push(sql)
      return { bind: () => ({ first: async () => row }) }
    },
  }
}

/** `n` bytes all equal to `fill` — a per-segment fingerprint we can look for in
 *  the stitched WAV, so "read through the hole" is proven by BYTES, not by a
 *  header the code also writes. */
const seg = (fill: number, n = 8) => new Uint8Array(n).fill(fill)

/** The journal must exist (the route 404s without it). No `response_started`
 *  marks, so the mix places nothing and the WAV body is exactly the in-stream —
 *  which is what lets us assert on segment fingerprints. */
const EVENTS = new Uint8Array(Buffer.from('{"t":"session_started","ms":0}\n', 'utf8'))

const ID = 'call-1'
const req = () => new Request(`https://w.example/voice/recording/${ID}`)

async function body(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

describe.skipIf(!present)('a hole below segment_count is read THROUGH, not treated as the end', () => {
  it('segments after a missing index still reach the WAV', async () => {
    // in-0,1,2 present · in-3 LOST · in-4,5 present. count = 6.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-1.pcm`]: seg(0x11),
      [`voice/${ID}/in-2.pcm`]: seg(0x12),
      [`voice/${ID}/in-4.pcm`]: seg(0x14),
      [`voice/${ID}/in-5.pcm`]: seg(0x15),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 6 }) }
    const res = await v.voiceRecording(req(), env)
    expect(res.status).toBe(200)
    const bytes = await body(res)
    // The fingerprints of the segments PAST the hole. Under break-at-first-miss
    // these are simply absent and the recording is 3/5 as long.
    expect(bytes.includes(0x14), 'segment in-4 (after the hole) is missing from the stitch').toBe(true)
    expect(bytes.includes(0x15), 'segment in-5 (after the hole) is missing from the stitch').toBe(true)
    // 5 segments × 8 bytes + the 44-byte WAV header.
    expect(bytes.length, 'the stitch is short — a segment past the hole was dropped').toBe(44 + 40)
  })

  it('the gap is NAMED on the response, not merely survived', async () => {
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-2.pcm`]: seg(0x12),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 4 }) }
    const res = await v.voiceRecording(req(), env)
    expect(res.headers.get('X-Tiny-Recording-Partial'), 'a lossy stitch is served with no partial flag')
      .toBe('1')
    expect(res.headers.get('X-Tiny-Segments-Missing'), 'the missing segment is not named')
      .toBe('in-1')
  })

  it('a lossy stitch is NOT frozen into R2 (there is no MEDIA.delete to undo it)', async () => {
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-2.pcm`]: seg(0x12),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 4 }) }
    const res = await v.voiceRecording(req(), env)
    expect(
      media.puts,
      'a short stitch was cached — with immutable cache-control and no delete in this worker, ' +
        'that is the call\'s permanent answer, and the segments may still be in flight from ' +
        'teardown\'s un-awaited flush',
    ).toEqual([])
    expect(res.headers.get('Cache-Control'), 'a lossy stitch is served as cacheable')
      .toBe('no-store')
  })

  it('the loss is logged with the session id, so it is findable without a report', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const media = fakeMedia({
        [`voice/${ID}/events.jsonl`]: EVENTS,
        [`voice/${ID}/in-0.pcm`]: seg(0x10),
        [`voice/${ID}/in-2.pcm`]: seg(0x12),
      })
      await v.voiceRecording(req(), { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 4 }) })
      const said = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(said, 'nothing was logged when a recording was stitched with gaps').toMatch(/gap/i)
      expect(said, 'the log does not name the session, so it cannot be traced').toContain(ID)
    } finally {
      spy.mockRestore()
    }
  })
})

describe.skipIf(!present)('a complete call is unchanged — the fix costs the happy path nothing', () => {
  it('all segments present → cached, immutable, and no partial headers', async () => {
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-1.pcm`]: seg(0x11),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 2 }) }
    const res = await v.voiceRecording(req(), env)
    expect(res.status).toBe(200)
    expect(media.puts, 'a complete stitch is no longer cached — every replay re-stitches')
      .toEqual([`voice/${ID}/recording.wav`])
    expect(res.headers.get('Cache-Control')).toMatch(/immutable/)
    expect(res.headers.get('X-Tiny-Recording-Partial'), 'a complete call is flagged partial').toBeNull()
    expect(res.headers.get('X-Tiny-Segments-Missing')).toBeNull()
  })

  it('the per-direction TAIL overshoot is not reported as loss', async () => {
    // ⚠️ The pin that keeps the count honest. `segment_count` = in + out = 4, so
    // probing "in" to 4 misses in-2 and in-3 — which never existed, because
    // those two segments are the OUT ones. A naive "miss below the count is a
    // gap" reports every complete two-way call as lossy.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-1.pcm`]: seg(0x11),
      [`voice/${ID}/out-0.pcm`]: seg(0x20),
      [`voice/${ID}/out-1.pcm`]: seg(0x21),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 4 }) }
    const res = await v.voiceRecording(req(), env)
    expect(res.headers.get('X-Tiny-Segments-Missing'), 'the tail overshoot was reported as missing')
      .toBeNull()
    expect(res.headers.get('X-Tiny-Recording-Partial')).toBeNull()
    expect(media.puts, 'a complete call was refused the cache because of overshoot')
      .toEqual([`voice/${ID}/recording.wav`])
  })

  it('probing past the real tail is BOUNDED — not 10k GETs per direction', async () => {
    // A call whose count is large but whose segments ended early (the out
    // direction of a mostly-listening call) must not walk the whole range.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 900 }) }
    await v.voiceRecording(req(), env)
    const probes = media.gets.filter((k) => k.endsWith('.pcm')).length
    expect(probes, `probed ${probes} keys — the read past the tail is unbounded`)
      .toBeLessThan(20)
  })
})

describe.skipIf(!present)('segment_count is used as a NUMBER, not the boolean every client reads', () => {
  it('the route selects the column alongside status (one query, no extra round trip)', () => {
    // The clients all do `(segment_count || 0) > 0`. If this SELECT loses the
    // column, `expected` is null forever and the whole read-through path
    // silently reverts to break-at-first-miss with nothing failing.
    expect(voiceSrc, 'the recording route no longer selects segment_count')
      .toMatch(/SELECT status, segment_count FROM voice_sessions WHERE id = \?/)
  })

  it('a count of 0 is "unknown", not "zero segments" — legacy rows still stitch', async () => {
    // Migration 0018 defaults the column to 0, so pre-count calls and rows whose
    // end-update never landed both read 0. Treating that as a real count would
    // make every one of them stitch to silence.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-1.pcm`]: seg(0x11),
    })
    const env = { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 0 }) }
    const res = await v.voiceRecording(req(), env)
    expect(res.status, 'a legacy row (count 0) no longer produces a recording').toBe(200)
    expect((await body(res)).length, 'the legacy read stitched nothing').toBe(44 + 16)
  })

  it('an unknown count is DISCLOSED — "no gaps" there only means none were detectable', async () => {
    // The honest half of keeping the old behaviour: with no count the read still
    // breaks at the first miss, so its silence proves nothing. Say so rather
    // than letting a legacy row look verified.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
    })
    const res = await v.voiceRecording(req(), { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 0 }) })
    expect(res.headers.get('X-Tiny-Segments-Unverified'), 'a countless read is served as if verified')
      .toBe('1')
  })

  it('a verified complete read is NOT marked unverified', async () => {
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
    })
    const res = await v.voiceRecording(req(), { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 1 }) })
    expect(res.headers.get('X-Tiny-Segments-Unverified'), 'every read claims to be unverified — ' +
      'the header carries no information').toBeNull()
  })

  it('no D1 binding at all → unverified, not a confident empty read', async () => {
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
    })
    const res = await v.voiceRecording(req(), { MEDIA: media })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Tiny-Segments-Unverified')).toBe('1')
  })
})

describe.skipIf(!present)('the guards the read sits behind still hold', () => {
  it('a live call is still 409, before any stitching', async () => {
    // The count check must not have moved the status guard: stitching a growing
    // call is what the 409 exists to prevent.
    const media = fakeMedia({ [`voice/${ID}/events.jsonl`]: EVENTS })
    const res = await v.voiceRecording(req(), { MEDIA: media, DB: fakeDb({ status: 'live', segment_count: 2 }) })
    expect(res.status).toBe(409)
    expect(media.puts).toEqual([])
  })

  it('an already-cached recording is served without re-reading segments', async () => {
    const media = fakeMedia({
      [`voice/${ID}/recording.wav`]: new Uint8Array(64).fill(7),
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
    })
    const res = await v.voiceRecording(req(), { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 1 }) })
    expect(res.status).toBe(200)
    expect(media.gets.filter((k) => k.endsWith('.pcm')), 'the cache hit re-probed segments').toEqual([])
  })

  it('the partial headers survive a Range request (rangedWav spreads, not replaces)', async () => {
    // iOS AVPlayer opens every asset with `Range: bytes=0-1`. If the disclosure
    // only rode on the 200 path, the strictest client we serve would never see it.
    const media = fakeMedia({
      [`voice/${ID}/events.jsonl`]: EVENTS,
      [`voice/${ID}/in-0.pcm`]: seg(0x10),
      [`voice/${ID}/in-2.pcm`]: seg(0x12),
    })
    const r = new Request(`https://w.example/voice/recording/${ID}`, { headers: { Range: 'bytes=0-1' } })
    const res = await v.voiceRecording(r, { MEDIA: media, DB: fakeDb({ status: 'ended', segment_count: 4 }) })
    expect(res.status).toBe(206)
    expect(res.headers.get('X-Tiny-Recording-Partial')).toBe('1')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe.skipIf(!present)('the advice to stop at the first missing index is gone for good', () => {
  it('no comment in voice.ts tells a client to stop at the first missing segment', () => {
    // VoiceSessionGetCall's `manifest` used to instruct exactly the bug this
    // cycle fixed one surface over: "expose both series generously and let the
    // player stop at the first missing index." No client reads `audioBase`
    // today, so that comment was a spec waiting to be implemented wrongly.
    expect(voiceSrc.length, 'the voice.ts scrape read nothing').toBeGreaterThan(1000)
    expect(
      voiceSrc.match(/stop at the first missing/i),
      'voice.ts again tells a reader to stop at the first missing index — that is the defect ' +
        'this suite exists for. A hole and the end of a call are the same observation from ' +
        'outside; walk to segment_count and report the misses below it.',
    ).toBeNull()
  })

  it('the manifest names segment_count as the stop signal instead', () => {
    // The comment had to say something; a deletion would leave the next author
    // to re-derive the wrong rule. ⚠️ Anchored to the `audioBase` block, not the
    // whole file — the read loop above legitimately discusses segment_count, and
    // a file-wide scan is satisfied by that SIBLING with this comment deleted.
    const at = voiceSrc.indexOf('audioBase:')
    expect(at, 'audioBase moved — re-anchor this pin').toBeGreaterThan(-1)
    const block = voiceSrc.slice(Math.max(0, at - 800), at)
    expect(block, 'the manifest no longer tells a player how to find the end of the segments')
      .toMatch(/segment_count/)
  })
})
