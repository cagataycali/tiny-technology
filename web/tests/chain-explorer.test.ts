// @vitest-environment node
//
// The /chain explorer's pure core. The stakes: validators guard URL segments
// that become RPC parameters, the decoder renders on-chain truth (a guessed
// transfer is a lie on an audit surface), and the uint256 clamp keeps one
// hostile mint from crashing the page someone opened to investigate it.
import { describe, it, expect } from 'vitest'
import {
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
  addressFromTopic,
  decodeTransferLog,
  hexToNumber,
  isAddress,
  isTxHash,
  lookbackFrom,
  lookupTarget,
  shortHex,
  transferKind,
  usdMicro,
} from '@/lib/chain/explorer-core'

const HASH = `0x${'ab'.repeat(32)}`
const ADDR = `0x${'12'.repeat(20)}`
const topicFor = (addr: string) => `0x${addr.slice(2).padStart(64, '0')}`

describe('validators / lookup routing', () => {
  it('a 32-byte hash is a tx, a 20-byte hex is an address', () => {
    expect(lookupTarget(HASH)).toBe('tx')
    expect(lookupTarget(ADDR)).toBe('address')
    expect(lookupTarget(`  ${ADDR}  `)).toBe('address')
  })
  it('anything else routes nowhere — the segment is an RPC parameter', () => {
    for (const junk of ['', '0x', 'lazy', `0x${'g'.repeat(64)}`, `0x${'ab'.repeat(31)}`, null, 42]) {
      expect(lookupTarget(junk)).toBe(null)
    }
    expect(isTxHash(ADDR)).toBe(false)
    expect(isAddress(HASH)).toBe(false)
  })
})

describe('hexToNumber', () => {
  it('parses quantities and clamps beyond MAX_SAFE_INTEGER instead of Infinity', () => {
    expect(hexToNumber('0x0')).toBe(0)
    expect(hexToNumber('0x2710')).toBe(10_000)
    expect(hexToNumber(`0x${'f'.repeat(64)}`)).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('junk is null, not zero — a malformed log is not a free transfer', () => {
    expect(hexToNumber(undefined)).toBe(null)
    expect(hexToNumber('10000')).toBe(null)
    expect(hexToNumber('0xzz')).toBe(null)
  })
})

describe('usdMicro', () => {
  it('formats dollars, sub-cent amounts, and says when it clamped', () => {
    expect(usdMicro(10_000)).toBe('$0.01')
    expect(usdMicro(1_000_000)).toBe('$1.00')
    expect(usdMicro(100)).toBe('$0.0001')
    expect(usdMicro(0)).toBe('$0.00')
    expect(usdMicro(null)).toBe('—')
    expect(usdMicro(Number.MAX_SAFE_INTEGER)).toContain('clamped')
  })
})

describe('decodeTransferLog', () => {
  const log = {
    topics: [TRANSFER_TOPIC, topicFor(ADDR), topicFor(ZERO_ADDRESS)],
    data: '0x2710',
    transactionHash: HASH,
    blockNumber: '0xa',
  }
  it('decodes a real Transfer', () => {
    const t = decodeTransferLog(log)!
    expect(t.from).toBe(ADDR)
    expect(t.to).toBe(ZERO_ADDRESS)
    expect(t.micro).toBe(10_000)
    expect(t.txHash).toBe(HASH)
    expect(t.blockNumber).toBe(10)
  })
  it('refuses non-Transfer topics and thin logs — never guesses', () => {
    expect(decodeTransferLog({ ...log, topics: [`0x${'0'.repeat(64)}`, ...log.topics.slice(1)] })).toBe(null)
    expect(decodeTransferLog({ ...log, topics: [TRANSFER_TOPIC] })).toBe(null)
    expect(decodeTransferLog(null)).toBe(null)
  })
  it('addressFromTopic only accepts a 32-byte word', () => {
    expect(addressFromTopic(topicFor(ADDR))).toBe(ADDR)
    expect(addressFromTopic(ADDR)).toBe('')
  })
})

describe('transferKind / lookback / shortHex', () => {
  it('mints come from the zero address, burns go to it', () => {
    expect(transferKind({ from: ZERO_ADDRESS, to: ADDR })).toBe('mint')
    expect(transferKind({ from: ADDR, to: ZERO_ADDRESS })).toBe('burn')
    expect(transferKind({ from: ADDR, to: ADDR })).toBe('transfer')
  })
  it('lookback floors at genesis', () => {
    expect(lookbackFrom(100, 10_000)).toBe(0)
    expect(lookbackFrom(50_000, 10_000)).toBe(40_000)
  })
  it('shortHex keeps short strings whole', () => {
    expect(shortHex('0xabcd')).toBe('0xabcd')
    expect(shortHex(HASH, 8, 6)).toBe(`0xabababab…ababab`)
  })
})
