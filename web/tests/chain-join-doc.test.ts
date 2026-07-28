// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import genesis from '@/chain/multinode/genesis-8470.json'

/**
 * 📄 docs/developers/run-a-node.md — the PUBLIC page telling strangers how to run
 * a node.
 *
 * Two independent risks, and the doc is the only place both land at once:
 *
 *  1. LEAKAGE. This repo is private; the mkdocs site is public. Root-level
 *     docs/*.md are internal notes and excluded, but anything under a
 *     subdirectory is published — so a private key, an internal hostname or a
 *     127.0.0.1 command in this file goes on the internet.
 *  2. DRIFT. A doc that describes an endpoint is a second source of truth. If the
 *     URL, the chain id or the flags stop matching the code, the doc keeps
 *     confidently telling people to run something that no longer works, and
 *     nothing fails until a stranger tries it.
 */

const root = process.cwd()
const DOC = joinPath(root, 'docs/developers/run-a-node.md')
const doc = readFileSync(DOC, 'utf8')

describe('the page is safe to publish (repo private, site public)', () => {
  it('is in the mkdocs nav — an unlisted page is a page nobody finds', () => {
    const nav = readFileSync(joinPath(root, 'mkdocs.yml'), 'utf8')
    expect(nav).toMatch(/developers\/run-a-node\.md/)
    // And the Developers section must still expose its own index, which the
    // single-line `Developers: developers/index.md` form did implicitly. Turning
    // a leaf into a section silently drops it otherwise.
    expect(nav).toMatch(/developers\/index\.md/)
  })

  it('leaks no private key, mnemonic, or internal-only credential', () => {
    // A 64-hex string in a public doc is the worst single thing this file could
    // contain. The chain's dev keys are world-known, which makes pasting one feel
    // harmless right up until it is copied into a doc about a chain that holds
    // real balances.
    expect(doc).not.toMatch(/0x[0-9a-fA-F]{64}\b/)
    expect(doc).not.toMatch(/PRIVATE KEY|BEGIN [A-Z ]*PRIVATE/i)
    expect(doc).not.toMatch(/keys\.env|\.tiny-chain\/keys/)
  })

  it('exposes no loopback or LAN address as something a reader should dial', () => {
    // ⚠️ The one exception is deliberate and must stay exact: the "check your own
    // node" curl talks to the READER'S OWN 127.0.0.1:8545, which is correct. Any
    // OTHER loopback reference would be ours, and useless-or-misleading to them.
    const loopbacks = doc.match(/127\.0\.0\.1:\d+|localhost:\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+/g) || []
    expect(loopbacks.every((l) => l === '127.0.0.1:8545')).toBe(true)
    // Never our devnet's RPC ports (8600-8604) or the live chain's 8545 tunnel
    // internals — those are operator facts, not joiner facts.
    expect(doc).not.toMatch(/860[0-9]/)
  })

  it('names no internal host, tunnel, or machine', () => {
    expect(doc).not.toMatch(/\.trycloudflare\.com|mac-?mini|launchd|\.local\b/i)
  })
})

describe('the page does not drift from the endpoint it documents', () => {
  it('points at the real join route, both forms', () => {
    expect(doc).toMatch(/\/api\/chain\/join\b/)
    expect(doc).toMatch(/\/api\/chain\/join\?format=genesis/)
    // The route must actually exist and export a GET.
    const route = readFileSync(joinPath(root, 'app/api/chain/join/route.ts'), 'utf8')
    expect(route).toMatch(/export async function GET/)
    expect(route).toMatch(/format'\) === 'genesis'/)
  })

  it('every besu flag it tells a reader to run is one the join doc also emits', () => {
    // The doc and the endpoint are two voices describing one command. Drift here
    // means a reader following the page gets a different node than a reader
    // following the API — and only one of them is tested against the chain.
    const lib = readFileSync(joinPath(root, 'lib/chain/join.ts'), 'utf8')
    for (const flag of ['--sync-mode=FULL', '--data-storage-format=BONSAI', '--min-gas-price=0', '--genesis-file=']) {
      expect(doc, `doc missing ${flag}`).toContain(flag)
      expect(lib, `join doc builder missing ${flag}`).toContain(flag)
    }
  })

  it('states the FULL-sync reason, not just the flag', () => {
    // A flag without its reason gets "optimised" to SNAP by the next reader.
    expect(doc).toMatch(/re-execut/i)
    expect(doc).toMatch(/state root/)
  })

  it('warns about besu-vs-geth and Java 25 — the two first-contact failures', () => {
    expect(doc).toMatch(/QBFT/)
    expect(doc).toMatch(/geth and anvil cannot follow/)
    expect(doc).toMatch(/Java 25\+/)
    expect(doc).toMatch(/UnsupportedClassVersionError/)
  })

  it('separates running a node from validating, and keeps the stake honest', () => {
    expect(doc).toMatch(/MIN_STAKE/)
    // Backtick-tolerant: this is markdown, and `rotate()` is code-formatted here
    // while the API's plain-text version is not. Matching the literal would tie a
    // content assertion to a formatting choice.
    expect(doc).toMatch(/`?rotate\(\)`? yourself/)
    // The dishonest version of this page would call the stake slashable. On-chain
    // conviction is real; burning is not implemented.
    expect(doc).toMatch(/deposit, not a bond/i)
    expect(doc).toMatch(/nothing burns stake yet/)
    expect(doc).toMatch(/unstake\(\)/)
  })

  it('tells the reader the zero-balance trap, which costs an hour otherwise', () => {
    // Free gas does NOT mean a sender absent from state can transact: the pool
    // accepts and gossips the tx and no proposer ever selects it, with no error.
    expect(doc).toMatch(/free, not unmetered|free but metered/i)
    expect(doc).toMatch(/exist.{0,20}in state|absent from state/i)
    expect(doc).toMatch(/One wei|1 wei/)
  })

  it('does NOT claim that syncing puts you on the payment path', () => {
    // The mislabelling trap in prose form: production settles on a different chain
    // than the one this genesis describes, and a reader who conflates them looks
    // for their money on the wrong ledger.
    expect(doc).toMatch(/does \*not\* do|not necessarily the one you/)
    expect(doc).toMatch(/settles x402 payments/)
  })

  it('does not hardcode a chain id that could drift from the genesis', () => {
    // The page deliberately names no chain number: the endpoint reports it from
    // the genesis, so a redeploy on a new id cannot leave stale prose behind.
    // If a number appears here later it must be THE number.
    const ids = doc.match(/\bchain (\d{4,5})\b/g) || []
    for (const m of ids) {
      expect(m).toBe(`chain ${genesis.config.chainId}`)
    }
  })
})
