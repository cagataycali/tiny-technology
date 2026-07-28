// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { iconFor } from '../lib/chat/event-icons'

/**
 * 💻 LATE DEVICE COMPLETIONS → the event ring (loop item d-b).
 *
 * Cycle d-a made a slow device a claim ticket instead of an error: use_device
 * waits ~45s, then hands back { pending:true, envelope_id }. The half left open:
 * when the device finally replies, NOTHING knows. The reply sits in the mailbox
 * for its ~1h sweep window and is seen only if someone thinks to ask the agent
 * to redeem the ticket in that same conversation — close the tab, switch to the
 * phone, or just forget, and completed work is thrown away silently.
 *
 * Now a late reply emits a `device_result` event, because the event ring is the
 * one surface every client polls (ActivityHUD / Activity.swift / Activity.kt)
 * AND that the next turn's system prompt carries — so the result surfaces in any
 * client, with the exact redeem move in the detail text.
 *
 * Pinned here: only LATE replies event (an in-window reply is already the tool
 * result — eventing it too double-reports every device call), only `invoke`
 * envelopes (notify banners have no waiter), the detail is bounded and carries
 * the redeem instruction, and the envelope query still selects what the age
 * check needs while keeping its owner-scope guard.
 */
warnIfWorkerAbsent('relay-late-reply')

let buildLateReplyEvent: (p: { envelopeId: string; requestPayload: unknown; ageSeconds: number }) => { kind: string; detail: string } | null
let LATE_REPLY_S: number
let LATE_REPLY_KIND: string
let RELAY_ENVELOPE_SQL: string
let RELAY_INSERT_SQL: string
let db: any

const invokeEnvelope = (prompt: string) => JSON.stringify({ type: 'invoke', prompt })

beforeAll(async () => {
  if (!present) return
  const relay = await import(workerFile('relay.ts') /* @vite-ignore */)
  buildLateReplyEvent = relay.buildLateReplyEvent
  LATE_REPLY_S = relay.LATE_REPLY_S
  LATE_REPLY_KIND = relay.LATE_REPLY_KIND
  RELAY_ENVELOPE_SQL = relay.RELAY_ENVELOPE_SQL
  RELAY_INSERT_SQL = relay.RELAY_INSERT_SQL
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE relay_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_device TEXT NOT NULL,
      in_reply_to TEXT, payload TEXT NOT NULL, created_at INTEGER,
      delivered INTEGER DEFAULT 0
    );
  `)
})

describe.skipIf(!present)('buildLateReplyEvent — only late replies announce', () => {
  it('a reply past the 45s wait becomes a device_result event', () => {
    const ev = buildLateReplyEvent({
      envelopeId: 'env_slow',
      requestPayload: invokeEnvelope('run the full build and report failures'),
      ageSeconds: 300,
    })
    expect(ev?.kind).toBe('device_result')
    expect(ev!.detail).toContain('300s')
    expect(ev!.detail).toContain('run the full build')
    // The detail is what the agent reads next turn — it must carry the redeem
    // move verbatim, or the event announces work nobody can fetch.
    expect(ev!.detail).toContain("use_device action:'result'")
    expect(ev!.detail).toContain("envelope_id:'env_slow'")
  })

  it('an IN-WINDOW reply stays silent — the tool already returned it', () => {
    // The waiter got this one inline; an event too would double-report every
    // single device call in the activity feed.
    for (const age of [0, 1, 30, 44, LATE_REPLY_S]) {
      expect(buildLateReplyEvent({ envelopeId: 'e', requestPayload: invokeEnvelope('hi'), ageSeconds: age })).toBeNull()
    }
    // One second past the budget is the first late reply.
    expect(buildLateReplyEvent({ envelopeId: 'e', requestPayload: invokeEnvelope('hi'), ageSeconds: LATE_REPLY_S + 1 })).not.toBeNull()
  })

  it('the threshold IS use_device 15×3s wait budget (drift here re-opens the gap)', () => {
    expect(LATE_REPLY_S).toBe(45)
    expect(LATE_REPLY_KIND).toBe('device_result')
  })

  it('non-invoke envelopes never event — notify banners have no waiter', () => {
    const notify = JSON.stringify({ type: 'notify', title: '💬 Ada', body: 'hey' })
    expect(buildLateReplyEvent({ envelopeId: 'e', requestPayload: notify, ageSeconds: 9000 })).toBeNull()
  })

  it('an unparseable or promptless original still announces, generically', () => {
    // The reply EXISTS and is fetchable; losing the announcement because the
    // request text is unreadable would be the same silent-discard bug.
    const junk = buildLateReplyEvent({ envelopeId: 'env_x', requestPayload: '{not json', ageSeconds: 120 })
    expect(junk?.kind).toBe('device_result')
    expect(junk!.detail).toContain("envelope_id:'env_x'")
    expect(junk!.detail).not.toContain('""')  // no empty quoted ask
    const noPrompt = buildLateReplyEvent({ envelopeId: 'env_y', requestPayload: JSON.stringify({ type: 'invoke' }), ageSeconds: 120 })
    expect(noPrompt?.kind).toBe('device_result')
  })

  it('a non-finite or negative age is NOT provably late → silent', () => {
    // Clock skew / missing created_at must not manufacture events. The route
    // passes NaN rather than 0 for a null created_at precisely for this.
    for (const age of [NaN, Infinity, -5]) {
      expect(buildLateReplyEvent({ envelopeId: 'e', requestPayload: invokeEnvelope('x'), ageSeconds: age })).toBeNull()
    }
  })

  it('the detail fits the ring column: prompt clamped, whitespace collapsed', () => {
    const ev = buildLateReplyEvent({
      envelopeId: 'env_long',
      requestPayload: invokeEnvelope('a'.repeat(500) + '\n\nand   more'),
      ageSeconds: 99,
    })!
    // emitEvent slices detail at 300 chars — the built one must already fit, or
    // the redeem instruction (at the END) gets cut off and the event is useless.
    expect(ev.detail.length).toBeLessThanOrEqual(300)
    expect(ev.detail).toContain("envelope_id:'env_long'")
    const multiline = buildLateReplyEvent({
      envelopeId: 'e', requestPayload: invokeEnvelope('line one\nline two\ttabbed'), ageSeconds: 99,
    })!
    expect(multiline.detail).toContain('line one line two tabbed')
    expect(multiline.detail).not.toContain('\n')
  })

  it('takes an already-parsed object too (payload arrives as TEXT from D1)', () => {
    const ev = buildLateReplyEvent({ envelopeId: 'e', requestPayload: { type: 'invoke', prompt: 'ls -la' }, ageSeconds: 60 })
    expect(ev!.detail).toContain('ls -la')
  })
})

describe.skipIf(!present)('RELAY_ENVELOPE_SQL — the age check needs more than user_id', () => {
  it('returns the original request and its timestamp, still keyed by envelope id', () => {
    const created = 1_700_000_000
    db.prepare(RELAY_INSERT_SQL).run({ 1: 'e1', 2: 'u1', 3: 'dev_1', 4: null, 5: invokeEnvelope('disk usage?'), 6: created })
    const row = db.prepare(RELAY_ENVELOPE_SQL).get({ 1: 'e1' })
    // The owner guard (a device can't reply into another user's flow) is the
    // whole reason this row is fetched — it must survive the widening.
    expect(row.user_id).toBe('u1')
    expect(JSON.parse(row.payload).prompt).toBe('disk usage?')
    expect(row.created_at).toBe(created)
    // …and an unknown envelope is still nothing at all.
    expect(db.prepare(RELAY_ENVELOPE_SQL).get({ 1: 'nope' })).toBeUndefined()
  })

  it('end to end: a 5-minute-old envelope yields an event, a 3-second-old one does not', () => {
    const now = 1_700_001_000
    db.prepare(RELAY_INSERT_SQL).run({ 1: 'slow', 2: 'u1', 3: 'dev_1', 4: null, 5: invokeEnvelope('big build'), 6: now - 300 })
    db.prepare(RELAY_INSERT_SQL).run({ 1: 'fast', 2: 'u1', 3: 'dev_1', 4: null, 5: invokeEnvelope('echo hi'), 6: now - 3 })
    const evFor = (id: string) => {
      const r = db.prepare(RELAY_ENVELOPE_SQL).get({ 1: id })
      return buildLateReplyEvent({
        envelopeId: id, requestPayload: r.payload,
        ageSeconds: r.created_at == null ? NaN : now - Number(r.created_at),
      })
    }
    expect(evFor('slow')?.detail).toContain('big build')
    expect(evFor('fast')).toBeNull()
  })
})

describe('device_result renders in the activity feed', () => {
  it('iconFor("device_result") → 💻, not the ⚡ fallback', () => {
    // A kind with no glyph is the same class of bug tiny_visit had: the event
    // lands but reads as generic noise. Mirrored in ios Activity.swift
    // EventGlyph.icons and android ui/Activity.kt KIND_ICONS.
    expect(iconFor('device_result')).toBe('💻')
  })
})
