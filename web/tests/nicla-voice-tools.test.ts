// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, workerPresent as present } from './_worker'

import {
  makeNiclaVoiceStatusTool, makeNiclaVoiceWakesTool,
  makeNiclaVoiceRecordTool, makeNiclaVoiceTranscriptsTool, makeNiclaVoiceTranscriptTool,
  resolveVoice, resolvePhone, recentWakes, WAKE_KIND,
} from '../lib/chat/tools/nicla-voice'

/**
 * nicla_voice_* — the tools for the OTHER necklace.
 *
 * Three bug classes, all specific to this board:
 *
 * 1. WRONG-BOARD TOOLS. The Nicla Voice has no camera, no WiFi and no relay
 *    mailbox. Resolving it with nicla.ts's `platform === 'nicla-vision'` filter
 *    (or widening that filter to match both) would point photo/video/record
 *    tools at a board that can never answer them. These tests pin the platform
 *    filter on BOTH rosters so a future "simplification" that merges them fails
 *    loudly here.
 *
 * 2. ROSTER DRIFT. No central registry — four inline lists. nicla_take_video
 *    was missing from job-run for its whole life with nothing failing to reveal
 *    it. Same source-level check as tests/nicla-tools.test.ts.
 *
 * 3. SILENCE MISREPORTED AS SILENCE. The Voice cannot heartbeat for itself; a
 *    phone relays it over BLE. So an empty wake log means either "nobody spoke"
 *    or "nobody was listening", and those are not the same answer. If the tool
 *    doesn't distinguish them the agent will confidently tell the user they said
 *    nothing when in fact the necklace was out of range the whole time.
 */
const NAMES = [
  'nicla_voice_status', 'nicla_voice_wakes',
  'nicla_voice_record', 'nicla_voice_transcripts', 'nicla_voice_transcript',
]
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

/** Stub the worker: device list + event ring. */
function stubWorker(devices: any[], events: any[] = []) {
  global.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/device/list')) return new Response(JSON.stringify({ ok: true, devices }))
    if (u.includes('/events')) return new Response(JSON.stringify({ events }))
    return new Response(JSON.stringify({}), { status: 404 })
  }) as any
}

const voiceUnit = (over: any = {}) => ({
  id: 'v1', name: 'tiny voice', platform: 'nicla-voice', online: true,
  capabilities: JSON.stringify(['mic', 'wake', 'imu', 'ble']), ...over,
})

describe('nicla_voice tool identity', () => {
  it('the five factories produce exactly the five expected names', () => {
    const tools = [
      makeNiclaVoiceStatusTool('u1'), makeNiclaVoiceWakesTool('u1'),
      makeNiclaVoiceRecordTool('u1'), makeNiclaVoiceTranscriptsTool('u1'), makeNiclaVoiceTranscriptTool('u1'),
    ]
    expect(tools.map((t: any) => t.toolSpec.name)).toEqual(NAMES)
  })

  it('all refuse without a user — the necklace and its words belong to an account', async () => {
    const calls: Array<[any, any]> = [
      [makeNiclaVoiceStatusTool, {}],
      [makeNiclaVoiceWakesTool, {}],
      [makeNiclaVoiceRecordTool, {}],
      [makeNiclaVoiceTranscriptsTool, {}],
      [makeNiclaVoiceTranscriptTool, { id: 't-1' }], // id is schema-required
    ]
    for (const [make, args] of calls) {
      const t: any = make(null)
      const out = await t.invoke(args)
      expect(out.ok, t.toolSpec.name).toBe(false)
      expect(String(out.error)).toMatch(/login/i)
    }
  })

  it('still offers NO tool that pulls audio off the BOARD', () => {
    // 64KB RAM, ~60% spent on statics; adding a 128-byte characteristic during
    // bring-up broke every BLE connection. nicla_voice_record EXISTS now, but
    // it commands the paired PHONE's mic over the relay — nothing here may
    // claim the necklace itself as an audio source.
    const text = src('lib/chat/tools/nicla-voice.ts')
    expect(text).not.toMatch(/name:\s*'nicla_voice_(listen|audio|photo|video)'/)
    // The recorder resolves a PHONE, never the board. ⚠️ This used to assert
    // `platform === 'ios-arm64'` — the exact defect below — so the suite
    // greenly guaranteed that an Android-only account could not record. The
    // property that matters is "not the necklace's platform", which is what a
    // record capability expresses without naming any one phone.
    expect(text).toMatch(/parseCaps\(x\.capabilities\)\.includes\(RECORD_CAP\)/)
    expect(text).not.toMatch(/phones.*platform === 'ios-arm64'/)
  })
})

describe('⚠️ the recorder resolves a phone by CAPABILITY, not by platform', () => {
  // The c45 deferred half, and a real outage: nicla_voice_record filtered
  // `platform === 'ios-arm64'`, so all five tools refused an account whose only
  // phone is the Pixel — with "No phone is enrolled" — while that phone
  // implements the whole envelope (FleetManager's `type == "record"` arm →
  // PhoneRecorder → /api/devices/transcript). b791dcb8 then declared these five
  // tools to every voice surface, which made the wrong answer easier to reach.
  const androidPhone = (over: any = {}) => ({
    id: 'a1', name: 'pixel-8', platform: 'android-arm64', kind: 'daemon',
    online: true, capabilities: JSON.stringify(
      ['chat', 'location', 'bluetooth_scan', 'speak', 'open_app', 'screenshot', 'glasses', 'record'],
    ), ...over,
  })
  const iosPhone = (over: any = {}) => ({
    id: 'p1', name: 'iPhone', platform: 'ios-arm64', kind: 'daemon', online: true,
    capabilities: JSON.stringify(
      ['chat', 'bluetooth_scan', 'location', 'record', 'speak', 'open_app', 'image_gen', 'glasses', 'screenshot'],
    ), ...over,
  })

  it('an ANDROID-only account resolves its Pixel instead of being told it has no phone', async () => {
    stubWorker([voiceUnit(), androidPhone()])
    const phone = await resolvePhone('u1')
    expect(phone?.id, 'the Pixel declares `record` and answers the envelope').toBe('a1')
    expect(phone?.platform).toBe('android-arm64')
  })

  it('…and its record tool actually records rather than refusing the account', async () => {
    // The whole user-visible outage, end to end: same stub, real tool.
    let sentTo: string | null = null
    global.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/device/list')) {
        return new Response(JSON.stringify({ ok: true, devices: [voiceUnit(), androidPhone()] }))
      }
      if (u.includes('/device/relay/send')) {
        sentTo = JSON.parse(init.body).toDevice
        return new Response(JSON.stringify({ ok: true, id: 'env-1' }))
      }
      if (u.includes('/device/relay/recv')) {
        // Android's real reply shape: result + transcriptId, NO audioUrl key.
        return new Response(JSON.stringify({
          reply: { payload: JSON.stringify({ result: 'hello from the pixel', transcriptId: 't-9' }) },
        }))
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as any
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({ seconds: 5 })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(sentTo).toBe('a1')
    expect(out.result).toBe('hello from the pixel')
    expect(out.transcript_id).toBe('t-9')
  })

  it('an iPhone still resolves — the fix widened the filter, it did not move it', async () => {
    stubWorker([voiceUnit(), iosPhone()])
    expect((await resolvePhone('u1'))?.id).toBe('p1')
  })

  it('NEITHER necklace can be resolved as the recorder, whatever it advertises', async () => {
    // The original bug class this filter exists to prevent (see the header):
    // the boards' own caps are mic/wake/imu/ble — never `record`.
    stubWorker([
      voiceUnit(),
      { id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true, capabilities: JSON.stringify(['camera', 'mic', 'wifi']) },
    ])
    expect(await resolvePhone('u1')).toBeNull()
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({})
    expect(out.ok).toBe(false)
    // ⚠️ and the refusal must no longer claim the account has no phone.
    expect(String(out.error)).toMatch(/offering to record/i)
    expect(String(out.error)).not.toMatch(/No phone is enrolled/i)
    // ⚠️ It must also NAME BOTH PHONES. B2 survived the first battery by
    // reverting this clause to "the tiny app on the phone" — still true, still
    // mentions a phone, and still leaves an Android user reading a refusal that
    // sounds like the feature is an iPhone one. The sentence a user acts on has
    // to say their phone counts.
    expect(String(out.error)).toMatch(/iPhone or Android/i)
    // …and tell them the recovery, since a capability arrives on a heartbeat.
    expect(String(out.error)).toMatch(/open it once|re-registers/i)
  })

  it('a laptop node cannot be mistaken for a microphone', async () => {
    // tiny-tech declares its resolved TOOL LABELS as capabilities (apple,
    // computer, flipper, adb…). None is `record`, and this pins that a node
    // with a rich cap list still is not a recorder.
    stubWorker([{
      id: 'mac', name: 'laptop', platform: 'darwin-arm64', online: true,
      capabilities: JSON.stringify(['mcp', 'files', 'apple', 'computer', 'desktop', 'flipper', 'adb']),
    }])
    expect(await resolvePhone('u1')).toBeNull()
  })

  it('an online phone wins over an offline one, across platforms', async () => {
    stubWorker([androidPhone({ id: 'cold', online: false }), iosPhone({ id: 'warm', online: true })])
    expect((await resolvePhone('u1'))?.id).toBe('warm')
    stubWorker([iosPhone({ id: 'cold2', online: false }), androidPhone({ id: 'warm2', online: true })])
    expect((await resolvePhone('u1'))?.id).toBe('warm2')
  })

  it('a malformed capabilities blob drops the device instead of throwing', async () => {
    // parseCaps swallows it (shared with flipper.ts). A phone whose blob is
    // corrupt is unreachable, but the tool must still answer.
    stubWorker([{ id: 'weird', name: 'x', platform: 'ios-arm64', online: true, capabilities: 'not json at all' }])
    expect(await resolvePhone('u1')).toBeNull()
  })

  it('both phones DECLARE the capability this resolver asks for, and re-assert it', () => {
    // A capability filter is only as good as what the clients send. Pin both
    // enrollments AND the re-assertion, since a row enrolled before the
    // capability existed would otherwise stay invisible forever.
    const ios = src('ios/Tiny/Sources/Session.swift')
    expect(ios).toMatch(/static let capabilities = \[[^\]]*"record"/)
    expect(ios).toMatch(/beatCapabilities/)
    const kt = src('android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt')
    expect(kt).toMatch(/private val capabilities = listOf\([\s\S]{0,200}?"record"/)
    expect(kt).toMatch(/if \(first\) body\.put\("capabilities"/)
    expect(kt).toMatch(/\.put\("platform", "android-arm64"\)/)
  })

  it('the roster header states the contract, so the next reader does not re-add a platform test', () => {
    // ⚠️ F1 survived the first battery on this: the header's own summary of
    // nicla_voice_record still said "platform 'ios-arm64'" while the code below
    // asked for a capability. A stale header IS how this bug gets reintroduced
    // — the resolver was correct for one line and described wrong for twenty.
    const text = src('lib/chat/tools/nicla-voice.ts')
    const header = text.slice(0, text.indexOf('import {'))
    expect(header).toMatch(/declaring the `record` capability/)
    expect(header).toMatch(/iPhone or Pixel/)
    // The header must not still name a single platform as the recorder.
    expect(header).not.toMatch(/platform 'ios-arm64'/)
    // …and the resolver's own doc-comment must explain WHY, since "capability"
    // alone reads like a style choice rather than a fix for a real refusal.
    expect(text.slice(text.indexOf('RESOLVED BY CAPABILITY'), text.indexOf('export const RECORD_CAP')))
      .toMatch(/android-arm64/)
    // ⚠️ Unwrap the comment before matching: a doc sentence that happens to
    // break across ` * ` would otherwise fail on formatting alone, which is the
    // kind of false red someone deletes instead of investigating (c60).
    const doc = text.slice(text.indexOf('export const RECORD_CAP')).slice(0, 1500)
      .replace(/\n\s*\*\s?/g, ' ')
    expect(doc).toMatch(/declaring \[RECORD_CAP\], online preferred/)
  })

  it('the resolver shares ONE capability parser with the Flipper host resolver', () => {
    // Two readings of the worker's capabilities column would drift; flipper.ts
    // already lowercases and tolerates a malformed blob.
    const text = src('lib/chat/tools/nicla-voice.ts')
    expect(text).toMatch(/import \{ parseCaps \} from '\.\/flipper'/)
    expect(src('lib/chat/tools/flipper.ts')).toMatch(/export function parseCaps/)
  })
})

describe('a text-only take is not a failed take', () => {
  // ⚠️ Parameterised by PLATFORM, because the note has two branches and only one
  // of them was pinned. Measured: replacing `phone.platform === 'android-arm64'`
  // with `true` — every null reported as the Android constraint — left the suite
  // green, so an iPhone whose upload failed would have been explained to the agent
  // as a phone that never had samples. That is a confident wrong cause, which is
  // the same harm as the bare null this note replaced.
  const replyFrom = (platform: string, payload: any) => {
    global.fetch = (async (url: any) => {
      const u = String(url)
      if (u.includes('/device/list')) {
        return new Response(JSON.stringify({
          ok: true,
          devices: [{
            id: 'a1', name: platform === 'android-arm64' ? 'pixel' : 'iPhone', platform, online: true,
            capabilities: JSON.stringify(['record']),
          }],
        }))
      }
      if (u.includes('/device/relay/send')) return new Response(JSON.stringify({ ok: true, id: 'e1' }))
      if (u.includes('/device/relay/recv')) {
        return new Response(JSON.stringify({ reply: { payload: JSON.stringify(payload) } }))
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as any
  }
  const androidReply = (payload: any) => replyFrom('android-arm64', payload)

  it('Android: a missing audioUrl is EXPLAINED, not left as a bare null', async () => {
    // The agent cannot tell "never had a file" from "upload failed" by looking
    // at null, and reporting a stored transcript as a failed recording is the
    // whole harm. Only the resolver knows which phone answered.
    androidReply({ result: 'the words', transcriptId: 't-1' })
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.audio_url).toBeNull()
    expect(String(out.audio_note)).toMatch(/nothing went wrong/i)
    expect(String(out.audio_note)).toMatch(/text-only by design|transcript IS the recording/i)
  })

  it('iOS: a missing audioUrl is NOT blamed on a constraint that phone does not have', async () => {
    // The other branch, and the reason the note is decided by the resolver rather
    // than by the null: an iPhone feeds one AVAudioEngine tap to both the
    // recognizer and an AVAudioFile, so it CAN host audio. A null here means
    // something went wrong with this take — a note that says "nothing went wrong,
    // this phone cannot keep the samples" would be a confident wrong cause, and
    // would tell the user their platform is the reason when it is not.
    replyFrom('ios-arm64', { result: 'the words', transcriptId: 't-3' })
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.audio_url).toBeNull()
    // Still explained — a bare null is what this whole note exists to replace…
    expect(String(out.audio_note)).toMatch(/\S/)
    // …but not with the Android platform's excuse, and not by claiming nothing
    // went wrong, which is exactly what the Android copy says.
    expect(String(out.audio_note)).not.toMatch(/nothing went wrong/i)
    expect(String(out.audio_note)).not.toMatch(/android|by design|cannot keep the samples/i)
    // What it must still do is keep the transcript reachable, because the words
    // survived even though the file did not.
    expect(String(out.audio_note)).toMatch(/transcript/i)
  })

  it('an audio URL that DID come back carries no excuse note', async () => {
    androidReply({ result: 'the words', transcriptId: 't-2', audioUrl: 'https://x/y.m4a' })
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({})
    expect(out.audio_url).toBe('https://x/y.m4a')
    expect(out.audio_note).toBeUndefined()
  })

  it('the tool DESCRIPTION warns the agent before it ever sees a null', () => {
    // A tool description is shipped behaviour (c62): one that promises "the
    // hosted audio URL" unconditionally is false for half the phones that can
    // answer this envelope.
    const text = src('lib/chat/tools/nicla-voice.ts')
    const desc = text.slice(text.indexOf("name: 'nicla_voice_record'"))
    expect(desc.slice(0, 2200)).toMatch(/audio_url is null on an Android phone/)
    expect(desc.slice(0, 2200)).toMatch(/NOT a failed recording/)
    // …and it must not still promise one unconditionally.
    expect(desc.slice(0, 2200)).not.toMatch(/and the hosted audio URL\./)
  })

  it("Android's reply shape really does omit the key (the claim's source)", () => {
    // The description asserts something about a Kotlin file; read it.
    const kt = src('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
    expect(kt).toMatch(/NO `audioUrl` key at all|No `audioUrl` key/)
    expect(kt).not.toMatch(/o\.put\("audioUrl"/)
  })
})

describe('the two boards stay separate', () => {
  it('each roster filters on its OWN platform string', () => {
    expect(src('lib/chat/tools/nicla.ts')).toContain("platform === 'nicla-vision'")
    expect(src('lib/chat/tools/nicla-voice.ts')).toContain("platform === 'nicla-voice'")
  })

  it('resolveVoice ignores a Vision necklace entirely', async () => {
    stubWorker([
      { id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true },
      voiceUnit(),
    ])
    const dev = await resolveVoice('u1')
    expect(dev?.id).toBe('v1')
  })

  it('reports no Voice when the account only owns a Vision', async () => {
    stubWorker([{ id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true }])
    expect(await resolveVoice('u1')).toBeNull()
    const out: any = await (makeNiclaVoiceStatusTool('u1') as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/No Nicla Voice/i)
  })

  it('prefers a relayed unit over an unrelayed one', async () => {
    stubWorker([voiceUnit({ id: 'cold', online: false }), voiceUnit({ id: 'warm', online: true })])
    expect((await resolveVoice('u1'))?.id).toBe('warm')
  })
})

describe('every agent roster mounts the voice necklace', () => {
  // Source-level for the same reason as the Vision suite: the bug is a missing
  // line in a list, and importing the routes drags in the edge runtime.
  it.each([
    ['app/api/chat/route.ts'],
    ['app/api/job-run/route.ts'],
    ['lib/voice/tools.ts'],
    ['app/api/voice/tool/route.ts'],
  ])('%s registers all five', (path) => {
    const text = src(path)
    for (const factory of [
      'makeNiclaVoiceStatusTool', 'makeNiclaVoiceWakesTool',
      'makeNiclaVoiceRecordTool', 'makeNiclaVoiceTranscriptsTool', 'makeNiclaVoiceTranscriptTool',
    ]) {
      expect(text, `${path} imports ${factory}`).toContain(factory)
      expect(text.match(new RegExp(`${factory}\\s*\\(`, 'g'))?.length ?? 0,
        `${path} calls ${factory}()`).toBeGreaterThan(0)
    }
  })

  it('the job agent is TOLD the voice necklace is a DIFFERENT board', () => {
    // Unmentioned is unused — but worse here: told only "a necklace", the model
    // reaches for nicla_take_photo and burns the job's whole deadline failing.
    const text = src('app/api/job-run/route.ts')
    const note = text.slice(text.indexOf('const capabilityNote'),
                            text.indexOf('const agent = new Agent'))
    expect(note).toContain('nicla_voice_status')
    expect(note).toContain('nicla_voice_wakes')
    expect(note).toMatch(/no camera/i)
    // …and that the recorder is the PHONE's mic, needing the app open — a job
    // runs unattended, so "not listening" must read as a reportable outcome.
    expect(note).toContain('nicla_voice_record')
    expect(note).toContain('nicla_voice_transcripts')
    expect(note).toMatch(/PHONE mic/)
  })

  it('the transcripts tool admits the VISION necklace also files rows', () => {
    // The store is shared, and NiclaRecorder.storeHeard() posts the Nicla
    // VISION's live /audio segments into it under label "necklace-live"
    // (postToServer(asVoiceNecklace: false), so they are signed by the phone
    // rather than the Voice board). The listing tool returns them today — it
    // has no label filter — but its description said transcripts come from
    // "wake-word follow-ups and nicla_voice_record", which is the one thing an
    // agent reads before deciding whether the tool can answer a question.
    //
    // So continuous speech the necklace heard was reachable and undiscoverable
    // at the same time: asked "what did you hear in the kitchen?", a model told
    // this store only holds wake-word clips has no reason to look. Unmentioned
    // is unused.
    const src_ = src('lib/chat/tools/nicla-voice.ts')
    const t = src_.slice(src_.indexOf("name: 'nicla_voice_transcripts'"))
    const desc = t.slice(0, t.indexOf('inputSchema'))
    expect(desc).toMatch(/necklace-live/)
    expect(desc).toMatch(/vision/i)
    // A missing audio_url must not be described as missing AUDIO. The phone now
    // keeps each live segment's recording locally and plays it on the row; it is
    // simply not uploaded, so this tool cannot hand back a URL. The description
    // used to explain the null as "that mic recorded no file on the phone" —
    // true when written, and now the kind of stale reason that makes an agent
    // tell someone their recording does not exist when it is on their phone.
    expect(desc).not.toMatch(/recorded no file/)
    expect(desc, 'a null audio_url must not read as "no recording exists"')
      .toMatch(/playable|listen/i)
  })

  it('the description warns that a cut preview is a FRAGMENT, by the worker\'s own field names', () => {
    // A ~200-char preview of a 1700-char memo is under 12% of what was said, and
    // an agent can answer from it and sound certain. The list rows carry the two
    // fields that make the loss visible (transcripts-sql pins their semantics
    // against real sqlite) — but a field nothing in the description mentions is a
    // field the model has no reason to read.
    //
    // Derived from the worker's list statement rather than quoted, so renaming a
    // column cannot leave this description silently describing the old shape.
    const desc = (() => {
      const s = src('lib/chat/tools/nicla-voice.ts')
      const t = s.slice(s.indexOf("name: 'nicla_voice_transcripts'"))
      return t.slice(0, t.indexOf('inputSchema'))
    })()
    if (!present) return   // the SQL half of this pin needs the worker checkout
    const sql = readFileSync(workerFile('transcripts.ts'), 'utf8')
    const list = sql.slice(sql.indexOf('TRANSCRIPT_LIST_SQL'))
    // Array.from, not a spread: this tsconfig targets es5 with no downlevelIteration.
    const aliases = Array.from(
      list.slice(0, list.indexOf('`;')).matchAll(/AS (\w+)/g), m => m[1])
    expect(aliases, 'no aliases found in TRANSCRIPT_LIST_SQL — re-anchor this pin')
      .toContain('truncated')
    for (const field of aliases) {
      expect(desc, `the list returns \`${field}\` and the description never mentions it`)
        .toContain(field)
    }
    // And it must say what the flag MEANS, not merely name it.
    expect(desc).toMatch(/FRAGMENT/)
    expect(desc, 'a truncated row must send the agent to the full text')
      .toMatch(/nicla_voice_transcript with its id/)
  })

  it('an unattended job is told the transcript store holds passive speech', () => {
    // nicla_voice_record needs the app OPEN, which the note already says — so a
    // job asked "summarize what was discussed this morning" reads its options as
    // "record now (nobody's there) or read clips someone triggered", and reports
    // it has no way. The necklace-live rows are the answer and require nothing
    // of the moment: they were transcribed while the user wore the thing.
    const text = src('app/api/job-run/route.ts')
    const note = text.slice(text.indexOf('const capabilityNote'),
                            text.indexOf('const agent = new Agent'))
    expect(note).toMatch(/necklace-live/)
  })
})

describe('nicla_voice_record targets the PHONE, not the board', () => {
  /**
   * A phone as the fleet really lists one. ⚠️ The `capabilities` are not
   * decoration: these fixtures used to omit them entirely, which no enrolled
   * phone does (Session.swift and FleetManager both send the list on enroll and
   * re-assert it on the first beat). A stub thinner than the real payload is how
   * a resolver change reads as three broken tests instead of one honest fixture.
   */
  const phoneRow = (over: any = {}) => ({
    id: 'p1', name: 'iPhone', platform: 'ios-arm64', kind: 'daemon', online: true,
    capabilities: JSON.stringify(['chat', 'location', 'record', 'speak', 'glasses']),
    ...over,
  })

  it('resolvePhone picks the recording phone and ignores both necklaces', async () => {
    stubWorker([
      voiceUnit(),
      { id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true, capabilities: JSON.stringify(['camera', 'wifi']) },
      phoneRow(),
    ])
    expect((await resolvePhone('u1'))?.id).toBe('p1')
  })

  it('no phone enrolled → says the PHONE records, not the necklace', async () => {
    stubWorker([voiceUnit()])
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/phone/i)
    expect(String(out.error)).not.toMatch(/offline/i) // nothing here is "offline"
  })

  it('phone enrolled but backgrounded → "not listening", an app problem, not a dead phone', async () => {
    stubWorker([voiceUnit(), phoneRow({ online: false })])
    const out: any = await (makeNiclaVoiceRecordTool('u1') as any).invoke({ seconds: 10 })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/not listening|closed or backgrounded/i)
    expect(String(out.error)).not.toMatch(/unpowered/i)
  })

  it('sends a {type:record} envelope with clamped seconds and returns the phone reply', async () => {
    vi.useFakeTimers()
    try {
      let sentBody: any = null
      global.fetch = (async (url: any, init?: any) => {
        const u = String(url)
        if (u.includes('/device/list')) {
          return new Response(JSON.stringify({ ok: true, devices: [voiceUnit(), phoneRow()] }))
        }
        if (u.includes('/device/relay/send')) {
          sentBody = JSON.parse(init.body)
          return new Response(JSON.stringify({ ok: true, id: 'env-1' }))
        }
        if (u.includes('/device/relay/recv')) {
          return new Response(JSON.stringify({ ok: true, reply: {
            payload: JSON.stringify({ result: 'heard: "buy milk"', transcriptId: 'tr-1', audioUrl: 'https://m/x.m4a' }),
          } }))
        }
        return new Response(JSON.stringify({}), { status: 404 })
      }) as any

      const p = (makeNiclaVoiceRecordTool('u1') as any).invoke({ seconds: 999, reason: 'note' })
      await vi.advanceTimersByTimeAsync(0)    // let list+send settle so the poll timer registers
      await vi.advanceTimersByTimeAsync(3000) // first recv poll
      const out: any = await p

      expect(sentBody.toDevice).toBe('p1') // the phone — never v1/n1
      const payload = JSON.parse(sentBody.payload)
      expect(payload.type).toBe('record')
      expect(payload.seconds).toBe(120)    // 999 clamped into 5..120
      expect(payload.reason).toBe('note')
      expect(out.ok).toBe(true)
      expect(out.result).toContain('buy milk')
      expect(out.transcript_id).toBe('tr-1')
      expect(out.audio_url).toBe('https://m/x.m4a')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('transcript tools read the worker store', () => {
  it('list passes the userId + limit through and hands rows back', async () => {
    let listedUrl = ''
    global.fetch = (async (url: any) => {
      listedUrl = String(url)
      return new Response(JSON.stringify({ ok: true, transcripts: [
        { id: 'tr-2', label: 'wake: alexa', preview: 'later words', audio_url: '', duration_s: 10, created: 2000 },
      ] }))
    }) as any
    const out: any = await (makeNiclaVoiceTranscriptsTool('u1') as any).invoke({ limit: 5 })
    expect(listedUrl).toContain('/transcript/list?userId=u1&limit=5')
    expect(out.ok).toBe(true)
    expect(out.transcripts[0].id).toBe('tr-2')
  })

  it('an empty store explains where transcripts come from instead of a bare []', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, transcripts: [] }))) as any
    const out: any = await (makeNiclaVoiceTranscriptsTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.transcripts).toEqual([])
    expect(String(out.note)).toMatch(/nicla_voice_record/)
  })

  it('get: a 404 names the fix (list), not just "not found"', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as any
    const out: any = await (makeNiclaVoiceTranscriptTool('u1') as any).invoke({ id: 'nope' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/nicla_voice_transcripts/)
  })
})

describe('wake events are read off the ring, not the board', () => {
  it('filters to wake events, newest first, honouring the limit', async () => {
    stubWorker([voiceUnit()], [
      // The worker returns the ring oldest-last with every subsystem mixed in.
      { id: 1, kind: 'scheduler', detail: 'a job fired', created: 't1' },
      { id: 2, kind: WAKE_KIND, detail: 'tiny voice: heard “alexa” (#1)', created: 't2' },
      { id: 3, kind: 'device_result', detail: 'a late reply', created: 't3' },
      { id: 4, kind: WAKE_KIND, detail: 'tiny voice: heard “alexa” (#2)', created: 't4' },
    ])
    const wakes = await recentWakes('u1', 10)
    expect(wakes.map(w => w.created)).toEqual(['t4', 't2'])

    const out: any = await (makeNiclaVoiceWakesTool('u1') as any).invoke({ limit: 1 })
    expect(out.ok).toBe(true)
    expect(out.wakes).toHaveLength(1)
    expect(out.wakes[0].detail).toContain('#2')
  })

  it('status surfaces the most recent wake and the loaded capabilities', async () => {
    stubWorker([voiceUnit()], [{ id: 9, kind: WAKE_KIND, detail: 'tiny voice: heard “alexa” (#7)', created: 't9' }])
    const out: any = await (makeNiclaVoiceStatusTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.relayed).toBe(true)
    expect(out.capabilities).toEqual(['mic', 'wake', 'imu', 'ble'])
    expect(out.last_heard).toContain('#7')
  })

  it('survives a malformed capabilities blob rather than failing the read', async () => {
    // A status read is the tool you call when something is already wrong; it must
    // not be the second thing that breaks.
    stubWorker([voiceUnit({ capabilities: 'not json at all' })])
    const out: any = await (makeNiclaVoiceStatusTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.capabilities).toEqual([])
  })
})

describe('an unrelayed necklace is not a silent user', () => {
  it('an empty log while relayed says "heard nothing"', async () => {
    stubWorker([voiceUnit({ online: true })], [])
    const out: any = await (makeNiclaVoiceWakesTool('u1') as any).invoke({})
    expect(out.wakes).toEqual([])
    expect(out.note).toMatch(/has not matched/i)
    expect(out.note).not.toMatch(/not evidence/i)
  })

  it('an empty log while UNrelayed says the log itself is uninformative', async () => {
    stubWorker([voiceUnit({ online: false })], [])
    const out: any = await (makeNiclaVoiceWakesTool('u1') as any).invoke({})
    expect(out.wakes).toEqual([])
    // The load-bearing sentence: without it the agent reports "you said nothing"
    // about a period when nothing COULD have been reported.
    expect(out.note).toMatch(/not evidence/i)
  })

  it('status explains an unrelayed necklace as range, not death', async () => {
    stubWorker([voiceUnit({ online: false })])
    const out: any = await (makeNiclaVoiceStatusTool('u1') as any).invoke({})
    expect(out.ok).toBe(true)
    expect(out.relayed).toBe(false)
    // "offline" for a WiFi node means unpowered; for this board it means the
    // phone walked away. Sending the user to look for a charger is the wrong fix.
    expect(out.note).toMatch(/Bluetooth range|app is closed/i)
    expect(out.note).not.toMatch(/unpowered/i)
  })
})
