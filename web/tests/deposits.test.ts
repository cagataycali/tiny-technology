// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('deposits')

let mod: any
beforeAll(async () => {
  if (!present) return
  mod = await import(workerFile('deposits.ts') /* @vite-ignore */)
})

const DEPOSIT = '0x' + 'd'.repeat(40)
const SENDER = '0x' + 'a'.repeat(40)
const pad = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2)

const transferLog = (over: Partial<any> = {}) => ({
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    pad(SENDER),
    pad(DEPOSIT),
  ],
  data: '0x' + (10_000_000).toString(16), // $10 USDC
  ...over,
})

describe.skipIf(!present)('findUsdcTransfer — the deposit verifier', () => {
  const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

  it('accepts a canonical transfer and reads micro-USDC exactly', () => {
    const r = mod.findUsdcTransfer([transferLog()], token, DEPOSIT, SENDER)
    expect(r).toEqual({ amount_micro: 10_000_000 })
  })

  it('rejects wrong token contract (fake-USDC attack)', () => {
    const log = transferLog({ address: '0x' + '1'.repeat(40) })
    expect(mod.findUsdcTransfer([log], token, DEPOSIT, SENDER)).toBeNull()
  })

  it('rejects transfers from an unlinked sender (claim-theft attack)', () => {
    const other = '0x' + 'b'.repeat(40)
    const log = transferLog({ topics: [transferLog().topics[0], pad(other), pad(DEPOSIT)] })
    expect(mod.findUsdcTransfer([log], token, DEPOSIT, SENDER)).toBeNull()
  })

  it('rejects transfers to the wrong recipient', () => {
    const other = '0x' + 'c'.repeat(40)
    const log = transferLog({ topics: [transferLog().topics[0], pad(SENDER), pad(other)] })
    expect(mod.findUsdcTransfer([log], token, DEPOSIT, SENDER)).toBeNull()
  })

  it('rejects non-Transfer events on the right contract (Approval spoof)', () => {
    const log = transferLog({ topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', pad(SENDER), pad(DEPOSIT)] })
    expect(mod.findUsdcTransfer([log], token, DEPOSIT, SENDER)).toBeNull()
  })

  it('rejects zero and >$10k amounts', () => {
    expect(mod.findUsdcTransfer([transferLog({ data: '0x0' })], token, DEPOSIT, SENDER)).toBeNull()
    const big = '0x' + (10_000_000_001).toString(16)
    expect(mod.findUsdcTransfer([transferLog({ data: big })], token, DEPOSIT, SENDER)).toBeNull()
  })

  it('empty/garbage logs are null, not throws', () => {
    expect(mod.findUsdcTransfer([], token, DEPOSIT, SENDER)).toBeNull()
    expect(mod.findUsdcTransfer(null as any, token, DEPOSIT, SENDER)).toBeNull()
    expect(mod.findUsdcTransfer([{}, { topics: null }], token, DEPOSIT, SENDER)).toBeNull()
  })
})

describe.skipIf(!present)('hex helpers', () => {
  it('topicToAddress extracts the last 20 bytes', () => {
    expect(mod.topicToAddress(pad(SENDER))).toBe(SENDER.toLowerCase())
    expect(mod.topicToAddress('0xshort')).toBe('')
  })
  it('strict tx-hash and address shapes', () => {
    expect(mod.isTxHash('0x' + 'f'.repeat(64))).toBe(true)
    expect(mod.isTxHash('0x' + 'f'.repeat(63))).toBe(false)
    expect(mod.isAddress(DEPOSIT)).toBe(true)
    expect(mod.isAddress(DEPOSIT + '00')).toBe(false)
  })
  it('hexToBigInt handles garbage without throwing', () => {
    expect(mod.hexToBigInt('0xff')).toBe(BigInt(255))
    expect(mod.hexToBigInt('not-hex')).toBe(BigInt(0))
  })
})
