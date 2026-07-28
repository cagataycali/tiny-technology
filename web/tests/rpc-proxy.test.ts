// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { ALLOWED, partition } from '@/chain/rpc-proxy.mjs'
import {
  RAW_TX_METHOD,
  RAW_TX_REJECTED,
  rawTxParam,
  recoverRawTxSender,
  screenRawTx,
  screenRawTxBatch,
} from '@/chain/raw-tx-guard.mjs'
import { WELL_KNOWN_KEYS, WELL_KNOWN_ADDRESSES } from '@/chain/dev-keys.mjs'

/**
 * 🌐 THE PUBLIC RPC SURFACE (loop item c-m). `chain/rpc-proxy.mjs` is the only
 * thing a cloudflared tunnel exposes to the internet
 * (`chain.example.com → :8552`), anvil itself being bound to 127.0.0.1 — and it
 * had no unit test at all. Its only coverage was `chain/scripts/proxy-e2e.mjs`,
 * which needs a live anvil, so it never runs in the suite.
 *
 * The sweep of the allowlist found a real hole, and it's c33's finding one layer
 * out. `eth_sendRawTransaction` is allowed on the correct general reasoning —
 * unlike `eth_sendTransaction`, a raw transaction is already signed, so the
 * caller must hold the key. On the live chain, verified 2026-07-25:
 *
 *   • all ten accounts of anvil's PUBLISHED mnemonic hold 10,000 ETH each,
 *     nonce 0 — 80,000 ETH of gas anyone can spend;
 *   • `web3_clientVersion` (allowlisted, because wallets ask) answers
 *     `anvil/v1.7.1` through the tunnel, so finding the endpoint is finding
 *     the keys.
 *
 * Nothing can be stolen: `mint` is owner-only and none of the ten holds any
 * TinyUSDC. What they buy is an unauthenticated, free, permanent WRITE channel —
 * arbitrary contract deploys and storage growth into `~/.tiny-chain/state` on the
 * one Mac mini that also serves the facilitator, the proxy and the tunnel. So the
 * allowlist decides which METHODS are public and `raw-tx-guard.mjs` decides which
 * SIGNERS are.
 *
 * The judgement worth reusing: **the guard fails OPEN on an unrecoverable
 * signer.** A proxy is not a validator. A transaction type viem can't parse yet
 * but the node can (blob, EIP-7702, whatever ships next) must forward, because
 * turning "my viem is old" into "your payment is rejected" breaks real users to
 * defend a case no worse than today's.
 */

const ANVIL_0 = WELL_KNOWN_KEYS[0]
const ANVIL_9 = WELL_KNOWN_KEYS[9]
const DENY: Record<string, string | undefined> = {}
const ALLOW = { TINY_CHAIN_ALLOW_DEV_KEYS: '1' }

const tx = {
  to: '0x00000000000000000000000000000000000000aa' as `0x${string}`,
  value: BigInt(1), chainId: 8469, nonce: 0, gas: BigInt(21_000),
  maxFeePerGas: BigInt(1_000_000_000), maxPriorityFeePerGas: BigInt(1),
  type: 'eip1559' as const,
}
const signWith = (key: string, over: Record<string, unknown> = {}) =>
  privateKeyToAccount(key as `0x${string}`).signTransaction({ ...tx, ...over } as never)
const rawTxItem = (hex: string, id: unknown = 1) =>
  ({ jsonrpc: '2.0', id, method: RAW_TX_METHOD, params: [hex] })

describe('the method allowlist', () => {
  it('never allows a method that rewrites the chain', () => {
    // The reason the proxy exists: any one of these is full write access on
    // anvil, with no authentication of any kind.
    for (const m of [
      'anvil_setBalance', 'anvil_setCode', 'anvil_setStorageAt', 'anvil_setNonce',
      'anvil_impersonateAccount', 'anvil_autoImpersonateAccount', 'anvil_mine',
      'anvil_reset', 'anvil_dumpState', 'anvil_loadState', 'anvil_setChainId',
      'evm_mine', 'evm_setNextBlockTimestamp', 'evm_snapshot', 'evm_revert',
      'hardhat_setBalance', 'hardhat_impersonateAccount', 'hardhat_mine',
      'debug_traceTransaction', 'txpool_content',
    ]) expect(ALLOWED.has(m), m).toBe(false)
  })

  it('never allows the node to SIGN on a caller\'s behalf', () => {
    // eth_sendTransaction is signed by anvil with its own unlocked, world-known
    // accounts, so allowing it would make "spend as account 0" a public
    // primitive with no signature required at all. eth_accounts/eth_sign are the
    // same class: they only mean anything because the node holds keys.
    for (const m of ['eth_sendTransaction', 'eth_accounts', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData_v4', 'personal_sign', 'personal_unlockAccount']) {
      expect(ALLOWED.has(m), m).toBe(false)
    }
  })

  it('allows the reads a wallet and our own app genuinely need', () => {
    for (const m of [
      'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
      'eth_call', 'eth_estimateGas', 'eth_getTransactionReceipt', 'eth_getLogs',
      'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'net_version',
    ]) expect(ALLOWED.has(m), m).toBe(true)
  })

  it('allows exactly one write method, and it is the signed one', () => {
    const writes = Array.from(ALLOWED as Set<string>).filter((m) => /send|sign|set|mine|reset|impersonate/i.test(m))
    expect(writes).toEqual(['eth_sendRawTransaction'])
  })
})

describe('partition — the allowlist gate', () => {
  it('forwards an allowed single call and refuses nothing', () => {
    const { forward, refused, batch } = partition({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] })
    expect(forward).toHaveLength(1)
    expect(refused).toHaveLength(0)
    expect(batch).toBe(false)
  })

  it('answers a refused method locally with -32601 and never forwards it', () => {
    const { forward, refused } = partition({ jsonrpc: '2.0', id: 7, method: 'anvil_setBalance', params: [] })
    expect(forward).toHaveLength(0)
    expect(refused[0]).toEqual({
      jsonrpc: '2.0', id: 7,
      error: { code: -32601, message: 'method not available on the public endpoint' },
    })
  })

  it('keeps the caller\'s id so a client can pair the answer', () => {
    // JSON-RPC ids are strings as often as numbers, and 0 is a legal id — a
    // truthiness check here would answer `null` and orphan the response.
    for (const id of [0, 'abc', -1, 12345]) {
      expect(partition({ method: 'anvil_mine', id }).refused[0].id).toBe(id)
    }
    expect(partition({ method: 'anvil_mine' }).refused[0].id).toBe(null)
  })

  it('refuses one item of a batch without taking down its siblings', () => {
    const { forward, refused, batch } = partition([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'anvil_mine', params: [] },
      { jsonrpc: '2.0', id: 3, method: 'eth_chainId', params: [] },
    ])
    expect(batch).toBe(true)
    expect(forward.map((f: { id: number }) => f.id)).toEqual([1, 3])
    expect(refused.map((r: { id: number }) => r.id)).toEqual([2])
  })

  it('treats junk items as refused rather than throwing', () => {
    // A public endpoint receives scanner noise all day. Every one of these must
    // produce an answer, not a 500 from an unhandled property access.
    // (`[]` is NOT in this list — an empty array is a legitimately empty batch,
    // asserted below, and lumping it in here would demand a refusal for a
    // request that has nothing to refuse.)
    for (const item of [null, undefined, 0, '', 'eth_chainId', {}, { method: 42 }, { method: null }]) {
      const { forward, refused } = partition(item)
      expect(forward, JSON.stringify(item)).toHaveLength(0)
      expect(refused[0].error.code).toBe(-32601)
    }
  })

  it('is case-sensitive — ETH_CHAINID is not eth_chainId', () => {
    // Deliberate: JSON-RPC method names are exact, and a case-insensitive
    // allowlist would have to be case-insensitive on the DENY side too, where
    // `ANVIL_SETBALANCE` reaching the node is the whole failure.
    expect(partition({ method: 'ETH_CHAINID', id: 1 }).forward).toHaveLength(0)
    expect(partition({ method: 'Anvil_SetBalance', id: 1 }).forward).toHaveLength(0)
  })

  it('an empty batch forwards nothing and refuses nothing', () => {
    expect(partition([])).toEqual({ forward: [], refused: [], batch: true })
  })
})

describe('rawTxParam', () => {
  it('extracts the hex only from a real eth_sendRawTransaction', () => {
    expect(rawTxParam(rawTxItem('0xabcdef'))).toBe('0xabcdef')
  })

  it('is null for every other method', () => {
    for (const m of ['eth_chainId', 'eth_call', 'eth_sendTransaction', 'ETH_SENDRAWTRANSACTION']) {
      expect(rawTxParam({ method: m, params: ['0xabcdef'] }), m).toBe(null)
    }
  })

  it('is null for a malformed param — the NODE is the one that reports that', () => {
    // Returning null forwards it, and anvil answers with its own -32602. The
    // guard's job is screening signers, not validating JSON-RPC; duplicating
    // that here would mean two sources of truth for what a bad param is.
    for (const p of [undefined, null, '', '0x', 'abcdef', '0xzz', 123, {}, ['0xab']]) {
      expect(rawTxParam({ method: RAW_TX_METHOD, params: [p] }), JSON.stringify(p)).toBe(null)
    }
    expect(rawTxParam({ method: RAW_TX_METHOD })).toBe(null)
    expect(rawTxParam({ method: RAW_TX_METHOD, params: '0xabcdef' })).toBe(null)
  })

  it('is null for junk, never a throw', () => {
    for (const item of [null, undefined, 0, '', []]) expect(rawTxParam(item)).toBe(null)
  })

  it('accepts 0x-prefixed hex in either case', () => {
    expect(rawTxParam(rawTxItem('0xABCDEF'))).toBe('0xABCDEF')
  })
})

describe('recoverRawTxSender', () => {
  it('recovers the signer of every published account, lowercased', async () => {
    for (let i = 0; i < WELL_KNOWN_KEYS.length; i++) {
      const raw = await signWith(WELL_KNOWN_KEYS[i])
      expect(await recoverRawTxSender(raw), `#${i}`).toBe(WELL_KNOWN_ADDRESSES[i])
    }
  })

  it('recovers legacy and EIP-2930 transactions too', async () => {
    // A wallet gets to choose its tx type; a guard that only understood 1559
    // would wave every legacy anvil-signed transaction straight through.
    const legacy = await signWith(ANVIL_0, { type: 'legacy', gasPrice: BigInt(1_000_000_000), maxFeePerGas: undefined, maxPriorityFeePerGas: undefined })
    expect(await recoverRawTxSender(legacy)).toBe(WELL_KNOWN_ADDRESSES[0])
    const eip2930 = await signWith(ANVIL_0, { type: 'eip2930', gasPrice: BigInt(1_000_000_000), accessList: [], maxFeePerGas: undefined, maxPriorityFeePerGas: undefined })
    expect(await recoverRawTxSender(eip2930)).toBe(WELL_KNOWN_ADDRESSES[0])
  })

  it('recovers a generated key\'s own address', async () => {
    const key = generatePrivateKey()
    const expected = privateKeyToAccount(key).address.toLowerCase()
    expect(await recoverRawTxSender(await signWith(key))).toBe(expected)
  })

  it('returns null instead of throwing on anything unparseable', async () => {
    // viem throws several distinct error classes here (PositionOutOfBounds,
    // InvalidSerializedTransaction, …). Every one of them has to become null,
    // because a throw inside the proxy is a 500 on a public endpoint.
    for (const hex of ['0x', '0xdeadbeef', '0x02c0', '0xff'.repeat(40), '0x00']) {
      expect(await recoverRawTxSender(hex), hex).toBe(null)
    }
  })
})

describe('screenRawTx — the signer gate', () => {
  it('refuses a transaction signed by a published key', async () => {
    const bad = await screenRawTx(rawTxItem(await signWith(ANVIL_0), 42), DENY)
    expect(bad).not.toBe(null)
    if (!bad) throw new Error('unreachable')
    expect(bad.id).toBe(42)
    expect(bad.error.code).toBe(RAW_TX_REJECTED)
    expect(bad.error.message).toContain('anvil account #0')
  })

  it('refuses all ten and names the right index', async () => {
    for (let i = 0; i < WELL_KNOWN_KEYS.length; i++) {
      const bad = await screenRawTx(rawTxItem(await signWith(WELL_KNOWN_KEYS[i])), DENY)
      expect(bad?.error.message, `#${i}`).toContain(`anvil account #${i}`)
    }
  })

  it('shares -32003 with the node\'s own rejections, and is told apart by its message', async () => {
    // Verified against the live endpoint: anvil answers -32003 "Insufficient
    // funds for gas * price + value" for an unfunded sender. That's the RIGHT
    // outcome — both are "this transaction is rejected" — but it means the code
    // alone cannot tell a guard refusal from a node refusal, so the message
    // carries the distinction and a test has to pin it. Inventing a private code
    // would be worse: a client that special-cased it would break the moment the
    // node grew the same condition.
    const bad = await screenRawTx(rawTxItem(await signWith(ANVIL_0)), DENY)
    if (!bad) throw new Error('unreachable — a published-key tx must be refused')
    expect(bad.error.message).toContain('anvil account')
    expect(bad.error.message).not.toMatch(/insufficient funds/i)
  })

  it('uses -32003 (transaction rejected), NOT -32601', async () => {
    // The METHOD is available here — this transaction isn't. A client that read
    // -32601 as "method not found" would conclude the node is old and retry
    // some other way forever, instead of surfacing "use a real key".
    const bad = await screenRawTx(rawTxItem(await signWith(ANVIL_9)), DENY)
    if (!bad) throw new Error('unreachable — a published-key tx must be refused')
    expect(bad.error.code).toBe(-32003)
    expect(bad.error.code).not.toBe(-32601)
  })

  it('forwards a transaction signed by a generated key', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await screenRawTx(rawTxItem(await signWith(generatePrivateKey())), DENY)).toBe(null)
    }
  })

  it('forwards everything that is not a raw transaction', async () => {
    for (const item of [
      { method: 'eth_chainId', id: 1, params: [] },
      { method: 'eth_call', id: 2, params: [{}] },
      null, undefined, 0, [], {},
    ]) expect(await screenRawTx(item, DENY), JSON.stringify(item)).toBe(null)
  })

  // The load-bearing judgement of this file.
  it('FAILS OPEN when the signer cannot be recovered', async () => {
    // A proxy is not a validator. A tx type viem cannot parse yet but the node
    // can must reach the node — the alternative is that upgrading Chrome's
    // wallet breaks payments on our chain, to defend against a case that is
    // exactly as bad as today's behaviour.
    for (const hex of ['0x00', '0xdeadbeef', '0x02c0', '0x04' + 'ab'.repeat(60)]) {
      expect(await screenRawTx(rawTxItem(hex), DENY), hex).toBe(null)
    }
  })

  it('never echoes the raw transaction or a key back', async () => {
    const raw = await signWith(ANVIL_0)
    const bad = await screenRawTx(rawTxItem(raw), DENY)
    if (!bad) throw new Error('unreachable — a published-key tx must be refused')
    expect(bad.error.message).not.toContain(raw)
    expect(bad.error.message).not.toContain(ANVIL_0)
    expect(bad.error.message).not.toContain(WELL_KNOWN_ADDRESSES[0])
  })

  it('tells the operator what to do instead', async () => {
    const bad = await screenRawTx(rawTxItem(await signWith(ANVIL_0)), DENY)
    if (!bad) throw new Error('unreachable — a published-key tx must be refused')
    expect(bad.error.message).toMatch(/published/)
    expect(bad.error.message).toMatch(/key you generated/)
  })

  it('stands down under the explicit devnet opt-in', async () => {
    // A scratch anvil's accounts ARE these accounts — refusing them there would
    // make the guard break the very setup it exists to distinguish from.
    expect(await screenRawTx(rawTxItem(await signWith(ANVIL_0)), ALLOW)).toBe(null)
  })

  it('is opt-IN: nothing, "0" and "true" all still refuse', async () => {
    const item = rawTxItem(await signWith(ANVIL_0))
    for (const v of [undefined, '', '0', 'false', 'true', 'yes']) {
      expect(await screenRawTx(item, { TINY_CHAIN_ALLOW_DEV_KEYS: v }), String(v)).not.toBe(null)
    }
  })

  it('reads the env it is HANDED, so an ambient opt-in cannot leak in', async () => {
    // Same reason as devKeysAllowed's parameter (c33): chain/'s scratch-anvil
    // scripts set the opt-in process-wide, and a guard that consulted
    // process.env directly would inherit that grant on the public endpoint.
    expect(await screenRawTx(rawTxItem(await signWith(ANVIL_0)), {})).not.toBe(null)
  })
})

describe('screenRawTxBatch', () => {
  it('splits a mixed batch, keeping the good and answering the bad', async () => {
    const good = rawTxItem(await signWith(generatePrivateKey()), 1)
    const bad = rawTxItem(await signWith(ANVIL_0), 2)
    const read = { jsonrpc: '2.0', id: 3, method: 'eth_chainId', params: [] }
    const { forward, refused } = await screenRawTxBatch([good, bad, read], DENY)
    expect(forward.map((f: { id: number }) => f.id)).toEqual([1, 3])
    expect(refused).toHaveLength(1)
    expect(refused[0].id).toBe(2)
  })

  it('a batch of only bad transactions forwards nothing at all', async () => {
    const items = await Promise.all(WELL_KNOWN_KEYS.slice(0, 4).map(async (k: string, i: number) => rawTxItem(await signWith(k), i)))
    const { forward, refused } = await screenRawTxBatch(items, DENY)
    expect(forward).toHaveLength(0)
    expect(refused).toHaveLength(4)
  })

  it('an empty list is empty, not a throw', async () => {
    expect(await screenRawTxBatch([], DENY)).toEqual({ forward: [], refused: [] })
  })

  it('preserves the order of what it forwards', async () => {
    // The proxy answers `[...upstreamAnswers, ...refused]`, pairing by id — but
    // the forwarded batch itself must stay in the caller's order, since a
    // batch of transactions from one account is nonce-ordered.
    const items = [1, 2, 3, 4].map((id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }))
    const { forward } = await screenRawTxBatch(items, DENY)
    expect(forward.map((f: { id: number }) => f.id)).toEqual([1, 2, 3, 4])
  })
})

/**
 * The wiring, asserted on source: the server body is inside an http handler that
 * needs a listening socket and a live upstream, so what matters here is that the
 * second gate is actually invoked and that its refusals are answered locally.
 */
const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('the proxy wires both gates', () => {
  it('screens after partition and merges into the SAME refused list', () => {
    const src = source('chain/rpc-proxy.mjs')
    expect(src).toContain("from './raw-tx-guard.mjs'")
    expect(src).toMatch(/await screenRawTxBatch\(allowed\)/)
    expect(src).toMatch(/refused\.push\(\.\.\.badSigner\)/)
    // The forwarded set must be the SCREENED one — forwarding `allowed` would
    // leave the guard computing a refusal nobody applies.
    expect(src).toMatch(/body: JSON\.stringify\(batch \? forward : forward\[0\]\)/)
    expect(src).toMatch(/const \{ forward, refused: badSigner \}/)
  })

  it('still binds loopback only — the tunnel is the only way in', () => {
    // anvil is on 127.0.0.1:8545 and this proxy on 127.0.0.1:8552; cloudflared
    // is what publishes it. Binding 0.0.0.0 would put the proxy on the LAN too.
    expect(source('chain/rpc-proxy.mjs')).toMatch(/server\.listen\(PORT, '127\.0\.0\.1'/)
  })

  it('does not grant itself the dev-key opt-in', () => {
    for (const rel of ['chain/rpc-proxy.mjs', 'chain/raw-tx-guard.mjs']) {
      expect(source(rel), rel).not.toMatch(/process\.env\.TINY_CHAIN_ALLOW_DEV_KEYS\s*=[^=]/)
    }
  })

  it('is documented where an operator reads about the chain', () => {
    expect(source('chain/README.md')).toContain('eth_sendRawTransaction')
  })
})
