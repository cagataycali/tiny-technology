// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { settleNetwork } from '../app/api/wallet/withdraw/route'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('withdraw-settle-network')

/**
 * ⚖️ ONE AUTHORITY ON WHICH CHAIN A PAYOUT LANDS ON.
 *
 * The withdrawal is split across two codebases on purpose: the worker owns the
 * LEDGER (the atomic debit, the caps, the trial exclusion) and the app's Node
 * route owns the SIGNING. Both, until now, independently answered "which network
 * is this?" — the worker with `normalizeNetwork(env, requested)`, the route with
 * a two-branch ternary over the raw request body:
 *
 *   body.network === 'base-sepolia' ? 'base-sepolia'
 *     : body.network === 'tiny' && TINY ? 'tiny' : 'base'
 *
 * On production (`PAYMENTS_NETWORK=tiny`) those two answers differed on nearly
 * every input, including the most common one — no network field at all, which is
 * what Android's `/wallet withdraw 5.00 confirm` sends:
 *
 *   worker → 'tiny'  (the deployment default)      route → 'base'
 *
 * And the divergence was a MINT. `tiny` is trial-class, so the worker's debit
 * sets `trialFactor = 0` and skips the trial exclusion entirely — faucet-minted
 * TinyUSDC passes `WITHDRAW_DEBIT_SQL` because paying it out on the chain we own
 * costs nobody anything. The route then read the same request as `base` and
 * signed a transfer of mainnet USDC from the payout hot wallet. Minted trial
 * credit out as real money, one authenticated request, no accomplice — straight
 * through the exclusion (c-d) and the taint propagation (c-f0b), because both of
 * those guard the ledger and the ledger was never the thing that lied.
 *
 * So the route no longer decides. It forwards the request raw, and signs on the
 * network the worker says it DEBITED. What's pinned below is that property in
 * three layers: the resolver's fail-closed behaviour, the source-level absence of
 * any second copy of the table, and — with the worker checked out — an actual
 * differential over `normalizeNetwork` proving the two can no longer disagree.
 */

const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const ROUTE = 'app/api/wallet/withdraw/route.ts'

/**
 * Source with comments stripped. Four cycles running now (c37–c39, and this one)
 * a "this file must not contain X" assertion has been tripped by the doc comment
 * explaining why the file doesn't contain X — here, the header quoting the exact
 * ternary it deleted. A prose mention isn't code. (Same helper as
 * tests/standing.test.ts; deliberately a second copy rather than a shared import,
 * since the two suites assert on unrelated files.)
 */
const code = (rel: string) => source(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** The three-network table a fully-configured tiny-chain deployment builds. */
const FULL = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  tiny: '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec',
}
/** …and what an app with no TINY_CHAIN_* env builds (tinyChainConfig() → null). */
const NO_TINY = { base: FULL.base, 'base-sepolia': FULL['base-sepolia'] }

describe('settleNetwork — sign only on a chain this deployment has an address for', () => {
  it('passes through each configured network verbatim', () => {
    for (const n of Object.keys(FULL)) expect(settleNetwork(n, FULL)).toBe(n)
  })

  it('REFUSES a network the deployment has no USDC address for', () => {
    // The live half of the config mismatch: the worker has TINY_CHAIN_* set (so
    // it resolves 'tiny' and skips the trial exclusion) while the app does not.
    // The old code signed that on mainnet; there is no answer here but refusal.
    expect(settleNetwork('tiny', NO_TINY)).toBeNull()
  })

  it('REFUSES an absent / empty network — an older worker must not fall back to base', () => {
    // `base` is the single worst default in this table: it's the only entry that
    // moves real money, so an unidentifiable chain must never resolve to it.
    for (const junk of [undefined, null, '', ' ', 0, false, NaN]) {
      expect(settleNetwork(junk as any, FULL), String(junk)).toBeNull()
    }
  })

  it('REFUSES an alias the WORKER would accept — it only ever echoes canonical', () => {
    // normalizeNetwork folds these; its RESPONSE is always one of the three
    // canonical keys. Seeing an alias here would mean we're reading something
    // other than the worker's answer, so it must not resolve.
    for (const alias of ['sepolia', 'base_sepolia', 'eip155:8453', 'eip155:84532', 'eip155:8469', '8469', 'tiny-chain', 'mainnet']) {
      expect(settleNetwork(alias, FULL), alias).toBeNull()
    }
  })

  it('is case- and whitespace-EXACT (no normalizing, which is the bug it replaces)', () => {
    for (const v of ['Base', 'BASE', 'Tiny', ' tiny', 'tiny ', 'base-Sepolia']) {
      expect(settleNetwork(v, FULL), v).toBeNull()
    }
  })

  it('never resolves an inherited Object.prototype key', () => {
    // `table[n]` would make a worker reply of "constructor" truthy and signable.
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(settleNetwork(k, FULL), k).toBeNull()
    }
  })

  it('an object / array network is refused, not coerced into a key', () => {
    for (const v of [{}, [], ['base'], { network: 'base' }, () => 'base']) {
      expect(settleNetwork(v as any, FULL)).toBeNull()
    }
  })
})

describe('the route holds no second copy of the network table', () => {
  const src = code(ROUTE)

  it('the ternary that disagreed with the worker is GONE', () => {
    // The exact shape, in case a future edit reintroduces it by reflex. Asserted
    // on stripped source — the header QUOTES this ternary to explain the bug.
    expect(src).not.toMatch(/body\.network === 'base-sepolia'/)
    expect(src).not.toMatch(/body\.network === 'tiny'/)
    // No hardcoded chain name may decide the settlement network any more.
    expect(src).not.toMatch(/const network = .*'base'/)
  })

  it('`network` is derived from the WORKER response, exactly once', () => {
    expect(src).toMatch(/const network = settleNetwork\(wr\.network\)/)
    expect(src.match(/settleNetwork\(wr\.network\)/g)?.length).toBe(1)
    // …and the body's network is forwarded, never interpreted.
    expect(src).toMatch(/network: String\(body\.network\)/)
  })

  it('reads body.network only to forward it', () => {
    // Two readings of the same field is how the two answers appeared in the first
    // place. `network` on the wire is a REQUEST, resolved once, upstream — so
    // every mention here belongs to the one forwarding expression.
    const mentions = src.match(/body\.network[^\n]*/g) ?? []
    expect(mentions.length).toBe(1)
    expect(mentions[0]).toMatch(/body\.network === undefined \|\| body\.network === null \? \{\} : \{ network: String\(body\.network\) \}/)
  })

  it('REFUNDS when it cannot sign — the debit already happened', () => {
    // Ordering fact: settleNetwork runs AFTER /pay/withdraw-request, because the
    // debit is what decides the network. So its refusal path must undo the debit,
    // or a config mismatch silently eats the user's balance.
    const gate = src.slice(src.indexOf('const network = settleNetwork'))
    const refuse = gate.slice(0, gate.indexOf('let txHash'))
    expect(refuse).toMatch(/withdraw-fail/)
    expect(refuse).toMatch(/424/)
    // The detail (which network the worker named) goes to the log, not the caller.
    expect(refuse).toMatch(/console\.error/)
    // And it must be positioned after the debit, before any signing. (Anchored on
    // the CALL, not the identifier — whose first hit is the viem import.)
    expect(src.indexOf('const network = settleNetwork')).toBeGreaterThan(src.indexOf('/pay/withdraw-request'))
    expect(src.indexOf('const network = settleNetwork')).toBeLessThan(src.indexOf('privateKeyToAccount(pk'))
  })
})

/**
 * The differential the bug needed: run the WORKER's resolver and assert its
 * output is always something the route will sign for — on a tiny-chain
 * deployment, which is the configuration where the old ternary diverged.
 */
describe.skipIf(!present)('worker ↔ route: the two can no longer disagree', () => {
  let dep: any
  const TINY_ENV = {
    TINY_CHAIN_ID: '8469',
    TINY_CHAIN_USDC_ADDRESS: FULL.tiny,
    PAYMENTS_NETWORK: 'tiny',
  }

  beforeAll(async () => {
    if (!present) return
    dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
  })

  const REQUESTS = [
    undefined, null, '', 'tiny', 'base', 'base-sepolia', 'sepolia', 'base_sepolia',
    'eip155:8453', 'eip155:84532', 'eip155:8469', '8469', 'TINY', 'Base', ' tiny ',
    'junk', 'ethereum', '0', 'null',
  ]

  it('every resolved network is one the route can sign for', () => {
    for (const r of REQUESTS) {
      const resolved = dep.normalizeNetwork(TINY_ENV, r as any)
      expect(settleNetwork(resolved, FULL), `request=${String(r)} resolved=${resolved}`).toBe(resolved)
    }
  })

  it('the chain SIGNED is the chain DEBITED, for every request shape', () => {
    // The invariant in one line. Trial-ness is decided from the resolved network
    // (isTrialNetwork → trialFactor), so signing on anything else is precisely
    // the "debited as trial, paid as real" mint.
    for (const r of REQUESTS) {
      const debited = dep.normalizeNetwork(TINY_ENV, r as any)
      const signed = settleNetwork(debited, FULL)
      expect(signed, `request=${String(r)}`).toBe(debited)
      // And a trial debit can never be signed on a real-money chain.
      if (dep.isTrialNetwork(debited)) expect(signed).not.toBe('base')
    }
  })

  it('demonstrates the OLD ternary diverging, so this test can never pass vacuously', () => {
    // Guard against a future edit that makes the differential trivially true.
    // These are the inputs the shipped bug got wrong on production.
    const old = (b: unknown) =>
      b === 'base-sepolia' ? 'base-sepolia' : b === 'tiny' ? 'tiny' : 'base'
    const diverged = REQUESTS.filter(r => old(r) !== dep.normalizeNetwork(TINY_ENV, r as any))
    expect(diverged.length).toBeGreaterThan(0)
    // Specifically: no network field at all — the commonest request there is.
    expect(old(undefined)).toBe('base')
    expect(dep.normalizeNetwork(TINY_ENV, undefined)).toBe('tiny')
    // …and that pairing is the mint: a trial debit signed on real Base.
    expect(dep.isTrialNetwork('tiny')).toBe(true)
  })

  it('a request naming a REAL network still settles real — the fix is not "always trial"', () => {
    // The safe direction isn't to force everything to the trial chain; it's for
    // the two halves to agree. A user with real Base deposits withdrawing on
    // 'base' must still be paid on Base, trial exclusion applied.
    expect(dep.normalizeNetwork(TINY_ENV, 'base')).toBe('base')
    expect(settleNetwork('base', FULL)).toBe('base')
    expect(dep.isTrialNetwork('base')).toBe(false)
  })
})
