// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relayerCanTransact, relayerGasRefusal } from '@/chain/relayer-gas.mjs'

/**
 * ⛽ ZERO-PRICE GAS IS NOT NO-GAS-REQUIRED (P6, multi-node chain loop c8).
 *
 * Measured on the live 4-node chain 8470, `gasPrice: 0` on every trial, senders
 * differing ONLY in balance:
 *
 *   balance 0 wei  → eth_sendRawTransaction returns a hash; the tx is never
 *                    mined, never rejected, and no log line names it.
 *   balance 1 wei  → mined in the next block (~4s).
 *
 * The gate is a strictly positive balance, NOT affordability. That is what these
 * tests pin, because the intuitive check is wrong in the dangerous direction: on
 * a zero-fee chain `balance >= gas * maxFeePerGas` is `0 >= 0`, i.e. TRUE, for
 * the one account that provably cannot transact.
 *
 * Why it's money and not just downtime: the facilitator signs, assigns `hash`,
 * broadcasts, then waits for a receipt. Past the signing line every failure must
 * report `unknown` (chain/settle-outcome.mjs) because a broadcast tx may land at
 * any time — and `unknown` must never be auto-refunded. A zero-balance relayer
 * turns EVERY settlement into an unrefundable unknown: payer debited, receiver
 * 402'd, reconciler chasing a transfer that can never happen.
 */
describe('relayerCanTransact — the measured rule, not the fee model', () => {
  it('refuses a zero balance: accepted into the pool, mined never', () => {
    expect(relayerCanTransact(BigInt(0))).toBe(false)
    expect(relayerCanTransact(0)).toBe(false)
    expect(relayerCanTransact('0')).toBe(false)
    expect(relayerCanTransact('0x0')).toBe(false)
  })

  it('accepts 1 wei — provably enough on 8470, so the rule must not be a threshold', () => {
    // If this were an affordability check with any assumed gas price, 1 wei would
    // fail. It mines. A guard stricter than the chain would refuse to start a
    // facilitator that works.
    expect(relayerCanTransact(BigInt(1))).toBe(true)
    expect(relayerCanTransact('0x1')).toBe(true)
  })

  it('accepts a normally funded relayer', () => {
    // ~1000 ETH — prod's actual 8469 relayer balance. As a string because the
    // repo's tsconfig targets es5: bigint literals and ** on bigints don't compile.
    expect(relayerCanTransact('1000000000000000000000')).toBe(true)
  })

  it('treats an ABSENT balance as cannot-transact, never as fine', () => {
    // A failed eth_getBalance must not read as a funded relayer. Same fail-closed
    // direction as tinyChainConfig() returning null on a partial config.
    expect(relayerCanTransact(null)).toBe(false)
    expect(relayerCanTransact(undefined)).toBe(false)
    expect(relayerCanTransact('')).toBe(false)
    expect(relayerCanTransact('not-a-number')).toBe(false)
    expect(relayerCanTransact(NaN)).toBe(false)
  })

  it('refuses a negative balance instead of throwing', () => {
    expect(relayerCanTransact(BigInt(-1))).toBe(false)
  })
})

describe('relayerGasRefusal — an operator who thinks gas is free must not override it', () => {
  const msg = relayerGasRefusal('0xc9AA3fa9cb704d6185489bcD8F1A466C08510AE9', 8470)

  it('names the address and the chain, so a multi-chain operator knows WHICH', () => {
    // The whole bug is chain-specific: this same relayer holds ~1000 ETH on 8469.
    expect(msg).toContain('0xc9AA3fa9cb704d6185489bcD8F1A466C08510AE9')
    expect(msg).toContain('8470')
  })

  it('says zero-price gas is not the same as no gas required', () => {
    // Without this sentence the message reads as a bug in the check, on a chain
    // whose entire fee model says gas is free — and it gets overridden.
    expect(msg).toMatch(/[Zz]ero-price gas is NOT the same as no gas required/)
  })

  it('names the actual failure — accepted then never mined — and the unknown outcome', () => {
    expect(msg).toMatch(/never mined/)
    expect(msg).toMatch(/unknown/)
  })

  it('says what fixes it, including that 1 wei suffices', () => {
    expect(msg).toMatch(/[Ff]und/)
    expect(msg).toMatch(/1 wei/)
    expect(msg).toMatch(/restart/)
  })
})

describe('the facilitator actually consults the guard at startup', () => {
  // Anchored to the call site, not the file: a `toContain('relayerCanTransact')`
  // over the whole file passes on the import line alone, and this repo has hit
  // that exact false pass five times (see the mutation-test note in the loop
  // memory). Assert the negated call inside an `if` that exits.
  const server = readFileSync(join(process.cwd(), 'chain/facilitator/server.mjs'), 'utf8')

  it('refuses to START rather than failing at the first /settle', () => {
    const guard = /if \(!relayerCanTransact\(await pub\.getBalance\([^)]*\)\)\) \{\s*console\.error\(relayerGasRefusal\([^)]*\)\)\s*process\.exit\(1\)/
    expect(server).toMatch(guard)
  })

  it('reads the balance of the relayer it will actually SIGN with', () => {
    // Not RELAYER_KEY's address recomputed, not an env var: the wallet client's
    // own account. A guard that checks a different address than the signer is
    // theatre.
    expect(server).toMatch(/relayerCanTransact\(await pub\.getBalance\(\{ address: relayer\.account\.address \}\)\)/)
  })
})
