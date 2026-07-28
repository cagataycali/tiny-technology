// @vitest-environment node
//
// The words a payment approval is made of. Found by the first real external
// x402 payment against the self-hosted chain (2026-07-25): the 402 description
// branded our chain "(testnet)" — an instruction to go find a public faucet
// that doesn't exist — and the confirm summary asked for approval without
// naming WHICH money ("Pay $0.01 to consult…"), though trial credit vs real
// USDC is the entire stake of the tap. Absence assertions carry the weight
// (the c27 lesson): the wrong claim must be provably gone, not merely
// accompanied by a right one.
import { describe, it, expect } from 'vitest'
import { moneyKind, quoteSummary, x402DescSuffix, type PayNetwork } from '@/lib/x402/top-up'

const ALL: PayNetwork[] = ['base', 'base-sepolia', 'tiny']

describe('moneyKind', () => {
  it('base is real USDC', () => expect(moneyKind('base')).toBe('real USDC'))
  it('both trial networks are trial credit', () => {
    expect(moneyKind('tiny')).toBe('trial credit')
    expect(moneyKind('base-sepolia')).toBe('trial credit')
  })
  it('every network claims exactly one kind, never neither', () => {
    for (const n of ALL) expect(['real USDC', 'trial credit']).toContain(moneyKind(n))
  })
})

describe('quoteSummary', () => {
  it('names the amount and the kind', () => {
    const s = quoteSummary(10_000, 'tiny')
    expect(s).toContain('$0.01')
    expect(s).toContain('trial credit')
    expect(s).toContain('Awaiting your approval')
  })
  it('a trial-network summary never claims real money', () => {
    for (const n of ['tiny', 'base-sepolia'] as PayNetwork[]) {
      expect(quoteSummary(10_000, n)).not.toMatch(/real/i)
    }
  })
  it('a base summary never claims trial', () => {
    expect(quoteSummary(10_000, 'base')).toContain('real USDC')
    expect(quoteSummary(10_000, 'base')).not.toMatch(/trial/i)
  })
})

describe('x402DescSuffix', () => {
  it('base gets no suffix', () => expect(x402DescSuffix('base')).toBe(''))
  it('base-sepolia keeps its honest (testnet) — a public faucet DOES exist there', () =>
    expect(x402DescSuffix('base-sepolia')).toBe(' (testnet)'))
  it('the self-hosted chain says (trial credit), NEVER (testnet)', () => {
    expect(x402DescSuffix('tiny')).toBe(' (trial credit)')
    expect(x402DescSuffix('tiny')).not.toContain('testnet')
  })
})
