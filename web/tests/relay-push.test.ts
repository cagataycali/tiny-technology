// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('relay-push')

/**
 * 🔔 Late device completions → PUSH (use_device async P1 —
 * docs/use-device-async-design-2026-08-02.md).
 *
 * relay-late-reply.test.ts pins the ring-event half; this pins the other half:
 * the same late reply builds a push payload for sendPushToUser (web push + a
 * {type:'notify'} envelope every fresh phone banners), and BOTH rails share
 * one lateness gate — what events, pushes; what stays silent, stays silent on
 * both. Drift between them re-opens either the silent-discard bug (push
 * missing) or double-reporting (push on in-window replies the tool already
 * returned inline).
 */
let relay: any
let db: any

const invoke = (prompt?: string) => JSON.stringify({ type: 'invoke', ...(prompt ? { prompt } : {}) })

beforeAll(async () => {
  if (!present) return
  relay = await import(workerFile('relay.ts') /* @vite-ignore */)
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0
    );
    CREATE TABLE relay_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_device TEXT NOT NULL,
      in_reply_to TEXT, payload TEXT NOT NULL, created_at INTEGER,
      delivered INTEGER DEFAULT 0
    );
  `)
})

describe.skipIf(!present)('buildDeviceResultPush — the push half of a late reply', () => {
  it('a late invoke reply pushes: device name in the title, the ask in the body, the claim ticket in url+tag', () => {
    const p = relay.buildDeviceResultPush({
      envelopeId: 'env_1', deviceName: 'studio-mac',
      requestPayload: invoke('run the full test suite'), ageSeconds: 300,
    })
    expect(p.title).toBe('💻 studio-mac finished')
    expect(p.body).toContain('run the full test suite')
    // P3: the url is a ?q= deep link — the web app AUTO-SENDS it as a visible
    // turn (lib/chat/deep-link.ts: plain ?q= sends unless locked/share), so a
    // tap lands on the fetched result. The turn must teach the redeem move.
    expect(p.url.startsWith('/?q=')).toBe(true)
    const turn = decodeURIComponent(p.url.slice('/?q='.length))
    expect(turn).toContain("use_device action:'result'")
    expect(turn).toContain("envelope_id:'env_1'")
    expect(p.tag).toBe('device-result-env_1')       // same-task banners collapse
  })

  it('shares the event gate EXACTLY — one gate, two rails, no drift', () => {
    const cases = [
      { requestPayload: invoke('x'), ageSeconds: 10 },                                        // in-window
      { requestPayload: invoke('x'), ageSeconds: relay.LATE_REPLY_S },                        // boundary: not late
      { requestPayload: invoke('x'), ageSeconds: relay.LATE_REPLY_S + 1 },                    // first late second
      { requestPayload: invoke('x'), ageSeconds: NaN },                                       // missing created_at
      { requestPayload: invoke('x'), ageSeconds: -5 },                                        // clock skew
      { requestPayload: JSON.stringify({ type: 'notify', title: 'hi' }), ageSeconds: 9000 },  // banner, no waiter
      { requestPayload: '{not json', ageSeconds: 120 },                                       // unreadable original
      { requestPayload: JSON.stringify({ type: 'invoke' }), ageSeconds: 120 },                // promptless
    ]
    for (const c of cases) {
      const ev = relay.buildLateReplyEvent({ envelopeId: 'e', ...c })
      const push = relay.buildDeviceResultPush({ envelopeId: 'e', deviceName: 'd', ...c })
      expect(push === null, `gate drift for age=${c.ageSeconds}`).toBe(ev === null)
    }
  })

  it('missing/blank device name degrades gracefully; long names clamp for the 100-char title', () => {
    const anon = relay.buildDeviceResultPush({ envelopeId: 'e', requestPayload: invoke('x'), ageSeconds: 60 })
    expect(anon.title).toBe('💻 your device finished')
    const long = relay.buildDeviceResultPush({
      envelopeId: 'e', deviceName: 'N'.repeat(200), requestPayload: invoke('x'), ageSeconds: 60,
    })
    expect(long.title.length).toBeLessThanOrEqual(100) // sendPushToUser slices titles at 100; ours already fits
  })

  it('a promptless invoke still pushes, generically — losing the announcement is the original bug', () => {
    const p = relay.buildDeviceResultPush({ envelopeId: 'e2', deviceName: 'mac', requestPayload: invoke(), ageSeconds: 60 })
    expect(p.body).toContain('background task finished')
    expect(p.url).toContain('e2')
  })

  it('the body carries the ASK (clamped), never a result — and already fits the 400-char push clamp', () => {
    // Privacy pin: the builder takes NO reply/result input at all — the lock
    // screen can only ever show words the user themselves typed. If a result
    // preview is ever wanted, it is an explicit opt-in, not a drive-by edit here.
    const p = relay.buildDeviceResultPush({
      envelopeId: 'e', deviceName: 'mac',
      requestPayload: invoke('a'.repeat(1000)), ageSeconds: 60,
    })
    expect(p.body.length).toBeLessThanOrEqual(400)
    expect(p.body).toContain('a'.repeat(140))
    expect(p.body).not.toContain('a'.repeat(141))
  })

  it('the envelope id URL-encodes safely into the redeem link', () => {
    const p = relay.buildDeviceResultPush({ envelopeId: 'a&b=c', deviceName: 'm', requestPayload: invoke('x'), ageSeconds: 60 })
    // the & in the id must survive the q param round-trip intact
    const q = new URL('https://x' + p.url).searchParams.get('q')
    expect(q).toContain("envelope_id:'a&b=c'")
  })
})

describe.skipIf(!present)('the name lookup + the G5 regression (real sqlite)', () => {
  it('RELAY_DEVICE_NAME_SQL resolves the push title by device id', () => {
    db.prepare(`INSERT INTO devices (id, user_id, name, token_hash) VALUES ('d1','u1','studio-mac','h')`).run()
    expect(db.prepare(relay.RELAY_DEVICE_NAME_SQL).get({ 1: 'd1' })?.name).toBe('studio-mac')
    expect(db.prepare(relay.RELAY_DEVICE_NAME_SQL).get({ 1: 'nope' })).toBeUndefined()
  })

  it('G5: a 2h task can now deliver — its DELIVERED envelope survives the sweep, and the reply announces', () => {
    const now = 1_700_000_000
    db.prepare(relay.RELAY_INSERT_SQL).run({ 1: 'slow2h', 2: 'u1', 3: 'd1', 4: null, 5: invoke('the two hour build'), 6: now - 7200 })
    db.prepare(relay.RELAY_MARK_SQL).run({ 1: 'slow2h' })
    // a send-triggered sweep runs at some point during those two hours…
    db.prepare(relay.RELAY_SWEEP_SQL).run({ 1: now - relay.SWEEP_AGE_S, 2: now - relay.SWEEP_SETTLED_AGE_S })
    // …and the original must still be there: before the two-tier sweep this row
    // was deleted at 1h, the daemon's reply PATCH 404'd (and was swallowed),
    // and a finished multi-hour task vanished without a trace.
    const orig = db.prepare(relay.RELAY_ENVELOPE_SQL).get({ 1: 'slow2h' })
    expect(orig).toBeDefined()
    const push = relay.buildDeviceResultPush({
      envelopeId: 'slow2h', deviceName: 'studio-mac',
      requestPayload: orig.payload, ageSeconds: now - Number(orig.created_at),
    })
    expect(push?.title).toBe('💻 studio-mac finished')
    expect(push?.body).toContain('the two hour build')
  })
})

describe.skipIf(!present)('wiring pins (source-order, job-abandoned.test.ts pattern)', () => {
  it('RelayReplyCall delivers the reply row first, events second, pushes third', () => {
    const src = readFileSync(workerFile('relay.ts'), 'utf8')
    const handler = src.slice(src.indexOf('class RelayReplyCall'))
    const insert = handler.indexOf('RELAY_INSERT_SQL')
    const event = handler.indexOf('emitEvent(env, owner')
    const push = handler.indexOf('sendPushToUser(env, owner')
    // the reply row is the payload the user redeems — announcements must never
    // be able to fail the device's PATCH before the row is committed
    expect(insert).toBeGreaterThan(-1)
    expect(event).toBeGreaterThan(insert)
    expect(push).toBeGreaterThan(event)
  })

  it('the import cycle stays broken: push.ts reads RELAY_INSERT_SQL from the leaf, never from relay.ts', () => {
    const push = readFileSync(workerFile('push.ts'), 'utf8')
    expect(push).toContain('from "./relay-shared"')
    expect(push).not.toContain('from "./relay";')
    // and relay.ts (which imports push.ts) defines no second copy of the INSERT
    const rel = readFileSync(workerFile('relay.ts'), 'utf8')
    expect(rel).toContain('from "./push"')
    expect(rel.match(/INSERT INTO relay_messages/g) ?? []).toHaveLength(0)
  })
})
