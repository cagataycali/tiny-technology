// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('payments')

let splitInvoke: (price: number, fee?: number) => { debit: number; ownerCredit: number; fee: number } | null
let validResource: (r: string) => boolean
let PLATFORM_FEE_MICRO: number
let SPEND_MAX_MICRO: number

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('payments.ts') /* @vite-ignore */)
  splitInvoke = mod.splitInvoke
  validResource = mod.validResource
  PLATFORM_FEE_MICRO = mod.PLATFORM_FEE_MICRO
  SPEND_MAX_MICRO = mod.SPEND_MAX_MICRO
})

describe.skipIf(!present)('splitInvoke — the money conservation law', () => {
  it('debit + ownerCredit + fee = 0 (nothing created or destroyed)', () => {
    for (const price of [1, 999, 1000, 1001, 10_000, 1_000_000, 99_999_999]) {
      const s = splitInvoke(price)!
      expect(s.debit + s.ownerCredit + s.fee).toBe(0)
    }
  })

  it('flat fee regardless of price ($0.001 on $0.01 and on $100 alike)', () => {
    expect(splitInvoke(10_000)!.fee).toBe(PLATFORM_FEE_MICRO)
    expect(splitInvoke(100_000_000)!.fee).toBe(PLATFORM_FEE_MICRO)
  })

  it('price below the fee: owner gets 0, fee capped at price (never negative)', () => {
    const s = splitInvoke(500)! // $0.0005 < $0.001 fee
    expect(s.fee).toBe(500)
    expect(s.ownerCredit).toBe(0)
    expect(s.debit).toBe(-500)
  })

  it('free and invalid prices settle to null (no ledger rows)', () => {
    expect(splitInvoke(0)).toBeNull()
    expect(splitInvoke(-5)).toBeNull()
    expect(splitInvoke(NaN)).toBeNull()
  })

  it('floors fractional micro amounts (no sub-micro dust)', () => {
    const s = splitInvoke(10_000.7)!
    expect(s.debit).toBe(-10_000)
  })
})

describe.skipIf(!present)('validResource — the price-key gate', () => {
  it('accepts tiny:<slug> and tool:<login>/<name>', () => {
    expect(validResource('tiny:tiny')).toBe(true)
    expect(validResource('tiny:my-cool-ai')).toBe(true)
    expect(validResource('tool:cagataycali/weather')).toBe(true)
  })
  it('rejects injection-shaped and malformed keys', () => {
    expect(validResource('tiny:')).toBe(false)
    expect(validResource('tiny:UPPER')).toBe(false)
    expect(validResource("tiny:x' OR 1=1")).toBe(false)
    expect(validResource('tool:no-slash')).toBe(false)
    expect(validResource('other:thing')).toBe(false)
    expect(validResource('tiny:' + 'a'.repeat(65))).toBe(false)
  })
})

describe.skipIf(!present)('SPEND_MAX_MICRO — outbound x402 payment ceiling', () => {
  it('is a positive, sane per-payment cap (a runaway agent cannot drain a whale)', () => {
    expect(SPEND_MAX_MICRO).toBeGreaterThan(0)
    // $100 ceiling — matches the price sanity cap; the app layer clamps tighter.
    expect(SPEND_MAX_MICRO).toBe(100_000_000)
  })
})

describe.skipIf(!present)('P2P transfer — /pay/transfer building blocks', () => {
  let validTransferAmount: (n: number) => boolean
  let MAX_TRANSFER_MICRO: number
  let TAINT_TRANSFER_SQL: string
  let TAINT_INVOKE_SQL: string

  beforeAll(async () => {
    if (!present) return
    const mod = await import(workerFile('payments.ts') /* @vite-ignore */)
    validTransferAmount = mod.validTransferAmount
    MAX_TRANSFER_MICRO = mod.MAX_TRANSFER_MICRO
    TAINT_TRANSFER_SQL = mod.TAINT_TRANSFER_SQL
    TAINT_INVOKE_SQL = mod.TAINT_INVOKE_SQL
  })

  it('amount gate: integer micro in 1..$100 only (no dust, no negatives, no floats)', () => {
    expect(validTransferAmount(1)).toBe(true)
    expect(validTransferAmount(1_000_000)).toBe(true)
    expect(validTransferAmount(MAX_TRANSFER_MICRO)).toBe(true)
    expect(validTransferAmount(0)).toBe(false)
    expect(validTransferAmount(-5)).toBe(false)
    expect(validTransferAmount(0.5)).toBe(false)
    expect(validTransferAmount(1.5)).toBe(false)
    expect(validTransferAmount(MAX_TRANSFER_MICRO + 1)).toBe(false)
    expect(validTransferAmount(NaN)).toBe(false)
    expect(validTransferAmount(Infinity)).toBe(false)
  })

  it('ceiling matches the $100 price sanity cap', () => {
    expect(MAX_TRANSFER_MICRO).toBe(100_000_000)
  })

  it('taint SQL is the invoke taint with only the kind + debit gate swapped', () => {
    // The taint math (TAINT_MICRO_EXPR) must be SHARED, not re-derived: the
    // anti-laundering property was audited once for invoke, and transfer must
    // inherit it verbatim. Swapping the two literals back should reproduce the
    // invoke statement exactly.
    const backToInvoke = TAINT_TRANSFER_SQL
      .replace("'transfer',", "'invoke',")
      .replace("kind='transfer_debit'", "kind='invoke_debit'")
    expect(backToInvoke).toBe(TAINT_INVOKE_SQL)
    // …and the transfer flavor really gates on the transfer debit row.
    expect(TAINT_TRANSFER_SQL).toContain("kind='transfer_debit'")
    expect(TAINT_TRANSFER_SQL).toContain("'transfer',")
    expect(TAINT_TRANSFER_SQL).toContain('INSERT OR IGNORE INTO trial_taint')
  })
})
