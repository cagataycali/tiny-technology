// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    // The recorder resolves the phone, never the board:
    expect(text).toContain("platform === 'ios-arm64'")
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
  it('resolvePhone picks the ios-arm64 device and ignores both necklaces', async () => {
    stubWorker([
      voiceUnit(),
      { id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true },
      { id: 'p1', name: 'iPhone', platform: 'ios-arm64', kind: 'daemon', online: true },
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
    stubWorker([voiceUnit(), { id: 'p1', name: 'iPhone', platform: 'ios-arm64', online: false }])
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
          return new Response(JSON.stringify({ ok: true, devices: [
            voiceUnit(), { id: 'p1', name: 'iPhone', platform: 'ios-arm64', online: true },
          ] }))
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
