// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  decodeCalldata,
  decodeEventLog,
  microToNumber,
  timestampLabel,
  FUNCTIONS,
  EVENTS,
} from '@/lib/chain/calldata'
import { usdMicro } from '@/lib/chain/explorer-core'
import { keccak256, toHex } from 'viem'

/**
 * 🧾 The explorer's input/output decoder.
 *
 * The two calldata fixtures below are REAL transactions mined on the live tiny
 * chain (8469), copied byte-for-byte from `eth_getTransactionByHash`, not
 * hand-assembled from the ABI. That distinction is the point: a fixture built
 * from the same mental model as the decoder proves only that the model is
 * self-consistent. These prove the decoder reads what the chain actually
 * contains — including the ABI's dynamic-`bytes` tail, which is where a
 * hand-written fixture would most likely have been wrong in the same direction
 * as the code.
 */

// tx 0xcbe0fa41…3fdd — an x402 settlement: transferWithAuthorization(…, bytes)
const SETTLE_INPUT =
  '0xcf092995' +
  '000000000000000000000000f33b014377c04603eb502596cde607b698057dfa' +
  '000000000000000000000000f33b014377c04603eb502596cde607b698057dfa' +
  '0000000000000000000000000000000000000000000000000000000000002710' +
  '000000000000000000000000000000000000000000000000000000006a657167' +
  '000000000000000000000000000000000000000000000000000000006a65721b' +
  '86a9d9973a1a13b405bf623348660de5bd66ba61a4b5a2ebcbb3c84b5416f381' +
  '00000000000000000000000000000000000000000000000000000000000000e0' +
  '0000000000000000000000000000000000000000000000000000000000000041' +
  '10d5285e3cb991f5241423d4498e0e47bfb5fe668ed07493a1685703cbd1958a' +
  '0d2ccfb4de92f91778f8e5daf4f5d6727ddc8187c72fff019f2b55d90dc31fb8' +
  '1b00000000000000000000000000000000000000000000000000000000000000'

// tx 0x5afc123a…e000 — a faucet mint: mint(address,uint256)
const MINT_INPUT =
  '0x40c10f19' +
  '0000000000000000000000000fcc80f730048db58f4f370c12c1d2d859cbdb13' +
  '00000000000000000000000000000000000000000000000000000000002dc6c0'

describe('decodeCalldata — real settlements from the live chain', () => {
  it('explains an x402 settlement, including the offline-signature tail', () => {
    const d = decodeCalldata(SETTLE_INPUT)
    expect(d).not.toBeNull()
    expect(d!.name).toBe('transferWithAuthorization')
    expect(d!.selector).toBe('0xcf092995')
    const byName = Object.fromEntries(d!.args.map((a) => [a.name, a.value]))
    expect(byName.from).toBe('0xf33b014377c04603eb502596cde607b698057dfa')
    expect(byName.to).toBe('0xf33b014377c04603eb502596cde607b698057dfa')
    expect(byName.value).toBe('10000') // 0x2710 micro = $0.01
    expect(byName.nonce).toBe('0x86a9d9973a1a13b405bf623348660de5bd66ba61a4b5a2ebcbb3c84b5416f381')
    // The dynamic tail: a 65-byte ECDSA signature, read via its offset word
    // (0xe0 = 224). Getting this wrong is how a decoder renders garbage.
    expect(byName.signature).toBe(
      '0x10d5285e3cb991f5241423d4498e0e47bfb5fe668ed07493a1685703cbd1958a' +
        '0d2ccfb4de92f91778f8e5daf4f5d6727ddc8187c72fff019f2b55d90dc31fb81b',
    )
    expect((byName.signature.length - 2) / 2).toBe(65)
  })

  it('renders the settlement amount as the same dollars the rest of the explorer shows', () => {
    const d = decodeCalldata(SETTLE_INPUT)!
    const value = d.args.find((a) => a.name === 'value')!
    expect(value.kind).toBe('micro')
    expect(usdMicro(microToNumber(value.value))).toBe('$0.01')
  })

  it('turns the EIP-3009 validity window into readable dates', () => {
    const d = decodeCalldata(SETTLE_INPUT)!
    const after = d.args.find((a) => a.name === 'validAfter')!
    const before = d.args.find((a) => a.name === 'validBefore')!
    expect(after.kind).toBe('timestamp')
    // 0x6a657167 / 0x6a65721b — a 180-second window, as the payer signed it.
    expect(Number(before.value) - Number(after.value)).toBe(180)
    expect(timestampLabel(before.value)).toMatch(/GMT$/)
  })

  it('explains a mint, and says who is allowed to do it', () => {
    const d = decodeCalldata(MINT_INPUT)
    expect(d).not.toBeNull()
    expect(d!.name).toBe('mint')
    const byName = Object.fromEntries(d!.args.map((a) => [a.name, a.value]))
    expect(byName.to).toBe('0x0fcc80f730048db58f4f370c12c1d2d859cbdb13')
    expect(byName.value).toBe('3000000') // $3.00
    expect(usdMicro(microToNumber(byName.value))).toBe('$3.00')
    expect(d!.summary).toMatch(/owner/)
  })

  it('keys on SELECTOR, so the two transferWithAuthorization overloads differ', () => {
    // Both are named transferWithAuthorization in Solidity. The 7-arg form ends
    // in `bytes signature`; the 9-arg form ends in split v/r/s. A name-keyed
    // table would decode one as the other and mislabel the trailing words.
    expect(FUNCTIONS['0xcf092995'].name).toBe('transferWithAuthorization')
    expect(FUNCTIONS['0xe3ee160e'].name).toBe('transferWithAuthorization')
    expect(FUNCTIONS['0xcf092995'].params.at(-1)).toEqual({ name: 'signature', kind: 'bytes' })
    expect(FUNCTIONS['0xe3ee160e'].params.at(-1)).toEqual({ name: 's', kind: 'bytes32' })
  })
})

describe('decodeCalldata — refuses rather than guessing', () => {
  it('returns null for a plain ETH send and for junk', () => {
    // No calldata is not an empty call — it's a value transfer, which the page
    // must describe differently rather than as an unnamed function.
    expect(decodeCalldata('0x')).toBeNull()
    expect(decodeCalldata('')).toBeNull()
    expect(decodeCalldata(null)).toBeNull()
    expect(decodeCalldata(undefined)).toBeNull()
    expect(decodeCalldata('0xzz')).toBeNull()
    expect(decodeCalldata('not hex')).toBeNull()
    expect(decodeCalldata('0xabc')).toBeNull() // odd length
  })

  it('returns null for an unknown selector instead of a nameless decode', () => {
    // A contract we don't model (TinyValidators.stake, TinyIssuance.claim) must
    // fall back to raw hex, not be described with TinyUSDC argument names.
    expect(decodeCalldata(`0xdeadbeef${'0'.repeat(64)}`)).toBeNull()
  })

  it('refuses calldata that is SHORTER than the signature promises', () => {
    // The words simply aren't there. Padding them with zeros would render a
    // transfer to 0x0 of $0.00 — a plausible-looking event that never happened.
    expect(decodeCalldata('0x40c10f19')).toBeNull()
    expect(decodeCalldata(`0x40c10f19${'0'.repeat(64)}`)).toBeNull() // one word short
    expect(decodeCalldata(SETTLE_INPUT.slice(0, 200))).toBeNull()
  })

  it('accepts calldata LONGER than the signature — solidity does', () => {
    // Trailing calldata is ignored by the EVM, so this transaction really did
    // execute with these arguments; refusing it would hide a real settlement.
    const d = decodeCalldata(`${MINT_INPUT}${'ab'.repeat(32)}`)
    expect(d?.name).toBe('mint')
    expect(d?.args.find((a) => a.name === 'value')?.value).toBe('3000000')
  })

  it('refuses an address word with a dirty high pad', () => {
    // 32 bytes where only the low 20 are an address. If the top bytes are set,
    // this word is NOT an address — truncating it invents a counterparty.
    const dirty = `0x40c10f19${'11'.repeat(32)}${'0'.repeat(64)}`
    expect(decodeCalldata(dirty)).toBeNull()
  })

  it('refuses a dynamic bytes offset that points outside the calldata', () => {
    // The one place a decoder can be walked out of bounds by its own input.
    const head = SETTLE_INPUT.slice(0, 8 + 6 * 64 + 2) // through the nonce word
    const badOffset = 'f'.repeat(4).padStart(64, '0') // 0xffff — way past the end
    expect(decodeCalldata(head + badOffset)).toBeNull()
  })

  it('refuses a MISALIGNED bytes offset even when every other check passes', () => {
    // Isolates the `offset % 32` check. Built deliberately so NO other guard can
    // be the one refusing: offset 0xf0 = 240 (240 % 32 === 16, misaligned) points
    // at a length word that reads exactly 2, followed by exactly 2 bytes of
    // payload. In-bounds, sane length, complete payload — only alignment is
    // wrong. Verified by mutation: deleting the `% 32` check makes this the one
    // assertion that fails, and my first attempt at this fixture was caught by
    // the huge-length guard instead, so the mutant survived and looked fine.
    //
    // Why it matters: a misaligned read straddles two ABI words, so the length
    // it finds is the tail of one value joined to the head of the next, and the
    // "signature" it returns is bytes that were never a signature.
    const head = SETTLE_INPUT.slice(0, 2 + 8 + 6 * 64) // selector + 6 static words
    const offset = (240).toString(16).padStart(64, '0')
    const filler = '0'.repeat(32) // pad up to the misaligned length word
    const lenWord = (2).toString(16).padStart(64, '0')
    expect(decodeCalldata(`${head}${offset}${filler}${lenWord}beef`)).toBeNull()
  })

  it('refuses a bytes length that overruns the payload', () => {
    const head = SETTLE_INPUT.slice(0, 8 + 6 * 64 + 2)
    const offset = (224).toString(16).padStart(64, '0')
    const hugeLen = (5000).toString(16).padStart(64, '0')
    expect(decodeCalldata(head + offset + hugeLen + 'ab'.repeat(10))).toBeNull()
  })
})

describe('decodeEventLog — the output side', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
  const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`

  it('decodes a Transfer with its amount from data', () => {
    const d = decodeEventLog({
      topics: [TRANSFER, pad('0xf33b014377c04603eb502596cde607b698057dfa'), pad('0x0fcc80f730048db58f4f370c12c1d2d859cbdb13')],
      data: `0x${(10000).toString(16).padStart(64, '0')}`,
    })
    expect(d?.name).toBe('Transfer')
    expect(d!.args.map((a) => a.value)).toEqual([
      '0xf33b014377c04603eb502596cde607b698057dfa',
      '0x0fcc80f730048db58f4f370c12c1d2d859cbdb13',
      '10000',
    ])
  })

  it('decodes AuthorizationUsed, which carries NO amount', () => {
    // Both args are indexed, so `data` is '0x'. A decoder that expected a value
    // in data would read '0x' as zero and render a $0.00 settlement — the
    // amount lives in the paired Transfer event, not here.
    const d = decodeEventLog({
      topics: [USED, pad('0xf33b014377c04603eb502596cde607b698057dfa'), '0x86a9d9973a1a13b405bf623348660de5bd66ba61a4b5a2ebcbb3c84b5416f381'],
      data: '0x',
    })
    expect(d?.name).toBe('AuthorizationUsed')
    expect(d!.args).toHaveLength(2)
    expect(d!.args.some((a) => a.kind === 'micro')).toBe(false)
    expect(d!.args[1].value).toBe('0x86a9d9973a1a13b405bf623348660de5bd66ba61a4b5a2ebcbb3c84b5416f381')
    expect(d!.summary).toMatch(/replay/)
  })

  it('refuses a log whose indexed-argument count disagrees with the ABI', () => {
    // An indexed miscount shifts every value one position — the failure mode
    // that attributes a payment to the wrong address while looking successful.
    //
    // Both cases below are otherwise WELL-FORMED — valid addresses, a valid
    // value word — so the topic-count check is the only thing that can refuse
    // them. Without that isolation a laxer check still passes this test by
    // tripping over a malformed address or missing data instead.
    const value = `0x${(10000).toString(16).padStart(64, '0')}`
    // One topic too many: a Transfer-shaped log from a contract whose event has
    // three indexed args. Decoding it silently drops the third and reports the
    // first two as from/to — a real transfer between the wrong parties.
    expect(
      decodeEventLog({
        topics: [TRANSFER, pad('0x' + '11'.repeat(20)), pad('0x' + '22'.repeat(20)), pad('0x' + '33'.repeat(20))],
        data: value,
      }),
    ).toBeNull()
    // One too few, with valid data present.
    expect(decodeEventLog({ topics: [TRANSFER, pad('0x' + '11'.repeat(20))], data: value })).toBeNull()
    // And the zero-data events, where a lax count check has nothing else to
    // trip over: AuthorizationUsed declares no data args, so a 3-topic version
    // would decode CLEANLY under a `topics.length < 1` guard.
    expect(
      decodeEventLog({
        topics: [USED, pad('0x' + '11'.repeat(20)), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)],
        data: '0x',
      }),
    ).toBeNull()
  })

  it('refuses unknown topics, malformed topics, and short data', () => {
    expect(decodeEventLog({ topics: ['0xdeadbeef'], data: '0x' })).toBeNull()
    expect(decodeEventLog({ topics: [], data: '0x' })).toBeNull()
    expect(decodeEventLog(null)).toBeNull()
    expect(decodeEventLog({ topics: [TRANSFER, 'not-a-topic', pad('0x' + '22'.repeat(20))], data: '0x' })).toBeNull()
    // Transfer promises a value word; '0x' would decode as $0.00.
    expect(decodeEventLog({ topics: [TRANSFER, pad('0x' + '11'.repeat(20)), pad('0x' + '22'.repeat(20))], data: '0x' })).toBeNull()
  })
})

describe('formatters clamp instead of overflowing', () => {
  it('microToNumber clamps a uint256 to the visible ceiling', () => {
    // Same family as usdMicro's clamp: a hostile mint must render as "clamped",
    // never as Infinity, on the page someone opens to audit that mint.
    const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    expect(microToNumber(max)).toBe(Number.MAX_SAFE_INTEGER)
    expect(usdMicro(microToNumber(max))).toMatch(/clamped/)
    expect(microToNumber('10000')).toBe(10000)
    expect(microToNumber('not a number')).toBeNull()
    expect(microToNumber('')).toBeNull()
  })

  it('timestampLabel rejects sentinels rather than printing a fake date', () => {
    // EIP-3009 uses 0 for "no lower bound" and uint256-max for "no deadline".
    // Rendering those as 1970 and as year 5e11 would both read as real limits.
    expect(timestampLabel('0')).toBeNull()
    expect(timestampLabel('115792089237316195423570985008687907853269984665640564039457584007913129639935')).toBeNull()
    expect(timestampLabel('1785028028')).toMatch(/2026/)
  })
})

describe('participation calls — the point of an open chain', () => {
  it('explains staking, the transaction by which a stranger joins', () => {
    // Real shape from the live 8470 devnet: stake(uint256) with 1000 USDC.
    const d = decodeCalldata(`0xa694fc3a${(1_000_000_000).toString(16).padStart(64, '0')}`)
    expect(d?.name).toBe('stake')
    expect(d!.args[0]).toEqual({ name: 'amount', kind: 'micro', value: '1000000000' })
    expect(usdMicro(microToNumber(d!.args[0].value))).toBe('$1,000.00')
    expect(d!.summary).toMatch(/anyone joins/)
  })

  it('explains a zero-argument participation call with name + summary alone', () => {
    // rotate() has no arguments; the explanation IS the summary. It must still
    // decode (not fall through to "not decoded"), and must note it's open to all.
    const d = decodeCalldata('0xd992818d')
    expect(d?.name).toBe('rotate')
    expect(d!.args).toEqual([])
    expect(d!.summary).toMatch(/[Pp]ermissionless/)
  })

  it('decodes a serve-reward claim without walking its bytes[] tail', () => {
    // The five static words before `bytes[] sigs` are what explain the claim; a
    // dynamic array of dynamic bytes is a second indirection this decoder does
    // not walk. Static-word layout is fixed regardless of what follows, so the
    // decode is correct as far as it goes — and it must not claim more.
    const w = (n: number | string) => BigInt(n).toString(16).padStart(64, '0')
    const input =
      '0x6b055035' +
      `000000000000000000000000${'ab'.repeat(20)}` +
      w(7) + // epoch
      w(42) + // requestCount
      w(4_000_000) + // volumeMicro
      w(6_000_000) + // epochTotalVolumeMicro
      w(192) // the bytes[] offset — present, not decoded
    const d = decodeCalldata(input)
    expect(d?.name).toBe('claimServeReward')
    expect(d!.args.map((a) => a.name)).toEqual([
      'server',
      'epoch',
      'requestCount',
      'volumeMicro',
      'epochTotalVolumeMicro',
    ])
    expect(d!.args.find((a) => a.name === 'volumeMicro')!.value).toBe('4000000')
    // And it says the attested part is attested, not chain-proven.
    expect(d!.summary).toMatch(/attest/i)
  })

  it('walks all four dynamic tails of an equivocation proof', () => {
    // The court's transaction. Four `bytes` params means four offset heads and
    // four length-prefixed tails; a decoder that mixed up one offset would read
    // a seal as a header. Built to the ABI's layout, tails in order.
    const w = (n: number | string) => BigInt(n).toString(16).padStart(64, '0')
    const tails = [
      'aa'.repeat(90), // canonicalHeader
      'bb'.repeat(65), // canonicalSeal — a commit signature
      'cc'.repeat(90), // conflictingHeader
      'dd'.repeat(65), // conflictingSeal
    ]
    // Heads: height + 4 offsets = 5 words = 160 bytes before the first tail.
    let cursor = 160
    const heads: string[] = []
    let body = ''
    for (const t of tails) {
      heads.push(w(cursor))
      const padded = t.padEnd(Math.ceil(t.length / 64) * 64, '0')
      body += w(t.length / 2) + padded
      cursor += 32 + padded.length / 2
    }
    const d = decodeCalldata(`0x906a494b${w(2732)}${heads.join('')}${body}`)
    expect(d?.name).toBe('submitEquivocation')
    const byName = Object.fromEntries(d!.args.map((a) => [a.name, a.value]))
    expect(byName.height).toBe('2732')
    expect(byName.canonicalSeal).toBe(`0x${'bb'.repeat(65)}`)
    expect(byName.conflictingSeal).toBe(`0x${'dd'.repeat(65)}`) // not confused with the canonical one
    expect(byName.canonicalHeader).toBe(`0x${'aa'.repeat(90)}`)
    expect(d!.summary).toMatch(/entrapment/) // says WHY there's no bounty
  })

  it('leaves setAttestors undecoded rather than partially decoded', () => {
    // Known gap, asserted so it stays deliberate: two dynamic ARRAYS. Reading
    // its leading words would name an attestor-set change without its set.
    expect(decodeCalldata(`0xe861b37f${'0'.repeat(192)}`)).toBeNull()
  })

  it('decodes participation EVENTS, including non-integer data fields', () => {
    // Equivocation puts two bytes32 digests and an address in `data`. Decoding
    // those as uint256 would print a 78-digit number where an address belongs.
    const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
    const w = (n: number) => BigInt(n).toString(16).padStart(64, '0')
    const d = decodeEventLog({
      address: '0x2B0D36FACd61B71CC05ab8F3D2355ec3631c0dd5',
      topics: [
        '0xcd6805dcd379b183528a991f0fc8fc0b0edc68e5cf4304d3dc57a5a6bfa51f4e',
        pad(`0x${'11'.repeat(20)}`),
        // 0x-prefixed on purpose: this fixture was first written with a bare
        // `w(2732)` and the decoder refused the whole log, which is right — a
        // topic isn't hex without it. Real node output always carries the 0x.
        `0x${w(2732)}`,
      ],
      data: `0x${w(1)}${'aa'.repeat(32)}${'bb'.repeat(32)}${w(2732)}000000000000000000000000${'cc'.repeat(20)}`,
    })
    expect(d?.name).toBe('Equivocation')
    const byName = Object.fromEntries(d!.args.map((a) => [a.name, a.value]))
    expect(byName.validator).toBe(`0x${'11'.repeat(20)}`)
    expect(byName.canonicalHash).toBe(`0x${'aa'.repeat(32)}`)
    expect(byName.reporter).toBe(`0x${'cc'.repeat(20)}`) // an address, not a huge integer
    // Honest about what the court does — it convicts, it doesn't burn.
    expect(d!.summary).toMatch(/burns no stake/)
  })

  it('decodes the event that proves issuance is locked to one minter', () => {
    const d = decodeEventLog({
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      topics: [
        '0xb213eb539d7e707d53a0572acf930275cba2db8ac754914c28256364f161204e',
        `0x${'ee'.repeat(20).padStart(64, '0')}`,
      ],
      data: '0x', // all-indexed: no data at all, and none expected
    })
    expect(d?.name).toBe('ServeDistributorSet')
    expect(d!.args).toEqual([{ name: 'distributor', kind: 'address', value: `0x${'ee'.repeat(20)}` }])
    expect(d!.summary).toMatch(/locked/)
  })

  it('leaves AttestorSetChanged undecoded — its data leads with a dynamic array', () => {
    // Paired with setAttestors: naming the event while misreading its threshold
    // would be worse than showing the raw log.
    expect(
      decodeEventLog({
        address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        topics: ['0xd12c33daab335f8573b82672079ed379bc909f0c3fa642e197a16d90cf5636ee'],
        data: `0x${'0'.repeat(192)}`,
      }),
    ).toBeNull()
  })

  it('reports the EMITTER, because the decoder matches on topic alone', () => {
    // A log from an unrelated contract with a colliding topic decodes as this
    // event; the emitter is the only thing that tells a reader whose it was.
    const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`
    const d = decodeEventLog({
      address: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
      topics: ['0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90', pad(`0x${'11'.repeat(20)}`)],
      data: `0x${BigInt(1_000_000_000).toString(16).padStart(64, '0')}${BigInt(2_000_000_000).toString(16).padStart(64, '0')}`,
    })
    expect(d?.name).toBe('Staked')
    expect(d!.emitter).toBe('0x0165878a594ca255338adfa4d48449f69242eb8f') // lowercased
    expect(d!.args.find((a) => a.name === 'total')!.value).toBe('2000000000')
  })
})

// The two artifact cross-checks below need forge build outputs, which are
// gitignored: a fresh clone hasn't compiled the contracts yet. Skip rather
// than fail — `cd chain && npm run compile` (and the multinode equivalent)
// turns them back on.
const HAS_MULTINODE_ARTIFACTS = existsSync(
  join(process.cwd(), 'chain/multinode/artifacts/TinyValidators.sol/TinyValidators.json'),
)
const HAS_USDC_ARTIFACT = existsSync(join(process.cwd(), 'chain/artifacts/TinyUSDC.sol/TinyUSDC.json'))

describe.skipIf(!HAS_MULTINODE_ARTIFACTS || !HAS_USDC_ARTIFACT)('the participation tables match the multinode artifacts', () => {
  // Same cross-check as the TinyUSDC one below, over the contracts that make
  // this chain joinable. These selectors were read off a LIVE devnet's
  // undecodable transactions, so a wrong entry here would leave the
  // participation history unreadable again.
  const artifact = (name: string) =>
    JSON.parse(readFileSync(join(process.cwd(), `chain/multinode/artifacts/${name}.sol/${name}.json`), 'utf8'))
  const CONTRACTS = ['TinyValidators', 'TinyIssuance', 'TinyServeRewards', 'TinySlashing']
  const abis = HAS_MULTINODE_ARTIFACTS ? CONTRACTS.map(artifact).map((a) => a.abi as any[]) : []
  const allFns = abis.flat().filter((e) => e.type === 'function')
  const allEvents = abis.flat().filter((e) => e.type === 'event')

  // Which selectors above belong to the multinode set (everything not in the
  // TinyUSDC ABI). Derived, not listed, so a new entry is covered automatically.
  const usdcNames = new Set(
    !HAS_USDC_ARTIFACT ? [] :
    (JSON.parse(readFileSync(join(process.cwd(), 'chain/artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8')).abi as any[])
      .filter((e) => e.type === 'function')
      .map((e) => e.name),
  )

  it('every participation selector names a real function with matching arg names', () => {
    const checked: string[] = []
    for (const [selector, spec] of Object.entries(FUNCTIONS)) {
      if (usdcNames.has(spec.name)) continue
      const candidates = allFns.filter((f) => f.name === spec.name)
      expect(candidates.length, `${spec.name} (${selector}) is in no multinode ABI`).toBeGreaterThan(0)
      // Length-AWARE, not length-equal: claimServeReward deliberately models
      // only its leading static words and stops before the bytes[] tail.
      const match = candidates.find((c) => c.inputs.length >= spec.params.length)
      expect(match, `${spec.name} has no overload with ≥${spec.params.length} args`).toBeTruthy()
      expect(match.inputs.slice(0, spec.params.length).map((i: any) => i.name)).toEqual(spec.params.map((p) => p.name))
      checked.push(spec.name)
    }
    // The four selectors that were literally unreadable on the live devnet.
    expect(checked).toContain('stake')
    expect(checked).toContain('unstake')
    expect(checked).toContain('claimValidatorReward')
    expect(checked).toContain('claimServeReward')
  })

  it('every participation event matches its ABI indexed/data split', () => {
    const usdcEventNames = new Set(['Transfer', 'Approval', 'AuthorizationUsed', 'AuthorizationCanceled'])
    let checked = 0
    for (const spec of Object.values(EVENTS)) {
      if (usdcEventNames.has(spec.name)) continue
      const ev = allEvents.find((e) => e.name === spec.name)
      expect(ev, `${spec.name} is in no multinode ABI`).toBeTruthy()
      expect(ev.inputs.filter((i: any) => i.indexed).length, `${spec.name} indexed count`).toBe(spec.topicArgs.length)
      expect(ev.inputs.filter((i: any) => !i.indexed).length, `${spec.name} data count`).toBe(spec.dataArgs.length)
      // Names AND order, since the UI prints them as labels.
      expect(ev.inputs.filter((i: any) => i.indexed).map((i: any) => i.name)).toEqual(spec.topicArgs.map((p) => p.name))
      expect(ev.inputs.filter((i: any) => !i.indexed).map((i: any) => i.name)).toEqual(spec.dataArgs.map((p) => p.name))
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(9)
  })
})

describe.skipIf(!HAS_USDC_ARTIFACT)('the selector and topic tables match the shipped TinyUSDC artifact', () => {
  // The whole decoder rests on these constants. A hand-typed selector that is
  // wrong makes a real function unexplainable; one that COLLIDES with another
  // contract's would explain it wrongly. Recompute from the artifact both chains
  // deploy rather than trusting what's typed above.
  const artifact = !HAS_USDC_ARTIFACT ? { abi: [] } : JSON.parse(
    readFileSync(join(process.cwd(), 'chain/artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'),
  )

  // The two cross-checks PARTITION the tables by which ABI a name lives in:
  // this one takes the TinyUSDC names, the participation one takes everything
  // else (`if (usdcNames.has(...)) continue`). Membership is derived from the
  // artifacts on both sides, so adding an entry to either contract keeps it
  // covered by exactly one check — and never silently by neither.
  const usdcFnNames = new Set(
    (artifact.abi as any[]).filter((e) => e.type === 'function').map((e) => e.name),
  )

  it('every modelled selector exists in the ABI with the right argument count', () => {
    const abi: any[] = artifact.abi
    for (const [selector, spec] of Object.entries(FUNCTIONS)) {
      if (!usdcFnNames.has(spec.name)) continue
      const candidates = abi.filter((e) => e.type === 'function' && e.name === spec.name)
      expect(candidates.length, `${spec.name} missing from ABI`).toBeGreaterThan(0)
      const match = candidates.find((c) => c.inputs.length === spec.params.length)
      expect(match, `${selector} (${spec.name}) has no ABI overload with ${spec.params.length} args`).toBeTruthy()
      // Argument NAMES must match the ABI too: the UI prints them as labels, so
      // a renamed argument is a wrong explanation of a correct decode.
      expect(match.inputs.map((i: any) => i.name)).toEqual(spec.params.map((p) => p.name))
    }
  })

  it('every modelled event exists with the ABI’s indexed split', () => {
    const abi: any[] = artifact.abi
    let checked = 0
    for (const [, spec] of Object.entries(EVENTS)) {
      const ev = abi.find((e) => e.type === 'event' && e.name === spec.name)
      if (!ev) continue // a participation event — checked against its own ABI above
      expect(ev.inputs.filter((i: any) => i.indexed).length).toBe(spec.topicArgs.length)
      expect(ev.inputs.filter((i: any) => !i.indexed).length).toBe(spec.dataArgs.length)
      checked++
    }
    // Without this, the `continue` above would turn a typo'd event NAME into a
    // skipped check instead of a failure, and the table could empty out silently.
    expect(checked).toBeGreaterThanOrEqual(4)
  })

  it('every key is the REAL keccak hash of a shipped signature', () => {
    // The strongest form of this check, and the one the others approximate: a
    // selector/topic is not a label, it is keccak(signature). Matching by name
    // and arity would still pass if a hex digit were mistyped — and a mistyped
    // key means a real transaction silently stops decoding, exactly the failure
    // that made the participation history unreadable in the first place.
    const all = [
      'chain/artifacts/TinyUSDC.sol/TinyUSDC.json',
      ...['TinyValidators', 'TinyIssuance', 'TinyServeRewards', 'TinySlashing'].map(
        (n) => `chain/multinode/artifacts/${n}.sol/${n}.json`,
      ),
    ].flatMap((p) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8')).abi as any[])
    const sigOf = (e: any) => `${e.name}(${e.inputs.map((i: any) => i.type).join(',')})`
    for (const [selector, spec] of Object.entries(FUNCTIONS)) {
      const hit = all
        .filter((e) => e.type === 'function' && e.name === spec.name)
        .find((e) => keccak256(toHex(sigOf(e))).slice(0, 10) === selector)
      expect(hit, `${selector} is not keccak of any shipped ${spec.name}(...) signature`).toBeTruthy()
    }
    for (const [topic, spec] of Object.entries(EVENTS)) {
      const hit = all
        .filter((e) => e.type === 'event' && e.name === spec.name)
        .find((e) => keccak256(toHex(sigOf(e))) === topic)
      expect(hit, `${topic} is not keccak of any shipped ${spec.name}(...) signature`).toBeTruthy()
    }
  })

  it('no modelled name escapes BOTH cross-checks', () => {
    // The partition must be exhaustive: a name in neither ABI is a name nothing
    // verifies. Cheaper to assert here than to discover from a wrong page.
    const multinode = ['TinyValidators', 'TinyIssuance', 'TinyServeRewards', 'TinySlashing']
      .map((n) =>
        JSON.parse(readFileSync(join(process.cwd(), `chain/multinode/artifacts/${n}.sol/${n}.json`), 'utf8')),
      )
      .flatMap((a) => a.abi as any[])
    const known = new Set([...(artifact.abi as any[]), ...multinode].map((e) => e.name))
    for (const spec of Object.values(FUNCTIONS)) expect(known, `function ${spec.name}`).toContain(spec.name)
    for (const spec of Object.values(EVENTS)) expect(known, `event ${spec.name}`).toContain(spec.name)
  })
})
