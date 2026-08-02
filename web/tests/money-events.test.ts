// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIND_ICONS, EMITTED_KINDS, iconFor } from '../lib/chat/event-icons'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('money-events')

/**
 * 💵 THE RAIL THAT TOLD THE USER WHEN MONEY MOVED.
 *
 * The finding: `payments.ts` (2,099 lines), `deposits.ts` (1,116) and
 * `withdrawals.ts` (206) — every path in the codebase that moves real value —
 * contained ZERO calls to `emitEvent`, `sendPushToUser`, or any other
 * notification. Meanwhile `visit.ts` gives a PAGE VIEW a ring event, a throttled
 * web push AND a social-graph edge.
 *
 * So: someone glancing at your tiny pinged your phone. Someone paying you real,
 * withdrawable USDC was silent. A withdrawal that FAILED — where the balance was
 * already debited and then refunded — was silent too, which is the worst of the
 * four: the user saw money leave and never heard it come back.
 *
 * Four moments now speak (money-events.ts). What this suite pins is not that the
 * pushes are sent — it's the four ways this feature could be WORSE than silence:
 *
 *   1. rounding real money to "$0.00" (prices start at $0.001)
 *   2. calling unwithdrawable credit "real USDC, withdrawable"
 *   3. naming a counterparty we never verified (a raw uuid in a push)
 *   4. a notification failure rolling back money that already moved
 *
 * …plus the c27 roster: a new kind with no glyph renders ⚡ (indistinguishable
 * from a corrupt event) on three HUDs and ℹ in the agent's prompt. Four new kinds
 * shipping unmapped would have re-created the exact defect c27 just fixed.
 */

const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (house rule since c37). */
const code = (rel: string) => source(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const workerSource = (name: string) => readFileSync(join(WORKER_SRC, name), 'utf8')

let me: any
beforeAll(async () => {
  if (!present) return
  me = await import(workerFile('money-events.ts') /* @vite-ignore */)
})

const BASE = 'base' as const              // real money
const SEPOLIA = 'base-sepolia' as const   // trial
const TINY = 'tiny' as const              // trial (the chain we mint)

describe.runIf(present)('formatMicro — never round real money to nothing', () => {
  it('renders the $0.001 floor as a visible amount, not $0.00', () => {
    // set_price's floor AND the flat platform fee. toFixed(2) would print
    // "$0.00" — a notification that says you were paid nothing.
    expect(me.formatMicro(1000)).toBe('$0.001')
    expect(me.formatMicro(1000)).not.toContain('0.00 ')
    expect(me.formatMicro(1000)).not.toBe('$0.00')
  })

  it('keeps sub-dollar amounts to 4 decimals, trimming dead zeros', () => {
    expect(me.formatMicro(10_000)).toBe('$0.01')
    expect(me.formatMicro(12_500)).toBe('$0.0125')
    expect(me.formatMicro(500_000)).toBe('$0.5')
  })

  it('drops to 2 decimals above a dollar (nobody wants $12.5000)', () => {
    expect(me.formatMicro(1_000_000)).toBe('$1.00')
    expect(me.formatMicro(12_500_000)).toBe('$12.50')
    expect(me.formatMicro(499_900_000)).toBe('$499.90')
  })

  it('is sign-blind — direction rides on `kind`, so no "$-0.02"', () => {
    expect(me.formatMicro(-25_000)).toBe(me.formatMicro(25_000))
    expect(me.formatMicro(-25_000)).not.toContain('-')
  })

  it('degrades garbage to $0 rather than $NaN', () => {
    for (const v of [0, NaN, undefined, null, 'x']) {
      expect(me.formatMicro(v as any)).toBe('$0')
    }
  })

  it('no amount in the whole ledger range renders as a zero-looking string', () => {
    // Every micro value a real event can carry: the floor, the fee, the caps —
    // and ONE micro, which is reachable (price $0.001001 credits the owner 1µ
    // after the flat fee) and which toFixed(4) rounds away to "$0".
    for (const micro of [1, 9, 99, 999, 1000, 1001, 9999, 100_000, 999_999, 1_000_000, 100_000_000, 500_000_000]) {
      const s = me.formatMicro(micro)
      expect(s, `formatMicro(${micro})`).not.toMatch(/^\$0(\.0+)?$/)
    }
  })
})

describe.runIf(present)('isSpendableOnly — two independent reasons money is not real', () => {
  it('is true on every trial network', () => {
    expect(me.isSpendableOnly({ network: SEPOLIA })).toBe(true)
    expect(me.isSpendableOnly({ network: TINY })).toBe(true)
  })

  it('is true for a TAINTED credit even on mainnet', () => {
    // 🔑 The defect a network-only check would have shipped. On a mainnet
    // deployment a tainted credit (the payer could only have paid from faucet
    // money — TAINT_INVOKE_SQL) is real-money SHAPED but excluded from both
    // real-value exits. A mainnet-only test would have passed while the push
    // said "Real USDC, withdrawable" about money that cannot be withdrawn.
    expect(me.isSpendableOnly({ network: BASE, tainted: true })).toBe(true)
  })

  it('is false only for untainted money on a real chain', () => {
    expect(me.isSpendableOnly({ network: BASE })).toBe(false)
    expect(me.isSpendableOnly({ network: BASE, tainted: false })).toBe(false)
  })
})

describe.runIf(present)('moneyEventText — the copy, asserted rather than eyeballed', () => {
  const earned = (over: any = {}) =>
    me.moneyEventText({ kind: 'pay_earned', micro: 24_000, network: BASE, who: 'octocat', slug: 'ada', ...over })

  it('says withdrawable ONLY when it is', () => {
    expect(earned().body).toMatch(/withdrawable/i)
    expect(earned().body).not.toMatch(/trial/i)

    for (const e of [{ network: SEPOLIA }, { network: TINY }, { network: BASE, tainted: true }]) {
      const t = earned(e)
      expect(t.body, JSON.stringify(e)).toMatch(/NOT withdrawable/)
      expect(t.body, JSON.stringify(e)).toMatch(/trial credit/i)
      expect(t.detail, JSON.stringify(e)).not.toContain('USDC')
    }
  })

  it('never names an unverified counterparty — "Someone", never an id', () => {
    const uuid = '5681f936-4425-4aac-8f33-ad0822fe70c4'
    for (const who of [undefined, '', '   ', uuid, 'not a login', 'a'.repeat(64), '<script>']) {
      const t = earned({ who })
      expect(t.title + t.body + t.detail, String(who)).not.toContain(uuid)
      expect(t.detail, String(who)).toContain('Someone')
    }
    expect(earned({ who: 'octocat' }).detail).toContain('@octocat')
    expect(earned({ who: '@octocat' }).detail).toContain('@octocat')
  })

  it('never claims a chain or an address', () => {
    // A push naming Base when the ledger settled on the tiny chain is the c42
    // divergence wearing a friendly face. The copy stays chain-agnostic; only
    // withdrawability is stated, because that is what the user can act on.
    for (const kind of me.MONEY_EVENT_KINDS) {
      for (const network of [BASE, SEPOLIA, TINY]) {
        const t = me.moneyEventText({ kind, micro: 2_000_000, network })
        const all = `${t.title} ${t.body} ${t.detail}`
        expect(all, `${kind}/${network}`).not.toMatch(/base|sepolia|ethereum|0x/i)
      }
    }
  })

  it('every kind routes to /wallet — the page that answers "is it really there?"', () => {
    for (const kind of me.MONEY_EVENT_KINDS) {
      const t = me.moneyEventText({ kind, micro: 1_000_000, network: BASE })
      expect(t.url).toBe('/wallet')
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.body.length).toBeGreaterThan(0)
      expect(t.detail.length).toBeGreaterThan(0)
      // The ring column truncates at 300 (emitEvent) — stay well inside it.
      expect(t.detail.length).toBeLessThan(200)
    }
  })

  it('collapses a burst per kind, and never across kinds', () => {
    const tags = me.MONEY_EVENT_KINDS.map((kind: any) =>
      me.moneyEventText({ kind, micro: 1_000_000, network: BASE }).tag)
    expect(new Set(tags).size).toBe(me.MONEY_EVENT_KINDS.length)
  })

  it('a refund reads as "nothing was lost", never as a loss', () => {
    const t = me.moneyEventText({ kind: 'pay_refunded', micro: 5_000_000, network: BASE, reason: 'gas too low' })
    expect(t.body).toMatch(/nothing was lost/i)
    expect(t.body).toContain('back')
    expect(t.detail).toContain('gas too low')
    // …and it still works with no reason (withdraw-fail's default path).
    const bare = me.moneyEventText({ kind: 'pay_refunded', micro: 5_000_000, network: BASE })
    expect(bare.detail).not.toContain('()')
    expect(bare.body).toMatch(/nothing was lost/i)
  })
})

describe.runIf(present)('notifyMoney — a push outage must not touch money that moved', () => {
  const evt = { kind: 'pay_earned' as const, micro: 24_000, network: BASE }

  it('returns a report and never throws when BOTH rails fail', async () => {
    // D1 face-down under both legs — the harshest case, and the one that must not
    // propagate: money has already moved by the time this is called.
    const env = { DB: { prepare: () => { throw new Error('D1 down') } } }
    const r = await me.notifyMoney(env, 'u1', evt)
    expect(r.push).toBe(0)
  })

  it('does NOT claim the ring landed — emitEvent swallows its own errors', async () => {
    // The field is `ringAttempted`, not `ring`, because emitEvent catches
    // internally and returns void: a `ring: true` would report success with the
    // row never written, and no caller could tell. Pinned by NAME, since the whole
    // point is that the value cannot be trusted as "it landed".
    const env = { DB: { prepare: () => { throw new Error('D1 down') } } }
    const r = await me.notifyMoney(env, 'u1', evt)
    expect(Object.keys(r).sort()).toEqual(['push', 'ringAttempted'])
    expect(r).not.toHaveProperty('ring')
  })

  it('skips a zero-value event rather than saying "you earned $0"', async () => {
    let touched = 0
    const env = { DB: { prepare: () => { touched++; throw new Error('unused') } } }
    expect(await me.notifyMoney(env, 'u1', { ...evt, micro: 0 })).toEqual({ ringAttempted: false, push: 0 })
    expect(await me.notifyMoney(env, '', evt)).toEqual({ ringAttempted: false, push: 0 })
    expect(touched).toBe(0)
  })

  it('is called AFTER the ledger batch at every site, never inside one', async () => {
    // The invariant that makes the isolation real. A notifyMoney inside a
    // batch array would make a push failure part of the money transaction.
    for (const f of ['payments.ts', 'withdrawals.ts']) {
      const src = workerSource(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(src, f).toContain('notifyMoney(')
      // No notifyMoney between `env.DB.batch([` and its closing `])`.
      for (const m of Array.from(src.matchAll(/env\.DB\.batch\(\[([\s\S]*?)\n\s*\]\)/g))) {
        expect(m[1], `${f} batch body`).not.toContain('notifyMoney')
      }
    }
  })

  it('loginOf never falls back to the raw user id', async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }
    expect(await me.loginOf(env, 'u-123')).toBeUndefined()
    const boom = { DB: { prepare: () => { throw new Error('D1 down') } } }
    expect(await me.loginOf(boom, 'u-123')).toBeUndefined()
    const ok = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ github_login: 'octocat' }) }) }) } }
    expect(await me.loginOf(ok, 'u-123')).toBe('octocat')
  })
})

describe.runIf(present)('the four sites actually notify — the silence is closed', () => {
  it('payments.ts settles now speak: earned to the owner, received to the payee', () => {
    const src = code('worker/src/payments.ts')
    expect(src).toMatch(/notifyMoney\(env,\s*ownerId,\s*\{\s*kind:\s*"pay_earned"/)
    expect(src).toMatch(/notifyMoney\(env,\s*payeeId,\s*\{\s*kind:\s*"pay_received"/)
  })

  it('withdrawals.ts speaks on BOTH terminal states', () => {
    const src = code('worker/src/withdrawals.ts')
    expect(src).toContain('"pay_withdrawn"')
    expect(src).toContain('"pay_refunded"')
  })

  it('reads the taint from the statement that WRITES it, at the right index', () => {
    // `tainted` decides whether the copy promises withdrawability, and it comes
    // from a batch result INDEX. An off-by-one there reads the platform-fee row's
    // changes instead and silently flips the wording on every payment — so the
    // index is DERIVED from the source (count the prepares in the batch that
    // contains the TAINT statement) rather than hard-coded here, which would just
    // restate the mistake. Both call sites, whose batches are different lengths:
    // invoke has 5 statements (taint at 4), transfer has 3 (taint at 2).
    const src = workerSource('payments.ts')
    const seen: number[] = []
    for (const taintSql of ['TAINT_INVOKE_SQL', 'TAINT_TRANSFER_SQL']) {
      // The prepare() that binds the taint SQL — not the export of the constant.
      const at = src.indexOf(`env.DB.prepare(${taintSql})`)
      expect(at, `${taintSql} is not in a batch`).toBeGreaterThan(0)
      const start = src.lastIndexOf('env.DB.batch([', at)
      const end = src.indexOf('])', at)
      expect(start, `${taintSql} has no enclosing batch`).toBeGreaterThan(0)
      const stmts = src.slice(start, end).split('env.DB.prepare(').length - 1
      const m = src.slice(end).match(/taintChanges = Number\(results\?\.\[(\d+)\]/)
      expect(m, `${taintSql}: no taintChanges read after the batch`).toBeTruthy()
      // TAINT is documented as LAST in each batch (it must read post-debit state).
      expect(Number(m![1]), `${taintSql}: batch has ${stmts} statements`).toBe(stmts - 1)
      seen.push(stmts)
    }
    // Guards the derivation itself: if both batches came out the same length, the
    // loop is probably reading ONE batch twice and proving nothing.
    expect(new Set(seen).size, `both batches measured ${seen}`).toBe(2)
  })

  it('the withdrawal announces the NET, not the gross', () => {
    // The gross includes the $0.10 fee that never arrives. Overstating what
    // landed on a message whose whole job is "the money is real now" is the
    // same class of lie as calling trial credit withdrawable.
    const src = code('worker/src/withdrawals.ts')
    const at = src.indexOf('"pay_withdrawn"')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 300)).toMatch(/amount_micro\)\s*-\s*Number\(w\.fee_micro\)/)
  })
})

describe.runIf(present)('the c27 roster — a shipped kind must not render as noise', () => {
  it('every money kind is on the web roster', () => {
    for (const kind of me.MONEY_EVENT_KINDS) {
      expect(EMITTED_KINDS as readonly string[], `${kind} missing from EMITTED_KINDS`).toContain(kind)
    }
  })

  it('every money kind has its OWN glyph on the HUD — not ⚡, not the siren', () => {
    const glyphs = me.MONEY_EVENT_KINDS.map((k: string) => iconFor(k))
    expect(glyphs).not.toContain('⚡')
    expect(glyphs).not.toContain('🚨')        // 🚨 means "a human must intervene"
    expect(new Set(glyphs).size).toBe(me.MONEY_EVENT_KINDS.length)
  })

  it('pay_alarm keeps the siren to itself — no pay_* prefix collision', () => {
    expect(iconFor('pay_alarm')).toBe('🚨')
    expect(KIND_ICONS.pay).toBeUndefined()
    // A future pay_* kind nobody mapped must fall to ⚡, NOT inherit 🚨.
    expect(iconFor('pay_something_new')).toBe('⚡')
  })

  it('the agent prompt has a distinct glyph for each too', () => {
    const src = source('lib/chat/prompt.ts')
    const table = src.slice(src.indexOf('const EVENT_ICONS'), src.indexOf('export function buildSoulPrompt'))
    for (const kind of me.MONEY_EVENT_KINDS) {
      expect(table, `${kind} missing from prompt EVENT_ICONS`).toContain(`${kind}:`)
    }
  })

  it('iOS and Android mirror both the glyph map and the roster', () => {
    const swift = source('ios/Tiny/Sources/Activity.swift')
    const kotlin = source('android/app/src/main/java/technology/tiny/app/ui/Activity.kt')
    for (const kind of me.MONEY_EVENT_KINDS) {
      expect(swift, `Swift glyph for ${kind}`).toContain(`("${kind}", "`)
      expect(swift, `Swift roster ${kind}`).toContain(`"${kind}",`)
      expect(kotlin, `Kotlin glyph for ${kind}`).toContain(`"${kind}" to "`)
      expect(kotlin, `Kotlin roster ${kind}`).toContain(`"${kind}",`)
    }
  })

  it('the worker module and the web roster do not drift', () => {
    // MONEY_EVENT_KINDS is the worker's declaration; EMITTED_KINDS is what the
    // clients can draw. Adding one there without one here is the c27 defect.
    const declared = workerSource('money-events.ts')
    for (const kind of EMITTED_KINDS.filter(k => k.startsWith('pay_') && k !== 'pay_alarm')) {
      expect(declared, `${kind} on the web roster but not in MONEY_EVENT_KINDS`).toContain(`"${kind}"`)
    }
  })
})
