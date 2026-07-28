// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('faucet-mint-not-a-deposit')

/**
 * 🚰→💵 A MINT IS NOT A DEPOSIT — the last of report §1.1's four chain edges.
 *
 * `_mint` and `_transfer` emit the SAME event. ERC-20 has no separate mint
 * topic: a mint is `Transfer(0x0 → to)` (chain/contracts/TinyUSDC.sol:67) and a
 * payment is `Transfer(from → to)` (:165). Canonical USDC is identical.
 *
 * Our own faucet mints TinyUSDC to `DEPOSIT_ADDRESS` on every daily drip
 * (app/api/wallet/faucet/route.ts, mintReserve). So every drip produces a
 * receipt containing a log whose `to` IS the deposit address — one of the two
 * things /pay/claim checks. The other is `from == your linked address`, and
 * `0x0…0` passed `isAddress` (it is 40 valid hex chars), so:
 *
 *   1. POST /pay/link-address with address = 0x0000…0000. Accepted.
 *   2. Take the daily drip. The API HANDS YOU the mint's hash — `reserve_tx`,
 *      plus an `explorer` link (they're rendered in the wallet UI on all three
 *      clients, and every other user's drip hash is equally public on /chain).
 *   3. POST /pay/claim with that hash. The receipt is real, status 0x1, ≥3
 *      confirmations, the token matches, `to` is the deposit address, and
 *      `from` is 0x0 — which now equals your "linked address".
 *   4. Credited. The platform's own mint is booked as YOUR deposit, on top of
 *      the drip already credited for that same mint, and repeatable with every
 *      other user's public drip hash.
 *
 * Two authorities on "who sent this money?" — the token's event, which cannot
 * distinguish issuance from payment, and the link table, which vouched for an
 * address nobody holds the key to. c44 made one transfer creditable once; this
 * is about a "transfer" that was never a transfer at all.
 *
 * Guard: `isSenderAddress` — `isAddress` minus the mint/burn sink — enforced in
 * `findUsdcTransfer` (the money path) AND at link time (defence in depth, one
 * comparison). Only 0x0 is excluded: every other address is somebody's, and
 * refusing more would break real deposits.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x' + '0'.repeat(40)
const DEPOSIT = '0x' + 'd'.repeat(40)
const SENDER = '0x' + 'a'.repeat(40)
const TOKEN = '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec' // prod TinyUSDC
const pad = (a: string) => '0x' + a.replace(/^0x/, '').padStart(64, '0')

/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (six cycles running now). */
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** The log TinyUSDC.mint actually emits: from = 0x0, to = the deposit address. */
const mintLog = (micro = 1_000_000) => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, pad(ZERO), pad(DEPOSIT)],
  data: '0x' + micro.toString(16),
})

/** A genuine user deposit, for the control. */
const transferLog = (micro = 10_000_000) => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, pad(SENDER), pad(DEPOSIT)],
  data: '0x' + micro.toString(16),
})

let dep: any

beforeAll(async () => {
  if (!present) return
  dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
})

describe.skipIf(!present)('THE FAUCET MINT: the platform\'s own issuance, claimed as a deposit', () => {
  it('OLD behaviour — a zero linked address matched the faucet\'s mint log', () => {
    // Non-vacuity proof: the matcher's own rules, applied by hand exactly as the
    // pre-fix loop did. If this doesn't match, the finding was imaginary.
    const log = mintLog()
    const topicToAddress = (t: string) => '0x' + t.replace(/^0x/, '').toLowerCase().slice(24)
    expect(String(log.address).toLowerCase()).toBe(TOKEN)                 // token ✓
    expect(String(log.topics[0]).toLowerCase()).toBe(dep.TRANSFER_TOPIC)  // Transfer ✓
    expect(topicToAddress(log.topics[1])).toBe(ZERO)                      // from == "linked" ✓
    expect(topicToAddress(log.topics[2])).toBe(DEPOSIT)                   // to == deposit ✓
    // …and 0x0 was a perfectly valid address to link, which is what tied it together.
    expect(dep.isAddress(ZERO)).toBe(true)
  })

  it('NEW behaviour — the mint is not creditable to a zero linked address', () => {
    expect(dep.findUsdcTransfer([mintLog()], TOKEN, DEPOSIT, ZERO)).toBeNull()
  })

  it('a real deposit from a real address still credits, unchanged', () => {
    // The fix must not be "deposits are hard now": this is the whole feature.
    expect(dep.findUsdcTransfer([transferLog()], TOKEN, DEPOSIT, SENDER))
      .toEqual({ amount_micro: 10_000_000 })
  })

  it('a mint sitting ALONGSIDE a real transfer credits only the real one', () => {
    // A tx can hold both (a mint and a payment in one call). The scan must pick
    // the transfer on its merits, not fall through to the first Transfer topic.
    const logs = [mintLog(9_000_000), transferLog(10_000_000)]
    expect(dep.findUsdcTransfer(logs, TOKEN, DEPOSIT, SENDER)).toEqual({ amount_micro: 10_000_000 })
    expect(dep.findUsdcTransfer(logs, TOKEN, DEPOSIT, ZERO)).toBeNull()
  })

  it('a BURN is not a deposit either — the mirror case, found by this test', () => {
    // `isAddress(env.DEPOSIT_ADDRESS)` accepts 0x0, so a deployment that mis-set
    // the deposit address to the sink would make every burn on the chain
    // (`Transfer(holder → 0x0)`) a claimable deposit — crediting money that just
    // left the supply. Same predicate, other end. (This assertion failed on the
    // first run against a fix that only screened `from`.)
    const burn = { address: TOKEN, topics: [TRANSFER_TOPIC, pad(SENDER), pad(ZERO)], data: '0x' + (5_000_000).toString(16) }
    expect(dep.findUsdcTransfer([burn], TOKEN, ZERO, SENDER)).toBeNull()
    // …and the guard is on the argument, so no log can sneak past it either.
    expect(dep.findUsdcTransfer([burn, transferLog()], TOKEN, ZERO, SENDER)).toBeNull()
  })

  it('mixed-case and unpadded zero forms are all refused', () => {
    // The check is a lowercase compare, so every spelling of the sink must lose.
    for (const z of [ZERO, ZERO.toUpperCase().replace('0X', '0x'), '0x' + '0'.repeat(40)]) {
      expect(dep.findUsdcTransfer([mintLog()], TOKEN, DEPOSIT, z), z).toBeNull()
    }
  })
})

describe.skipIf(!present)('isSenderAddress — isAddress minus the sink, and nothing more', () => {
  it('accepts every real address, rejects only 0x0', () => {
    expect(dep.isSenderAddress(SENDER)).toBe(true)
    expect(dep.isSenderAddress(DEPOSIT)).toBe(true)
    // 0x…1 is one bit from the sink and is a perfectly ordinary (if unowned)
    // address — narrowing further would refuse real deposits.
    expect(dep.isSenderAddress('0x' + '0'.repeat(39) + '1')).toBe(true)
    expect(dep.isSenderAddress(ZERO)).toBe(false)
    expect(dep.isSenderAddress(ZERO.toUpperCase().replace('0X', '0x'))).toBe(false)
  })

  it('still enforces the shape isAddress enforced', () => {
    for (const bad of ['', '0x', '0xzz', SENDER.slice(0, 41), SENDER + 'a', 'not an address']) {
      expect(dep.isSenderAddress(bad), bad).toBe(false)
    }
  })

  it('ZERO_ADDRESS is the canonical 20-byte sink', () => {
    expect(dep.ZERO_ADDRESS).toBe(ZERO)
    expect(dep.isAddress(dep.ZERO_ADDRESS)).toBe(true) // shape-valid, which is the trap
  })
})

describe.skipIf(!present)('both locks are in place', () => {
  const src = code('deposits.ts')

  it('findUsdcTransfer refuses a sink sender BEFORE scanning logs', () => {
    // The guard belongs on the argument, not per-log: a zero linked address must
    // match nothing whatever the receipt contains.
    const fn = src.slice(src.indexOf('export function findUsdcTransfer'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/isSenderAddress\(String\(fromAddr \|\| ""\)\)/)
    // Both ends — a sink `toAddr` is the burn case.
    expect(body).toMatch(/isSenderAddress\(String\(toAddr \|\| ""\)\)/)
    expect(body.indexOf('isSenderAddress')).toBeLessThan(body.indexOf('for (const log'))
    expect(body.lastIndexOf('isSenderAddress')).toBeLessThan(body.indexOf('for (const log'))
  })

  it('link-address refuses to bind the sink at all', () => {
    // Second lock. A linked 0x0 is a standing claim on every future mint, so the
    // money path guard alone would leave a row that only looks harmless.
    const cls = src.slice(src.indexOf('export class PayLinkAddressCall'))
    const handler = cls.slice(0, cls.indexOf('return json({ ok: true'))
    expect(handler).toMatch(/isSenderAddress\(String\(address \|\| ""\)\)/)
    expect(handler).not.toMatch(/!isAddress\(String\(address/)
  })

  it('the claim path reaches findUsdcTransfer with the LINKED address, not a request field', () => {
    // The guard is only worth anything if the address it screens is the one the
    // credit is bound to. (This is also why a linked 0x0 was exploitable at all.)
    const cls = src.slice(src.indexOf('export class PayClaimCall'))
    expect(cls).toMatch(/findUsdcTransfer\(\s*receipt\.logs, usdcContract\(network, env\), env\.DEPOSIT_ADDRESS, String\(wallet\.address\)\s*\)/)
  })

  it('the mint really does share the Transfer topic (the reason this edge exists)', () => {
    // If TinyUSDC ever emitted a distinct mint event this whole class of bug
    // would vanish — and this assertion would tell us.
    const token = readFileSync(join(WORKER_SRC, '..', '..', 'chain', 'contracts', 'TinyUSDC.sol'), 'utf8')
    const mint = token.slice(token.indexOf('function mint('), token.indexOf('function burn('))
    expect(mint).toMatch(/emit Transfer\(address\(0\), to, value\)/)
  })
})
