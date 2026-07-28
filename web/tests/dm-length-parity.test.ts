// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { decideDmSend, dmLength, DM_MAX_CHARS } from '../lib/chat/dm-send'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('dm-length-parity')

/**
 * ✂️ THE DM CAP WAS MEASURED IN TWO DIFFERENT UNITS, SO A LEGAL MESSAGE GOT CUT
 *    IN HALF — MID-EMOJI — WHILE THE AGENT SAID "Delivered".
 *
 * `lib/chat/dm-send.ts` already refuses over-length sends (a DM can't be unsent),
 * and it counts CODE POINTS: an emoji is one character, as a person would count.
 * But the worker's `MessageSendCall` then did `String(body).trim().slice(0, 2000)`,
 * and `.slice` counts UTF-16 CODE UNITS. Every non-BMP character therefore
 * consumed two of the server's 2000 while consuming one of the client's.
 *
 * Measured before the fix: `'x' + '👋'×1999` is 2000 code points, which
 * `decideDmSend` correctly approves — and the worker kept 1001 of them, ending in
 * a LONE HIGH SURROGATE (0xd83d). That is mojibake in D1, in the Telegram push and
 * in the event ring, half a message in the recipient's inbox, `{ ok: true }` on
 * the wire, and "Delivered to …" spoken by the agent. Nobody can find out.
 *
 * Two independent defects, hence two halves of this file:
 *   1. UNIT PARITY — every end of the rail must count the same thing.
 *   2. SCOPE — `dm-send.ts`'s refusal only ever ran on the AGENT tool path. The
 *      web composer, both mobile apps, the notification inline-reply and the MCP
 *      tool all POST /api/messages, which truncated. So the rule now lives at the
 *      route AND in the worker, which is the only place all four callers meet.
 */

let decideBody: (raw: any) => { ok: true; body: string } | { ok: false; error: string }
let bodyLength: (t: string) => number
let clipToCodePoints: (t: string, max: number) => string
let MAX_BODY: number

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('messages.ts') /* @vite-ignore */)
  decideBody = mod.decideBody
  bodyLength = mod.bodyLength
  clipToCodePoints = mod.clipToCodePoints
  MAX_BODY = mod.MAX_BODY
})

/** The exact string that reproduced the bug: 2000 code points, 3999 UTF-16 units. */
const AT_CAP_IN_EMOJI = 'x' + '👋'.repeat(DM_MAX_CHARS - 1)

describe('the shape of the bug, pinned as arithmetic', () => {
  it('a message at the code-point cap can be nearly DOUBLE the cap in UTF-16 units', () => {
    expect(dmLength(AT_CAP_IN_EMOJI)).toBe(DM_MAX_CHARS)
    expect(AT_CAP_IN_EMOJI.length).toBe(3999)   // what `.slice(0, 2000)` was cutting against
  })

  it('so a unit-counting slice would drop half the message and split a surrogate pair', () => {
    // Not asserting on our code — asserting that the OLD expression really was
    // wrong, so this file documents a real defect rather than a style preference.
    const oldWay = AT_CAP_IN_EMOJI.trim().slice(0, DM_MAX_CHARS)
    expect(dmLength(oldWay)).toBe(1001)                       // 999 characters gone
    const lastUnit = oldWay.charCodeAt(oldWay.length - 1)
    expect(lastUnit).toBeGreaterThanOrEqual(0xd800)           // lone HIGH surrogate…
    expect(lastUnit).toBeLessThanOrEqual(0xdbff)              // …i.e. mojibake
  })
})

describe.skipIf(!present)('worker decideBody — refuses, never truncates', () => {
  it('the cap is the same number on both ends', () => {
    expect(MAX_BODY).toBe(DM_MAX_CHARS)
  })

  it('counts code points, not UTF-16 units', () => {
    expect(bodyLength('👋')).toBe(1)
    expect('👋'.length).toBe(2)  // the thing it must NOT be
    expect(bodyLength(AT_CAP_IN_EMOJI)).toBe(DM_MAX_CHARS)
  })

  it('🔴 accepts the emoji message the client approved, whole and unmodified', () => {
    const out = decideBody(AT_CAP_IN_EMOJI)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    // The headline assertion: identical, not "close enough".
    expect(out.body).toBe(AT_CAP_IN_EMOJI)
    expect(bodyLength(out.body)).toBe(DM_MAX_CHARS)
  })

  it('🔴 refuses one character over instead of silently dropping it', () => {
    const out = decideBody('a'.repeat(DM_MAX_CHARS + 1))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected a refusal')
    expect(out.error).toContain(String(DM_MAX_CHARS + 1))  // the real length
    expect(out.error).toContain('1 over')                  // the actionable overrun
    expect(out.error).toMatch(/nothing was sent/)          // no ambiguity about state
  })

  it('the two ends agree on every boundary, so neither can pass what the other cuts', () => {
    for (const n of [1, DM_MAX_CHARS - 1, DM_MAX_CHARS, DM_MAX_CHARS + 1, DM_MAX_CHARS * 2]) {
      for (const unit of ['a', '👋', 'é', '한']) {
        const s = unit.repeat(n)
        expect(decideBody(s).ok, `${unit}×${n}`).toBe(decideDmSend(s).ok)
      }
    }
  })

  it('still trims and still rejects blank/absent bodies', () => {
    expect(decideBody('  hi  ')).toEqual({ ok: true, body: 'hi' })
    expect(decideBody('   ').ok).toBe(false)
    expect(decideBody('').ok).toBe(false)
    expect(decideBody(null).ok).toBe(false)
    expect(decideBody(undefined).ok).toBe(false)
  })
})

describe.skipIf(!present)('worker previews — cutting is right here, mid-surrogate is not', () => {
  it('clips on a code-point boundary', () => {
    const cut = clipToCodePoints('👋'.repeat(500), 300)
    expect(bodyLength(cut)).toBe(300)
    // The property that matters: re-encoding is lossless, i.e. no half pair.
    expect(Array.from(cut).every((c) => c === '👋')).toBe(true)
    expect(cut).toBe('👋'.repeat(300))
  })

  it('returns the input untouched when it fits (no needless copy)', () => {
    const s = 'short'
    expect(clipToCodePoints(s, 300)).toBe(s)
  })

  it('🔴 the three fan-out previews no longer use unit-counting slices', () => {
    // Telegram 3500, push 300, event ring 200 — all three fed a truncated body
    // to something a human reads, so all three could show a lone surrogate.
    const src = readFileSync('worker/src/messages.ts', 'utf8')
    expect(src).not.toMatch(/text\.slice\(0,\s*\d+\)/)
    for (const n of [3500, 300, 200]) {
      expect(src, `preview ${n}`).toContain(`clipToCodePoints(text, ${n})`)
    }
  })
})

describe('the rule reaches the callers that never had it', () => {
  const route = readFileSync('app/api/messages/route.ts', 'utf8')

  it('🔴 /api/messages refuses instead of slicing', () => {
    // This is the route the web composer, iOS, Android, the notification
    // inline-reply and tiny-tech's MCP tool all use — four of the five never ran
    // dm-send's check, so this was the live truncation path in practice.
    expect(route).not.toContain('message.slice(0, 2000)')
    expect(route).toContain('decideDmSend(message)')
    expect(route).toContain('body: decided.body')
  })

  it('and the refusal LEAVES the handler — a computed verdict decides nothing', () => {
    // Measured on an earlier fix in this codebase: an ordering-only assertion
    // stayed green while `if (false)` let everything through. Require the exit.
    const gate = route.indexOf('decideDmSend(message)')
    const send = route.indexOf('fetch(`${WORKER}/message`')
    expect(gate).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(gate)
    const between = route.slice(gate, send)
    expect(between).toContain('!decided.ok')
    expect(between).toMatch(/return new Response/)
    expect(between).toContain('400')
  })

  it('the worker enforces it too, since the route is not the only door', () => {
    const src = readFileSync('worker/src/messages.ts', 'utf8')
    expect(src).not.toContain('.trim().slice(0, MAX_BODY)')
    const gate = src.indexOf('decideBody(body)')
    const insert = src.indexOf('INSERT INTO messages')
    expect(gate).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(gate)
    expect(src.slice(gate, insert)).toContain('!decided.ok')
  })
})

describe('all five surfaces state the same limit', () => {
  const num = (s: string, re: RegExp, label: string) => {
    const m = s.match(re)
    expect(m, label).toBeTruthy()
    return Number(m![1])
  }

  it('web composer, iOS, Android and the worker all say 2000', () => {
    // A client cap that disagrees with the server's is either a message the user
    // can type but not send, or a refusal they get no warning about.
    expect(num(readFileSync('components/chat/MessagesHUD.tsx', 'utf8'),
      /maxLength=\{(\d+)\}/, 'MessagesHUD maxLength')).toBe(DM_MAX_CHARS)
    expect(num(readFileSync('ios/Tiny/Sources/Messages.swift', 'utf8'),
      /let kDmMaxChars = (\d+)/, 'iOS kDmMaxChars')).toBe(DM_MAX_CHARS)
    expect(num(readFileSync('android/app/src/main/java/technology/tiny/app/ui/Messages.kt', 'utf8'),
      /const val DM_MAX_CHARS = (\d+)/, 'Android DM_MAX_CHARS')).toBe(DM_MAX_CHARS)
  })

  it('🔴 the mobile clients count code points, not their platform default', () => {
    // Swift's String.count is already grapheme clusters. Kotlin's String.length
    // is UTF-16 units — the exact mistake the server made — so Android must use
    // codePointCount or it reports a 2000-emoji draft as 4000 characters and
    // refuses a message the server would accept.
    const kt = readFileSync('android/app/src/main/java/technology/tiny/app/ui/Messages.kt', 'utf8')
    expect(kt).toContain('codePointCount(0, text.length)')
    expect(kt).not.toMatch(/text\.length\s*-\s*DM_MAX_CHARS/)
    // Strip comments first: the docstring that EXPLAINS why not to use
    // `.utf16.count` contains the string, so an unscoped search finds the
    // warning and reports it as the defect.
    const swift = readFileSync('ios/Tiny/Sources/Messages.swift', 'utf8')
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    expect(swift).toContain('text.count - kDmMaxChars')
    expect(swift).not.toContain('utf16.count')
  })

  it('🔴 both mobile composers refuse BEFORE the round-trip and keep the draft', () => {
    // The server's 400 arrives as "HTTP 400" on iOS and "send failed — try
    // again" on Android: one is unreadable and the other invites a retry that
    // can never succeed. Neither client had any cap at all.
    const swift = readFileSync('ios/Tiny/Sources/Messages.swift', 'utf8')
    const sGate = swift.indexOf('dmSendRefusal(text)')
    const sSend = swift.indexOf('await model.send(to: peer')
    expect(sGate).toBeGreaterThan(-1)
    expect(sSend).toBeGreaterThan(sGate)
    expect(swift.slice(sGate, sSend)).toContain('return')       // exits, doesn't fall through
    expect(swift.slice(sGate, sSend)).toContain('sendError')     // and says why
    // `draft = ""` must stay inside the success branch — an early return that
    // cleared the field would lose the very message it refused to send.
    expect(swift).toMatch(/if ok \{ draft = "" \}/)

    const kt = readFileSync('android/app/src/main/java/technology/tiny/app/ui/Messages.kt', 'utf8')
    const kGate = kt.indexOf('dmSendRefusal(body)')
    const kPost = kt.indexOf('app.api.postJson("/api/messages"')
    expect(kGate).toBeGreaterThan(-1)
    expect(kPost).toBeGreaterThan(kGate)
    expect(kt.slice(kGate, kPost)).toMatch(/sendError = it; return/)
  })
})
