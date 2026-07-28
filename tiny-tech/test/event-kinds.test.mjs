/**
 * ⚡ The menu bar's event vocabulary — the half of a two-repo contract that lives
 * here.
 *
 * The daemon polls `/api/events` and collapses the worker's kinds into a short
 * vocabulary; the Swift helper switches on that vocabulary to pick a glyph and an
 * SF Symbol. Nothing tested either half against the worker, and the two halves
 * agreed with EACH OTHER, which is what made the gap invisible:
 *
 *  🐛 `job_result` and `job_error` both normalized to `'job'`, and the helper
 *     draws `'job'` as ⏳ / `clock.badge.checkmark` — a CHECKMARK. A scheduled job
 *     that FAILED (the scheduler emits `job_error` with the exception text as the
 *     detail, and it is the single event a user has to act on) appeared in the
 *     menu bar as a job that completed. Not "unstyled" — INVERTED.
 *
 *  🐛 `share_view` was a phantom on both sides: the daemon produced it from
 *     `k.includes('share')` and the helper had a `case "share_view"`, so the
 *     round trip looked complete. The worker has never emitted a share event.
 *
 *  🐛 `pay_alarm` — "🚨 x402 reconciliation needs a human" — plus `device_result`,
 *     `tool-update` and all four money kinds fell through to `default: "•"`, the
 *     same bullet as anything unrecognised. The menu bar is the only tiny surface
 *     with NO scrollback: four lines, a glyph each, then it closes. A kind the
 *     tray doesn't understand isn't merely unstyled — it is the whole news.
 *
 * The fix is a roster (`WORKER_EVENT_KINDS`, `TRAY_EVENT_TYPES`) plus an exported
 * `normalizeEventKind` — it used to be a closure inside a command handler, which
 * is why it could not be tested against the other half at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const {
  WORKER_EVENT_KINDS, TRAY_EVENT_TYPES, normalizeEventKind, trayEventKindGaps,
} = await import('../dist/tray.js')

const swift = (rel) => readFileSync(join(process.cwd(), 'menubar/Sources/TinyMenuKit', rel), 'utf8')

test('every kind the worker emits reaches a type the tray has a case for', () => {
  // The whole point of the roster: an omission is a red test, not a bullet.
  assert.deepEqual(trayEventKindGaps(), [], 'these kinds fall through to "•"')
})

test('a FAILED job does not render as a finished one', () => {
  // The inversion. Same family, opposite meaning — so exact match before prefix.
  assert.equal(normalizeEventKind('job_result'), 'job')
  assert.equal(normalizeEventKind('job_error'), 'job_error')
  assert.notEqual(normalizeEventKind('job_error'), normalizeEventKind('job_result'))
})

test('an ABANDONED job is not a job that ran', () => {
  // `job` is a prefix family here too, so without an exact-match branch the one
  // event meaning "this never happened and never will" normalizes to `job` — the
  // type whose Swift glyph is ⏳ and whose SF Symbol is a CHECKMARK.
  assert.equal(normalizeEventKind('job_missed'), 'job_missed')
  assert.notEqual(normalizeEventKind('job_missed'), normalizeEventKind('job_result'))
  assert.notEqual(normalizeEventKind('job_missed'), normalizeEventKind('job_error'))
})

test('the alarm keeps its own type — good money news never inherits the siren', () => {
  assert.equal(normalizeEventKind('pay_alarm'), 'alarm')
  for (const k of ['pay_earned', 'pay_received', 'pay_withdrawn', 'pay_refunded']) {
    assert.equal(normalizeEventKind(k), 'money', k)
  }
  // And a future pay_* kind lands on money, not on the siren.
  assert.equal(normalizeEventKind('pay_something_new'), 'money')
})

test('families that SHOULD collapse still do', () => {
  for (const k of ['telegram', 'telegram_out', 'telegram_button']) {
    assert.equal(normalizeEventKind(k), 'telegram', k)
  }
  assert.equal(normalizeEventKind('tiny_visit'), 'visit')
  assert.equal(normalizeEventKind('dm'), 'message')
  assert.equal(normalizeEventKind('device_result'), 'device')
  assert.equal(normalizeEventKind('tool-update'), 'tool')
})

test('garbage in never throws — the ticker builds cards from whatever arrives', () => {
  for (const v of [undefined, null, '', 0, {}]) {
    assert.equal(typeof normalizeEventKind(v), 'string', String(v))
  }
})

test('share_view is gone from BOTH Swift switches — it was never emitted', () => {
  // A phantom case reads as coverage. Both halves had it; the worker has no
  // share event at all (grep `emitEvent(` across the worker src).
  for (const f of ['TrayProtocol.swift', 'MenuModel.swift']) {
    const body = swift(f).replace(/\/\/\/.*$/gm, '').replace(/\/\/.*$/gm, '')
    assert.ok(!body.includes('share_view'), `${f} still switches on share_view`)
  }
  assert.ok(!TRAY_EVENT_TYPES.includes('share_view'))
})

test('every tray type has a case in BOTH Swift switches, and they agree', () => {
  // The two halves are separate switches over the same vocabulary. Neither may
  // grow a case the other lacks — a glyph without a symbol (or vice versa) is a
  // menu row that is styled in one place and generic in the other.
  const cases = (file) => {
    const body = swift(file).replace(/\/\/\/.*$/gm, '')
    const start = body.indexOf(file === 'TrayProtocol.swift' ? 'public var glyph' : 'func eventSymbol')
    const chunk = body.slice(start, body.indexOf('\n  }\n', start) + 5)
    return new Set(Array.from(chunk.matchAll(/case ([^:]+):/g))
      .flatMap(m => m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''))))
  }
  const glyphCases = cases('TrayProtocol.swift')
  const symbolCases = cases('MenuModel.swift')
  assert.ok(glyphCases.size > 5, `parsed too few glyph cases: ${[...glyphCases]}`)
  for (const t of TRAY_EVENT_TYPES) {
    assert.ok(glyphCases.has(t), `TrayEventCard.glyph has no case for "${t}"`)
    assert.ok(symbolCases.has(t), `eventSymbol has no case for "${t}"`)
  }
  assert.deepEqual([...glyphCases].sort(), [...symbolCases].sort(),
    'the two switches disagree about the vocabulary')
})

test('the roster names every kind and nothing extra', () => {
  // Both directions (the rule c27 learned the hard way): every kind maps to a
  // known type, AND every declared type is actually reachable from some kind.
  const produced = new Set(WORKER_EVENT_KINDS.map(normalizeEventKind))
  for (const t of TRAY_EVENT_TYPES) {
    if (t === 'dm') continue // an alias the Swift switch accepts, never produced
    assert.ok(produced.has(t), `no worker kind normalizes to "${t}" — phantom type`)
  }
})

/**
 * The roster is only as good as its agreement with the worker — and a roster I
 * typed by hand from a grep is the SAME defect class as the map it replaces.
 * So this test re-derives the kinds from the worker's own source when it is
 * checked out beside this repo (it is, in the monorepo this package is developed
 * in; a standalone clone skips).
 *
 * What the scan can see: every `emitEvent(env, id, "literal"` call, the two
 * kinds that reach it through an exported constant, and the money kinds from
 * `MONEY_EVENT_KINDS`. What it CANNOT see, stated rather than pretended away:
 * `POST /events/emit` forwards any slug an internal caller supplies, and
 * `relay.ts` passes a variable. Both end at `normalizeEventKind`'s fall-through,
 * which is why that line returns the kind unchanged instead of guessing.
 */
test('the roster still agrees with the worker source', () => {
  const worker = join(process.cwd(), '..', 'chatgpt-plugin-tinyai', 'src')
  if (!existsSync(worker)) return // standalone clone — nothing to compare against

  const found = new Set()
  for (const f of readdirSync(worker).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(worker, f), 'utf8')
    for (const m of src.matchAll(/emitEvent\(\s*[^,]+,\s*[^,]+,\s*['"]([a-z_0-9-]+)['"]/g)) found.add(m[1])
    // `emitEvent(env, id, KIND_CONST, …)` — resolve the constant in the same file.
    for (const m of src.matchAll(/emitEvent\(\s*[^,]+,\s*[^,]+,\s*([A-Z][A-Z_0-9]+)\b/g)) {
      const decl = src.match(new RegExp(`${m[1]}\\s*=\\s*['"]([a-z_0-9-]+)['"]`))
      if (decl) found.add(decl[1])
    }
    // The ternary form: emitEvent(env, id, cond ? 'a' : 'b', …)
    for (const m of src.matchAll(/emitEvent\([^)]*?\?\s*['"]([a-z_0-9-]+)['"]\s*:\s*['"]([a-z_0-9-]+)['"]/gs)) {
      found.add(m[1]); found.add(m[2])
    }
    // The one indirection that exists: `relay.ts` builds `{kind: LATE_REPLY_KIND}`
    // and emits `late.kind`, so no literal is ever adjacent to the call. Scoped to
    // *_KIND CONSTANTS in files that emit — a bare `kind: 'x'` literal belongs to
    // whichever subsystem owns it (learnings.ts's `kind:` fields are REPUTATION
    // kinds), and treating those as event kinds is how a scan starts lying.
    if (src.includes('emitEvent(')) {
      for (const m of src.matchAll(/\bkind:\s*([A-Z][A-Z_0-9]*_KIND)\b/g)) {
        const decl = src.match(new RegExp(`${m[1]}\\s*=\\s*['"]([a-z_0-9-]+)['"]`))
        if (decl) found.add(decl[1])
      }
    }

    const money = src.match(/MONEY_EVENT_KINDS\s*=\s*\[([^\]]+)\]/)
    if (money) for (const m of money[1].matchAll(/['"]([a-z_0-9-]+)['"]/g)) found.add(m[1])
  }

  // The scan itself has to be load-bearing: if it silently matched nothing, the
  // whole test would pass while comparing against an empty set.
  assert.ok(found.size >= 10, `the scan found only ${found.size} kinds — it stopped working, not the worker`)
  const roster = new Set(WORKER_EVENT_KINDS)
  const missing = [...found].filter(k => !roster.has(k)).sort()
  assert.deepEqual(missing, [], 'the worker emits kinds WORKER_EVENT_KINDS does not name')
  // And the other direction: a roster entry the worker no longer emits is a
  // phantom, exactly what share_view was.
  const stale = WORKER_EVENT_KINDS.filter(k => !found.has(k)).sort()
  assert.deepEqual(stale, [], 'WORKER_EVENT_KINDS names kinds the worker never emits')
})
