// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parsePayees, payeeAllowed, OFF_LIST_REASON, NO_PAYEES_REFUSAL,
} from '@/chain/settle-policy.mjs'

/**
 * 💸 WHOM THE FACILITATOR SETTLES FOR (loop item c-n).
 *
 * The cloudflared tunnel publishes TWO services. c34 swept the first
 * (`chain.example.com` → the RPC proxy) and screened its signers. This is the
 * second: `x402.example.com` → `chain/facilitator/server.mjs`, whose /verify and
 * /settle took `paymentRequirements` — *including payTo* — verbatim from the
 * request body, and never asked whether that payee was us.
 *
 * Proven against the LIVE service on 2026-07-25, from a freshly generated key
 * holding 0 USDC and 0 ETH:
 *
 *     POST https://x402.example.com/settle
 *       payTo: 0x…dEaD, value "0", resource "https://not-ours.example/x"
 *     → {"success":true,"transaction":"0xf416d8…"}
 *     relayer nonce 3 → 4, 0.0000603 ETH of our gas spent
 *
 * Every pre-existing check passed, and each was individually correct: the
 * signature recovers to `from`, `auth.to === requirement.payTo`, the nonce is
 * unused, `value <= balance`. All true of a payment that has nothing to do with
 * this deployment. The missing question wasn't "is this authorization valid" but
 * "is it OURS" — and `paymentRequirements` is caller-supplied, so payTo was
 * never evidence of anything.
 *
 * Not theft (EIP-3009 authorizations move only their own signer's balance) and
 * not the relayer key (c32 covers that). What it is: an unmetered write channel
 * funded by our relayer — free arbitrary transfer-relaying for anyone who finds
 * the hostname, growing `~/.tiny-chain/state` until the relayer's ETH is gone
 * and real settlement stops.
 *
 * The judgement worth reusing: **the guard reuses `X402_PAY_TO` instead of a new
 * facilitator-side env.** The receiver advertises exactly one payTo in its 402
 * challenge and this facilitator exists to settle exactly that challenge — one
 * fact, so one env. A `FACILITATOR_PAY_TO` copy would drift in the expensive
 * direction: rotate the receiving address, forget the copy, and every REAL
 * payment fails closed while every stranger's still settles.
 */

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const A = '0xf33b014377c04603eb502596cde607b698057dfa'
const B = '0x000000000000000000000000000000000000dead'

describe('parsePayees — the allowlist can only ever shrink', () => {
  it('parses one address, lowercased', () => {
    expect(parsePayees(A)).toEqual([A])
  })

  it('accepts EIP-55 checksummed input (what a dashboard paste looks like)', () => {
    // Every real source of this value — a wallet UI, BaseScan, the go-live
    // checklist — hands out the checksummed form. A case-sensitive compare here
    // would reject the deployment's own payTo and fail every genuine payment.
    expect(parsePayees('0xF33B014377c04603Eb502596CDE607B698057dfA')).toEqual([A])
  })

  it('parses a comma-separated rotation list', () => {
    expect(parsePayees(`${A},${B}`)).toEqual([A, B])
  })

  it('tolerates whitespace and newlines around entries', () => {
    // The realistic arrival path is a paste into an env field or a `source`d
    // keys file, and a guard a stray newline defeats is not a guard (same
    // tolerance dev-keys.mjs applies for the same reason).
    expect(parsePayees(` ${A} , \n${B}\t`)).toEqual([A, B])
  })

  it('DROPS junk entries rather than treating them as wildcards', () => {
    // A typo must make the allowlist smaller, never bigger. The dropped entry's
    // payments fail closed and the operator finds out; the alternative (any
    // unparseable entry meaning "allow all") is the c32 bug — a wrong value that
    // reads as configured.
    expect(parsePayees(`${A},nope,0x1234,,${B}`)).toEqual([A, B])
    expect(parsePayees('0x' + 'g'.repeat(40))).toEqual([])
    expect(parsePayees('0x' + 'a'.repeat(41))).toEqual([])
    expect(parsePayees('0x' + 'a'.repeat(39))).toEqual([])
  })

  it('an all-junk value is EMPTY — identical to unset, never a wildcard', () => {
    for (const raw of ['nope', ',,,', '0x', 'null', 'undefined', '*', 'any']) {
      expect(parsePayees(raw), raw).toEqual([])
    }
  })

  it('unset / nullish → empty, and never throws', () => {
    for (const raw of [undefined, null, '', '   ', 0, false, {}, []]) {
      expect(parsePayees(raw as never), JSON.stringify(raw)).toEqual([])
    }
  })

  it('a bare address without 0x is junk (no silent prefixing)', () => {
    expect(parsePayees('f33b014377c04603eb502596cde607b698057dfa')).toEqual([])
  })
})

describe('payeeAllowed — the one question /settle was never asking', () => {
  const payees = parsePayees(A)

  it('allows the deployment\'s own receiving address', () => {
    expect(payeeAllowed(A, payees)).toBe(true)
  })

  it('allows it in checksummed form too — the 402 challenge emits EIP-55', () => {
    expect(payeeAllowed('0xF33B014377c04603Eb502596CDE607B698057dfA', payees)).toBe(true)
  })

  it('REFUSES the stranger payee that the live exploit used', () => {
    expect(payeeAllowed(B, payees)).toBe(false)
  })

  it('refuses every off-list address, including near-misses', () => {
    // A one-character difference is the interesting case: an operator who
    // fat-fingers their own address gets a refusal, not a payout to a typo.
    for (const p of [
      A.replace(/a$/, 'b'), '0x' + 'a'.repeat(40), '0x' + '0'.repeat(40), B,
    ]) expect(payeeAllowed(p, payees), p).toBe(false)
  })

  it('an EMPTY allowlist allows nothing at all (fail closed)', () => {
    // The startup guard means the server never runs in this state, but the
    // predicate must still be closed on its own: a future caller that forgets
    // the startup check must not get "no list ⟹ allow everything".
    for (const p of [A, B, '', '0x' + '1'.repeat(40)]) {
      expect(payeeAllowed(p, []), p).toBe(false)
    }
  })

  it('junk / missing payTo is refused, not skipped', () => {
    for (const p of [undefined, null, '', '  ', 'nope', 0, {}, []]) {
      expect(payeeAllowed(p as never, payees), JSON.stringify(p)).toBe(false)
    }
  })

  it('is a whole-value match — a payee CONTAINING ours is not ours', () => {
    // Substring matching here would be the c32 hostname lesson repeated: an
    // address is an exact 20-byte value, and `0x…dead${A}` is somebody else's.
    expect(payeeAllowed(A + '00', payees)).toBe(false)
    expect(payeeAllowed(B.slice(0, 4) + A.slice(4), payees)).toBe(false)
  })
})

describe('the refusal messages', () => {
  it('the off-list reason never names the address we DO settle for', () => {
    // A prober is entitled to learn that this facilitator isn't theirs to use,
    // and to nothing else. Our receiving address stays something an honest payer
    // gets from the 402 challenge.
    expect(OFF_LIST_REASON).not.toContain(A)
    expect(OFF_LIST_REASON).not.toMatch(/0x[0-9a-f]{40}/i)
    expect(OFF_LIST_REASON).toMatch(/payTo/)
  })

  it('the off-list reason does not echo caller input back', () => {
    // A constant, not a template: reflecting request content into a response
    // string on a public endpoint is a habit worth not having.
    expect(OFF_LIST_REASON).not.toContain('${')
    expect(typeof OFF_LIST_REASON).toBe('string')
  })

  it('the startup refusal says what to set and that a restart cures it', () => {
    // c33's rule: exit (don't refuse permanently) when a later env fix cures
    // it — nothing here is written on-chain — and the message must name the fix.
    expect(NO_PAYEES_REFUSAL).toContain('X402_PAY_TO')
    expect(NO_PAYEES_REFUSAL).toMatch(/restart/)
    expect(NO_PAYEES_REFUSAL).toMatch(/relayer/)
  })
})

/**
 * The wiring, asserted on source: the server body needs a listening socket, a
 * live anvil and a deployed token, so `chain/scripts/facilitator-e2e.mjs` owns
 * the behavioural proof. What matters here is that the gate is invoked in the
 * one place both endpoints share, and that it can't be defaulted away.
 */
describe('the facilitator wires the policy', () => {
  const server = () => src('chain/facilitator/server.mjs')

  it('refuses to START with no payee configured', () => {
    expect(server()).toMatch(/const PAYEES = parsePayees\(process\.env\.X402_PAY_TO\)/)
    expect(server()).toMatch(/if \(PAYEES\.length === 0\)[\s\S]{0,120}process\.exit\(1\)/)
  })

  it('has NO fallback payee — an unset env cannot resolve to an address', () => {
    // The whole c32/c33 lesson: a wrong default reads as configured. `payTo`
    // must have no `||` rescue, or the refusal above becomes unreachable.
    expect(server()).not.toMatch(/X402_PAY_TO\s*\|\|/)
  })

  it('checks the payee inside validate(), so /verify and /settle agree', () => {
    // Both endpoints call validate(); putting the check anywhere else would let
    // /verify bless an authorization /settle refuses (or worse, the reverse).
    const body = server()
    const validateAt = body.indexOf('async function validate(')
    const checkAt = body.indexOf('payeeAllowed(requirement.payTo, PAYEES)')
    const verifyAt = body.indexOf('async function handleVerify(')
    expect(validateAt).toBeGreaterThan(-1)
    expect(checkAt).toBeGreaterThan(validateAt)
    expect(checkAt).toBeLessThan(verifyAt)
  })

  it('screens the payee BEFORE the signature and on-chain reads', () => {
    // Static and free, so it goes first: no ecrecover, no two RPC round-trips
    // for a request we were never going to relay.
    const body = server()
    expect(body.indexOf('payeeAllowed(requirement.payTo, PAYEES)'))
      .toBeLessThan(body.indexOf('verifyTypedData({'))
  })

  it('documents the requirement where an operator reads about the env', () => {
    expect(server()).toContain('X402_PAY_TO')
    expect(src('chain/README.md')).toContain('X402_PAY_TO')
    expect(src('.env.example')).toContain('X402_PAY_TO')
  })
})
