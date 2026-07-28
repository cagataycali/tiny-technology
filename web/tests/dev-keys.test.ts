// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  WELL_KNOWN_MNEMONIC,
  WELL_KNOWN_KEYS,
  WELL_KNOWN_ADDRESSES,
  isWellKnownKey,
  isWellKnownAddress,
  wellKnownIndex,
  devKeysAllowed,
  devKeyRefusal,
} from '@/chain/dev-keys.mjs'
import { assertDeployerKeySafe } from '@/chain/scripts/deploy.mjs'

/**
 * 🔑 THE PUBLISHED DEV KEYS (loop item c-l) — the c32 failure mode, third
 * instance: **a missing env is easy to guard, but a wrong default reads as
 * configured.**
 *
 * Two money paths in chain/ defaulted to accounts of anvil's published test
 * mnemonic when their env was unset:
 *
 *   chain/scripts/deploy.mjs      TINY_CHAIN_DEPLOYER_KEY  || anvil #0
 *   chain/facilitator/server.mjs  FACILITATOR_RELAYER_KEY  || anvil #9
 *
 * The deployer one is the most dangerous value in the repo. TinyUSDC's `mint` is
 * owner-only and the owner is fixed AT DEPLOY TIME, so a deploy that falls back
 * to anvil #0 hands the token's monetary authority to a keypair the entire
 * internet has — permanently, with no revoke. The only remedy is deploying a new
 * token and migrating every balance, which is exactly why deploy() REFUSES
 * (assertDeployerKeySafe, before any RPC, so a refusal leaves no half-deployed
 * token) while nothing here can be fixed by editing an env afterwards.
 *
 * What these tests actually pin, beyond the obvious:
 *
 *  1. **The key→address table is correct.** It's hand-written so this module can
 *     stay dependency-free, and a mistyped address is a guard that silently
 *     passes. Derived here with viem and compared.
 *  2. **Whitespace and case can't defeat it.** The realistic way one of these
 *     arrives in production is pasted into a dashboard env field with a stray
 *     newline.
 *  3. **The escape hatch is opt-IN, never opt-out.** The safe state has to be the
 *     one you get by doing nothing — the whole bug is a default nobody chose.
 *  4. **A generated key passes.** A guard that rejects real keys is a broken
 *     deployment, not a safe one.
 */

const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ANVIL_9 = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
const ALLOW = { TINY_CHAIN_ALLOW_DEV_KEYS: '1' }

describe('the well-known key table', () => {
  it('is anvil/hardhat/ganache\'s published mnemonic', () => {
    expect(WELL_KNOWN_MNEMONIC).toBe('test test test test test test test test test test test junk')
  })

  it('holds ten keys and ten index-aligned addresses', () => {
    expect(WELL_KNOWN_KEYS).toHaveLength(10)
    expect(WELL_KNOWN_ADDRESSES).toHaveLength(10)
  })

  // 1. The load-bearing assertion of this file: a hand-written table with one
  //    wrong hex digit is a guard that lets that exact account through.
  it('every address really is that key\'s address', () => {
    WELL_KNOWN_KEYS.forEach((key: string, i: number) => {
      const derived = privateKeyToAccount(key as `0x${string}`).address.toLowerCase()
      expect(derived, `key #${i}`).toBe(WELL_KNOWN_ADDRESSES[i])
    })
  })

  it('stores everything lowercased, so string comparison is enough', () => {
    for (const v of [...WELL_KNOWN_KEYS, ...WELL_KNOWN_ADDRESSES]) {
      expect(v).toBe(v.toLowerCase())
      expect(v.startsWith('0x')).toBe(true)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(WELL_KNOWN_KEYS).size).toBe(10)
    expect(new Set(WELL_KNOWN_ADDRESSES).size).toBe(10)
  })

  // The two defaults this whole cycle exists for.
  it('contains both defaults that shipped in chain/', () => {
    expect(isWellKnownKey(ANVIL_0)).toBe(true) // deploy.mjs
    expect(isWellKnownKey(ANVIL_9)).toBe(true) // facilitator/server.mjs
    expect(wellKnownIndex(ANVIL_0)).toBe(0)
    expect(wellKnownIndex(ANVIL_9)).toBe(9)
  })
})

describe('isWellKnownKey', () => {
  it('flags all ten', () => {
    for (const k of WELL_KNOWN_KEYS) expect(isWellKnownKey(k)).toBe(true)
  })

  // 2. A guard a trailing space defeats is not a guard.
  it('is whitespace- and case-tolerant', () => {
    expect(isWellKnownKey(`  ${ANVIL_0}  `)).toBe(true)
    expect(isWellKnownKey(`${ANVIL_0}\n`)).toBe(true)
    expect(isWellKnownKey(ANVIL_0.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isWellKnownKey(ANVIL_0.toUpperCase())).toBe(true)
  })

  // 4. Real keys must pass, or the guard just breaks the deployment.
  it('passes freshly generated keys', () => {
    for (let i = 0; i < 5; i++) expect(isWellKnownKey(generatePrivateKey())).toBe(false)
  })

  it('does not treat empty/missing as well-known', () => {
    // Absence is a DIFFERENT failure with a different message — each caller
    // already has its own "not configured" path, and conflating them would tell
    // an operator with no key set to go generate one they already lack.
    for (const v of ['', '   ', null, undefined, 0, false, {}, []]) {
      expect(isWellKnownKey(v as any)).toBe(false)
    }
  })

  it('rejects near-misses — one digit off is a different account', () => {
    expect(isWellKnownKey(ANVIL_0.slice(0, -1) + '1')).toBe(false)
    expect(isWellKnownKey(ANVIL_0.slice(2))).toBe(false) // no 0x
    expect(isWellKnownKey(ANVIL_0 + '00')).toBe(false)
  })

  it('does not confuse an address for a key', () => {
    expect(isWellKnownKey(WELL_KNOWN_ADDRESSES[0])).toBe(false)
  })
})

describe('isWellKnownAddress', () => {
  it('flags all ten, checksummed or not', () => {
    WELL_KNOWN_KEYS.forEach((k: string) => {
      const checksummed = privateKeyToAccount(k as `0x${string}`).address
      expect(isWellKnownAddress(checksummed)).toBe(true)
      expect(isWellKnownAddress(checksummed.toLowerCase())).toBe(true)
      expect(isWellKnownAddress(` ${checksummed}\n`)).toBe(true)
    })
  })

  it('passes a generated account and rejects empty', () => {
    expect(isWellKnownAddress(privateKeyToAccount(generatePrivateKey()).address)).toBe(false)
    expect(isWellKnownAddress('')).toBe(false)
    expect(isWellKnownAddress(undefined as any)).toBe(false)
  })

  it('does not confuse a key for an address', () => {
    expect(isWellKnownAddress(ANVIL_0)).toBe(false)
  })
})

describe('wellKnownIndex', () => {
  it('names the account for keys AND addresses', () => {
    WELL_KNOWN_KEYS.forEach((k: string, i: number) => {
      expect(wellKnownIndex(k)).toBe(i)
      expect(wellKnownIndex(WELL_KNOWN_ADDRESSES[i])).toBe(i)
      expect(wellKnownIndex(privateKeyToAccount(k as `0x${string}`).address)).toBe(i)
    })
  })

  it('is -1 for anything else', () => {
    expect(wellKnownIndex(generatePrivateKey())).toBe(-1)
    expect(wellKnownIndex('')).toBe(-1)
    expect(wellKnownIndex(undefined as any)).toBe(-1)
  })
})

describe('devKeysAllowed — the escape hatch', () => {
  // 3. Opt-IN only. Every one of these must stay unsafe-by-default, because a
  //    deployment that sets nothing is precisely the deployment being protected.
  it('is false with nothing set', () => {
    expect(devKeysAllowed({})).toBe(false)
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: undefined })).toBe(false)
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: '' })).toBe(false)
  })

  it('is true only for "1"', () => {
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: '1' })).toBe(true)
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: ' 1\n' })).toBe(true)
  })

  it('does not accept "0", "false" or "true" as opt-in/opt-out', () => {
    // Deliberately narrow: '0' and 'false' must NOT read as "allowed", and
    // 'true'/'yes' must NOT either — an operator who means it can type 1.
    for (const v of ['0', 'false', 'no', 'true', 'yes', 'on', '2']) {
      expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: v }), v).toBe(v === '1')
    }
  })

  it('reads the env it is HANDED, so an ambient opt-in can\'t leak into a caller', () => {
    // The `env` parameter exists because chain/'s scratch-anvil scripts set the
    // opt-in process-wide: a guard that ignored its argument and consulted
    // process.env would inherit that grant everywhere. Asserted by passing an
    // explicit deny while the ambient value may well be '1' (this suite is run
    // under TINY_CHAIN_ALLOW_DEV_KEYS=1 as one of its deployment shells).
    expect(devKeysAllowed({})).toBe(false)
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: '0' })).toBe(false)
    expect(devKeysAllowed({ TINY_CHAIN_ALLOW_DEV_KEYS: '1' })).toBe(true)
  })
})

describe('devKeyRefusal', () => {
  it('names the anvil account index — an operator who understands the warning heeds it', () => {
    const msg = devKeyRefusal('the deployer', ANVIL_0)
    expect(msg).toContain('anvil account #0')
    expect(msg).toContain('the deployer')
  })

  it('names the override so the message is actionable', () => {
    expect(devKeyRefusal('x', ANVIL_9)).toContain('TINY_CHAIN_ALLOW_DEV_KEYS=1')
  })

  it('never echoes the key itself', () => {
    // These particular keys are public, but a refusal message is exactly the
    // string that ends up in logs and screenshots — the habit matters more than
    // this instance.
    expect(devKeyRefusal('the deployer', ANVIL_0)).not.toContain(ANVIL_0)
  })

  it('degrades gracefully for an unlisted value', () => {
    expect(devKeyRefusal('the deployer', 'nonsense')).toContain('a well-known dev key')
  })
})

/**
 * The four call sites, asserted on their source. Three of them (the facilitator
 * server, the two Next routes) can't be exercised in-process here — the
 * facilitator needs a chain and an unguarded startup would `process.exit`, and
 * the routes need a session plus a worker. What matters isn't the mechanism
 * anyway; it's that no signer in this repo is left with a published default.
 */
const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('every signer that could default into a dev key checks', () => {
  it('the facilitator refuses to START, not at the first payment', () => {
    const src = source('chain/facilitator/server.mjs')
    expect(src).toContain("from '../dev-keys.mjs'")
    expect(src).toMatch(/isWellKnownKey\(RELAYER_KEY\) && !devKeysAllowed\(\)/)
    // Exit, don't warn-and-continue: a facilitator that boots and then fails
    // every settlement is far worse to diagnose than one that won't boot.
    expect(src).toMatch(/process\.exit\(1\)/)
  })

  it('the faucet reports an un-backed drip instead of throwing', () => {
    // This path must never fail the request — the ledger credit is already
    // granted (chain/README.md "ledger first, mint second"), so a refusal here
    // would spend the user's daily ref and hand them an error.
    const src = source('app/api/wallet/faucet/route.ts')
    expect(src).toContain("from '@/chain/dev-keys.mjs'")
    expect(src).toMatch(/isWellKnownKey\(pk\) && !devKeysAllowed\(\)/)
    expect(src).toMatch(/return \{ error: 'deployer key is a published dev key' \}/)
  })

  it('withdrawals treat a published payout key as unconfigured', () => {
    const src = source('app/api/wallet/withdraw/route.ts')
    expect(src).toContain("from '@/chain/dev-keys.mjs'")
    expect(src).toMatch(/isWellKnownKey\(pk\) && !devKeysAllowed\(\)/)
    // Same 424 + same wording as the unset case ON PURPOSE: both mean "this
    // deployment cannot pay out", and a distinct message here would tell an
    // attacker probing the endpoint which key the platform holds.
    const guard = src.slice(src.indexOf('isWellKnownKey(pk)'))
    expect(guard).toMatch(/withdrawals not configured on this deployment'.*\}, 424\)/s)
  })

  it('the scratch-anvil scripts opt IN, so the guards cost the suite nothing', () => {
    // These scripts boot their own throwaway anvil, whose accounts ARE these
    // accounts — demanding a generated key there would make the tests worse for
    // no safety gained. Opting in explicitly is what keeps the DEFAULT unsafe-free.
    for (const rel of ['chain/scripts/e2e.mjs', 'chain/scripts/faucet-e2e.mjs', 'chain/scripts/facilitator-e2e.mjs']) {
      expect(source(rel), rel).toMatch(/process\.env\.TINY_CHAIN_ALLOW_DEV_KEYS = '1'/)
    }
  })

  it('nothing sets TINY_CHAIN_ALLOW_DEV_KEYS outside chain/scripts', () => {
    // The one way this guard dies quietly is a stray assignment in a route or a
    // deploy script. The guarded files may NAME the var (their comments must, to
    // be useful) but none of them may WRITE it — only the throwaway-anvil
    // scripts above get to grant themselves permission.
    for (const rel of ['app/api/wallet/faucet/route.ts', 'app/api/wallet/withdraw/route.ts', 'chain/facilitator/server.mjs', 'chain/scripts/deploy.mjs', 'chain/dev-keys.mjs']) {
      expect(source(rel), rel).not.toMatch(/process\.env\.TINY_CHAIN_ALLOW_DEV_KEYS\s*=[^=]/)
    }
  })

  it('is documented where an operator configures the chain', () => {
    expect(source('.env.example')).toContain('TINY_CHAIN_ALLOW_DEV_KEYS')
    expect(source('chain/README.md')).toContain('TINY_CHAIN_ALLOW_DEV_KEYS')
  })

  it('the e2e scripts do not overwrite a live deployment record', () => {
    // Found by running them: deploy() writes chain/deployment.json — the file the
    // facilitator reads its USDC address from at startup — and it's gitignored,
    // so git can't restore it. A routine `npm run e2e` was silently replacing a
    // live chain's record with a scratch anvil's address, recoverable only by
    // asking the running facilitator what it used to be. The e2es never needed
    // the file; they use deploy()'s return value.
    for (const rel of ['chain/scripts/e2e.mjs', 'chain/scripts/faucet-e2e.mjs', 'chain/scripts/facilitator-e2e.mjs']) {
      expect(source(rel), rel).toMatch(/deploy\(RPC, \{ write: false \}\)/)
    }
    expect(source('chain/scripts/deploy.mjs')).toMatch(/if \(write\) writeFileSync/)
  })
})

describe('assertDeployerKeySafe — a refusal, not a warning', () => {
  it('throws for every published account', () => {
    for (const k of WELL_KNOWN_KEYS) {
      expect(() => assertDeployerKeySafe(k, {})).toThrow(/anvil account #\d/)
    }
  })

  it('explains that the mint authority is unrecoverable', () => {
    // The reason this one refuses where the relayer only exits: no env fix later
    // can move a deployed token's owner.
    expect(() => assertDeployerKeySafe(ANVIL_0, {})).toThrow(/CANNOT be changed/)
  })

  it('allows it under the explicit devnet opt-in', () => {
    expect(() => assertDeployerKeySafe(ANVIL_0, ALLOW)).not.toThrow()
  })

  it('allows a generated key with no opt-in at all', () => {
    expect(() => assertDeployerKeySafe(generatePrivateKey(), {})).not.toThrow()
  })

  it('is not fooled by a padded paste', () => {
    expect(() => assertDeployerKeySafe(`${ANVIL_0}\n`, {})).toThrow()
  })
})
