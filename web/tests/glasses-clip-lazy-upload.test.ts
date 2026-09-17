// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎥 A clip nobody asked for does not go to R2.
 *
 * The worker's media store has `MEDIA.put`, `MEDIA.head` and `MEDIA.get` — and
 * **no delete**, anywhere (`worker/src/media.ts`). So every byte
 * uploaded is permanent, and there is no reclaim path even in principle.
 *
 * That collided with how `meta_record_video` auto-stops. Two things happen at
 * ~28s, and only ONE of them is forced: the MP4 must be finalized (the muxer has
 * to close), but the UPLOAD is not — the START call was answered long ago, and
 * nobody has asked for the bytes yet. The recorder uploaded anyway, on the guess
 * that a second call would come. When it didn't (c39: the clip expires after
 * `pendingTTL`) or when the account changed under it (c40: sign-out drops the
 * park), the clip was already hosted at a public-but-unguessable /media/ URL —
 * and both of those fixes could only drop the phone's *reference* to bytes that
 * outlived them.
 *
 * So the upload moved to the collect. `finalizeClip()` / `finalize()` closes the
 * file and parks the BYTES; the upload runs when — and only when — the second
 * call actually wants a URL. An expired or dropped clip now never reaches R2 at
 * all, which is the only reclaim story available without a worker deploy.
 *
 * ⚠️ Pinned on BOTH phones and against the WORKER: if a `MEDIA.delete` ever
 * lands, this design has a cheaper alternative and the pin should be revisited
 * deliberately rather than silently outliving its reason.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ios = read('ios/Tiny/Sources/WearablesRecorder.swift')
const android = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')

/**
 * The WHOLE worker, not just media.ts: `voice.ts` writes to the same R2 binding
 * (recording.wav, events.jsonl, the pcm segments). A delete added anywhere is
 * the thing that changes this design's trade-off, so the premise is checked
 * across every source file rather than the one that happens to own the route.
 */
const workerSrc = join(ROOT, 'worker/src')
const workerFiles = readdirSync(workerSrc).filter((f) => f.endsWith('.ts'))
const worker = workerFiles.map((f) => read(join('worker/src', f))).join('\n')

/** Slice a named region and PROVE both anchors were found (c34 M1 / c36 N10). */
const region = (src: string, from: string, to: string, label: string) => {
  const at = src.indexOf(from)
  expect(at, `${label}: could not find "${from}"`).toBeGreaterThan(-1)
  const end = src.indexOf(to, at + from.length)
  expect(end, `${label}: could not find the end anchor "${to}"`).toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('the premise: the worker cannot delete media', () => {
  it('nothing in the worker deletes from R2 — this is WHY the upload is lazy', () => {
    // The whole design rests on this. If it stops being true, say so loudly
    // rather than letting the phones keep a workaround nobody can explain.
    // Prove the scrape read real source first: a slicer returning "" passes
    // forever, and this one reads a directory that could be renamed.
    expect(workerFiles.length, 'the worker src/ scrape found no .ts files').toBeGreaterThan(3)
    expect(worker, 'the worker no longer writes to R2 at all — re-read this suite')
      .toMatch(/MEDIA\.put\(/)
    expect(
      worker.match(/MEDIA\.delete\(/g),
      'the worker gained MEDIA.delete — the phones defer their upload because there was NO reclaim ' +
        'path for a clip nobody collects. With a delete, revisit that trade deliberately (a delete ' +
        'endpoint + an owner check) instead of leaving this comment stale.',
    ).toBeNull()
  })
})

describe('the auto-stop finalizes but does NOT upload', () => {
  it('iOS parks finalized BYTES, and the finalizer touches no network', () => {
    // The parked value carries the bytes, not a URL — a payload here means the
    // upload already happened at park time.
    expect(ios, 'iOS no longer parks raw bytes').toMatch(/let mp4:\s*Data/)
    expect(ios, 'the parked frames are no longer raw JPEGs either')
      .toMatch(/let frameJpegs:\s*\[Data\]/)

    const finalize = region(
      ios,
      'private func finalizeClip() async -> Parked',
      'private func upload(',
      'iOS finalizeClip',
    )
    // ⚠️ THE POINT OF THE WHOLE CYCLE: no upload inside the finalizer.
    expect(finalize, 'the iOS finalizer uploads — a clip nobody collects would reach R2 again')
      .not.toMatch(/api\/media/)
    expect(finalize, 'the finalizer no longer returns the bytes it finalized')
      .toMatch(/return \.clip\(Finished\(/)

    // And the auto-stop must call the FINALIZER, not the uploading stop().
    const auto = region(ios, 'autoStopTask = Task', 'return ["ok": true, "recording": true]', 'iOS auto-stop')
    expect(auto, 'the auto-stop calls the uploading path instead of finalizing')
      .toContain('await self.finalizeClip()')
    expect(auto, 'the auto-stop still goes through the uploading stop()')
      .not.toMatch(/await self\.stop\(/)
  })

  it('Android does the same, in the coroutine that parks', () => {
    expect(android, 'Android no longer parks raw bytes')
      .toMatch(/class Finished\(val mp4: ByteArray/)

    const finalize = region(
      android,
      'private fun finalizeInner(): Parked',
      // ⚠️ Ends at teardown(), NOT at the file's next comment: teardown has its
      // own `file.delete()` and its own no-network body, so a slice running past
      // it is satisfied by the SIBLING and reads as a pass no matter what
      // finalizeInner does (measured — mutant N7 survived on exactly this).
      'fun teardown()',
      'Android finalizeInner',
    )
    expect(finalize, 'the Android finalizer uploads — a clip nobody collects would reach R2 again')
      .not.toMatch(/api\/media/)
    expect(finalize, 'the finalizer no longer returns the bytes it finalized')
      .toMatch(/Parked\.Clip\(Finished\(/)

    // The wrapper the auto-stop actually calls, too — `finalizeInner` being
    // clean proves nothing if `finalize()` uploads around it.
    const wrapper = region(android, 'suspend fun finalize(): Parked', 'private fun finalizeInner', 'Android finalize wrapper')
    expect(wrapper, 'the Android finalize wrapper uploads around its inner half')
      .not.toMatch(/upload\(/)
    // It must stay NonCancellable: the auto-stop runs inside the recording's own
    // scope, and finalizeInner cancels that scope (measured on the Pixel).
    expect(wrapper, 'finalize is cancellable — its own teardown would kill it mid-finalize')
      .toMatch(/NonCancellable/)

    const auto = region(android, 'delay(MAX_SECONDS * 1000)', 'private fun encode(', 'Android auto-stop')
    expect(auto, 'the Android auto-stop calls the uploading path instead of finalizing')
      .toContain('finalize()')
    expect(auto, 'the Android auto-stop still calls stopAndUpload')
      .not.toMatch(/stopAndUpload/)
  })

  it('the temp file is deleted by the finalizer, so a parked clip needs no file', () => {
    // Bytes in memory, not a path: cacheDir/tmp is reclaimable by the OS, and a
    // park that depended on a file would come back empty after eviction.
    const iosFinalize = region(
      ios,
      'private func finalizeClip() async -> Parked',
      'private func upload(',
      'iOS finalizeClip',
    )
    expect(iosFinalize, 'iOS no longer deletes the temp file when it finalizes')
      .toMatch(/removeItem\(at: fileURL\)/)
    const androidFinalize = region(
      android,
      'private fun finalizeInner(): Parked',
      // ⚠️ Ends at teardown(), NOT at the file's next comment: teardown has its
      // own `file.delete()` and its own no-network body, so a slice running past
      // it is satisfied by the SIBLING and reads as a pass no matter what
      // finalizeInner does (measured — mutant N7 survived on exactly this).
      'fun teardown()',
      'Android finalizeInner',
    )
    expect(androidFinalize, 'Android no longer deletes the temp file when it finalizes')
      .toMatch(/file\.delete\(\)/)
  })
})

describe('the collect is where the bytes go up', () => {
  it('iOS uploads inside the TTL branch, never outside it', () => {
    const toggle = region(ios, 'func toggle(token: String?) async', 'private func start(', 'iOS toggle')
    expect(toggle, 'the collect no longer uploads the parked clip')
      .toMatch(/case \.clip\(let clip\): return await upload\(clip, token: token\)/)
    // A parked FAILURE still has to reach the agent — it is the reason the park
    // is an enum and not just bytes.
    expect(toggle, 'a parked finalize-failure is swallowed instead of reported')
      .toMatch(/case \.failure\(let payload\): return payload/)

    // ⚠️ ORDERING: the upload must sit INSIDE the freshness check. Uploading
    // before it would put an expired clip in R2 — exactly the leak being fixed.
    const ttlAt = toggle.indexOf('Date().timeIntervalSince(done.at) < Self.pendingTTL')
    const uploadAt = toggle.indexOf('await upload(clip, token: token)')
    const staleAt = toggle.indexOf('Self.staleNote')
    expect(ttlAt, 'the TTL check is gone from the collect').toBeGreaterThan(-1)
    expect(uploadAt, 'the collect does not upload at all').toBeGreaterThan(ttlAt)
    expect(staleAt, 'an expired clip is uploaded before being discarded')
      .toBeGreaterThan(uploadAt)
  })

  it('Android uploads inside the TTL branch too', () => {
    const toggle = region(android, 'internal suspend fun toggle(', 'private suspend fun upload(', 'Android toggle')
    expect(toggle, 'the Android collect no longer uploads the parked clip')
      .toMatch(/is Parked\.Clip -> upload\(app, parked\.done\)/)
    expect(toggle, 'a parked finalize-failure is swallowed on Android')
      .toMatch(/is Parked\.Failure -> parked\.payload/)

    const ttlAt = toggle.indexOf('System.currentTimeMillis() - parkedAt < PENDING_TTL_MS')
    const uploadAt = toggle.indexOf('upload(app, parked.done)')
    const staleAt = toggle.indexOf('STALE_NOTE')
    expect(ttlAt, 'the Android TTL check is gone').toBeGreaterThan(-1)
    expect(uploadAt, 'the Android collect does not upload').toBeGreaterThan(ttlAt)
    expect(staleAt, 'an expired clip is uploaded on Android before being discarded')
      .toBeGreaterThan(uploadAt)
  })

  it('the manual STOP still uploads immediately — someone IS waiting for it', () => {
    // The lazy upload must not become a lazy ANSWER: on a real second call the
    // server is polling the mailbox, so stop() finalizes and uploads in one go.
    const stop = region(ios, 'private func stop(token: String?) async', '\n    private func teardown', 'iOS stop')
    expect(stop, 'the manual stop no longer finalizes').toContain('await finalizeClip()')
    expect(stop, 'the manual stop no longer uploads — the caller would get no URL')
      .toMatch(/return await upload\(done, token: token\)/)

    const kStop = region(android, 'suspend fun stopAndUpload(app: TinyApp)', 'suspend fun finalize()', 'Android stopAndUpload')
    expect(kStop, 'the Android manual stop no longer finalizes').toMatch(/finalizeInner\(\)/)
    expect(kStop, 'the Android manual stop no longer uploads')
      .toMatch(/is Parked\.Clip -> upload\(app, parked\.done\)/)
  })

  it('sign-out drops the bytes, and now that costs nothing', () => {
    // c40's endSession() still holds: dropping `pending` is complete now, since
    // there is nothing in R2 to be left behind.
    const end = region(ios, 'func endSession() {', '\n    }', 'iOS endSession')
    expect(end, 'endSession no longer drops the parked bytes').toMatch(/pending = nil/)
    const kEnd = region(android, 'suspend fun endSession()', '\n    suspend fun runTool', 'Android endSession')
    expect(kEnd, 'Android endSession no longer drops the parked bytes').toMatch(/pending = null/)
  })
})
