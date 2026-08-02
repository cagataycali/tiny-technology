// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  makeNiclaTakePhotoTool, makeNiclaTakeVideoTool,
  makeNiclaListenTool, makeNiclaStatusTool,
  clampWait, MIN_WAIT_S,
} from '../lib/chat/tools/nicla'

/**
 * nicla_* — the named tools for the tiny necklace.
 *
 * Two classes of bug live here, and both actually happened:
 *
 * 1. ROSTER DRIFT. There is no central tool registry — the chat route, the
 *    job-run route, and the voice builder each list tools inline. nicla_take_video
 *    was silently absent from job-run for its whole life, so "record a clip every
 *    morning" was unschedulable while photo and listen worked, with nothing
 *    failing to reveal it. These tests read the source of each roster.
 *
 * 2. A TOOL THAT OUTLIVES ITS CALLER. nicla_take_video polls 90s; a scheduled
 *    job is cancelled at 50s. Mounted unclamped, the job can ONLY report
 *    "job timeout" — while the necklace completes the capture and uploads a clip
 *    nobody ever reads. Worse than a slow tool: a tool that lies about failing.
 */
const NAMES = ['nicla_take_photo', 'nicla_take_video', 'nicla_listen', 'nicla_status']
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

describe('nicla tool identity', () => {
  it('the four factories produce exactly the four expected names', () => {
    const tools = [
      makeNiclaTakePhotoTool('u1'), makeNiclaTakeVideoTool('u1'),
      makeNiclaListenTool('u1'), makeNiclaStatusTool('u1'),
    ]
    expect(tools.map((t: any) => t.toolSpec.name)).toEqual(NAMES)
  })

  it('every tool refuses without a user — the necklace belongs to an account', async () => {
    // invoke(), the same entry point the voice bridge uses (app/api/voice/tool),
    // so this exercises zod validation + the callback exactly as production does.
    for (const make of [makeNiclaTakePhotoTool, makeNiclaTakeVideoTool,
                        makeNiclaListenTool, makeNiclaStatusTool]) {
      const t: any = make(null)
      const out = await t.invoke({})
      expect(out.ok, t.toolSpec.name).toBe(false)
      expect(String(out.error)).toMatch(/login/i)
    }
  })
})

describe('every agent roster mounts the whole necklace', () => {
  // Source-level, deliberately: the alternative is importing route modules that
  // pull in edge runtime + a model provider, and the bug being caught is a
  // missing LINE IN A LIST, which is exactly what the source shows.
  it.each([
    ['app/api/chat/route.ts'],
    ['app/api/job-run/route.ts'],
    ['lib/voice/tools.ts'],
    ['app/api/voice/tool/route.ts'],
  ])('%s registers all four', (path) => {
    const text = src(path)
    for (const factory of ['makeNiclaTakePhotoTool', 'makeNiclaTakeVideoTool',
                           'makeNiclaListenTool', 'makeNiclaStatusTool']) {
      // Imported AND actually called — an unused import mounts nothing.
      expect(text, `${path} imports ${factory}`).toContain(factory)
      expect(text.match(new RegExp(`${factory}\\s*\\(`, 'g'))?.length ?? 0,
        `${path} calls ${factory}()`).toBeGreaterThan(0)
    }
  })

  it('the job agent is TOLD it has a necklace, or it will never reach for one', () => {
    const text = src('app/api/job-run/route.ts')
    const note = text.slice(text.indexOf('const capabilityNote'),
                            text.indexOf('const agent = new Agent'))
    expect(note).toContain('nicla_')
  })
})

describe('nicla_status asks once', () => {
  it("splits the firmware's combined reply into battery and info", async () => {
    // The firmware answers 'status' with "battery: … | name=… ip=… mem_free=…".
    // Previously the tool fired 'battery' and 'info' as two concurrent
    // envelopes: double latency and two chances to miss the device's poll
    // window, on the tool whose whole job is a cheap reachability check.
    const combined = 'battery: 91% (4.199V, -1.4mA, idle/usb) | name=tiny necklace ip=192.168.1.207 mem_free=337488'
    const [battery, info] = combined.split(' | ')
    expect(battery).toContain('battery: 91%')
    expect(info).toContain('mem_free=337488')

    // And it must send exactly ONE envelope.
    const sends: string[] = []
    const realFetch = global.fetch
    global.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/device/list')) {
        return new Response(JSON.stringify({
          devices: [{ id: 'n1', name: 'tiny necklace', platform: 'nicla-vision', online: true }],
        }))
      }
      if (u.includes('/relay/send')) {
        sends.push(JSON.parse(init.body).payload)
        return new Response(JSON.stringify({ id: 'env1' }))
      }
      return new Response(JSON.stringify({ reply: { payload: JSON.stringify({ result: combined }) } }))
    }) as any
    try {
      const out: any = await (makeNiclaStatusTool('u1') as any).invoke({})
      expect(sends.length).toBe(1)
      expect(JSON.parse(sends[0]).prompt).toBe('status')
      expect(out.battery).toContain('91%')
      expect(out.info).toContain('mem_free=337488')
    } finally {
      global.fetch = realFetch
    }
  })
})

describe('poll budgets cannot outlive the caller', () => {
  it('with no budget, the tool keeps its own generous default', () => {
    expect(clampWait(90)).toBe(90)
    expect(clampWait(45, undefined)).toBe(45)
  })

  it('a budget shorter than the default wins, minus room to answer', () => {
    expect(clampWait(90, 50)).toBe(42)   // the job case: 90s tool, 50s job
    expect(clampWait(45, 50)).toBe(42)
  })

  it('a budget longer than the default does not stretch the tool', () => {
    expect(clampWait(45, 600)).toBe(45)
  })

  it('never clamps below a measured video round-trip (~15.7s on hardware)', () => {
    // A 5s cap would not prevent failure, it would guarantee it — the necklace
    // needs ~15.7s to capture, GIF-encode and stream-upload a clip.
    expect(clampWait(90, 6)).toBe(MIN_WAIT_S)
    expect(clampWait(90, 0)).toBe(90)    // 0 is "unset", not "no time at all"
    expect(MIN_WAIT_S).toBeGreaterThanOrEqual(15)
  })

  it('job-run derives the tool budget from the SAME constant it cancels on', () => {
    // Two hardcoded 50s — one in the race, one passed to the tools — is a
    // latent mismatch the next person to tune the deadline will introduce.
    const text = src('app/api/job-run/route.ts')
    expect(text).toMatch(/JOB_DEADLINE_S\s*=\s*\d+/)
    expect(text).toContain('JOB_DEADLINE_S * 1000')
    // All device tools that can block (nicla + flipper) must get the deadline
    const deviceTools = text.match(/make(Nicla|Flipper)\w+\(userId \|\| null, JOB_DEADLINE_S\)/g)?.length || 0
    expect(deviceTools).toBeGreaterThanOrEqual(7) // 4 nicla-vision + 1 nicla-voice + 2 flipper
    // The deadline must stay under the worker cron's 60s fetch abort.
    const secs = Number(/JOB_DEADLINE_S\s*=\s*(\d+)/.exec(text)![1])
    expect(secs).toBeLessThan(60)
  })
})
