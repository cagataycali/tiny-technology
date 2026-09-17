// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('voice-teardown-monotonic')

/**
 * 🧟 A COLD TEARDOWN KNOWS NOTHING, AND USED TO WRITE THAT DOWN.
 *
 * `VoiceSession.teardown` binds eight counters into `VOICE_END_SQL`. Every one
 * of them lives ONLY in Durable Object instance memory — `inSeq`, `outSeq`,
 * `eventCount`, `inTokens`, `outTokens`, `startedMs`, `events` — while
 * `state.storage` holds `cfg` alone. And `this.closed`, the idempotence guard,
 * is per-instance too, so it does not stop a second teardown on a new one.
 *
 * Two live paths reach a fresh instance:
 *   - `POST /voice/reap/:id` (voiceReap) wakes a possibly-cold DO on purpose —
 *     its own docstring calls it "safe on any session".
 *   - an eviction. `alarm()`'s comment already concedes this: "A DO eviction
 *     resets startedMs, which lands in the pre-connect arm — teardown, the
 *     right call there too." It reasoned about the sockets, not the counters.
 *
 * The old statement was `SET segment_count = ?5, …` unconditionally, so either
 * path overwrote a real 12-segment two-hour row with ZEROES (proven below
 * against the same sqlite D1 runs).
 *
 * That is not cosmetic. `segment_count` is the only value that can tell a hole
 * from the end of a call (tests/voice-recording-gaps.test.ts), so a zeroed
 * count silently reverts the stitch to break-at-first-miss. And all three
 * clients DROP a `segment_count = 0` row from the recordings list — web
 * `app/calls/page.tsx`, iOS `VoiceCall.swift`, Android `CallRecordingsSheet.kt`
 * — each calling it an outage casualty whose "stitch 404s, the row is dead",
 * while the PCM segments sit in R2 intact and stitchable.
 *
 * The same bug had a worse second half in R2: teardown `put` an events.jsonl
 * body of `this.events.join("\n")` — the empty string on a fresh instance.
 * A put OVERWRITES even though this worker has no delete, and events.jsonl
 * carries the mix markers, so blanking it makes the whole call 404 ("no replay
 * journaled") with every byte of audio still present.
 *
 * These run the REAL exported statement against node:sqlite (D1 is sqlite) so
 * the guard is proven, not asserted.
 */

let V: any
let voiceSrc = ''
let db: any

const COLS = 'status, ended_at, duration_ms, segment_count, event_count, input_tokens, output_tokens, error'

beforeAll(async () => {
  if (!present) return
  V = await import(workerFile('voice.ts') /* @vite-ignore */)
  voiceSrc = readFileSync(workerFile('voice.ts'), 'utf8')
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // Tracks migration 0018 exactly, including the DEFAULT 0s — the defaults are
  // half the bug (a defaulted 0 is indistinguishable from a measured 0).
  db.exec(`
    CREATE TABLE voice_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tiny_name TEXT NOT NULL,
      voice TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      started_at INTEGER NOT NULL,
      connected_at INTEGER,
      ended_at INTEGER,
      duration_ms INTEGER DEFAULT 0,
      segment_count INTEGER DEFAULT 0,
      event_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      error TEXT
    );
  `)
})

beforeEach(() => {
  if (!present) return
  db.exec('DELETE FROM voice_sessions')
})

// node:sqlite binds ?1-numbered params as NAMED params; D1's positional
// .bind(v) is identical (tests/devices-sql.test.ts pattern).
const insert = (id: string, status = 'live') =>
  db.prepare(V.VOICE_INSERT_SQL).run({ 1: id, 2: 'u1', 3: 'tiny', 4: 'marin', 5: 100 })
    && db.prepare('UPDATE voice_sessions SET status = ?2 WHERE id = ?1').run({ 1: id, 2: status })

const row = (id: string) => db.prepare(`SELECT ${COLS} FROM voice_sessions WHERE id = ?1`).get({ 1: id })

/** Exactly teardown's bind order: id, status, endedAt, durationMs, segCount,
 *  eventCount, inTokens, outTokens, error. */
const end = (id: string, o: any = {}) =>
  db.prepare(V.VOICE_END_SQL).run({
    1: id,
    2: o.status ?? 'ended',
    3: o.endedAt ?? 200,
    4: o.durationMs ?? 0,
    5: o.segCount ?? 0,
    6: o.eventCount ?? 0,
    7: o.inTokens ?? 0,
    8: o.outTokens ?? 0,
    9: o.error ?? null,
  })

/** A teardown on a fresh instance: every in-memory counter is its initial 0. */
const coldEnd = (id: string, status = 'ended', endedAt = 900) =>
  end(id, { status, endedAt, durationMs: 0, segCount: 0, eventCount: 0, inTokens: 0, outTokens: 0, error: null })

describe.skipIf(!present)('a cold teardown cannot erase a finished call', () => {
  it('the real numbers survive a second, knowledge-free teardown', () => {
    insert('c1')
    end('c1', { durationMs: 7_200_000, segCount: 12, eventCount: 40, inTokens: 500, outTokens: 900 })
    coldEnd('c1')
    const r: any = row('c1')
    expect(r.segment_count, 'a cold teardown zeroed segment_count — the stitch loses its only ' +
      'way to tell a hole from the end of the call, and all three clients drop the row').toBe(12)
    expect(r.duration_ms, 'a cold teardown zeroed duration_ms — the row drops below the >2000ms ' +
      'filter every client applies').toBe(7_200_000)
    expect(r.event_count).toBe(40)
    expect(r.input_tokens).toBe(500)
    expect(r.output_tokens).toBe(900)
  })

  it('the no-knowledge re-teardown is a genuine NO-OP, not a write of the same values', () => {
    // Not just "the numbers are unchanged": the row must not be touched at all.
    // A statement that writes every time is one `max()` typo away from the old
    // behaviour, and the WHERE clause is what makes the guard structural.
    insert('c1')
    end('c1', { durationMs: 7_200_000, segCount: 12, eventCount: 40 })
    const res: any = coldEnd('c1')
    expect(Number(res.changes), 'a cold re-teardown still writes the row — the guard is in the ' +
      'SET clause only, so it survives by arithmetic rather than by refusing').toBe(0)
  })

  it('ended_at keeps the FIRST stamp — that is when the call actually ended', () => {
    insert('c1')
    end('c1', { endedAt: 200, durationMs: 7_200_000, segCount: 12 })
    // A later teardown that DOES know more still must not re-date the call.
    end('c1', { endedAt: 99_999, durationMs: 7_300_000, segCount: 14 })
    const r: any = row('c1')
    expect(r.ended_at, 'a later teardown re-dated the call').toBe(200)
    expect(r.segment_count, 'a teardown that knew MORE was refused').toBe(14)
  })

  it('a later teardown that genuinely journaled more is allowed through', () => {
    // The guard must not be "first write wins" — that would lose a legitimately
    // larger count (a flush that landed after the first status update).
    insert('c1')
    end('c1', { durationMs: 1000, segCount: 4, eventCount: 3 })
    const res: any = end('c1', { durationMs: 5000, segCount: 9, eventCount: 11 })
    expect(Number(res.changes), 'a better teardown was refused').toBe(1)
    const r: any = row('c1')
    expect(r.segment_count).toBe(9)
    expect(r.duration_ms).toBe(5000)
    expect(r.event_count).toBe(11)
  })

  it('a partial-knowledge teardown raises only what it knows', () => {
    // Allowed in by a higher segment count, but its other counters are 0. Those
    // must not ride along as zeroes — this is why every column has its own max.
    insert('c1')
    end('c1', { durationMs: 7_200_000, segCount: 12, eventCount: 40, inTokens: 500 })
    end('c1', { durationMs: 0, segCount: 99, eventCount: 0, inTokens: 0 })
    const r: any = row('c1')
    expect(r.segment_count).toBe(99)
    expect(r.duration_ms, 'a partial teardown dragged duration_ms down with it').toBe(7_200_000)
    expect(r.event_count, 'a partial teardown dragged event_count down with it').toBe(40)
    expect(r.input_tokens).toBe(500)
  })
})

describe.skipIf(!present)('reap still does its job — the guard must not neuter it', () => {
  it("a zombie 'live' row is still finished by a knowledge-free reap", () => {
    // The whole point of POST /voice/reap/:id: a session stuck 'live' (seen
    // live — 91b08eb1 sat live for an hour after the app was force-killed) must
    // reach a terminal status even though the reaping instance knows nothing.
    insert('c2', 'live')
    const res: any = coldEnd('c2')
    expect(Number(res.changes), 'a reap of a stuck live row did nothing — the row stays live ' +
      'forever and the BYO-key cleanup story with it').toBe(1)
    expect((row('c2') as any).status).toBe('ended')
    expect((row('c2') as any).ended_at).toBe(900)
  })

  it("a 'created' row that never connected is still reapable", () => {
    // handleInit's TICKET_TTL alarm path: nothing ever journaled, and the row
    // must still leave 'created' so it stops looking pending.
    insert('c3', 'created')
    expect(Number((coldEnd('c3') as any).changes)).toBe(1)
    expect((row('c3') as any).status).toBe('ended')
  })

  it('the statement lets an error teardown through on status alone, no counters', () => {
    // The upstream-death path (`teardown("error")`) carries its meaning in
    // `status`, not in counters — a guard keyed only on segment_count would
    // silently drop it. That is what this pins, and it is reachable today.
    //
    // ⚠️ The `error` COLUMN, though, is dead: teardown's only VOICE_END_SQL
    // bind hardcodes `null` for ?9 (voice.ts — `this.outTokens, null`), so
    // nothing in this worker has ever written a reason. `?9` is bound here so
    // the statement's contract is pinned for whoever wires it up, NOT as a
    // claim that a reason reaches D1 — it does not. The upstream close/error
    // listeners hold the reason and only `console.log` it, while VOICE_GET_SQL
    // faithfully selects a column that is always NULL. Measured via a surviving
    // mutant: `error = ?9` and `error = COALESCE(?9, error)` are behaviourally
    // IDENTICAL in production precisely because ?9 is a constant null. Tracked
    // as its own increment; do not read this test's name as "reasons persist".
    insert('c4', 'ended')
    const res: any = end('c4', { status: 'error', error: 'upstream dropped', segCount: 0 })
    expect(Number(res.changes), 'an error teardown was refused, so the reason is lost').toBe(1)
    expect((row('c4') as any).error).toBe('upstream dropped')
    expect((row('c4') as any).status).toBe('error')
  })

  it('a recorded error reason is not blanked by a later silent teardown', () => {
    insert('c4', 'live')
    end('c4', { status: 'error', error: 'upstream dropped', segCount: 3 })
    coldEnd('c4')
    const r: any = row('c4')
    expect(r.error, 'a cold teardown erased the error reason').toBe('upstream dropped')
    expect(r.status, 'a cold teardown downgraded an error to a clean end').toBe('error')
    expect(r.segment_count).toBe(3)
  })
})

describe.skipIf(!present)('NULL columns are raised, never blanked (max(NULL, x) is NULL)', () => {
  it('a row with NULL counters ends up with the teardown values, not NULL', () => {
    // ⚠️ Migration 0018 DEFAULTs these to 0, but a DEFAULT only applies when the
    // column is omitted — a row written by anything else can hold NULL, and
    // sqlite's max(NULL, 5) is NULL. Without COALESCE the guard would blank the
    // row it exists to protect. Measured, not assumed.
    insert('c5')
    db.exec(`UPDATE voice_sessions SET duration_ms = NULL, segment_count = NULL,
             event_count = NULL, input_tokens = NULL, output_tokens = NULL WHERE id = 'c5'`)
    end('c5', { durationMs: 5000, segCount: 3, eventCount: 7, inTokens: 11, outTokens: 13 })
    const r: any = row('c5')
    expect(r.segment_count, 'max(NULL, x) blanked segment_count instead of raising it').toBe(3)
    expect(r.duration_ms).toBe(5000)
    expect(r.event_count).toBe(7)
    expect(r.input_tokens).toBe(11)
    expect(r.output_tokens).toBe(13)
  })

  it('a NULL-countered row is also not left NULL by a cold teardown', () => {
    insert('c6')
    db.exec(`UPDATE voice_sessions SET segment_count = NULL WHERE id = 'c6'`)
    coldEnd('c6')
    expect((row('c6') as any).segment_count, 'a cold teardown left segment_count NULL — every ' +
      "client's `(segment_count ?? 0) > 0` reads that as a dead row").toBe(0)
  })
})

describe.skipIf(!present)('the statement is structurally monotonic, not incidentally so', () => {
  it('every counter column is wrapped in max() — no bare assignment survives', () => {
    // A source pin as well as the behavioural ones above: a new column added
    // with a bare `= ?N` is exactly how this bug returns, and the behavioural
    // tests only cover the columns they know about.
    const at = voiceSrc.indexOf('export const VOICE_END_SQL')
    expect(at, 'VOICE_END_SQL moved — re-anchor this pin').toBeGreaterThan(-1)
    // End at the closing backtick of the template, NOT at the next blank line:
    // a wider slice runs into VoiceSession's own SQL and would be satisfied by
    // a SIBLING statement.
    const stmt = voiceSrc.slice(at, voiceSrc.indexOf('`;', at))
    expect(stmt.length, 'the VOICE_END_SQL slice read nothing').toBeGreaterThan(100)
    for (const col of ['duration_ms', 'segment_count', 'event_count', 'input_tokens', 'output_tokens']) {
      expect(
        stmt,
        `${col} is assigned without max() — a teardown on a FRESH DO instance has every ` +
          `in-memory counter at 0 and would write that over a real call's numbers`,
      ).toMatch(new RegExp(`${col}\\s*=\\s*max\\(`))
    }
    // And the WHERE clause is what makes a no-knowledge teardown a no-op.
    expect(stmt, 'the WHERE clause no longer refuses a re-teardown of a finished row')
      .toMatch(/WHERE[\s\S]*status NOT IN/)
  })

  it('the counters really are instance-memory only — the premise of all of this', () => {
    // If teardown ever persists them (state.storage.put("counters", …)), these
    // pins are still correct but the reasoning above changes, and the comment
    // explaining WHY becomes wrong. Measured so it cannot drift silently.
    const stored = Array.from(voiceSrc.matchAll(/state\.storage\.put\(\s*"([^"]+)"/g)).map((m) => m[1])
    expect(stored.length, 'no state.storage.put calls found — re-read this suite').toBeGreaterThan(0)
    expect(
      Array.from(new Set(stored)),
      'VoiceSession now persists something other than cfg. If the teardown counters are among ' +
        'them, VOICE_END_SQL\'s comment about a cold instance knowing nothing needs re-deriving.',
    ).toEqual(['cfg'])
  })
})

describe.skipIf(!present)('a recorded reason comes from an instance that KNOWS one', () => {
  /**
   * Found by a SURVIVING mutant, and it indicted this suite's own first draft.
   * `error = ?9` and `error = COALESCE(?9, error)` behaved identically no matter
   * what was thrown at them, because teardown's only bind passed a hardcoded
   * `null` for ?9. So: the column VOICE_GET_SQL had always selected was NULL for
   * every session ever recorded, the guard arm added to protect it could not
   * fire, and a test named "an error teardown can name its reason" was pinning a
   * capability production did not have.
   *
   * ⚠️ THE CLASS: a parameter that is a CONSTANT at every call site makes every
   * statement downstream of it unfalsifiable. Two of the three things wrong here
   * were invisible to review and to a passing test — only the survivor showed
   * it. When a mutant lives, ask what makes its two versions indistinguishable;
   * the answer is usually a caller, not the statement.
   */
  it('teardown takes a reason and binds it — ?9 is not a hardcoded null', () => {
    const at = voiceSrc.indexOf('private async teardown(')
    expect(at, 'teardown moved — re-anchor').toBeGreaterThan(-1)
    expect(
      voiceSrc.slice(at, voiceSrc.indexOf('\n', at)),
      'teardown takes no reason parameter, so voice_sessions.error can only ever be NULL — ' +
        'the column every client selects would be dead again',
    ).toMatch(/reason/)
    // And the bind must pass it. A parameter accepted but not bound is the same
    // dead column with more ceremony.
    const bindAt = voiceSrc.indexOf('VOICE_END_SQL).bind(')
    expect(bindAt, 'the VOICE_END_SQL bind moved — re-anchor').toBeGreaterThan(-1)
    const bind = voiceSrc.slice(bindAt, voiceSrc.indexOf(').run()', bindAt))
    expect(bind, 'the 9th bind argument is not `reason` — a hardcoded null here is what made ' +
      "the error column dead and the guard arm unfireable").toMatch(/outTokens,\s*reason/)
    expect(bind, 'the bind still passes a literal null for the reason').not.toMatch(/outTokens,\s*null/)
  })

  it('the two callers that cannot know a reason do not invent one', () => {
    // The whole cycle in one pin. A reap runs on a possibly-cold instance by
    // design, and the alarm's `!startedMs` arm cannot tell an unused ticket from
    // an EVICTION of a live call. Both must leave the column NULL — "no reason
    // recorded" is honest, a guessed reason is this cycle's own defect.
    const reap = voiceSrc.slice(voiceSrc.indexOf('private async handleReap'), voiceSrc.indexOf('private async handleConnect'))
    expect(reap.length, 'the handleReap slice read nothing').toBeGreaterThan(100)
    expect(reap, 'a reap now writes a reason it cannot possibly know').toMatch(/teardown\("ended"\)/)
    const alarm = voiceSrc.slice(voiceSrc.indexOf('async alarm()'))
    const preConnect = alarm.slice(0, alarm.indexOf('const idle'))
    expect(preConnect, 'the pre-connect alarm arm read nothing').toContain('startedMs')
    expect(
      preConnect,
      'the `!startedMs` arm now names a reason, but it cannot distinguish an expired ticket ' +
        'from an eviction — that is exactly the cold-instance guess this cycle removed',
    ).toMatch(/teardown\("ended"\)/)
  })

  it('the callers that DO know one pass it', () => {
    // Upstream death is the case that cost an hour of debugging during the
    // 2026-07-25 OpenAI incident, and its reason was going to console.log only.
    const at = voiceSrc.indexOf('u.addEventListener("close"')
    expect(at, 'the upstream listeners moved — re-anchor').toBeGreaterThan(-1)
    const listeners = voiceSrc.slice(at, at + 1400)
    for (const arm of ['ended', 'error']) {
      expect(
        listeners,
        `the upstream ${arm} arm still tells only the live socket and the log — the row is what ` +
          `the caller still has tomorrow when they ask why the call dropped`,
      ).toMatch(new RegExp(`teardown\\("${arm}",\\s*why\\)`))
    }
    // ⚠️ ONE LINE, not a character window. A `slice(idleAt, idleAt + 200)` here
    // survived deleting this very arm's reason: 200 chars runs on into the
    // MAX_SESSION_MS arm below, whose own reason satisfied the match. An
    // assertion window wider than its subject passes on a SIBLING's evidence —
    // caught by a surviving mutant, and the reason each arm is now pinned
    // separately by the line it lives on.
    const arms = voiceSrc.split('\n').filter((l) => /await this\.teardown\("ended"/.test(l))
    expect(arms.length, 'the alarm arms moved — re-anchor this pin').toBeGreaterThanOrEqual(3)
    const idleArm = arms.find((l) => l.includes('CLIENT_IDLE_MS'))
    expect(idleArm, 'the idle arm is gone').toBeTruthy()
    expect(idleArm!, 'the idle reaper records no reason, though it measured the silence itself')
      .toMatch(/teardown\("ended",\s*"/)
    const capArm = voiceSrc.split('\n').find((l) => l.includes('the call hit the maximum'))
    expect(capArm, 'the MAX_SESSION_MS arm no longer names its reason — a call cut at the hard ' +
      'cap looks identical to one that just ended').toBeTruthy()
  })

  it('every client-facing query carries the reason, not just the by-id one', () => {
    // A reason only VOICE_GET_SQL selects is a reason no list renders, and the
    // list is the surface all three clients actually draw.
    for (const name of ['VOICE_GET_SQL', 'VOICE_LIST_SQL']) {
      const at = voiceSrc.indexOf(`export const ${name}`)
      expect(at, `${name} moved — re-anchor`).toBeGreaterThan(-1)
      const stmt = voiceSrc.slice(at, voiceSrc.indexOf('`;', at))
      expect(stmt, `${name} omits the error column, so a recorded reason cannot reach a client`)
        .toMatch(/\berror\b/)
    }
  })

  it('a reason survives a later knowledge-free teardown', () => {
    // The behavioural half, now that ?9 can actually be non-null: this is the
    // path the surviving mutant proved was unreachable, and it is reachable now.
    insert('c7', 'live')
    end('c7', { status: 'error', error: 'upstream error: socket hang up', segCount: 3 })
    // A reap arrives later knowing nothing — allowed through by nothing, but if
    // some future arm lets it in, the reason must not be blanked.
    coldEnd('c7')
    expect((row('c7') as any).error, 'a cold teardown erased a reason a live instance recorded')
      .toBe('upstream error: socket hang up')
  })

  it('a later teardown that journaled more does not blank the reason', () => {
    // This is the path that actually let M8 live: the WHERE clause admits a
    // better-informed teardown, and inside it a bare `error = ?9` would wipe a
    // reason recorded by the instance that knew one.
    insert('c8', 'live')
    end('c8', { status: 'error', error: 'upstream error: socket hang up', segCount: 3 })
    const res: any = end('c8', { status: 'ended', segCount: 9 })
    expect(Number(res.changes), 'a better-informed teardown was refused').toBe(1)
    const r: any = row('c8')
    expect(r.segment_count, 'the larger count did not land').toBe(9)
    expect(r.error, 'a later teardown with no reason of its own blanked the recorded one — ' +
      'this is the exact path `error = ?9` survives on').toBe('upstream error: socket hang up')
  })
})

describe.skipIf(!present)('the events journal is never overwritten with nothing', () => {
  it('teardown only puts events.jsonl when this instance HAS events', () => {
    // The R2 half, and the worse one: a put OVERWRITES (no MEDIA.delete in this
    // worker), and events.jsonl carries the mix markers, so an empty body makes
    // voiceRecording 404 the whole call with every PCM segment still in place.
    const at = voiceSrc.indexOf('events.jsonl`, body')
    expect(at, 'the events.jsonl put moved — re-anchor this pin').toBeGreaterThan(-1)
    const before = voiceSrc.slice(Math.max(0, at - 500), at)
    expect(
      before,
      'the events.jsonl put is no longer guarded by this.events being non-empty — a cold ' +
        'teardown (reap / eviction) writes an EMPTY journal over the real one',
    ).toMatch(/this\.events\.length/)
  })

  it('the skipped write is logged, so a blanked-journal suspicion is checkable', () => {
    const at = voiceSrc.indexOf('events.jsonl`, body')
    const after = voiceSrc.slice(at, at + 700)
    expect(after, 'a teardown that declines to write the journal says nothing at all')
      .toMatch(/no journaled events/)
  })
})

describe.skipIf(!present)('the clients no longer state a conclusion the row cannot support', () => {
  const CLIENTS = [
    ['app/calls/page.tsx', 'segment_count || 0'],
    ['ios/Tiny/Sources/VoiceCall.swift', 'segment_count ?? 0'],
    ['android/app/src/main/java/technology/tiny/app/ui/CallRecordingsSheet.kt', 'segment_count'],
  ] as const

  it('all three still filter zero-count rows (the filter itself is correct)', () => {
    // The fix does not make a 0 row playable — it has no mix markers, so the
    // stitch really does 404. Removing the filter would trade a hidden row for
    // a broken player, so these pins keep it.
    for (const [path, needle] of CLIENTS) {
      const src = readFileSync(path, 'utf8')
      expect(src.length, `${path} read nothing`).toBeGreaterThan(500)
      expect(src, `${path} no longer filters on segment_count`).toContain(needle)
    }
  })

  it('none of them still calls a zero-count row proof the audio is gone', () => {
    // What changed is the REASON each gave. "no audio journaled — outage
    // casualties; the row is dead" is a claim about R2 that the row cannot
    // support: the count was a DO-memory artifact, and the segments outlive it.
    for (const [path] of CLIENTS) {
      const src = readFileSync(path, 'utf8')
      expect(
        src.match(/the row is dead/),
        `${path} still calls a zero-segment row dead — the count was overwritable by a cold ` +
          `teardown while the PCM segments sat in R2 intact, so a 0 means "nothing we can ` +
          `offer", not "no audio exists"`,
      ).toBeNull()
    }
  })

  it('each names the DO-memory cause, so the next reader does not re-derive it', () => {
    for (const [path] of CLIENTS) {
      // ⚠️ Comment prose WRAPS, and each of these three files wraps at a
      // different width — iOS breaks between "Durable Object's" and "memory".
      // Matching the raw phrase pins the line layout, not the explanation, so
      // strip the comment leaders and collapse whitespace first (measured: this
      // pin failed on a file that DID contain the phrase).
      const flat = readFileSync(path, 'utf8').replace(/^\s*(\/\/|\*)\s?/gm, ' ').replace(/\s+/g, ' ')
      expect(flat.length, `${path} read nothing`).toBeGreaterThan(500)
      expect(flat, `${path} does not say why a zero count is not proof of loss`)
        .toMatch(/Durable Object'?s? memory/)
    }
  })
})
